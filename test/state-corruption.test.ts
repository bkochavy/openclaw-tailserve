import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import { readState } from "../src/state.js";

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

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("state corruption handling", () => {
  it("falls back to default state when state.json contains invalid JSON", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{not valid json", "utf8");

    const state = readState();

    expect(state).toEqual({
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      tsProtocol: "https",
      protectedPorts: [18789],
      shares: {},
      projects: {},
      tunnels: {},
    });
  });

  it("falls back gracefully when required fields are missing", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: "bad-port",
        tsHostname: "",
        tsPort: "bad-port",
        shares: {
          badshare: {
            type: "file",
            path: "/tmp/file.txt",
            // missing createdAt, expiresAt, persist, readonly
          },
        },
        projects: null,
        tunnels: {
          badtunnel: {
            pid: "abc",
            url: "",
            port: "nope",
            createdAt: 123,
          },
        },
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.port).toBe(7899);
    expect(state.tsHostname).toBe("localhost");
    expect(state.tsPort).toBe(7899);
    expect(state.shares).toEqual({});
    expect(state.projects).toEqual({});
    expect(state.tunnels).toEqual({});
  });

  it("drops malformed share references with invalid path and port values", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {
          badpath1: {
            id: "badpath1",
            type: "file",
            path: "relative/path.txt",
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          badport1: {
            id: "badport1",
            type: "proxy",
            port: 70000,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
        },
        projects: {},
        tunnels: {},
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.shares).toEqual({});
  });

  it("does not crash ts list when the state file is corrupted", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{invalid", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "list"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const lines = stdout
      .toString()
      .trimEnd()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split(/\s{2,}/)).toEqual(["ID", "Type", "Path", "URL", "Access", "Status", "Expires"]);
  });

  it("allows ts share to recover by writing a valid state file", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{invalid", "utf8");

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "recover.html");
    writeFileSync(filePath, "<h1>recover</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);

    const parsedState = JSON.parse(readFileSync(statePath, "utf8")) as {
      shares: Record<string, { id: string; type: string; path?: string }>;
      projects: Record<string, unknown>;
      tunnels: Record<string, unknown>;
    };

    const shareRecords = Object.values(parsedState.shares);
    expect(shareRecords).toHaveLength(1);
    expect(shareRecords[0]?.type).toBe("file");
    expect(shareRecords[0]?.path).toBe(path.resolve(filePath));
    expect(parsedState.projects).toEqual({});
    expect(parsedState.tunnels).toEqual({});
  });
});
