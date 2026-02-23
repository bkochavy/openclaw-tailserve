import { type SpawnSyncReturns } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TailserveState } from "../src/state.js";
import {
  checkCloudflaredAuth,
  checkCloudflaredInstalled,
  createNamedTunnel,
  generateTunnelConfig,
  isNamedTunnelRunning,
  killTunnelProcess,
  loginCloudflared,
  removeNamedTunnel,
  resolveNamedTunnelPid,
  routeTunnelDns,
  spawnCloudflaredTunnel,
  startNamedTunnel,
  stopConfiguredNamedTunnel,
  stopNamedTunnel,
  type TunnelRuntime,
} from "../src/tunnel.js";

type MockChildProcess = EventEmitter & {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  unref: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(pid = 4242): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = vi.fn();
  return child;
}

function createSyncResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

function createRuntime(overrides: Partial<TunnelRuntime> = {}): TunnelRuntime {
  return {
    spawnProcess: vi.fn(() => createMockChildProcess()),
    killProcess: vi.fn(),
    runSyncProcess: vi.fn(() => createSyncResult()),
    fileExists: vi.fn(() => true),
    makeDirectory: vi.fn(),
    writeFile: vi.fn(),
    resolveHomeDirectory: vi.fn(() => "/home/tester"),
    now: vi.fn(() => Date.now()),
    wait: vi.fn(async () => {}),
    ...overrides,
  };
}

function createState(overrides: Partial<TailserveState> = {}): TailserveState {
  return {
    port: 7899,
    tsHostname: "demo.tailnet.ts.net",
    tsPort: 7899,
    tsProtocol: "https",
    protectedPorts: [18789],
    shares: {},
    projects: {},
    tunnels: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("spawnCloudflaredTunnel", () => {
  it("spawns cloudflared and resolves with pid + trycloudflare URL from stdout", async () => {
    const child = createMockChildProcess(1234);
    const spawnProcess = vi.fn(() => child);
    const runtime = createRuntime({ spawnProcess });

    const tunnelPromise = spawnCloudflaredTunnel(7899, { runtime });
    child.stdout.emit("data", "INF +----------------------------------------------------------------\n");
    child.stdout.emit("data", "INF |  https://gentle-waterfall.trycloudflare.com                |\n");

    await expect(tunnelPromise).resolves.toEqual({
      pid: 1234,
      url: "https://gentle-waterfall.trycloudflare.com",
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://localhost:7899"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("parses the trycloudflare URL from stderr", async () => {
    const child = createMockChildProcess(5678);
    const runtime = createRuntime({
      spawnProcess: vi.fn(() => child),
    });

    const tunnelPromise = spawnCloudflaredTunnel(3000, { runtime });
    child.stderr.emit("data", Buffer.from("Visit https://quiet-meadow.trycloudflare.com to test"));

    await expect(tunnelPromise).resolves.toEqual({
      pid: 5678,
      url: "https://quiet-meadow.trycloudflare.com",
    });
  });

  it("throws a clear install message when cloudflared is not found", async () => {
    const child = createMockChildProcess();
    const runtime = createRuntime({
      spawnProcess: vi.fn(() => child),
    });

    const tunnelPromise = spawnCloudflaredTunnel(7899, { runtime });
    child.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }));

    await expect(tunnelPromise).rejects.toThrow("cloudflared not installed — run: brew install cloudflared");
  });

  it("times out after 15 seconds if no URL is emitted", async () => {
    vi.useFakeTimers();

    const child = createMockChildProcess(9999);
    const killProcess = vi.fn();
    const runtime = createRuntime({
      spawnProcess: vi.fn(() => child),
      killProcess,
    });

    const tunnelPromise = spawnCloudflaredTunnel(7899, { runtime });
    const rejection = expect(tunnelPromise).rejects.toThrow("Timed out waiting for cloudflared tunnel URL");
    await vi.advanceTimersByTimeAsync(15_001);

    await rejection;
    expect(killProcess).toHaveBeenCalledWith(9999);
  });
});

describe("cloudflared named tunnel lifecycle", () => {
  it("runs `cloudflared tunnel login` with inherited terminal IO", () => {
    const runSyncProcess = vi.fn(() => createSyncResult());
    const fileExists = vi.fn((targetPath: string) => targetPath === "/home/tester/.cloudflared/cert.pem");
    const runtime = createRuntime({ runSyncProcess, fileExists });

    loginCloudflared({ runtime });

    expect(runSyncProcess).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "login"],
      {
        stdio: ["inherit", "inherit", "inherit"],
        encoding: "utf8",
      },
    );
    expect(fileExists).toHaveBeenCalledWith("/home/tester/.cloudflared/cert.pem");
  });

  it("fails login when cloudflared exits non-zero", () => {
    const runtime = createRuntime({
      runSyncProcess: vi.fn(() => createSyncResult({ status: 1, stderr: "login failed" })),
    });

    expect(() => loginCloudflared({ runtime })).toThrow("Cloudflare login failed");
  });

  it("fails login when cert.pem is still missing after successful command", () => {
    const runtime = createRuntime({
      runSyncProcess: vi.fn(() => createSyncResult()),
      fileExists: vi.fn(() => false),
    });

    expect(() => loginCloudflared({ runtime })).toThrow(
      "Cloudflare login completed but cert.pem was not found — auth may have failed",
    );
  });

  it("checks whether cloudflared is installed", () => {
    const runSyncProcess = vi.fn(() => createSyncResult({ stdout: "/usr/local/bin/cloudflared\n" }));
    const runtime = createRuntime({ runSyncProcess });

    expect(checkCloudflaredInstalled({ runtime })).toBe("/usr/local/bin/cloudflared");
    expect(runSyncProcess).toHaveBeenCalledWith(
      "which",
      ["cloudflared"],
      expect.objectContaining({
        encoding: "utf8",
      }),
    );
  });

  it("returns null when cloudflared is not installed", () => {
    const runtime = createRuntime({
      runSyncProcess: vi.fn(() => createSyncResult({ status: 1 })),
    });

    expect(checkCloudflaredInstalled({ runtime })).toBeNull();
  });

  it("checks cloudflared auth certificate path", () => {
    const fileExists = vi.fn((targetPath: string) => targetPath === "/home/tester/.cloudflared/cert.pem");
    const runtime = createRuntime({ fileExists });

    expect(checkCloudflaredAuth({ runtime })).toBe(true);
    expect(fileExists).toHaveBeenCalledWith("/home/tester/.cloudflared/cert.pem");
  });

  it("creates a named tunnel and parses uuid + credentials path", () => {
    const runSyncProcess = vi
      .fn()
      .mockReturnValueOnce(createSyncResult({ stdout: "/usr/local/bin/cloudflared\n" }))
      .mockReturnValueOnce(
        createSyncResult({
          stdout:
            "Tunnel credentials written to /home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json\n",
          stderr: "Created tunnel tailserve-main with id f47ac10b-58cc-4372-a567-0e02b2c3d479\n",
        }),
      );
    const runtime = createRuntime({ runSyncProcess });

    expect(createNamedTunnel("tailserve-main", { runtime })).toEqual({
      name: "tailserve-main",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
    });
  });

  it("falls back to ~/.cloudflared/<uuid>.json when credentials path is missing from output", () => {
    const runSyncProcess = vi
      .fn()
      .mockReturnValueOnce(createSyncResult({ stdout: "/usr/local/bin/cloudflared\n" }))
      .mockReturnValueOnce(
        createSyncResult({
          stderr: "Created tunnel tunnel-a with id f47ac10b-58cc-4372-a567-0e02b2c3d479\n",
        }),
      );
    const runtime = createRuntime({ runSyncProcess });

    expect(createNamedTunnel("tunnel-a", { runtime })).toEqual({
      name: "tunnel-a",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
    });
  });

  it("throws a clear error when cloudflared is unavailable for named tunnel creation", () => {
    const runtime = createRuntime({
      runSyncProcess: vi.fn(() => createSyncResult({ status: 1 })),
    });

    expect(() => createNamedTunnel("tailserve-main", { runtime })).toThrow("cloudflared not installed");
  });

  it("routes tunnel dns with cloudflared command", () => {
    const runSyncProcess = vi
      .fn()
      .mockReturnValueOnce(createSyncResult({ stdout: "/usr/local/bin/cloudflared\n" }))
      .mockReturnValueOnce(createSyncResult());
    const runtime = createRuntime({ runSyncProcess });

    routeTunnelDns("tailserve-main", "tailserve.example.com", { runtime });

    expect(runSyncProcess).toHaveBeenNthCalledWith(
      2,
      "cloudflared",
      ["tunnel", "route", "dns", "tailserve-main", "tailserve.example.com"],
      expect.objectContaining({
        encoding: "utf8",
      }),
    );
  });

  it("generates tunnel config with hostname ingress and 404 catch-all", () => {
    const makeDirectory = vi.fn();
    const writeFile = vi.fn();
    const runtime = createRuntime({
      makeDirectory,
      writeFile,
    });
    const state = createState({
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    const configPath = generateTunnelConfig(state, { runtime });

    expect(configPath).toBe("/home/tester/.tailserve/cloudflared-config.yml");
    expect(makeDirectory).toHaveBeenCalledWith("/home/tester/.tailserve");
    expect(writeFile).toHaveBeenCalledWith(
      "/home/tester/.tailserve/cloudflared-config.yml",
      [
        "tunnel: f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "credentials-file: /home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
        "",
        "ingress:",
        "  - hostname: tailserve.example.com",
        "    service: http://127.0.0.1:7899",
        "  - service: http_status:404",
        "",
      ].join("\n"),
    );
  });

  it("starts a named tunnel with generated config and returns pid", () => {
    const child = createMockChildProcess(2468);
    const runSyncProcess = vi.fn(() => createSyncResult({ stdout: "/usr/local/bin/cloudflared\n" }));
    const spawnProcess = vi.fn(() => child);
    const runtime = createRuntime({
      runSyncProcess,
      spawnProcess,
    });
    const state = createState({
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    const pid = startNamedTunnel(state, { runtime });

    expect(pid).toBe(2468);
    expect(state.namedTunnelPid).toBe(2468);
    expect(spawnProcess).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--config", "/home/tester/.tailserve/cloudflared-config.yml", "run", "tailserve-main"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("checks if a named tunnel pid is running", () => {
    const killProcess = vi.fn();
    const runtime = createRuntime({ killProcess });

    expect(isNamedTunnelRunning(2468, { runtime })).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(2468, 0);
  });

  it("returns false for a missing named tunnel pid", () => {
    const runtime = createRuntime({
      killProcess: vi.fn(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }),
    });

    expect(isNamedTunnelRunning(2468, { runtime })).toBe(false);
  });

  it("resolves the running pid from process list when runtime pid is not available", () => {
    const runSyncProcess = vi
      .fn()
      .mockReturnValueOnce(createSyncResult({
        stdout: "121 /usr/bin/other-process\n2468 /usr/local/bin/cloudflared tunnel --config /tmp/c.yml run tailserve-main\n",
      }));
    const runtime = createRuntime({
      runSyncProcess,
    });
    const state = createState({
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    expect(resolveNamedTunnelPid(state, { runtime })).toBe(2468);
    expect(state.namedTunnelPid).toBe(2468);
    expect(runSyncProcess).toHaveBeenCalledWith(
      "ps",
      ["-ax", "-o", "pid=", "-o", "command="],
      expect.objectContaining({
        encoding: "utf8",
      }),
    );
  });

  it("returns undefined when no named tunnel process matches", () => {
    const runSyncProcess = vi.fn(() =>
      createSyncResult({
        stdout: "121 /usr/local/bin/cloudflared tunnel --url http://localhost:7899\n",
      }),
    );
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    });
    const runtime = createRuntime({
      runSyncProcess,
      killProcess,
    });
    const state = createState({
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
      namedTunnelPid: 2468,
    });

    expect(resolveNamedTunnelPid(state, { runtime })).toBeUndefined();
    expect(state.namedTunnelPid).toBeUndefined();
  });

  it("stops named tunnel by SIGTERM and waits for exit", async () => {
    let nowMs = 0;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && nowMs >= 200) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    });
    const runtime = createRuntime({
      killProcess,
      now: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs;
      },
    });

    await stopNamedTunnel(2468, { runtime });

    expect(killProcess).toHaveBeenCalledWith(2468, "SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(2468, 0);
  });

  it("times out if named tunnel process does not stop in 5 seconds", async () => {
    let nowMs = 0;
    const runtime = createRuntime({
      killProcess: vi.fn(),
      now: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs;
      },
    });

    await expect(stopNamedTunnel(1357, { runtime })).rejects.toThrow(
      "Timed out waiting for cloudflared tunnel process 1357 to stop",
    );
  });

  it("stops the discovered named tunnel process when configured state lacks runtime pid", async () => {
    let nowMs = 0;
    const runSyncProcess = vi.fn(() =>
      createSyncResult({
        stdout: "2468 /usr/local/bin/cloudflared tunnel --config /tmp/c.yml run tailserve-main\n",
      }),
    );
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    });
    const runtime = createRuntime({
      runSyncProcess,
      killProcess,
      now: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs;
      },
    });
    const state = createState({
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    await expect(stopConfiguredNamedTunnel(state, { runtime })).resolves.toBe(true);
    expect(killProcess).toHaveBeenCalledWith(2468, "SIGTERM");
    expect(state.namedTunnelPid).toBeUndefined();
  });

  it("removes a named tunnel, deletes it with cloudflared, and clears state", async () => {
    let nowMs = 0;
    const runSyncProcess = vi
      .fn()
      .mockReturnValueOnce(createSyncResult({ stdout: "/usr/local/bin/cloudflared\n" }))
      .mockReturnValueOnce(createSyncResult());
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && nowMs >= 100) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    });
    const runtime = createRuntime({
      runSyncProcess,
      killProcess,
      now: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs;
      },
    });
    const state = createState({
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
      namedTunnelPid: 2468,
    });

    await removeNamedTunnel(state, { runtime });

    expect(killProcess).toHaveBeenCalledWith(2468, "SIGTERM");
    expect(runSyncProcess).toHaveBeenNthCalledWith(
      2,
      "cloudflared",
      ["tunnel", "delete", "tailserve-main"],
      expect.objectContaining({
        encoding: "utf8",
      }),
    );
    expect(state.namedTunnel).toBeUndefined();
    expect(state.namedTunnelPid).toBeUndefined();
  });
});

describe("killTunnelProcess", () => {
  it("sends kill to the provided process id", () => {
    const killProcess = vi.fn();
    const runtime = createRuntime({ killProcess });

    killTunnelProcess(4321, { runtime });

    expect(killProcess).toHaveBeenCalledWith(4321);
  });

  it("ignores ESRCH when the process does not exist", () => {
    const runtime = createRuntime({
      killProcess: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });

    expect(() => killTunnelProcess(1234, { runtime })).not.toThrow();
  });
});
