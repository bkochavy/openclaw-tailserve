import * as childProcess from "node:child_process";

import { readState, type TailserveState } from "./state.js";

export interface TailscaleRuntime {
  readStatusJson: () => string | null;
  readServeStatus: () => string | null;
  isLocalPortInUse: (port: number) => boolean;
  runServeInBackground: (httpsPort: number, internalPort: number) => boolean;
  runServeOff: (httpsPort: number) => void;
  runFunnelInBackground: (httpsPort: number, internalPort: number) => boolean;
  runFunnelOff: (httpsPort: number) => void;
}

export interface CleanupStaleRoutesSummary {
  removed: number[];
  protected: number[];
  skipped: number[];
}

function buildTailscaleUnavailableWarning(port: number): string {
  return `Warning: tailscale unavailable, using http://localhost:${port}`;
}

function isTailscaleDryRun(env: NodeJS.ProcessEnv): boolean {
  const configured = env.TAILSERVE_TAILSCALE_DRY_RUN;
  if (typeof configured === "string") {
    const normalized = configured.trim().toLowerCase();
    return normalized !== "0" && normalized !== "false";
  }

  return env.VITEST === "1" || env.VITEST === "true" || env.NODE_ENV === "test";
}

function buildDefaultTailscaleRuntime(env: NodeJS.ProcessEnv): TailscaleRuntime {
  return {
    readStatusJson: () => {
      const tailscaleBinary = env.TAILSERVE_TAILSCALE_BIN || "tailscale";
      const result = childProcess.spawnSync(tailscaleBinary, ["status", "--json"], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });

      if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
        return null;
      }

      return result.stdout;
    },
    readServeStatus: () => {
      const tailscaleBinary = env.TAILSERVE_TAILSCALE_BIN || "tailscale";
      const result = childProcess.spawnSync(tailscaleBinary, ["serve", "status"], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });

      if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
        return null;
      }

      return result.stdout;
    },
    isLocalPortInUse: (port) => {
      const lookup = childProcess.spawnSync("lsof", ["-ti", `:${port}`], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });

      if (lookup.error) {
        const code = (lookup.error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return true;
        }

        return false;
      }

      if (lookup.status !== 0) {
        return false;
      }

      return typeof lookup.stdout === "string" && lookup.stdout.trim().length > 0;
    },
    runServeInBackground: (httpsPort, internalPort) => {
      const tailscaleBinary = env.TAILSERVE_TAILSCALE_BIN || "tailscale";
      const result = childProcess.spawnSync(
        tailscaleBinary,
        ["serve", "--bg", `--https=${httpsPort}`, `http://localhost:${internalPort}`],
        { stdio: "ignore" },
      );

      return !(result.error || result.status !== 0);
    },
    runServeOff: (httpsPort) => {
      const tailscaleBinary = env.TAILSERVE_TAILSCALE_BIN || "tailscale";
      const result = childProcess.spawnSync(tailscaleBinary, ["serve", `--https=${httpsPort}`, "off"], {
        stdio: "ignore",
      });

      if (result.error) {
        return;
      }
    },
    runFunnelInBackground: (httpsPort, internalPort) => {
      const tailscaleBinary = env.TAILSERVE_TAILSCALE_BIN || "tailscale";
      const result = childProcess.spawnSync(
        tailscaleBinary,
        ["funnel", "--bg", `--https=${httpsPort}`, `http://localhost:${internalPort}`],
        { stdio: "ignore" },
      );

      return !(result.error || result.status !== 0);
    },
    runFunnelOff: (httpsPort) => {
      const tailscaleBinary = env.TAILSERVE_TAILSCALE_BIN || "tailscale";
      const result = childProcess.spawnSync(tailscaleBinary, ["funnel", `--https=${httpsPort}`, "off"], {
        stdio: "ignore",
      });

      if (result.error) {
        return;
      }
    },
  };
}

function updateTailscaleHostnameFromStatus(state: TailserveState, runtime: TailscaleRuntime): void {
  const statusJson = runtime.readStatusJson();
  if (!statusJson) {
    return;
  }

  try {
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
    const dnsNameValue = parsed.Self?.DNSName;
    if (typeof dnsNameValue !== "string") {
      return;
    }

    const normalizedHostname = dnsNameValue.trim().replace(/\.$/, "");
    if (normalizedHostname.length === 0) {
      return;
    }

    state.tsHostname = normalizedHostname;
  } catch {
    return;
  }
}

interface ServeRoute {
  httpsPort: number;
  backendPort: number;
}

function parseServeRoutes(statusOutput: string): ServeRoute[] {
  const routes: ServeRoute[] = [];
  let currentHttpsPort = 443;

  for (const rawLine of statusOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const httpsMatch = /^https:\/\/[^\s/:]+(?::(\d+))?/.exec(line);
    if (httpsMatch) {
      const parsedHttpsPort = httpsMatch[1] ? Number.parseInt(httpsMatch[1], 10) : 443;
      if (Number.isInteger(parsedHttpsPort) && parsedHttpsPort > 0) {
        currentHttpsPort = parsedHttpsPort;
      }
    }

    const backendMatch = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(line);
    if (!backendMatch) {
      continue;
    }

    const backendPort = Number.parseInt(backendMatch[1], 10);
    if (!Number.isInteger(backendPort) || backendPort <= 0) {
      continue;
    }

    routes.push({
      httpsPort: currentHttpsPort,
      backendPort,
    });
  }

  return routes;
}

function sortPorts(ports: Iterable<number>): number[] {
  return [...new Set(ports)].sort((a, b) => a - b);
}

function hasActiveRoute(state: TailserveState): boolean {
  return Object.keys(state.shares).length > 0 || Object.keys(state.projects).length > 0;
}

function enableTailscaleServeRoute(
  state: TailserveState,
  options?: { env?: NodeJS.ProcessEnv; runtime?: TailscaleRuntime },
): { warning?: string } {
  const env = options?.env ?? process.env;
  if (isTailscaleDryRun(env)) {
    state.tsProtocol = "https";
    return {};
  }

  const runtime = options?.runtime ?? buildDefaultTailscaleRuntime(env);
  updateTailscaleHostnameFromStatus(state, runtime);
  if (runtime.runServeInBackground(state.tsPort, state.port)) {
    state.tsProtocol = "https";
    return {};
  }

  state.tsHostname = "localhost";
  state.tsPort = state.port;
  state.tsProtocol = "http";
  return {
    warning: buildTailscaleUnavailableWarning(state.port),
  };
}

export function enableTailscaleFunnelRoute(
  state: TailserveState,
  options?: { env?: NodeJS.ProcessEnv; runtime?: TailscaleRuntime },
): { warning?: string } {
  const env = options?.env ?? process.env;
  if (isTailscaleDryRun(env)) {
    state.tsProtocol = "https";
    return {};
  }

  const runtime = options?.runtime ?? buildDefaultTailscaleRuntime(env);
  updateTailscaleHostnameFromStatus(state, runtime);
  if (runtime.runFunnelInBackground(state.tsPort, state.port)) {
    state.tsProtocol = "https";
    return {};
  }

  state.tsHostname = "localhost";
  state.tsPort = state.port;
  state.tsProtocol = "http";
  return {
    warning: buildTailscaleUnavailableWarning(state.port),
  };
}

export function ensureTailscaleServeForFirstShare(
  state: TailserveState,
  options?: { env?: NodeJS.ProcessEnv; runtime?: TailscaleRuntime },
): { warning?: string } {
  if (Object.keys(state.shares).length > 0) {
    return {};
  }

  return enableTailscaleServeRoute(state, options);
}

export function ensureTailscaleServeForRestoredRoutes(
  state: TailserveState,
  options?: { env?: NodeJS.ProcessEnv; runtime?: TailscaleRuntime },
): { warning?: string } {
  if (!hasActiveRoute(state)) {
    return {};
  }

  return enableTailscaleServeRoute(state, options);
}

export function cleanupStaleTailscaleServeRoutes(options?: {
  env?: NodeJS.ProcessEnv;
  runtime?: TailscaleRuntime;
  dryRun?: boolean;
  protectedPorts?: ReadonlyArray<number>;
}): CleanupStaleRoutesSummary {
  const env = options?.env ?? process.env;
  const emptySummary: CleanupStaleRoutesSummary = {
    removed: [],
    protected: [],
    skipped: [],
  };

  if (isTailscaleDryRun(env)) {
    return emptySummary;
  }

  const runtime = options?.runtime ?? buildDefaultTailscaleRuntime(env);
  const serveStatus = runtime.readServeStatus();
  if (!serveStatus || serveStatus.trim().length === 0) {
    return emptySummary;
  }

  const routes = parseServeRoutes(serveStatus);
  const protectedPorts = new Set(options?.protectedPorts ?? readState(env).protectedPorts);
  const dryRun = options?.dryRun === true;
  const staleHttpsPorts = new Set<number>();
  const protectedHttpsPorts = new Set<number>();
  const skippedHttpsPorts = new Set<number>();
  for (const route of routes) {
    if (route.httpsPort === 443 || protectedPorts.has(route.backendPort)) {
      protectedHttpsPorts.add(route.httpsPort);
      continue;
    }

    if (runtime.isLocalPortInUse(route.backendPort)) {
      skippedHttpsPorts.add(route.httpsPort);
      continue;
    }

    staleHttpsPorts.add(route.httpsPort);
  }

  const removedHttpsPorts: number[] = [];
  for (const httpsPort of staleHttpsPorts) {
    if (protectedHttpsPorts.has(httpsPort) || skippedHttpsPorts.has(httpsPort)) {
      continue;
    }

    removedHttpsPorts.push(httpsPort);
    if (!dryRun) {
      runtime.runServeOff(httpsPort);
    }
  }

  return {
    removed: sortPorts(removedHttpsPorts),
    protected: sortPorts(protectedHttpsPorts),
    skipped: sortPorts(skippedHttpsPorts),
  };
}

export function disableTailscaleServe(
  state: TailserveState,
  options?: { env?: NodeJS.ProcessEnv; runtime?: TailscaleRuntime },
): void {
  const env = options?.env ?? process.env;
  if (isTailscaleDryRun(env)) {
    return;
  }

  const runtime = options?.runtime ?? buildDefaultTailscaleRuntime(env);
  runtime.runServeOff(state.tsPort);
}
