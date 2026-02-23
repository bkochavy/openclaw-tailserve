import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

interface SpawnedCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function writeStateFile(homeDir: string, state: Record<string, unknown>): void {
  const statePath = path.join(homeDir, ".tailserve", "state.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
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

function runBinTs(args: string[], homeDir: string, timeoutMs = 1500): Promise<SpawnedCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "bin", "ts"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill failures; process may already have exited.
      }

      settle(() => {
        reject(new Error(`Timed out waiting for ts ${args.join(" ")}`));
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });

    child.once("close", (code) => {
      settle(() => {
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
        });
      });
    });
  });
}

const originalHome = process.env.HOME;
const originalTailscaleDryRun = process.env.TAILSERVE_TAILSCALE_DRY_RUN;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalTailscaleDryRun === undefined) {
    delete process.env.TAILSERVE_TAILSCALE_DRY_RUN;
  } else {
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = originalTailscaleDryRun;
  }
});

describe("ts stop with already-stopped server", () => {
  it("removes the requested share from state and exits cleanly", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const keepPath = path.join(workspace, "keep.txt");
    const stopPath = path.join(workspace, "stop.txt");
    const timestamp = "2026-02-16T00:00:00.000Z";

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {
        keep0001: {
          id: "keep0001",
          type: "file",
          path: keepPath,
          createdAt: timestamp,
          expiresAt: null,
          persist: true,
          readonly: false,
        },
        stop0001: {
          id: "stop0001",
          type: "file",
          path: stopPath,
          createdAt: timestamp,
          expiresAt: null,
          persist: true,
          readonly: false,
        },
      },
      projects: {},
      tunnels: {},
    });

    const stalePid = chooseDeadPid();
    const pidPath = path.join(homeDir, ".tailserve", "server.pid");
    writeFileSync(pidPath, `${stalePid}\n`, "utf8");

    const result = await runBinTs(["stop", "stop0001"], homeDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { id: string; path: string }>;
    };

    expect(state.shares.stop0001).toBeUndefined();
    expect(state.shares.keep0001).toMatchObject({
      id: "keep0001",
      path: keepPath,
    });
  });

  it("supports stop --all with no pid file and keeps persistent data", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "1";

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const keepPath = path.join(workspace, "keep.txt");
    const ephPath = path.join(workspace, "ephemeral.txt");
    const timestamp = "2026-02-16T00:00:00.000Z";

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {
        keep0001: {
          id: "keep0001",
          type: "file",
          path: keepPath,
          createdAt: timestamp,
          expiresAt: null,
          persist: true,
          readonly: false,
        },
        epha0001: {
          id: "epha0001",
          type: "file",
          path: ephPath,
          createdAt: timestamp,
          expiresAt: timestamp,
          persist: false,
          readonly: false,
        },
      },
      projects: {
        reelfit: {
          name: "reelfit",
          path: "/tmp/reelfit",
          status: "online",
        },
      },
      tunnels: {},
    });

    const pidPath = path.join(homeDir, ".tailserve", "server.pid");
    expect(existsSync(pidPath)).toBe(false);

    const result = await runBinTs(["stop", "--all"], homeDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { id: string; path?: string; persist: boolean }>;
      projects: Record<string, { name: string; path: string; status: string }>;
    };

    expect(Object.keys(state.shares)).toEqual(["keep0001"]);
    expect(state.shares.keep0001).toMatchObject({
      id: "keep0001",
      path: keepPath,
      persist: true,
    });
    expect(state.projects).toEqual({
      reelfit: {
        name: "reelfit",
        path: "/tmp/reelfit",
        status: "online",
      },
    });
  });
});
