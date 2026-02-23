import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { readState, writeState } from "../src/state.js";

const originalHome = process.env.HOME;
const originalTailservePort = process.env.TAILSERVE_PORT;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalTailservePort === undefined) {
    delete process.env.TAILSERVE_PORT;
  } else {
    process.env.TAILSERVE_PORT = originalTailservePort;
  }
});

describe("state port configuration", () => {
  it("uses TAILSERVE_PORT when state file does not exist", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_PORT = "46789";

    const state = readState();

    expect(state.port).toBe(46789);
    expect(state.tsPort).toBe(46789);
  });

  it("overrides persisted ports with TAILSERVE_PORT", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_PORT = "45678";

    const stateDir = path.join(homeDir, ".tailserve");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        tsProtocol: "https",
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.port).toBe(45678);
    expect(state.tsPort).toBe(45678);
    expect(state.tsHostname).toBe("demo.tailnet.ts.net");
  });

  it("ignores invalid TAILSERVE_PORT values", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_PORT = "invalid";

    const stateDir = path.join(homeDir, ".tailserve");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.port).toBe(7899);
    expect(state.tsPort).toBe(8443);
  });
});

describe("state public flags", () => {
  it("preserves public on share and project records", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stateDir = path.join(homeDir, ".tailserve");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 7899,
        tsProtocol: "https",
        protectedPorts: [18789],
        shares: {
          share0001: {
            id: "share0001",
            type: "file",
            path: "/tmp/public.txt",
            createdAt: "2026-02-17T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
            public: true,
          },
        },
        projects: {
          reelfit: {
            name: "reelfit",
            path: "/tmp/reelfit",
            status: "online",
            public: false,
          },
        },
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.shares.share0001.public).toBe(true);
    expect(state.projects.reelfit.public).toBe(false);
  });
});

describe("state tunnels", () => {
  it("defaults tunnels to an empty record when not persisted", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const state = readState();

    expect(state.tunnels).toEqual({});
  });

  it("preserves persisted tunnel records", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stateDir = path.join(homeDir, ".tailserve");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 7899,
        tsProtocol: "https",
        protectedPorts: [18789],
        shares: {},
        projects: {},
        tunnels: {
          tunnel001: {
            pid: 4321,
            url: "https://bright-sky.trycloudflare.com",
            port: 7899,
            createdAt: "2026-02-17T00:00:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.tunnels.tunnel001).toEqual({
      pid: 4321,
      url: "https://bright-sky.trycloudflare.com",
      port: 7899,
      createdAt: "2026-02-17T00:00:00.000Z",
    });
  });
});

describe("state named tunnel configuration", () => {
  it("defaults namedTunnel to undefined when not persisted", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const state = readState();

    expect(state.namedTunnel).toBeUndefined();
  });

  it("preserves valid persisted namedTunnel config", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stateDir = path.join(homeDir, ".tailserve");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 7899,
        tsProtocol: "https",
        protectedPorts: [18789],
        shares: {},
        projects: {},
        tunnels: {},
        namedTunnel: {
          name: "tailserve-main",
          uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          hostname: "tailserve.example.com",
          credentialsPath: "/home/user/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
        },
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.namedTunnel).toEqual({
      name: "tailserve-main",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      hostname: "tailserve.example.com",
      credentialsPath: "/home/user/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
    });
  });

  it("ignores invalid persisted namedTunnel config", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stateDir = path.join(homeDir, ".tailserve");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 7899,
        tsProtocol: "https",
        protectedPorts: [18789],
        shares: {},
        projects: {},
        tunnels: {},
        namedTunnel: {
          name: "tailserve-main",
          uuid: "",
          hostname: "tailserve.example.com",
          credentialsPath: "/home/user/.cloudflared/id.json",
        },
      })}\n`,
      "utf8",
    );

    const state = readState();

    expect(state.namedTunnel).toBeUndefined();
  });

  it("does not persist namedTunnelPid runtime field", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const state = readState();
    state.namedTunnel = {
      name: "tailserve-main",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      hostname: "tailserve.example.com",
      credentialsPath: "/home/user/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
    };
    state.namedTunnelPid = 43210;
    writeState(state);

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as { namedTunnelPid?: unknown };
    expect(raw.namedTunnelPid).toBeUndefined();

    const rereadState = readState();
    expect(rereadState.namedTunnel).toEqual(state.namedTunnel);
    expect(rereadState.namedTunnelPid).toBeUndefined();
  });
});

describe("state write locking", () => {
  it("waits for concurrent lock release and then writes state", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    const lockPath = `${statePath}.lock`;
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(lockPath, "busy\n", "utf8");

    const releaseWorker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { unlinkSync } = require("node:fs");
      setTimeout(() => {
        try {
          unlinkSync(workerData.lockPath);
        } catch {}
        parentPort?.postMessage("released");
      }, workerData.delayMs);
    `,
      {
        eval: true,
        workerData: {
          lockPath,
          delayMs: 150,
        },
      },
    );

    const state = readState();
    state.tsHostname = "released.tailnet.ts.net";
    writeState(state);
    await new Promise<void>((resolve) => {
      releaseWorker.once("exit", () => {
        resolve();
      });
    });

    expect(readState().tsHostname).toBe("released.tailnet.ts.net");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes stale lock files before writing", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    const lockPath = `${statePath}.lock`;
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(lockPath, "stale\n", "utf8");

    const staleDate = new Date(Date.now() - 11_000);
    utimesSync(lockPath, staleDate, staleDate);

    const state = readState();
    state.tsHostname = "stale-replaced.tailnet.ts.net";
    writeState(state);

    expect(readState().tsHostname).toBe("stale-replaced.tailnet.ts.net");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  });

  it("fails after retry budget when lock remains active", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    const lockPath = `${statePath}.lock`;
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(lockPath, "active\n", "utf8");

    const state = readState();
    state.tsHostname = "blocked.tailnet.ts.net";

    const startedAt = Date.now();
    expect(() => {
      writeState(state);
    }).toThrow(`Failed to acquire state lock: ${lockPath}`);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
  });
});
