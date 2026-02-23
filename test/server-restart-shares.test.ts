import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import { resolveRequest } from "../src/server.js";
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

const originalHome = process.env.HOME;
const originalTailserveServerAutostart = process.env.TAILSERVE_SERVER_AUTOSTART;
const originalTailserveServerEntry = process.env.TAILSERVE_SERVER_ENTRY;

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

describe("server restart with active ephemeral shares", () => {
  it("restarts on next share and keeps recently-created ephemeral shares in state", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_SERVER_AUTOSTART = "1";

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const firstFilePath = path.join(workspace, "restart-active-1.html");
    const secondFilePath = path.join(workspace, "restart-active-2.html");
    const thirdFilePath = path.join(workspace, "restart-active-3.html");
    const fourthFilePath = path.join(workspace, "restart-active-4.html");
    writeFileSync(firstFilePath, "<h1>restart active 1</h1>\n", "utf8");
    writeFileSync(secondFilePath, "<h1>restart active 2</h1>\n", "utf8");
    writeFileSync(thirdFilePath, "<h1>restart active 3</h1>\n", "utf8");
    writeFileSync(fourthFilePath, "<h1>restart active 4</h1>\n", "utf8");

    const pidPath = getServerPidPath();
    const markerPath = path.join(workspace, "restart-active-pids.log");
    const entryPath = path.join(workspace, "tailserve-restart-active-entry.cjs");
    writeFileSync(
      entryPath,
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');\n" +
        "const path = require('node:path');\n" +
        `const pidPath = ${JSON.stringify(pidPath)};\n` +
        `const markerPath = ${JSON.stringify(markerPath)};\n` +
        "mkdirSync(path.dirname(pidPath), { recursive: true });\n" +
        "writeFileSync(pidPath, `${process.pid}\\n`, 'utf8');\n" +
        "appendFileSync(markerPath, `${process.pid}\\n`, 'utf8');\n" +
        "setInterval(() => {}, 1000);\n",
      "utf8",
    );
    process.env.TAILSERVE_SERVER_ENTRY = entryPath;

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

    const shareFileAndReturnId = async (targetPath: string): Promise<string> => {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "share", targetPath], stdout, stderr);
      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");
      const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(stdout.toString().trim());
      expect(match).not.toBeNull();
      return match?.[1] ?? "";
    };

    const startedPids: number[] = [];
    try {
      const firstShareId = await shareFileAndReturnId(firstFilePath);
      expect(await waitForFile(markerPath)).toBe(true);
      expect(await waitForFile(pidPath)).toBe(true);

      const initialPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      startedPids.push(initialPid);
      expect(Number.isInteger(initialPid)).toBe(true);
      expect(initialPid).toBeGreaterThan(0);

      const secondShareId = await shareFileAndReturnId(secondFilePath);
      const thirdShareId = await shareFileAndReturnId(thirdFilePath);

      const beforeRestartState = JSON.parse(readFileSync(statePath, "utf8")) as {
        shares: Record<string, { id: string; expiresAt: string | null; persist: boolean }>;
      };
      expect(Object.keys(beforeRestartState.shares).sort()).toEqual([firstShareId, secondShareId, thirdShareId].sort());

      process.kill(initialPid, "SIGKILL");
      const killed = await waitForPredicate(() => {
        try {
          process.kill(initialPid, 0);
          return false;
        } catch (error: unknown) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      });
      expect(killed).toBe(true);

      const fourthShareId = await shareFileAndReturnId(fourthFilePath);

      const restarted = await waitForPredicate(() => {
        if (!existsSync(pidPath)) {
          return false;
        }

        const rawPid = readFileSync(pidPath, "utf8").trim();
        if (!/^\d+$/.test(rawPid)) {
          return false;
        }

        const pid = Number.parseInt(rawPid, 10);
        if (pid <= 0 || pid === initialPid) {
          return false;
        }

        try {
          process.kill(pid, 0);
          startedPids.push(pid);
          return true;
        } catch {
          return false;
        }
      });
      expect(restarted).toBe(true);

      const resolved = resolveRequest({
        method: "GET",
        url: `/s/${fourthShareId}`,
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.filePath).toBe(path.resolve(fourthFilePath));

      const afterRestartState = JSON.parse(readFileSync(statePath, "utf8")) as {
        shares: Record<string, { id: string; expiresAt: string | null; persist: boolean }>;
      };
      expect(Object.keys(afterRestartState.shares).sort()).toEqual([firstShareId, secondShareId, thirdShareId, fourthShareId].sort());

      for (const shareId of [firstShareId, secondShareId, thirdShareId]) {
        const share = afterRestartState.shares[shareId];
        expect(share).toBeDefined();
        expect(share.persist).toBe(false);
        expect(share.expiresAt).not.toBeNull();
        expect(Date.parse(share.expiresAt ?? "")).toBeGreaterThan(Date.now());
      }
    } finally {
      await run(["node", "ts", "server", "stop"], new MemoryOutput(), new MemoryOutput());

      for (const pid of startedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }
  });
});
