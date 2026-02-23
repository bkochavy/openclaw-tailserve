import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";

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

function writeState(homeDir: string, state: Record<string, unknown>): void {
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
});

describe("ts status", () => {
  it("opens the dashboard URL in the default browser", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    writeState(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 8443,
      tsProtocol: "https",
      shares: {},
      projects: {},
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const openUrl = vi.fn<(url: string) => void>();
    const exitCode = await run(["node", "ts", "status"], stdout, stderr, { openUrl });

    expect(exitCode).toBe(0);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://demo.tailnet.ts.net:8443/");
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");
  });

  it("prints the dashboard URL with --json without opening the browser", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    writeState(homeDir, {
      port: 9001,
      tsHostname: "ignored.tailnet.ts.net",
      tsPort: 443,
      tsProtocol: "http",
      shares: {},
      projects: {},
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const openUrl = vi.fn<(url: string) => void>();
    const exitCode = await run(["node", "ts", "status", "--json"], stdout, stderr, { openUrl });

    expect(exitCode).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();
    expect(stdout.toString()).toBe("http://localhost:9001/\n");
    expect(stderr.toString()).toBe("");
  });
});
