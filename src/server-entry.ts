import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { cleanStaleTailscaleMapping, findAvailablePort } from "./doctor.js";
import { buildPortInUseErrorMessage } from "./server-process.js";
import { createTailserveServer } from "./server.js";
import { getServerPidPath, readState, writeState } from "./state.js";
import { generateTunnelConfig, resolveNamedTunnelPid, startNamedTunnel, stopNamedTunnel } from "./tunnel.js";

const SHUTDOWN_TIMEOUT_MS = 5000;

function exitWithListenError(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function writeServerPid(): void {
  const pidPath = getServerPidPath();
  mkdirSync(path.dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
}

function removeServerPid(): void {
  rmSync(getServerPidPath(), { force: true });
}

export function startTailserveServer(): void {
  const state = readState();
  const server = createTailserveServer();
  const initialPort = state.port;
  let listenPort = initialPort;
  let shuttingDown = false;
  let attemptedStaleCleanupRetry = false;
  let attemptedFallbackPort = false;

  async function stopConfiguredNamedTunnelOnShutdown(): Promise<void> {
    const shutdownState = readState();
    if (!shutdownState.namedTunnel) {
      return;
    }

    const runningPid = resolveNamedTunnelPid(shutdownState);
    if (typeof runningPid !== "number") {
      return;
    }

    await stopNamedTunnel(runningPid);
  }

  function ensureConfiguredNamedTunnelStarted(): void {
    if (!state.namedTunnel) {
      return;
    }

    generateTunnelConfig(state);
    const runningPid = resolveNamedTunnelPid(state);
    if (typeof runningPid === "number") {
      return;
    }

    startNamedTunnel(state);
  }

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const forceExitTimer = setTimeout(() => {
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    void stopConfiguredNamedTunnelOnShutdown()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown named tunnel shutdown error";
        process.stderr.write(`Failed to stop named tunnel: ${message}\n`);
      })
      .finally(() => {
        server.close(() => {
          clearTimeout(forceExitTimer);
          process.exit(0);
        });
      });
  };

  server.once("listening", writeServerPid);
  server.once("close", removeServerPid);
  process.once("exit", removeServerPid);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const onListening = (): void => {
    server.off("error", onError);
    if (listenPort !== state.port || listenPort !== state.tsPort) {
      state.port = listenPort;
      state.tsPort = listenPort;
      writeState(state);
    }

    try {
      ensureConfiguredNamedTunnelStarted();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown named tunnel startup error";
      process.stderr.write(`Failed to start named tunnel: ${message}\n`);
    }
  };

  const onError = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EADDRINUSE") {
      if (!attemptedStaleCleanupRetry && listenPort === initialPort) {
        attemptedStaleCleanupRetry = true;
        const cleaned = cleanStaleTailscaleMapping(initialPort);
        if (cleaned) {
          server.listen(initialPort, "127.0.0.1");
          return;
        }
      }

      if (!attemptedFallbackPort) {
        attemptedFallbackPort = true;
        const availablePort = findAvailablePort(initialPort + 1, 10);
        if (typeof availablePort === "number") {
          listenPort = availablePort;
          server.listen(availablePort, "127.0.0.1");
          return;
        }
      }

      server.off("listening", onListening);
      exitWithListenError(buildPortInUseErrorMessage(initialPort));
      return;
    }

    server.off("listening", onListening);
    const message = error.message.trim().length > 0 ? error.message : "Unknown listen error";
    exitWithListenError(`Failed to start tailserve server: ${message}`);
  };

  server.once("listening", onListening);
  server.on("error", onError);
  server.listen(listenPort, "127.0.0.1");
}

startTailserveServer();
