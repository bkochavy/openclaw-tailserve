import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureTailserveServerRunning, type TailserveServerRuntime } from "../src/server-process.js";
import { createDefaultState, getServerPidPath } from "../src/state.js";

const originalHome = process.env.HOME;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function chooseDeadPid(): number {
  const candidates = [999_999, 888_888, 777_777, 666_666];
  for (const candidate of candidates) {
    try {
      process.kill(candidate, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return candidate;
      }
    }
  }

  return 999_999;
}

afterEach(() => {
  restoreEnvVar("HOME", originalHome);
});

describe("server startup self-healing", () => {
  it("cleans a stale PID file and starts successfully", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stalePid = chooseDeadPid();
    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${stalePid}\n`, "utf8");

    const isPortInUse = vi.fn(() => false);
    isPortInUse.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const runtime: TailserveServerRuntime = {
      fileExists: () => true,
      isPortInUse,
      spawnServer: vi.fn(),
    };

    const state = createDefaultState();
    const started = ensureTailserveServerRunning({
      state,
      env: { TAILSERVE_SERVER_AUTOSTART: "1" },
      moduleDir: homeDir,
      runtime,
      verifyTimeoutMs: 0,
    });

    expect(started).toBe(true);
    expect(runtime.spawnServer).toHaveBeenCalledTimes(1);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("retries startup when spawn verification fails and recovers on second attempt", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const isPortInUse = vi.fn(() => false);
    isPortInUse.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);

    const cleanStalePortMapping = vi.fn(() => true);
    const runtime: TailserveServerRuntime = {
      fileExists: () => true,
      isPortInUse,
      spawnServer: vi.fn(),
      cleanStalePortMapping,
      cleanStalePidFile: vi.fn(() => false),
    };

    const state = createDefaultState();
    const started = ensureTailserveServerRunning({
      state,
      env: { TAILSERVE_SERVER_AUTOSTART: "1" },
      moduleDir: homeDir,
      runtime,
      verifyTimeoutMs: 0,
    });

    expect(started).toBe(true);
    expect(runtime.spawnServer).toHaveBeenCalledTimes(2);
    expect(cleanStalePortMapping).toHaveBeenCalledTimes(1);
    expect(cleanStalePortMapping).toHaveBeenCalledWith(state.port);
  });
});
