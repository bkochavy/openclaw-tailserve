import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { ensureTailserveServerRunning, readTailserveServerStatus } from "./server-process.js";
import {
  createDefaultState,
  getServerPidPath,
  getStatePath,
  readState,
  type ShareRecord,
  writeState,
} from "./state.js";
import { cleanupStaleTailscaleServeRoutes } from "./tailscale.js";

const PORT_SCAN_MAX_ATTEMPTS = 20;
const PORT_CHECK_SLEEP_MS = 50;
const SERVER_VERIFY_TIMEOUT_MS = 2000;
const TAILSCALE_STANDALONE_MACOS_URL = "https://tailscale.com/kb/1065/macos-variants";
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export interface DoctorCheckResult {
  ok: boolean;
  message: string;
  fixed?: boolean;
}

export interface DoctorCheckSummary extends DoctorCheckResult {
  name: string;
}

export interface DoctorSummary {
  ok: boolean;
  checks: DoctorCheckSummary[];
  failed: number;
  fixed: number;
}

function sleepSync(milliseconds: number): void {
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

function isValidPid(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function parsePid(value: string): number | undefined {
  if (!isValidPid(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }

    if (code === "EPERM") {
      return true;
    }

    throw error;
  }
}

interface PortUsageLookup {
  inUse: boolean;
  lookupUnavailable: boolean;
}

function lookupPortUsage(port: number): PortUsageLookup {
  const result = spawnSync("lsof", ["-ti", `:${port}`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { inUse: false, lookupUnavailable: true };
    }

    return { inUse: false, lookupUnavailable: false };
  }

  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { inUse: false, lookupUnavailable: false };
  }

  return {
    inUse: result.stdout.trim().length > 0,
    lookupUnavailable: false,
  };
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function isSharePathValid(share: ShareRecord): boolean {
  if (typeof share.path !== "string" || share.path.length === 0) {
    return false;
  }

  let stats;
  try {
    stats = statSync(share.path);
  } catch {
    return false;
  }

  if (share.type === "file" || share.type === "edit") {
    return stats.isFile();
  }

  if (share.type === "dir") {
    return stats.isDirectory();
  }

  return false;
}

function getInvalidShareIds(state = readState()): string[] {
  const invalidIds: string[] = [];
  const nowMs = Date.now();

  for (const [shareId, share] of Object.entries(state.shares)) {
    if (share.expiresAt !== null) {
      const expiresAtMs = Date.parse(share.expiresAt);
      if (!Number.isNaN(expiresAtMs) && expiresAtMs <= nowMs) {
        invalidIds.push(shareId);
        continue;
      }
    }

    if (share.type === "proxy") {
      if (!isValidPort(share.port ?? -1)) {
        invalidIds.push(shareId);
      }
      continue;
    }

    if (!isSharePathValid(share)) {
      invalidIds.push(shareId);
    }
  }

  return invalidIds;
}

function toSummaryMessage(summary: { removed: number[]; protected: number[]; skipped: number[] }): string {
  const removed = summary.removed.length;
  const protectedCount = summary.protected.length;
  const skipped = summary.skipped.length;
  return `${removed} stale route${removed === 1 ? "" : "s"} (${protectedCount} protected, ${skipped} active)`;
}

function formatDoctorCommandOutput(output: unknown): string {
  if (typeof output !== "string") {
    return "";
  }

  return output.trim();
}

export function cleanStalePid(): boolean {
  const pidPath = getServerPidPath();
  if (!existsSync(pidPath)) {
    return false;
  }

  const pidRaw = readFileSync(pidPath, "utf8");
  const pid = parsePid(pidRaw);
  if (!pid) {
    rmSync(pidPath, { force: true });
    return true;
  }

  if (isPidRunning(pid)) {
    return false;
  }

  rmSync(pidPath, { force: true });
  return true;
}

export function cleanStaleTailscaleMapping(port: number): boolean {
  if (!isValidPort(port)) {
    return false;
  }

  if (isTailscaleDryRun(process.env)) {
    return true;
  }

  const tailscaleBinary = process.env.TAILSERVE_TAILSCALE_BIN || "tailscale";
  const result = spawnSync(tailscaleBinary, ["serve", `--https=${port}`, "off"], {
    stdio: "ignore",
  });

  return !(result.error || result.status !== 0);
}

export function findAvailablePort(startPort: number, maxAttempts: number): number | undefined {
  if (!isValidPort(startPort) || !Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    return undefined;
  }

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    if (!isValidPort(candidate)) {
      return undefined;
    }

    const usage = lookupPortUsage(candidate);
    if (usage.lookupUnavailable) {
      return undefined;
    }

    if (!usage.inUse) {
      return candidate;
    }
  }

  return undefined;
}

export function verifyServerStarted(port: number, timeoutMs: number): boolean {
  if (!isValidPort(port)) {
    return false;
  }

  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const deadline = Date.now() + effectiveTimeout;

  while (true) {
    const usage = lookupPortUsage(port);
    if (usage.lookupUnavailable) {
      return false;
    }

    if (usage.inUse) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    sleepSync(PORT_CHECK_SLEEP_MS);
  }
}

export function checkStalePid(fix: boolean): DoctorCheckResult {
  const pidPath = getServerPidPath();
  if (!existsSync(pidPath)) {
    return {
      ok: true,
      message: "PID file not present",
    };
  }

  const pidRaw = readFileSync(pidPath, "utf8");
  const pid = parsePid(pidRaw);
  if (!pid) {
    if (!fix) {
      return {
        ok: false,
        message: "PID file is invalid",
      };
    }

    const fixed = cleanStalePid();
    return {
      ok: fixed,
      message: fixed ? "Removed invalid PID file" : "Failed to clean PID file",
      fixed,
    };
  }

  if (isPidRunning(pid)) {
    return {
      ok: true,
      message: `PID ${pid} is running`,
    };
  }

  if (!fix) {
    return {
      ok: false,
      message: `PID file is stale (PID ${pid} not running)`,
    };
  }

  const fixed = cleanStalePid();
  return {
    ok: fixed,
    message: fixed ? `Removed stale PID ${pid}` : `Failed to remove stale PID ${pid}`,
    fixed,
  };
}

export function checkPortAvailability(port: number, fix: boolean): DoctorCheckResult {
  if (!isValidPort(port)) {
    return {
      ok: false,
      message: `Invalid port: ${port}`,
    };
  }

  const usage = lookupPortUsage(port);
  if (usage.lookupUnavailable) {
    return {
      ok: false,
      message: "Cannot verify port usage because `lsof` is unavailable",
    };
  }

  if (!usage.inUse) {
    return {
      ok: true,
      message: `Port ${port} is available`,
    };
  }

  const serverStatus = readTailserveServerStatus();
  if (serverStatus.running && serverStatus.port === port) {
    return {
      ok: true,
      message: `Port ${port} is in use by the running tailserve server`,
    };
  }

  if (!fix) {
    return {
      ok: false,
      message: `Port ${port} is already in use`,
    };
  }

  const availablePort = findAvailablePort(port + 1, PORT_SCAN_MAX_ATTEMPTS);
  if (availablePort === undefined) {
    return {
      ok: false,
      message: `Port ${port} is in use and no replacement was found`,
    };
  }

  const state = readState();
  state.port = availablePort;
  state.tsPort = availablePort;
  writeState(state);

  return {
    ok: true,
    message: `Moved from port ${port} to ${availablePort}`,
    fixed: true,
  };
}

export function checkTailscaleMappings(fix: boolean): DoctorCheckResult {
  const summary = cleanupStaleTailscaleServeRoutes({ dryRun: !fix });
  if (summary.removed.length === 0) {
    return {
      ok: true,
      message: "No stale tailscale serve mappings found",
    };
  }

  if (!fix) {
    return {
      ok: false,
      message: `Found ${toSummaryMessage(summary)}`,
    };
  }

  return {
    ok: true,
    message: `Removed ${toSummaryMessage(summary)}`,
    fixed: true,
  };
}

export function checkTailscaleServePermissions(): DoctorCheckResult {
  if (isTailscaleDryRun(process.env)) {
    return {
      ok: true,
      message: "tailscale serve permission check skipped in dry-run mode",
    };
  }

  const tailscaleBinary = process.env.TAILSERVE_TAILSCALE_BIN || "tailscale";
  const result = spawnSync(tailscaleBinary, ["serve", "status"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT") {
    return {
      ok: false,
      message: "tailscale CLI not found in PATH",
    };
  }

  if (result.error) {
    return {
      ok: false,
      message: `tailscale serve status failed: ${result.error.message}`,
    };
  }

  if (result.status === 0) {
    return {
      ok: true,
      message: "tailscale serve is accessible",
    };
  }

  const stdout = formatDoctorCommandOutput(result.stdout);
  const stderr = formatDoctorCommandOutput(result.stderr);
  const combinedOutput = `${stderr}\n${stdout}`.trim();
  const lowerOutput = combinedOutput.toLowerCase();
  const denied = lowerOutput.includes("denied") || lowerOutput.includes("permission");
  const appStoreHints = lowerOutput.includes("app store") || lowerOutput.includes("sandbox");

  if (denied || appStoreHints) {
    if (process.platform === "darwin" || appStoreHints) {
      return {
        ok: false,
        message:
          `tailscale serve permission denied. Tailscale App Store variant detected. ` +
          `Install Standalone Tailscale: ${TAILSCALE_STANDALONE_MACOS_URL}`,
      };
    }

    return {
      ok: false,
      message:
        "tailscale serve permission denied. On Linux run `sudo tailscale up --operator=$USER` " +
        `or on macOS install Standalone Tailscale: ${TAILSCALE_STANDALONE_MACOS_URL}`,
    };
  }

  const statusCode = typeof result.status === "number" ? result.status : "unknown";
  const detail = combinedOutput.length > 0 ? `: ${combinedOutput}` : "";
  return {
    ok: false,
    message: `tailscale serve status returned exit code ${statusCode}${detail}`,
  };
}

export function checkStateFile(fix: boolean): DoctorCheckResult {
  const statePath = getStatePath();
  if (!existsSync(statePath)) {
    if (!fix) {
      return {
        ok: false,
        message: "State file is missing",
      };
    }

    const state = createDefaultState();
    writeState(state);
    return {
      ok: true,
      message: "Created missing state file",
      fixed: true,
    };
  }

  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return {
        ok: true,
        message: "State file is valid JSON",
      };
    }
  } catch {
    // Invalid state file, handled below.
  }

  if (!fix) {
    return {
      ok: false,
      message: "State file is corrupted",
    };
  }

  const normalizedState = readState();
  writeState(normalizedState);
  return {
    ok: true,
    message: "Repaired corrupted state file",
    fixed: true,
  };
}

export function checkServerHealth(fix: boolean): DoctorCheckResult {
  const status = readTailserveServerStatus();
  const state = readState();
  const expectedPort = status.port ?? state.port;

  if (status.running && verifyServerStarted(expectedPort, PORT_CHECK_SLEEP_MS)) {
    return {
      ok: true,
      message: `Server is healthy on port ${expectedPort}`,
    };
  }

  if (!fix) {
    return {
      ok: false,
      message: status.running ? "Server process exists but health check failed" : "Server is not running",
    };
  }

  try {
    ensureTailserveServerRunning({
      state,
      env: {
        ...process.env,
        TAILSERVE_SERVER_AUTOSTART: "1",
      },
    });
  } catch (error: unknown) {
    return {
      ok: false,
      message: (error as Error).message,
    };
  }

  const refreshedStatus = readTailserveServerStatus();
  const refreshedPort = refreshedStatus.port ?? readState().port;
  const started = refreshedStatus.running && verifyServerStarted(refreshedPort, SERVER_VERIFY_TIMEOUT_MS);

  if (!started) {
    return {
      ok: false,
      message: "Server did not become healthy",
    };
  }

  return {
    ok: true,
    message: `Server is healthy on port ${refreshedPort}`,
    fixed: true,
  };
}

export function checkZombieProcesses(fix: boolean): DoctorCheckResult {
  const state = readState();
  const zombieTunnelIds = Object.entries(state.tunnels)
    .filter(([, tunnel]) => {
      if (!Number.isInteger(tunnel.pid) || tunnel.pid <= 0) {
        return true;
      }

      return !isPidRunning(tunnel.pid);
    })
    .map(([id]) => id);

  if (zombieTunnelIds.length === 0) {
    return {
      ok: true,
      message: "No zombie tunnel processes found",
    };
  }

  if (!fix) {
    return {
      ok: false,
      message: `Found ${zombieTunnelIds.length} zombie tunnel process${zombieTunnelIds.length === 1 ? "" : "es"}`,
    };
  }

  for (const tunnelId of zombieTunnelIds) {
    delete state.tunnels[tunnelId];
  }
  writeState(state);

  return {
    ok: true,
    message: `Removed ${zombieTunnelIds.length} zombie tunnel record${zombieTunnelIds.length === 1 ? "" : "s"}`,
    fixed: true,
  };
}

export function checkShareIntegrity(fix: boolean): DoctorCheckResult {
  const state = readState();
  const invalidShareIds = getInvalidShareIds(state);
  if (invalidShareIds.length === 0) {
    return {
      ok: true,
      message: "All shares are valid",
    };
  }

  if (!fix) {
    return {
      ok: false,
      message: `Found ${invalidShareIds.length} invalid share${invalidShareIds.length === 1 ? "" : "s"}`,
    };
  }

  for (const shareId of invalidShareIds) {
    delete state.shares[shareId];
  }
  writeState(state);

  return {
    ok: true,
    message: `Removed ${invalidShareIds.length} invalid share${invalidShareIds.length === 1 ? "" : "s"}`,
    fixed: true,
  };
}

export function runDoctor(options: { fix: boolean; verbose: boolean }): DoctorSummary {
  const checks: Array<{ name: string; run: () => DoctorCheckResult }> = [
    { name: "checkStalePid", run: () => checkStalePid(options.fix) },
    { name: "checkPortAvailability", run: () => checkPortAvailability(readState().port, options.fix) },
    { name: "checkTailscaleMappings", run: () => checkTailscaleMappings(options.fix) },
    { name: "checkTailscaleServePermissions", run: () => checkTailscaleServePermissions() },
    { name: "checkStateFile", run: () => checkStateFile(options.fix) },
    { name: "checkServerHealth", run: () => checkServerHealth(options.fix) },
    { name: "checkZombieProcesses", run: () => checkZombieProcesses(options.fix) },
    { name: "checkShareIntegrity", run: () => checkShareIntegrity(options.fix) },
  ];

  const results: DoctorCheckSummary[] = checks.map(({ name, run }) => {
    try {
      const result = run();
      return {
        name,
        ok: result.ok,
        message: options.verbose || !result.ok ? result.message : "ok",
        fixed: result.fixed,
      };
    } catch (error: unknown) {
      return {
        name,
        ok: false,
        message: (error as Error).message || "Unknown doctor check failure",
      };
    }
  });

  const failed = results.filter((result) => !result.ok).length;
  const fixed = results.filter((result) => result.fixed === true).length;

  return {
    ok: failed === 0,
    checks: results,
    failed,
    fixed,
  };
}
