import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getServerPidPath, type TailserveState, writeState } from "./state.js";

const AUTOSTART_ENV_KEY = "TAILSERVE_SERVER_AUTOSTART";
const SERVER_ENTRY_ENV_KEY = "TAILSERVE_SERVER_ENTRY";
const SERVER_STOP_TIMEOUT_MS = 5000;
const SERVER_STOP_POLL_MS = 50;
const SERVER_START_VERIFY_TIMEOUT_MS = 3000;
const SERVER_START_VERIFY_POLL_MS = 50;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export function buildPortInUseErrorMessage(port: number): string {
  return `Failed to start tailserve server: port ${port} is already in use. Check with \`lsof -i :${port}\` or run \`ts server stop\`.`;
}

export interface TailserveServerRuntime {
  fileExists: (filePath: string) => boolean;
  isPortInUse: (port: number) => boolean;
  spawnServer: (entryPath: string) => void;
  cleanStalePidFile?: () => boolean;
  cleanStalePortMapping?: (port: number) => boolean;
  now?: () => number;
  sleep?: (delayMs: number) => void;
}

export interface TailserveServerStopRuntime {
  readPidFile: (pidPath: string) => string | undefined;
  removePidFile: (pidPath: string) => void;
  sendTerminateSignal: (pid: number) => void;
  isPidRunning: (pid: number) => boolean;
  now: () => number;
  wait: (delayMs: number) => Promise<void>;
}

export interface TailserveServerStatus {
  running: boolean;
  pid?: number;
  uptimeMs?: number;
  port?: number;
}

function isEnabledByEnv(rawValue: string | undefined): boolean | undefined {
  if (typeof rawValue !== "string") {
    return undefined;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "0" || normalized === "false") {
    return false;
  }

  if (normalized === "1" || normalized === "true") {
    return true;
  }

  return undefined;
}

function shouldAutostartServer(env: NodeJS.ProcessEnv): boolean {
  const explicit = isEnabledByEnv(env[AUTOSTART_ENV_KEY]);
  if (typeof explicit === "boolean") {
    return explicit;
  }

  return env.VITEST !== "1" && env.VITEST !== "true" && env.NODE_ENV !== "test";
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) {
    return;
  }

  Atomics.wait(SLEEP_ARRAY, 0, 0, milliseconds);
}

function isTailscaleDryRun(env: NodeJS.ProcessEnv): boolean {
  const configured = env.TAILSERVE_TAILSCALE_DRY_RUN;
  if (typeof configured === "string") {
    const normalized = configured.trim().toLowerCase();
    return normalized !== "0" && normalized !== "false";
  }

  return env.VITEST === "1" || env.VITEST === "true" || env.NODE_ENV === "test";
}

function resolveServerEntryPath(
  env: NodeJS.ProcessEnv,
  moduleDir: string,
  runtime: TailserveServerRuntime,
): string | undefined {
  const configuredEntry = env[SERVER_ENTRY_ENV_KEY];
  if (typeof configuredEntry === "string" && configuredEntry.trim().length > 0) {
    const resolvedEntry = path.resolve(configuredEntry);
    return runtime.fileExists(resolvedEntry) ? resolvedEntry : undefined;
  }

  const candidates = [path.resolve(moduleDir, "server-entry.js"), path.resolve(moduleDir, "..", "dist", "server-entry.js")];
  for (const candidate of candidates) {
    if (runtime.fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function buildDefaultTailserveServerRuntime(env: NodeJS.ProcessEnv): TailserveServerRuntime {
  return {
    fileExists: existsSync,
    isPortInUse: (port) => {
      const lookup = spawnSync("lsof", ["-ti", `:${port}`], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });

      if (lookup.error || lookup.status !== 0) {
        return false;
      }

      return typeof lookup.stdout === "string" && lookup.stdout.trim().length > 0;
    },
    spawnServer: (entryPath) => {
      const child = spawn(process.execPath, [entryPath], {
        detached: true,
        stdio: "ignore",
        env,
      });
      child.unref();
    },
    cleanStalePidFile: () => cleanStalePidFile(getServerPidPath()),
    cleanStalePortMapping: (port) => cleanStalePortMapping(port, env),
    now: () => Date.now(),
    sleep: sleepSync,
  };
}

function buildDefaultTailserveServerStopRuntime(): TailserveServerStopRuntime {
  return {
    readPidFile: (pidPath) => {
      if (!existsSync(pidPath)) {
        return undefined;
      }

      return readFileSync(pidPath, "utf8");
    },
    removePidFile: (pidPath) => {
      rmSync(pidPath, { force: true });
    },
    sendTerminateSignal: (pid) => {
      process.kill(pid, "SIGTERM");
    },
    isPidRunning: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error: unknown) {
        if (isNoSuchProcessError(error)) {
          return false;
        }

        throw error;
      }
    },
    now: () => Date.now(),
    wait: (delayMs) =>
      new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      }),
  };
}

function parseServerPid(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const pid = Number.parseInt(normalized, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  return pid;
}

function cleanStalePidFile(pidPath: string): boolean {
  if (!existsSync(pidPath)) {
    return false;
  }

  const pid = parseServerPid(readFileSync(pidPath, "utf8"));
  if (!pid) {
    rmSync(pidPath, { force: true });
    return true;
  }

  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }

    rmSync(pidPath, { force: true });
    return true;
  }
}

function cleanStalePortMapping(port: number, env: NodeJS.ProcessEnv): boolean {
  if (isTailscaleDryRun(env)) {
    return true;
  }

  const tailscaleBinary = env.TAILSERVE_TAILSCALE_BIN || "tailscale";
  const result = spawnSync(tailscaleBinary, ["serve", `--https=${port}`, "off"], {
    stdio: "ignore",
  });

  return !(result.error || result.status !== 0);
}

function parsePsElapsedTimeSeconds(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const daySplit = trimmed.split("-");
  const rawTime = daySplit.length > 1 ? daySplit[daySplit.length - 1] : trimmed;
  const days = daySplit.length > 1 ? Number.parseInt(daySplit.slice(0, -1).join("-"), 10) : 0;
  if (!Number.isInteger(days) || days < 0) {
    return undefined;
  }

  const timeParts = rawTime.split(":").map((part) => Number.parseInt(part, 10));
  if (timeParts.some((part) => !Number.isInteger(part) || part < 0)) {
    return undefined;
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (timeParts.length === 3) {
    [hours, minutes, seconds] = timeParts;
  } else if (timeParts.length === 2) {
    [minutes, seconds] = timeParts;
  } else if (timeParts.length === 1) {
    [seconds] = timeParts;
  } else {
    return undefined;
  }

  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds);
}

function getProcessUptimeMs(pid: number): number | undefined {
  const lookup = spawnSync("ps", ["-o", "etime=", "-p", `${pid}`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });

  if (lookup.error || lookup.status !== 0 || typeof lookup.stdout !== "string") {
    return undefined;
  }

  const elapsedSeconds = parsePsElapsedTimeSeconds(lookup.stdout);
  if (typeof elapsedSeconds !== "number") {
    return undefined;
  }

  return elapsedSeconds * 1000;
}

function parseListeningPortFromLsof(output: string): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /\bTCP\b.*:(\d+)(?:\s|\(|$)/.exec(line);
    if (!match) {
      continue;
    }

    const port = Number.parseInt(match[1], 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      return port;
    }
  }

  return undefined;
}

function getProcessListeningPort(pid: number): number | undefined {
  const lookup = spawnSync("lsof", ["-Pan", "-p", `${pid}`, "-iTCP", "-sTCP:LISTEN"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });

  if (lookup.error || lookup.status !== 0 || typeof lookup.stdout !== "string") {
    return undefined;
  }

  return parseListeningPortFromLsof(lookup.stdout);
}

function isNoSuchProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

export function readTailserveServerStatus(options?: { pidPath?: string }): TailserveServerStatus {
  const pidPath = options?.pidPath ?? getServerPidPath();
  if (!existsSync(pidPath)) {
    return { running: false };
  }

  const pidRaw = readFileSync(pidPath, "utf8");
  const pid = parseServerPid(pidRaw);
  if (!pid) {
    rmSync(pidPath, { force: true });
    return { running: false };
  }

  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    if (isNoSuchProcessError(error)) {
      rmSync(pidPath, { force: true });
      return { running: false };
    }

    throw error;
  }

  const uptimeMs = getProcessUptimeMs(pid);
  const port = getProcessListeningPort(pid);
  const status: TailserveServerStatus = { running: true, pid };
  if (typeof uptimeMs === "number") {
    status.uptimeMs = uptimeMs;
  }

  if (typeof port === "number") {
    status.port = port;
  }

  return status;
}

export function reconcileStatePortWithRunningServer(state: TailserveState, status = readTailserveServerStatus()): boolean {
  if (!status.running || typeof status.port !== "number") {
    return false;
  }

  if (state.port === status.port && state.tsPort === status.port) {
    return false;
  }

  state.port = status.port;
  state.tsPort = status.port;
  writeState(state);
  return true;
}

function verifySpawnedServer(
  runtime: TailserveServerRuntime,
  port: number,
  timeoutMs: number,
): boolean {
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? sleepSync;
  const deadline = now() + Math.max(timeoutMs, 0);

  while (true) {
    if (runtime.isPortInUse(port)) {
      return true;
    }

    const status = readTailserveServerStatus();
    if (status.running) {
      return true;
    }

    if (now() >= deadline) {
      return false;
    }

    sleep(SERVER_START_VERIFY_POLL_MS);
  }
}

export function ensureTailserveServerRunning(options?: {
  state?: TailserveState;
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
  runtime?: TailserveServerRuntime;
  verifyTimeoutMs?: number;
}): boolean {
  const env = options?.env ?? process.env;
  if (!shouldAutostartServer(env)) {
    return false;
  }

  const state = options?.state;
  if (!state) {
    return false;
  }

  const runtime = options?.runtime ?? buildDefaultTailserveServerRuntime(env);
  runtime.cleanStalePidFile?.();
  if (runtime.isPortInUse(state.port)) {
    const status = readTailserveServerStatus();
    if (status.running) {
      reconcileStatePortWithRunningServer(state, status);
      return false;
    }

    throw new Error(buildPortInUseErrorMessage(state.port));
  }

  const status = readTailserveServerStatus();
  if (status.running) {
    reconcileStatePortWithRunningServer(state, status);
    return false;
  }

  const moduleDir = options?.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const entryPath = resolveServerEntryPath(env, moduleDir, runtime);
  if (!entryPath) {
    return false;
  }

  const verifyTimeoutMs = options?.verifyTimeoutMs ?? SERVER_START_VERIFY_TIMEOUT_MS;
  runtime.spawnServer(entryPath);
  if (verifySpawnedServer(runtime, state.port, verifyTimeoutMs)) {
    return true;
  }

  runtime.cleanStalePortMapping?.(state.port);
  runtime.cleanStalePidFile?.();
  runtime.spawnServer(entryPath);
  if (verifySpawnedServer(runtime, state.port, verifyTimeoutMs)) {
    return true;
  }

  throw new Error(`Failed to start tailserve server: spawned process did not become ready on port ${state.port}.`);
}

export async function stopTailserveServer(options?: {
  pidPath?: string;
  runtime?: TailserveServerStopRuntime;
}): Promise<boolean> {
  const runtime = options?.runtime ?? buildDefaultTailserveServerStopRuntime();
  const pidPath = options?.pidPath ?? getServerPidPath();
  const pidRaw = runtime.readPidFile(pidPath);
  if (typeof pidRaw !== "string") {
    return false;
  }

  const pid = parseServerPid(pidRaw);
  if (!pid) {
    runtime.removePidFile(pidPath);
    return false;
  }

  try {
    runtime.sendTerminateSignal(pid);
  } catch (error: unknown) {
    if (isNoSuchProcessError(error)) {
      runtime.removePidFile(pidPath);
      return false;
    }

    throw error;
  }

  const deadline = runtime.now() + SERVER_STOP_TIMEOUT_MS;
  while (runtime.now() < deadline) {
    if (!runtime.isPidRunning(pid)) {
      runtime.removePidFile(pidPath);
      return true;
    }

    await runtime.wait(SERVER_STOP_POLL_MS);
  }

  throw new Error("Timed out waiting for server to stop");
}
