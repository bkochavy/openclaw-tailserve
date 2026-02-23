import { Command, CommanderError } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { runDoctor } from "./doctor.js";
import { installTailserveLaunchAgent, uninstallTailserveLaunchAgent } from "./launch-agent.js";
import { ensureTailserveServerRunning, readTailserveServerStatus, reconcileStatePortWithRunningServer, stopTailserveServer } from "./server-process.js";
import { createEditShare, createFileShare, createProxyShare, removeEphemeralShares, removeShareById } from "./shares.js";
import {
  getStatePath,
  type NamedTunnelConfig,
  readState,
  type ShareRecord,
  type TailserveState,
  type TunnelRecord,
  toShareOrigin,
  toShareUrl,
  updateState,
  writeState,
} from "./state.js";
import {
  cleanupStaleTailscaleServeRoutes,
  disableTailscaleServe,
  enableTailscaleFunnelRoute,
  ensureTailscaleServeForFirstShare,
  type CleanupStaleRoutesSummary,
} from "./tailscale.js";
import {
  checkCloudflaredAuth,
  checkCloudflaredInstalled,
  installCloudflared,
  loginCloudflared,
  createNamedTunnel,
  generateTunnelConfig,
  killTunnelProcess,
  removeNamedTunnel,
  resolveNamedTunnelPid,
  routeTunnelDns,
  spawnCloudflaredTunnel,
  startNamedTunnel,
  stopConfiguredNamedTunnel,
} from "./tunnel.js";

type OutputWriter = Pick<NodeJS.WriteStream, "write">;
interface ShareCommandOptions {
  ttl?: string;
  persist?: boolean;
  public?: boolean;
  tunnel?: boolean;
}

interface EditCommandOptions {
  readonly?: boolean;
  ttl?: string;
  persist?: boolean;
  public?: boolean;
}

interface ListCommandOptions {
  json?: boolean;
}

interface StopCommandOptions {
  all?: boolean;
  tunnels?: boolean;
}

interface StatusCommandOptions {
  json?: boolean;
}

interface ProjectCommandOptions {
  name?: string;
  port?: string;
  start?: string;
  json?: boolean;
}

interface ProxyCommandOptions {
  name?: string;
  public?: boolean;
}

interface FunnelCommandOptions {
  name?: string;
}

interface TunnelSetupCommandOptions {
  name?: string;
}

interface CleanupCommandOptions {
  dryRun?: boolean;
}

interface DoctorCommandOptions {
  fix?: boolean;
  verbose?: boolean;
}

interface ListShareRow {
  id: string;
  type: ShareRecord["type"] | "project" | "tunnel";
  path: string;
  url: string;
  access: "tailnet" | "public";
  status: string;
  expires: string;
}

interface ProjectRecord {
  name?: unknown;
  path?: unknown;
  port?: unknown;
  status?: unknown;
  startCmd?: unknown;
  public?: unknown;
}

interface ListProjectRow {
  name: string;
  path: string;
  port: number | null;
  url: string;
  status: "online" | "offline";
  startCmd: string | null;
}

interface CliRuntime {
  openUrl: (url: string) => void;
  isInteractiveInput?: () => boolean;
  promptLine?: (query: string) => Promise<string>;
}

interface BrowserOpenCommand {
  command: string;
  args: string[];
}

const TTL_MULTIPLIER_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function resolveBrowserOpenCommand(platform: NodeJS.Platform): BrowserOpenCommand {
  if (platform === "darwin") {
    return { command: "open", args: [] };
  }

  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", ""] };
  }

  if (platform === "linux") {
    return { command: "xdg-open", args: [] };
  }

  throw new Error(`Unsupported platform for opening browser: ${platform}`);
}

function openUrlInDefaultBrowser(url: string): void {
  const openCommand = resolveBrowserOpenCommand(process.platform);
  const result = spawnSync(openCommand.command, [...openCommand.args, url], {
    stdio: "ignore",
  });

  if (result.error || result.status !== 0) {
    throw new Error(`Failed to open URL: ${url}`);
  }
}

const defaultCliRuntime: CliRuntime = {
  openUrl: openUrlInDefaultBrowser,
  isInteractiveInput: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
  promptLine: async (query: string) => {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return await prompt.question(query);
    } finally {
      prompt.close();
    }
  },
};

function formatTable(rows: string[][]): string {
  const columnCount = rows[0]?.length ?? 0;
  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );

  return rows
    .map((row) => row.map((cell, index) => (cell ?? "").padEnd(columnWidths[index])).join("  ").trimEnd())
    .join("\n");
}

function getShareUrl(state: TailserveState, share: ShareRecord): string {
  return toShareUrl(state, share.id);
}

function toProjectUrl(state: TailserveState, name: string): string {
  return `${toShareOrigin(state)}/p/${encodeURIComponent(name)}`;
}

function getShareStatus(share: ShareRecord, nowMs: number): string {
  const status = (share as { status?: unknown }).status;
  if (typeof status === "string" && status.length > 0) {
    return status;
  }

  if (share.expiresAt === null) {
    return "active";
  }

  const expiresAtMs = Date.parse(share.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return "unknown";
  }

  return expiresAtMs <= nowMs ? "expired" : "active";
}

function isShareExpired(share: ShareRecord, nowMs: number): boolean {
  if (share.expiresAt === null) {
    return false;
  }

  const expiresAtMs = Date.parse(share.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }

  return expiresAtMs <= nowMs;
}

function countActiveShares(state: TailserveState, nowMs: number): number {
  return Object.values(state.shares).filter((share) => !isShareExpired(share, nowMs)).length;
}

function countActiveProjects(state: TailserveState): number {
  return Object.values(state.projects).filter((project) => isProjectRecord(project)).length;
}

function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  if (totalSeconds === 0) {
    return "0s";
  }

  const parts: string[] = [];
  let remaining = totalSeconds;
  const units: ReadonlyArray<[suffix: string, seconds: number]> = [
    ["d", 24 * 60 * 60],
    ["h", 60 * 60],
    ["m", 60],
    ["s", 1],
  ];

  for (const [suffix, seconds] of units) {
    const value = Math.floor(remaining / seconds);
    if (value > 0) {
      parts.push(`${value}${suffix}`);
      remaining -= value * seconds;
    }
  }

  return parts.join(" ");
}

function getSharePath(share: ShareRecord): string {
  if (typeof share.path === "string" && share.path.length > 0) {
    return share.path;
  }

  if (typeof share.port === "number") {
    return `localhost:${share.port}`;
  }

  return "-";
}

function getAccessLabel(isPublic: unknown): "tailnet" | "public" {
  return isPublic === true ? "public" : "tailnet";
}

function toListShareRow(state: TailserveState, share: ShareRecord, nowMs: number): ListShareRow {
  return {
    id: share.id,
    type: share.type,
    path: getSharePath(share),
    url: getShareUrl(state, share),
    access: getAccessLabel(share.public),
    status: getShareStatus(share, nowMs),
    expires: share.expiresAt ?? "never",
  };
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  return typeof value === "object" && value !== null;
}

function toListProjectRow(state: TailserveState, projectKey: string, project: ProjectRecord): ListShareRow {
  const name = getProjectName(projectKey, project);
  const projectPath = getProjectPath(project);

  return {
    id: name,
    type: "project",
    path: projectPath,
    url: toProjectUrl(state, name),
    access: getAccessLabel(project.public),
    status: getProjectStatus(project),
    expires: "never",
  };
}

function getTunnelPath(tunnel: TunnelRecord): string {
  return Number.isInteger(tunnel.port) && tunnel.port > 0 && tunnel.port <= 65_535 ? `localhost:${tunnel.port}` : "-";
}

function getTunnelUrl(tunnel: TunnelRecord): string {
  return typeof tunnel.url === "string" && tunnel.url.length > 0 ? tunnel.url : "-";
}

function toListTunnelRow(tunnelId: string, tunnel: TunnelRecord): ListShareRow {
  return {
    id: tunnelId,
    type: "tunnel",
    path: getTunnelPath(tunnel),
    url: getTunnelUrl(tunnel),
    access: "public",
    status: "active",
    expires: "never",
  };
}

function getProjectName(projectKey: string, project: ProjectRecord): string {
  return typeof project.name === "string" && project.name.length > 0 ? project.name : projectKey;
}

function getProjectPath(project: ProjectRecord): string {
  return typeof project.path === "string" && project.path.length > 0 ? project.path : "-";
}

function getProjectPort(project: ProjectRecord): number | null {
  return typeof project.port === "number" && Number.isInteger(project.port) && project.port > 0 ? project.port : null;
}

function getProjectStatus(project: ProjectRecord): "online" | "offline" {
  return project.status === "online" ? "online" : "offline";
}

function getProjectStartCommand(project: ProjectRecord): string | null {
  return typeof project.startCmd === "string" && project.startCmd.length > 0 ? project.startCmd : null;
}

function toProjectListRow(state: TailserveState, projectKey: string, project: ProjectRecord): ListProjectRow {
  const name = getProjectName(projectKey, project);
  return {
    name,
    path: getProjectPath(project),
    port: getProjectPort(project),
    url: toProjectUrl(state, name),
    status: getProjectStatus(project),
    startCmd: getProjectStartCommand(project),
  };
}

function parseShareTtl(ttl: string): number {
  const normalized = ttl.trim().toLowerCase();
  const match = /^(\d+)([mhd])$/.exec(normalized);
  if (!match) {
    throw new Error(`Invalid TTL format: ${ttl}`);
  }

  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Invalid TTL value: ${ttl}`);
  }

  const multiplier = TTL_MULTIPLIER_MS[match[2]];
  return amount * multiplier;
}

function parseProjectPort(rawPort: string): number {
  const normalized = rawPort.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  return parsed;
}

function parseProjectStartCommand(rawStartCommand: string): string {
  const normalized = rawStartCommand.trim();
  if (normalized.length === 0) {
    throw new Error("Start command must not be empty");
  }

  return normalized;
}

function normalizeProjectName(candidate: string): string {
  const normalized = candidate.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error(`Invalid project name: ${candidate}`);
  }

  return normalized;
}

function resolveProjectName(pathName: string, rawName?: string): string {
  const candidate = typeof rawName === "string" && rawName.trim().length > 0 ? rawName : path.basename(pathName);
  return normalizeProjectName(candidate);
}

function normalizeLooseProjectName(candidate: string): string {
  return candidate.trim().toLowerCase();
}

function getStoredProjectName(project: ProjectRecord): string | undefined {
  if (typeof project.name !== "string") {
    return undefined;
  }

  const normalized = normalizeLooseProjectName(project.name);
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function removeProjectByName(projectName: string): boolean {
  const name = normalizeProjectName(projectName);
  const state = readState();
  const projectKeys = Object.keys(state.projects).filter((projectKey) => {
    if (normalizeLooseProjectName(projectKey) === name) {
      return true;
    }

    const project = state.projects[projectKey];
    if (!isProjectRecord(project)) {
      return false;
    }

    return getStoredProjectName(project) === name;
  });

  if (projectKeys.length === 0) {
    return false;
  }

  for (const projectKey of projectKeys) {
    delete state.projects[projectKey];
  }

  writeState(state);
  return true;
}

function toDashboardUrl(state: TailserveState): string {
  return new URL("/", toShareOrigin(state)).toString();
}

function removeTunnelById(id: string): boolean {
  const normalizedId = id.trim();
  if (normalizedId.length === 0) {
    throw new Error("Tunnel id is required");
  }

  const state = readState();
  const tunnel = state.tunnels[normalizedId];
  if (!tunnel) {
    return false;
  }

  if (typeof tunnel.pid === "number" && Number.isInteger(tunnel.pid) && tunnel.pid > 0) {
    killTunnelProcess(tunnel.pid);
  }

  delete state.tunnels[normalizedId];
  writeState(state);
  return true;
}

function removeAllTunnels(): number {
  const state = readState();
  const tunnelEntries = Object.entries(state.tunnels);
  if (tunnelEntries.length === 0) {
    return 0;
  }

  for (const [, tunnel] of tunnelEntries) {
    if (typeof tunnel.pid === "number" && Number.isInteger(tunnel.pid) && tunnel.pid > 0) {
      killTunnelProcess(tunnel.pid);
    }
  }

  state.tunnels = {};
  writeState(state);
  return tunnelEntries.length;
}

function formatCleanupPorts(ports: ReadonlyArray<number>): string {
  return ports.length > 0 ? ports.join(", ") : "none";
}

function formatCleanupSummary(summary: CleanupStaleRoutesSummary, dryRun: boolean): string {
  const actionLabel = dryRun ? "Dry run: would remove" : "Removed";
  return `${actionLabel} ${summary.removed.length} stale routes (ports ${formatCleanupPorts(summary.removed)}). Protected: ${formatCleanupPorts(summary.protected)}. Skipped: ${formatCleanupPorts(summary.skipped)}.`;
}

function formatDoctorSummary(issueCount: number, fixedCount: number, remainingCount: number): string {
  const issueLabel = issueCount === 1 ? "issue" : "issues";
  if (issueCount === 0) {
    return "Summary: 0 issues found.";
  }

  if (remainingCount === 0) {
    return `Summary: ${issueCount} ${issueLabel} found; all fixed (${fixedCount} fixed).`;
  }

  if (fixedCount === 0) {
    return `Summary: ${issueCount} ${issueLabel} found; ${remainingCount} unfixed.`;
  }

  return `Summary: ${issueCount} ${issueLabel} found; ${fixedCount} fixed, ${remainingCount} unfixed.`;
}

function formatExistingNamedTunnelConfig(namedTunnel: NamedTunnelConfig): string {
  return [
    "Named tunnel is already configured:",
    `- name: ${namedTunnel.name}`,
    `- hostname: ${namedTunnel.hostname}`,
    `- uuid: ${namedTunnel.uuid}`,
    `- credentials: ${namedTunnel.credentialsPath}`,
    "Run `ts tunnel remove` first.",
  ].join("\n");
}

function resolveTunnelName(rawName: string | undefined): string {
  const normalized = (rawName ?? "tailserve").trim();
  if (normalized.length === 0) {
    throw new Error("Tunnel name is required");
  }

  return normalized;
}

function resolveTunnelHostname(rawHostname: string): string {
  const normalized = rawHostname.trim();
  if (normalized.length === 0) {
    throw new Error("Tunnel hostname is required");
  }

  return normalized;
}

async function promptForTunnelHostname(stderr: OutputWriter, runtime: CliRuntime): Promise<string | undefined> {
  if (!runtime.isInteractiveInput?.() || typeof runtime.promptLine !== "function") {
    return undefined;
  }

  stderr.write("Tunnel hostname not provided.\n");
  for (;;) {
    const answer = await runtime.promptLine("Hostname (e.g. share.example.com): ");
    const normalized = answer.trim();
    if (normalized.length === 0) {
      stderr.write("Hostname cannot be empty.\n");
      continue;
    }

    return resolveTunnelHostname(normalized);
  }
}

function resolveNamedTunnelPublicHostname(state: TailserveState): string {
  const hostname = state.namedTunnel?.hostname?.trim();
  if (!hostname) {
    throw new Error("Named tunnel is not configured — run `ts tunnel setup <hostname>` first");
  }

  return hostname;
}

function toNamedTunnelShareUrl(hostname: string, id: string): string {
  return `https://${hostname}/s/${id}`;
}

function toNamedTunnelProjectUrl(hostname: string, name: string): string {
  return `https://${hostname}/p/${encodeURIComponent(name)}`;
}

function formatNamedTunnelStatusRows(state: TailserveState, runningPid: number | undefined): string[][] {
  if (!state.namedTunnel) {
    return [["Configured", "no"], ["Cloudflared", "stopped"]];
  }

  const rows: string[][] = [
    ["Name", state.namedTunnel.name],
    ["Hostname", state.namedTunnel.hostname],
    ["UUID", state.namedTunnel.uuid],
    ["Cloudflared", typeof runningPid === "number" ? "running" : "stopped"],
  ];

  if (typeof runningPid === "number") {
    rows.push(["PID", `${runningPid}`]);
  }

  return rows;
}

export function buildProgram(stdout: OutputWriter, stderr: OutputWriter, runtime: CliRuntime = defaultCliRuntime): Command {
  const program = new Command();

  program.name("ts").description("TailServe CLI").exitOverride();

  program.configureOutput({
    writeOut: (message) => {
      stdout.write(message);
    },
    writeErr: (message) => {
      stderr.write(message);
    },
  });

  program
    .command("status")
    .description("Open the tailserve dashboard URL")
    .option("--json", "Print dashboard URL instead of opening it")
    .action((options: StatusCommandOptions) => {
      const state = readState();
      ensureTailserveServerRunning({ state });
      const dashboardUrl = toDashboardUrl(state);

      if (options.json === true) {
        stdout.write(`${dashboardUrl}\n`);
        return;
      }

      runtime.openUrl(dashboardUrl);
    });

  program
    .command("share")
    .description("Share a file or directory")
    .argument("<targetPath>")
    .option("--ttl <ttl>", "Override share TTL (e.g. 30m, 2h, 1d, 7d)")
    .option("--persist", "Create a persistent share with no expiry")
    .option("--public", "Use the configured named tunnel hostname for this share URL")
    .option("--tunnel", "Expose this share through a cloudflared tunnel URL")
    .action(async (targetPath: string, options: ShareCommandOptions) => {
      const publicHostname = options.public === true ? resolveNamedTunnelPublicHostname(readState()) : undefined;
      const ttlMs = typeof options.ttl === "string" ? parseShareTtl(options.ttl) : undefined;
      const { id, url, warning } = createFileShare(targetPath, {
        ttlMs,
        persist: options.persist === true,
      });

      if (options.public === true) {
        updateState((state) => {
          const share = state.shares[id];
          if (share) {
            share.public = true;
          }
        });
      }

      if (warning) {
        stderr.write(`${warning}\n`);
      }

      if (options.tunnel === true) {
        let tunnelPid: number | undefined;
        try {
          const state = readState();
          const { pid, url: tunnelUrl } = await spawnCloudflaredTunnel(state.port);
          tunnelPid = pid;
          updateState((currentState) => {
            currentState.tunnels[id] = {
              pid,
              url: tunnelUrl,
              port: state.port,
              createdAt: new Date().toISOString(),
            };
          });
          stdout.write(`${tunnelUrl}\n`);
          return;
        } catch (error: unknown) {
          if (typeof tunnelPid === "number" && Number.isInteger(tunnelPid) && tunnelPid > 0) {
            try {
              killTunnelProcess(tunnelPid);
            } catch {
              // Best effort cleanup to avoid leaking a detached tunnel process.
            }
          }

          try {
            updateState((currentState) => {
              delete currentState.shares[id];
              delete currentState.tunnels[id];
            });
          } catch {
            // Preserve the original error from tunnel startup.
          }

          throw error;
        }
      }

      if (publicHostname) {
        stdout.write(`${toNamedTunnelShareUrl(publicHostname, id)}\n`);
        return;
      }

      stdout.write(`${url}\n`);
    });

  program
    .command("edit")
    .description("Share a file with browser editing support")
    .argument("<targetPath>")
    .option("--readonly", "View-only mode")
    .option("--persist", "Persistent share")
    .option("--ttl <ttl>", "Override TTL")
    .option("--public", "Use the configured named tunnel hostname for this share URL")
    .action((targetPath: string, options: EditCommandOptions) => {
      const publicHostname = options.public === true ? resolveNamedTunnelPublicHostname(readState()) : undefined;
      const ttlMs = typeof options.ttl === "string" ? parseShareTtl(options.ttl) : undefined;
      const resolvedPath = path.resolve(targetPath);
      const { id, url, warning } = createEditShare(resolvedPath, {
        readonly: options.readonly === true,
        persist: options.persist === true,
        ttlMs,
      });

      if (options.public === true) {
        updateState((state) => {
          const share = state.shares[id];
          if (share) {
            share.public = true;
          }
        });
      }

      if (warning) {
        stderr.write(`${warning}\n`);
      }

      if (publicHostname) {
        stdout.write(`${toNamedTunnelShareUrl(publicHostname, id)}\n`);
        return;
      }

      stdout.write(`${url}\n`);
    });

  program
    .command("proxy")
    .description("Share a local HTTP server by port")
    .argument("<port>")
    .option("--name <name>", "Project route name")
    .option("--public", "Use the configured named tunnel hostname for this proxy URL")
    .action((portValue: string, options: ProxyCommandOptions) => {
      const port = parseProjectPort(portValue);

      if (typeof options.name === "string") {
        const state = readState();
        const publicHostname = options.public === true ? resolveNamedTunnelPublicHostname(state) : undefined;
        ensureTailserveServerRunning({ state });
        const firstRouteSetup =
          Object.keys(state.shares).length === 0 && Object.keys(state.projects).length === 0
            ? ensureTailscaleServeForFirstShare(state)
            : {};
        const name = normalizeProjectName(options.name);

        state.projects[name] = {
          name,
          path: path.resolve(process.cwd()),
          port,
          createdAt: new Date().toISOString(),
          status: "online",
          public: options.public === true ? true : undefined,
        };
        writeState(state);

        if (firstRouteSetup.warning) {
          stderr.write(`${firstRouteSetup.warning}\n`);
        }
        if (publicHostname) {
          stdout.write(`${toNamedTunnelProjectUrl(publicHostname, name)}\n`);
          return;
        }

        stdout.write(`${toProjectUrl(state, name)}\n`);
        return;
      }

      const publicHostname = options.public === true ? resolveNamedTunnelPublicHostname(readState()) : undefined;
      const { id, url, warning } = createProxyShare(port);

      if (options.public === true) {
        updateState((state) => {
          const share = state.shares[id];
          if (share) {
            share.public = true;
          }
        });
      }

      if (warning) {
        stderr.write(`${warning}\n`);
      }

      if (publicHostname) {
        stdout.write(`${toNamedTunnelShareUrl(publicHostname, id)}\n`);
        return;
      }

      stdout.write(`${url}\n`);
    });

  program
    .command("funnel")
    .description("Share a local HTTP server publicly by port")
    .argument("<port>")
    .option("--name <name>", "Project route name")
    .action((portValue: string, options: FunnelCommandOptions) => {
      const port = parseProjectPort(portValue);
      const state = readState();
      ensureTailserveServerRunning({ state });
      const funnelSetup = enableTailscaleFunnelRoute(state);

      if (typeof options.name === "string") {
        const name = normalizeProjectName(options.name);
        state.projects[name] = {
          name,
          path: path.resolve(process.cwd()),
          port,
          createdAt: new Date().toISOString(),
          status: "online",
          public: true,
        };
        writeState(state);

        if (funnelSetup.warning) {
          stderr.write(`${funnelSetup.warning}\n`);
        }
        stdout.write(`${toProjectUrl(state, name)}\n`);
        return;
      }

      const { url, warning } = createProxyShare(port, {
        ensureServerRunning: false,
        setupTailscaleRoute: false,
        public: true,
        state,
      });
      if (funnelSetup.warning) {
        stderr.write(`${funnelSetup.warning}\n`);
      } else if (warning) {
        stderr.write(`${warning}\n`);
      }
      stdout.write(`${url}\n`);
    });

  const tunnelCommand = program.command("tunnel").description("Manage Cloudflare tunnels");

  tunnelCommand
    .command("setup")
    .description("Configure a named Cloudflare tunnel")
    .argument("[hostname]")
    .option("--name <name>", "Named tunnel identifier")
    .action(async (hostnameValue: string | undefined, options: TunnelSetupCommandOptions) => {
      const state = readState();
      let requestedHostname = typeof hostnameValue === "string" ? resolveTunnelHostname(hostnameValue) : undefined;
      const requestedTunnelName = typeof options.name === "string" ? resolveTunnelName(options.name) : undefined;
      if (state.namedTunnel) {
        const hostnameMatches = requestedHostname === undefined || state.namedTunnel.hostname === requestedHostname;
        const tunnelNameMatches = requestedTunnelName === undefined || state.namedTunnel.name === requestedTunnelName;
        if (hostnameMatches && tunnelNameMatches) {
          const runningPid = resolveNamedTunnelPid(state);
          if (typeof runningPid !== "number") {
            startNamedTunnel(state);
          }

          stderr.write(`✓ Named tunnel already configured at https://${state.namedTunnel.hostname}\n`);
          stdout.write(`https://${state.namedTunnel.hostname}\n`);
          return;
        }

        throw new Error(formatExistingNamedTunnelConfig(state.namedTunnel));
      }

      if (!requestedHostname) {
        requestedHostname = await promptForTunnelHostname(stderr, runtime);
      }

      if (!requestedHostname) {
        throw new Error("Tunnel hostname is required");
      }

      if (!checkCloudflaredInstalled()) {
        stderr.write("Installing cloudflared...\n");
        installCloudflared();
        stderr.write("✓ cloudflared installed\n");
      }

      if (!checkCloudflaredAuth()) {
        stderr.write("Opening browser for Cloudflare login...\n");
        loginCloudflared();
        stderr.write("✓ Cloudflare authenticated\n");
      }

      const tunnelName = resolveTunnelName(options.name);
      const hostname = requestedHostname;
      const createdTunnel = createNamedTunnel(tunnelName);

      routeTunnelDns(createdTunnel.name, hostname);
      state.namedTunnel = {
        ...createdTunnel,
        hostname,
      };

      generateTunnelConfig(state);
      writeState(state);
      startNamedTunnel(state);
      stderr.write(`✓ Named tunnel ready at https://${hostname}\n`);
      stdout.write(`https://${hostname}\n`);
    });

  tunnelCommand
    .command("status")
    .description("Show named tunnel configuration and runtime status")
    .action(() => {
      const state = readState();
      const runningPid = state.namedTunnel ? resolveNamedTunnelPid(state) : undefined;
      stdout.write(`${formatTable(formatNamedTunnelStatusRows(state, runningPid))}\n`);
    });

  tunnelCommand
    .command("start")
    .description("Start the configured named Cloudflare tunnel when stopped")
    .action(() => {
      const state = readState();
      if (!state.namedTunnel) {
        throw new Error("Named tunnel is not configured — run `ts tunnel setup <hostname>` first");
      }

      const runningPid = resolveNamedTunnelPid(state);
      if (typeof runningPid === "number") {
        return;
      }

      startNamedTunnel(state);
    });

  tunnelCommand
    .command("stop")
    .description("Stop the configured named Cloudflare tunnel process")
    .action(async () => {
      const state = readState();
      if (!state.namedTunnel) {
        throw new Error("Named tunnel is not configured — run `ts tunnel setup <hostname>` first");
      }

      await stopConfiguredNamedTunnel(state);
    });

  tunnelCommand
    .command("remove")
    .description("Delete the configured named Cloudflare tunnel and clear state")
    .action(async () => {
      const state = readState();
      if (!state.namedTunnel) {
        return;
      }

      await removeNamedTunnel(state);
      writeState(state);
    });

  program
    .command("project")
    .description("Register a project or remove one by name")
    .argument("[targetPath]")
    .argument("[projectName]")
    .option("--name <name>", "Project route name")
    .option("--port <port>", "Project backend port")
    .option("--start <cmd>", "Project start command for boot recovery")
    .option("--json", "Output as JSON array")
    .action((targetPath: string | undefined, projectName: string | undefined, options: ProjectCommandOptions) => {
      if (targetPath === "rm") {
        if (typeof options.name === "string" || typeof options.port === "string" || typeof options.start === "string" || options.json === true) {
          throw new Error("Do not use --name, --port, or --start with project rm");
        }

        if (typeof projectName !== "string" || projectName.trim().length === 0) {
          throw new Error("Project name is required");
        }

        removeProjectByName(projectName);
        return;
      }

      if (targetPath === "list") {
        if (typeof options.name === "string" || typeof options.port === "string" || typeof options.start === "string") {
          throw new Error("Do not use --name, --port, or --start with project list");
        }

        if (typeof projectName === "string" && projectName.trim().length > 0) {
          throw new Error(`Unexpected argument: ${projectName}`);
        }

        const state = readState();
        const rows = Object.entries(state.projects)
          .flatMap(([projectKey, project]) => (isProjectRecord(project) ? [toProjectListRow(state, projectKey, project)] : []))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (options.json === true) {
          stdout.write(`${JSON.stringify(rows)}\n`);
          return;
        }

        const tableRows: string[][] = [
          ["Name", "Path", "Port", "URL", "Status", "StartCmd"],
          ...rows.map((project) => [
            project.name,
            project.path,
            project.port === null ? "-" : `${project.port}`,
            project.url,
            project.status,
            project.startCmd ?? "-",
          ]),
        ];

        stdout.write(`${formatTable(tableRows)}\n`);
        return;
      }

      if (typeof projectName === "string" && projectName.trim().length > 0) {
        throw new Error(`Unexpected argument: ${projectName}`);
      }

      if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
        throw new Error("Path is required");
      }

      const absolutePath = path.resolve(targetPath);
      let stats;
      try {
        stats = statSync(absolutePath);
      } catch {
        throw new Error(`Directory not found: ${targetPath}`);
      }

      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${targetPath}`);
      }

      const state = readState();
      ensureTailserveServerRunning({ state });
      const firstRouteSetup =
        Object.keys(state.shares).length === 0 && Object.keys(state.projects).length === 0
          ? ensureTailscaleServeForFirstShare(state)
          : {};

      const name = resolveProjectName(absolutePath, options.name);
      const port = typeof options.port === "string" ? parseProjectPort(options.port) : undefined;
      const startCmd = typeof options.start === "string" ? parseProjectStartCommand(options.start) : undefined;

      state.projects[name] = {
        name,
        path: absolutePath,
        port,
        startCmd,
        createdAt: new Date().toISOString(),
        status: "online",
      };
      writeState(state);

      if (firstRouteSetup.warning) {
        stderr.write(`${firstRouteSetup.warning}\n`);
      }
      stdout.write(`${toProjectUrl(state, name)}\n`);
    });

  program
    .command("list")
    .description("List shares")
    .option("--json", "Output as JSON array")
    .action((options: ListCommandOptions) => {
      const state = readState();
      reconcileStatePortWithRunningServer(state);
      const nowMs = Date.now();
      const shares = Object.values(state.shares).filter((share) => !isShareExpired(share, nowMs)).map((share) => toListShareRow(state, share, nowMs));
      const projects = Object.entries(state.projects).flatMap(([projectKey, project]) =>
        isProjectRecord(project) ? [toListProjectRow(state, projectKey, project)] : [],
      );
      const tunnels = Object.entries(state.tunnels).map(([tunnelId, tunnel]) => toListTunnelRow(tunnelId, tunnel));
      const rows = [...shares, ...projects, ...tunnels].sort((a, b) => a.id.localeCompare(b.id));

      if (options.json === true) {
        stdout.write(`${JSON.stringify(rows)}\n`);
        return;
      }

      const tableRows: string[][] = [
        ["ID", "Type", "Path", "URL", "Access", "Status", "Expires"],
        ...rows.map((share) => [share.id, share.type, share.path, share.url, share.access, share.status, share.expires]),
      ];

      stdout.write(`${formatTable(tableRows)}\n`);
    });

  program
    .command("stop")
    .description("Remove a share by id or remove all ephemeral shares")
    .argument("[id]")
    .option("--all", "Remove all ephemeral shares")
    .option("--tunnels", "Kill all cloudflared tunnels")
    .action((id: string | undefined, options: StopCommandOptions) => {
      if (options.all === true && options.tunnels === true) {
        throw new Error("Do not use --all with --tunnels");
      }

      if (options.tunnels === true) {
        if (typeof id === "string" && id.trim().length > 0) {
          throw new Error("Do not provide an id when using --tunnels");
        }
        removeAllTunnels();
        return;
      }

      if (options.all === true) {
        if (typeof id === "string" && id.trim().length > 0) {
          throw new Error("Do not provide a share id when using --all");
        }
        removeEphemeralShares();
        disableTailscaleServe(readState());
        return;
      }

      if (typeof id !== "string" || id.trim().length === 0) {
        throw new Error("Share id is required");
      }

      removeShareById(id);
      removeTunnelById(id);
    });

  program
    .command("doctor")
    .description("Run diagnostics and optional self-healing checks")
    .option("--fix", "Attempt to repair detected issues")
    .option("--verbose", "Show detailed check messages")
    .action((options: DoctorCommandOptions) => {
      const summary = runDoctor({
        fix: options.fix === true,
        verbose: options.verbose === true,
      });

      for (const check of summary.checks) {
        const prefix = check.ok ? "✓" : "✗";
        stdout.write(`${prefix} ${check.name}: ${check.message}\n`);
      }

      const issueCount = summary.failed + summary.fixed;
      const remainingCount = summary.failed;
      stdout.write(`${formatDoctorSummary(issueCount, summary.fixed, remainingCount)}\n`);

      if (remainingCount > 0) {
        throw new CommanderError(1, "doctor.unfixed", "Unfixed doctor issues remain");
      }
    });

  program
    .command("cleanup")
    .description("Remove stale tailscale serve routes")
    .option("--dry-run", "Show stale route cleanup without disabling routes")
    .action((options: CleanupCommandOptions) => {
      const state = readState();
      const dryRun = options.dryRun === true;
      const summary = cleanupStaleTailscaleServeRoutes({
        protectedPorts: state.protectedPorts,
        dryRun,
      });

      stdout.write(`${formatCleanupSummary(summary, dryRun)}\n`);
    });

  const serverCommand = program.command("server").description("Manage the tailserve server");

  serverCommand
    .command("stop")
    .description("Gracefully stop the tailserve server")
    .action(async () => {
      const state = readState();
      await stopTailserveServer();
      disableTailscaleServe(state);
      cleanupStaleTailscaleServeRoutes({
        protectedPorts: state.protectedPorts,
      });

      const statePath = getStatePath();
      if (existsSync(statePath)) {
        updateState((currentState) => {
          delete currentState.namedTunnelPid;
        });
      }
    });

  serverCommand
    .command("status")
    .description("Show the current tailserve server status")
    .action(() => {
      const state = readState();
      const nowMs = Date.now();
      const status = readTailserveServerStatus();
      reconcileStatePortWithRunningServer(state, status);
      const uptime = status.running ? formatUptime(status.uptimeMs ?? 0) : "-";
      const port = status.running && typeof status.port === "number" ? status.port : state.port;
      const rows = [
        ["Status", status.running ? "running" : "stopped"],
        ["Port", `${port}`],
        ["Active Shares", `${countActiveShares(state, nowMs)}`],
        ["Active Projects", `${countActiveProjects(state)}`],
        ["Uptime", uptime],
      ];

      stdout.write(`${formatTable(rows)}\n`);
    });

  serverCommand
    .command("install")
    .description("Install launchd autostart agent")
    .action(() => {
      installTailserveLaunchAgent();
    });

  serverCommand
    .command("uninstall")
    .description("Uninstall launchd autostart agent")
    .action(() => {
      uninstallTailserveLaunchAgent();
    });

  return program;
}

export async function run(
  argv: string[] = process.argv,
  stdout: OutputWriter = process.stdout,
  stderr: OutputWriter = process.stderr,
  runtime: CliRuntime = defaultCliRuntime,
): Promise<number> {
  const program = buildProgram(stdout, stderr, runtime);

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    stderr.write(`${message}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
