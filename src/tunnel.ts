import { type ChildProcess, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { TailserveState } from "./state.js";

const CLOUDFLARED_NOT_FOUND_ERROR = "cloudflared not installed — run: brew install cloudflared";
const TUNNEL_TIMEOUT_MS = 15_000;
const NAMED_TUNNEL_STOP_TIMEOUT_MS = 5_000;
const NAMED_TUNNEL_STOP_POLL_MS = 100;
const TRY_CLOUDFLARE_URL_PATTERN = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com(?:\/[^\s"'<>]*)?)/i;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const CLOUDFLARED_CERT_RELATIVE_PATH = path.join(".cloudflared", "cert.pem");
const CLOUDFLARED_CONFIG_RELATIVE_PATH = path.join(".tailserve", "cloudflared-config.yml");

type SyncCommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface TunnelRuntime {
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  runSyncProcess?: SyncCommandRunner;
  fileExists?: (targetPath: string) => boolean;
  makeDirectory?: (directoryPath: string) => void;
  writeFile?: (targetPath: string, content: string) => void;
  resolveHomeDirectory?: () => string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface NamedTunnelCreationResult {
  name: string;
  uuid: string;
  credentialsPath: string;
}

interface ProcessListEntry {
  pid: number;
  command: string;
}

interface ResolvedTunnelRuntime {
  spawnProcess: TunnelRuntime["spawnProcess"];
  killProcess: TunnelRuntime["killProcess"];
  runSyncProcess: SyncCommandRunner;
  fileExists: NonNullable<TunnelRuntime["fileExists"]>;
  makeDirectory: NonNullable<TunnelRuntime["makeDirectory"]>;
  writeFile: NonNullable<TunnelRuntime["writeFile"]>;
  resolveHomeDirectory: NonNullable<TunnelRuntime["resolveHomeDirectory"]>;
  now: NonNullable<TunnelRuntime["now"]>;
  wait: NonNullable<TunnelRuntime["wait"]>;
}

function buildDefaultTunnelRuntime(): TunnelRuntime {
  return {
    spawnProcess: (command, args, options) => spawn(command, args, options),
    killProcess: (pid, signal) => {
      if (typeof signal === "undefined") {
        process.kill(pid);
        return;
      }

      process.kill(pid, signal);
    },
    runSyncProcess: (command, args, options) => spawnSync(command, args, options),
    fileExists: (targetPath) => existsSync(targetPath),
    makeDirectory: (directoryPath) => mkdirSync(directoryPath, { recursive: true }),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8"),
    resolveHomeDirectory: () => homedir(),
    now: () => Date.now(),
    wait: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
  };
}

function resolveTunnelRuntime(runtime?: TunnelRuntime): ResolvedTunnelRuntime {
  const defaults = buildDefaultTunnelRuntime();
  return {
    spawnProcess: runtime?.spawnProcess ?? defaults.spawnProcess,
    killProcess: runtime?.killProcess ?? defaults.killProcess,
    runSyncProcess: runtime?.runSyncProcess ?? (defaults.runSyncProcess as SyncCommandRunner),
    fileExists: runtime?.fileExists ?? (defaults.fileExists as NonNullable<TunnelRuntime["fileExists"]>),
    makeDirectory: runtime?.makeDirectory ?? (defaults.makeDirectory as NonNullable<TunnelRuntime["makeDirectory"]>),
    writeFile: runtime?.writeFile ?? (defaults.writeFile as NonNullable<TunnelRuntime["writeFile"]>),
    resolveHomeDirectory:
      runtime?.resolveHomeDirectory ?? (defaults.resolveHomeDirectory as NonNullable<TunnelRuntime["resolveHomeDirectory"]>),
    now: runtime?.now ?? (defaults.now as NonNullable<TunnelRuntime["now"]>),
    wait: runtime?.wait ?? (defaults.wait as NonNullable<TunnelRuntime["wait"]>),
  };
}

function extractTryCloudflareUrl(output: string): string | undefined {
  const match = TRY_CLOUDFLARE_URL_PATTERN.exec(output);
  return match?.[1];
}

function normalizeChunk(chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function isNoSuchProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isProcessLookupDenied(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EPERM";
}

function isCommandNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function buildSyncCommandOptions(): SpawnSyncOptionsWithStringEncoding {
  return {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  };
}

function formatCommandOutput(result: SpawnSyncReturns<string>): string {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return output;
}

function assertCloudflaredInstalled(runtime: ResolvedTunnelRuntime): string {
  const installedPath = checkCloudflaredInstalled({ runtime });
  if (!installedPath) {
    throw new Error(CLOUDFLARED_NOT_FOUND_ERROR);
  }

  return installedPath;
}

function runCloudflaredCommand(runtime: ResolvedTunnelRuntime, args: string[], action: string): SpawnSyncReturns<string> {
  assertCloudflaredInstalled(runtime);
  const result = runtime.runSyncProcess("cloudflared", args, buildSyncCommandOptions());

  if (result.error && isCommandNotFound(result.error)) {
    throw new Error(CLOUDFLARED_NOT_FOUND_ERROR);
  }

  if (result.error || result.status !== 0) {
    const detail = formatCommandOutput(result);
    const suffix = detail.length > 0 ? `: ${detail}` : "";
    throw new Error(`Failed to ${action}${suffix}`);
  }

  return result;
}

function extractUuid(output: string): string | undefined {
  return UUID_PATTERN.exec(output)?.[0];
}

function extractCredentialsPath(output: string): string | undefined {
  const unixPathMatch = output.match(/(\/[^\s"'`]+\.json)/);
  if (unixPathMatch?.[1]) {
    return unixPathMatch[1];
  }

  const windowsPathMatch = output.match(/([A-Za-z]:\\[^\s"'`]+\.json)/);
  return windowsPathMatch?.[1];
}

function normalizeTunnelName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new Error("Tunnel name is required");
  }

  return normalized;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim();
  if (normalized.length === 0) {
    throw new Error("Tunnel hostname is required");
  }

  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseProcessListEntries(output: string): ProcessListEntry[] {
  const entries: ProcessListEntry[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    entries.push({
      pid,
      command: match[2],
    });
  }

  return entries;
}

function isNamedTunnelRunCommand(command: string, tunnelName: string): boolean {
  if (!/cloudflared/i.test(command)) {
    return false;
  }

  if (!/(?:^|\s)tunnel(?:\s|$)/i.test(command)) {
    return false;
  }

  const runPattern = new RegExp(`(?:^|\\s)run\\s+${escapeRegExp(tunnelName)}(?:\\s|$)`, "i");
  return runPattern.test(command);
}

function resolveNamedTunnelConfigPath(runtime: ResolvedTunnelRuntime): string {
  return path.join(runtime.resolveHomeDirectory(), CLOUDFLARED_CONFIG_RELATIVE_PATH);
}

function buildNamedTunnelConfigYaml(state: TailserveState): string {
  if (!state.namedTunnel) {
    throw new Error("Named tunnel not configured in state");
  }

  return [
    `tunnel: ${state.namedTunnel.uuid}`,
    `credentials-file: ${state.namedTunnel.credentialsPath}`,
    "",
    "ingress:",
    `  - hostname: ${state.namedTunnel.hostname}`,
    `    service: http://127.0.0.1:${state.port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

export function checkCloudflaredInstalled(options?: { runtime?: TunnelRuntime }): string | null {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const result = runtime.runSyncProcess("which", ["cloudflared"], buildSyncCommandOptions());

  if (result.error || result.status !== 0) {
    return null;
  }

  const installedPath = result.stdout.trim().split(/\r?\n/)[0];
  return installedPath.length > 0 ? installedPath : null;
}

export function installCloudflared(options?: { runtime?: TunnelRuntime }): string {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const result = runtime.runSyncProcess("brew", ["install", "cloudflared"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    const detail = formatCommandOutput(result);
    const suffix = detail.length > 0 ? `: ${detail}` : "";
    throw new Error(`Failed to install cloudflared via brew${suffix}`);
  }

  const installedPath = checkCloudflaredInstalled({ runtime });
  if (!installedPath) {
    throw new Error("cloudflared was installed but could not be found on PATH");
  }

  return installedPath;
}

export function checkCloudflaredAuth(options?: { runtime?: TunnelRuntime }): boolean {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const certPath = path.join(runtime.resolveHomeDirectory(), CLOUDFLARED_CERT_RELATIVE_PATH);
  return runtime.fileExists(certPath);
}

export function loginCloudflared(options?: { runtime?: TunnelRuntime }): void {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const result = runtime.runSyncProcess("cloudflared", ["tunnel", "login"], {
    stdio: ["inherit", "inherit", "inherit"],
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    const detail = formatCommandOutput(result);
    const suffix = detail.length > 0 ? `: ${detail}` : "";
    throw new Error(`Cloudflare login failed${suffix}`);
  }

  if (!checkCloudflaredAuth({ runtime })) {
    throw new Error("Cloudflare login completed but cert.pem was not found — auth may have failed");
  }
}

export function createNamedTunnel(name: string, options?: { runtime?: TunnelRuntime }): NamedTunnelCreationResult {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const tunnelName = normalizeTunnelName(name);
  const result = runCloudflaredCommand(runtime, ["tunnel", "create", tunnelName], "create named cloudflared tunnel");
  const output = formatCommandOutput(result);
  const uuid = extractUuid(output);

  if (!uuid) {
    throw new Error("Failed to parse tunnel UUID from cloudflared output");
  }

  const credentialsPath = extractCredentialsPath(output) ?? path.join(runtime.resolveHomeDirectory(), ".cloudflared", `${uuid}.json`);

  return {
    name: tunnelName,
    uuid,
    credentialsPath,
  };
}

export function routeTunnelDns(name: string, hostname: string, options?: { runtime?: TunnelRuntime }): void {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const tunnelName = normalizeTunnelName(name);
  const tunnelHostname = normalizeHostname(hostname);
  runCloudflaredCommand(runtime, ["tunnel", "route", "dns", tunnelName, tunnelHostname], "route tunnel DNS");
}

export function generateTunnelConfig(state: TailserveState, options?: { runtime?: TunnelRuntime }): string {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const configPath = resolveNamedTunnelConfigPath(runtime);
  runtime.makeDirectory(path.dirname(configPath));
  runtime.writeFile(configPath, buildNamedTunnelConfigYaml(state));
  return configPath;
}

export function startNamedTunnel(state: TailserveState, options?: { runtime?: TunnelRuntime }): number {
  if (!state.namedTunnel) {
    throw new Error("Named tunnel not configured in state");
  }

  const runtime = resolveTunnelRuntime(options?.runtime);
  assertCloudflaredInstalled(runtime);
  const configPath = generateTunnelConfig(state, { runtime });
  const child = runtime.spawnProcess("cloudflared", ["tunnel", "--config", configPath, "run", state.namedTunnel.name], {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => {
    return;
  });
  child.unref();

  if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0) {
    throw new Error("Failed to start named cloudflared tunnel process");
  }

  state.namedTunnelPid = child.pid as number;
  return state.namedTunnelPid;
}

export function resolveNamedTunnelPid(state: TailserveState, options?: { runtime?: TunnelRuntime }): number | undefined {
  if (!state.namedTunnel) {
    delete state.namedTunnelPid;
    return undefined;
  }

  const runtime = resolveTunnelRuntime(options?.runtime);
  const knownPid = state.namedTunnelPid;
  if (typeof knownPid === "number" && Number.isInteger(knownPid) && knownPid > 0 && isNamedTunnelRunning(knownPid, { runtime })) {
    return knownPid;
  }

  const processList = runtime.runSyncProcess("ps", ["-ax", "-o", "pid=", "-o", "command="], buildSyncCommandOptions());
  if (processList.error || processList.status !== 0) {
    delete state.namedTunnelPid;
    return undefined;
  }

  const entries = parseProcessListEntries(processList.stdout ?? "");
  const matchedProcess = entries.find((entry) => isNamedTunnelRunCommand(entry.command, state.namedTunnel?.name ?? ""));
  if (!matchedProcess) {
    delete state.namedTunnelPid;
    return undefined;
  }

  state.namedTunnelPid = matchedProcess.pid;
  return matchedProcess.pid;
}

export function isNamedTunnelRunning(pid: number, options?: { runtime?: TunnelRuntime }): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const runtime = resolveTunnelRuntime(options?.runtime);

  try {
    runtime.killProcess(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNoSuchProcessError(error)) {
      return false;
    }

    if (isProcessLookupDenied(error)) {
      return true;
    }

    throw error;
  }
}

export async function stopNamedTunnel(pid: number, options?: { runtime?: TunnelRuntime }): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const runtime = resolveTunnelRuntime(options?.runtime);

  try {
    runtime.killProcess(pid, "SIGTERM");
  } catch (error: unknown) {
    if (isNoSuchProcessError(error)) {
      return;
    }

    throw error;
  }

  const startedAt = runtime.now();
  while (runtime.now() - startedAt <= NAMED_TUNNEL_STOP_TIMEOUT_MS) {
    if (!isNamedTunnelRunning(pid, { runtime })) {
      return;
    }

    await runtime.wait(NAMED_TUNNEL_STOP_POLL_MS);
  }

  throw new Error(`Timed out waiting for cloudflared tunnel process ${pid} to stop`);
}

export async function stopConfiguredNamedTunnel(state: TailserveState, options?: { runtime?: TunnelRuntime }): Promise<boolean> {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const pid = resolveNamedTunnelPid(state, { runtime });
  if (typeof pid !== "number") {
    delete state.namedTunnelPid;
    return false;
  }

  await stopNamedTunnel(pid, { runtime });
  delete state.namedTunnelPid;
  return true;
}

export async function removeNamedTunnel(state: TailserveState, options?: { runtime?: TunnelRuntime }): Promise<void> {
  const runtime = resolveTunnelRuntime(options?.runtime);
  await stopConfiguredNamedTunnel(state, { runtime });

  if (state.namedTunnel) {
    runCloudflaredCommand(runtime, ["tunnel", "delete", state.namedTunnel.name], "delete named cloudflared tunnel");
  }

  delete state.namedTunnel;
  delete state.namedTunnelPid;
}

export function spawnCloudflaredTunnel(
  port: number,
  options?: { runtime?: TunnelRuntime },
): Promise<{ pid: number; url: string }> {
  const runtime = resolveTunnelRuntime(options?.runtime);
  const child = runtime.spawnProcess("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", handleOutput);
      child.stderr?.off("data", handleOutput);
      child.off("error", handleError);
      child.off("exit", handleExit);
    };

    const settle = (handler: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      handler();
    };

    const handleOutput = (chunk: Buffer | string) => {
      const url = extractTryCloudflareUrl(normalizeChunk(chunk));
      if (!url) {
        return;
      }

      if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0) {
        settle(() => reject(new Error("cloudflared tunnel started without a PID")));
        return;
      }

      settle(() => resolve({ pid: child.pid as number, url }));
    };

    const handleError = (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        settle(() => reject(new Error(CLOUDFLARED_NOT_FOUND_ERROR)));
        return;
      }

      settle(() => reject(toError(error)));
    };

    const handleExit = () => {
      settle(() => reject(new Error("cloudflared tunnel exited before URL was available")));
    };

    const timeout = setTimeout(() => {
      if (Number.isInteger(child.pid) && (child.pid ?? 0) > 0) {
        try {
          runtime.killProcess(child.pid as number);
        } catch {
          // Ignore cleanup failure on timeout path.
        }
      }

      settle(() => reject(new Error("Timed out waiting for cloudflared tunnel URL")));
    }, TUNNEL_TIMEOUT_MS);

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);
    child.on("error", handleError);
    child.on("exit", handleExit);
  });
}

export function killTunnelProcess(pid: number, options?: { runtime?: TunnelRuntime }): void {
  const runtime = resolveTunnelRuntime(options?.runtime);

  try {
    runtime.killProcess(pid);
  } catch (error: unknown) {
    if (isNoSuchProcessError(error)) {
      return;
    }

    throw error;
  }
}
