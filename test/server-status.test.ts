import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import { getServerPidPath } from "../src/state.js";

class MemoryOutput {
  private readonly chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

function parseStatusRows(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trimEnd()
      .split("\n")
      .map((line) => {
        const parts = line.trimEnd().split(/\s{2,}/);
        const key = parts[0] ?? "";
        const value = parts.slice(1).join("  ");
        return [key, value];
      }),
  );
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 1500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for child process to exit"));
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForFile(filePath: string, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  return existsSync(filePath);
}

function writeStateFile(homeDir: string, state: Record<string, unknown>): void {
  const statePath = path.join(homeDir, ".tailserve", "state.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe("ts server status", () => {
  it("shows stopped state with active share and project counts", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const now = Date.now();
    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {
        active01: {
          id: "active01",
          type: "file",
          path: "/tmp/active.txt",
          createdAt: new Date(now - 60_000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          persist: false,
          readonly: false,
        },
        persist1: {
          id: "persist1",
          type: "file",
          path: "/tmp/persist.txt",
          createdAt: new Date(now - 60_000).toISOString(),
          expiresAt: null,
          persist: true,
          readonly: false,
        },
        expired1: {
          id: "expired1",
          type: "file",
          path: "/tmp/expired.txt",
          createdAt: new Date(now - 120_000).toISOString(),
          expiresAt: new Date(now - 30_000).toISOString(),
          persist: false,
          readonly: false,
        },
      },
      projects: {
        alpha: { name: "alpha", path: "/tmp/alpha" },
        beta: { name: "beta", path: "/tmp/beta" },
        invalid: "skip me",
      },
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "server", "status"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const rows = parseStatusRows(stdout.toString());
    expect(rows.Status).toBe("stopped");
    expect(rows.Port).toBe("7899");
    expect(rows["Active Shares"]).toBe("2");
    expect(rows["Active Projects"]).toBe("2");
    expect(rows.Uptime).toBe("-");
  });

  it("shows running state and uptime when PID-tracked server process exists", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 9001,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
    });

    const readyPath = path.join(homeDir, "status-ready");
    const child: ChildProcess = spawn(
      process.execPath,
      [
        "-e",
        "const { writeFileSync } = require('node:fs');" +
          "writeFileSync(process.env.TAILSERVE_TEST_READY, 'ready\\n', 'utf8');" +
          "setInterval(() => {}, 1000);",
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          TAILSERVE_TEST_READY: readyPath,
        },
      },
    );

    if (typeof child.pid !== "number") {
      throw new Error("Failed to spawn test process");
    }

    expect(await waitForFile(readyPath)).toBe(true);

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${child.pid}\n`, "utf8");

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "server", "status"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const rows = parseStatusRows(stdout.toString());
      expect(rows.Status).toBe("running");
      expect(rows.Port).toBe("9001");
      expect(rows["Active Shares"]).toBe("0");
      expect(rows["Active Projects"]).toBe("0");
      expect(rows.Uptime).toMatch(/^[0-9]+[smhd](?: [0-9]+[smhd])*$/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("treats a stale PID file as stopped and removes it", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 9001,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
    });

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });

    if (typeof child.pid !== "number") {
      throw new Error("Failed to spawn test process");
    }

    child.kill("SIGKILL");
    await waitForChildExit(child);

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${child.pid}\n`, "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "server", "status"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(existsSync(pidPath)).toBe(false);

    const rows = parseStatusRows(stdout.toString());
    expect(rows.Status).toBe("stopped");
  });

  it("treats an invalid PID file as stopped and removes it", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 9001,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
    });

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, "not-a-pid\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "server", "status"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(existsSync(pidPath)).toBe(false);

    const rows = parseStatusRows(stdout.toString());
    expect(rows.Status).toBe("stopped");
  });

  it("shows the live listening port when state.json has a stale port", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const actualPort = 7900;
    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 7899,
      shares: {},
      projects: {},
    });

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (typeof child.pid !== "number") {
      throw new Error("Failed to spawn test process");
    }

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakeLsofPath = path.join(fakeBinDir, "lsof");
    writeFileSync(
      fakeLsofPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"-Pan\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = \"$TAILSERVE_TEST_PID\" ]; then\n" +
        "  echo 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'\n" +
        "  echo \"node $3 user 20u IPv6 0x0 0t0 TCP *:$TAILSERVE_TEST_PORT (LISTEN)\"\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeLsofPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_TEST_PID = `${child.pid}`;
    process.env.TAILSERVE_TEST_PORT = `${actualPort}`;

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${child.pid}\n`, "utf8");

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "server", "status"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const rows = parseStatusRows(stdout.toString());
      expect(rows.Status).toBe("running");
      expect(rows.Port).toBe(`${actualPort}`);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        port: number;
        tsPort: number;
      };
      expect(state.port).toBe(actualPort);
      expect(state.tsPort).toBe(actualPort);
    } finally {
      delete process.env.TAILSERVE_TEST_PID;
      delete process.env.TAILSERVE_TEST_PORT;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
