import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const originalTailserveServerAutostart = process.env.TAILSERVE_SERVER_AUTOSTART;
const originalTailserveServerEntry = process.env.TAILSERVE_SERVER_ENTRY;

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

async function waitForPredicate(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  return predicate();
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
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalTailserveServerAutostart === undefined) {
    delete process.env.TAILSERVE_SERVER_AUTOSTART;
  } else {
    process.env.TAILSERVE_SERVER_AUTOSTART = originalTailserveServerAutostart;
  }

  if (originalTailserveServerEntry === undefined) {
    delete process.env.TAILSERVE_SERVER_ENTRY;
  } else {
    process.env.TAILSERVE_SERVER_ENTRY = originalTailserveServerEntry;
  }
});

describe("stale pid file handling", () => {
  it("reports stopped for server status when server.pid points to a dead process", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 9001,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const stalePid = chooseDeadPid();
    const pidPath = getServerPidPath();
    writeFileSync(pidPath, `${stalePid}\n`, "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "server", "status"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const rows = parseStatusRows(stdout.toString());
    expect(rows.Status).toBe("stopped");
    expect(existsSync(pidPath)).toBe(false);
  });

  it("auto-starts for share and replaces stale server.pid with a live PID", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_SERVER_AUTOSTART = "1";

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "stale-pid-share.html");
    writeFileSync(filePath, "<h1>stale pid share</h1>\n", "utf8");

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 48789,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const markerPath = path.join(workspace, "tailserve-server-stale-pid-started.flag");
    const markerLiteral = JSON.stringify(markerPath);
    const pidPath = getServerPidPath();
    const pidPathLiteral = JSON.stringify(pidPath);
    const entryPath = path.join(workspace, "tailserve-server-stale-pid-entry.cjs");
    writeFileSync(
      entryPath,
      "const { mkdirSync, writeFileSync } = require('node:fs');\n" +
        "const path = require('node:path');\n" +
        `const pidPath = ${pidPathLiteral};\n` +
        `const markerPath = ${markerLiteral};\n` +
        "mkdirSync(path.dirname(pidPath), { recursive: true });\n" +
        "writeFileSync(pidPath, `${process.pid}\\n`, 'utf8');\n" +
        "writeFileSync(markerPath, 'started\\n', 'utf8');\n" +
        "setInterval(() => {}, 1000);\n",
      "utf8",
    );
    process.env.TAILSERVE_SERVER_ENTRY = entryPath;

    const stalePid = chooseDeadPid();
    writeFileSync(pidPath, `${stalePid}\n`, "utf8");

    let startedPid: number | undefined;
    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");
      expect(stdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);
      expect(await waitForFile(markerPath)).toBe(true);

      const replacedPid = await waitForPredicate(() => {
        const pidRaw = readFileSync(pidPath, "utf8").trim();
        if (!/^\d+$/.test(pidRaw)) {
          return false;
        }

        const pid = Number.parseInt(pidRaw, 10);
        return pid > 0 && pid !== stalePid;
      });

      expect(replacedPid).toBe(true);

      startedPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      expect(Number.isInteger(startedPid)).toBe(true);
      expect(startedPid).toBeGreaterThan(0);
      expect(startedPid).not.toBe(stalePid);
      expect(() => {
        process.kill(startedPid as number, 0);
      }).not.toThrow();
    } finally {
      if (typeof startedPid === "number") {
        try {
          process.kill(startedPid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }
  });
});
