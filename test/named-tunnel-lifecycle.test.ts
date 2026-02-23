import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TailserveState } from "../src/state.js";
import type { TunnelRuntime } from "../src/tunnel.js";

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

class FakeServer extends EventEmitter {
  closeCalls = 0;

  listen(_port: number, _host?: string): this {
    this.emit("listening");
    return this;
  }

  close(callback?: () => void): this {
    this.closeCalls += 1;
    this.emit("close");
    callback?.();
    return this;
  }
}

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

function createNamedTunnelState(overrides: Partial<TailserveState> = {}): TailserveState {
  return createState({
    namedTunnel: {
      name: "tailserve-main",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      hostname: "share.example.com",
      credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
    },
    ...overrides,
  });
}

function createRuntime(overrides: Partial<TunnelRuntime> = {}): TunnelRuntime {
  return {
    spawnProcess: vi.fn(() => createMockChildProcess()),
    killProcess: vi.fn(),
    runSyncProcess: vi.fn(() => ({
      pid: 0,
      output: [null, "/usr/local/bin/cloudflared\n", ""],
      stdout: "/usr/local/bin/cloudflared\n",
      stderr: "",
      status: 0,
      signal: null,
      error: undefined,
    })),
    fileExists: vi.fn(() => true),
    makeDirectory: vi.fn(),
    writeFile: vi.fn(),
    resolveHomeDirectory: vi.fn(() => "/home/tester"),
    now: vi.fn(() => Date.now()),
    wait: vi.fn(async () => {}),
    ...overrides,
  };
}

function writeStateFile(homeDir: string, state: Record<string, unknown>): void {
  const statePath = path.join(homeDir, ".tailserve", "state.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalTailservePsOutput = process.env.TAILSERVE_PS_OUTPUT;

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

  if (originalTailservePsOutput === undefined) {
    delete process.env.TAILSERVE_PS_OUTPUT;
  } else {
    process.env.TAILSERVE_PS_OUTPUT = originalTailservePsOutput;
  }

  vi.resetModules();
  vi.doUnmock("../src/doctor.js");
  vi.doUnmock("../src/server.js");
  vi.doUnmock("../src/state.js");
  vi.doUnmock("../src/tunnel.js");
  vi.restoreAllMocks();
});

describe("named tunnel lifecycle", () => {
  it("start spawns cloudflared and tracks the runtime pid", async () => {
    const { startNamedTunnel } = await import("../src/tunnel.js");

    const state = createNamedTunnelState();
    const child = createMockChildProcess(2468);
    const runtime = createRuntime({
      spawnProcess: vi.fn(() => child),
    });

    const pid = startNamedTunnel(state, { runtime });

    expect(pid).toBe(2468);
    expect(state.namedTunnelPid).toBe(2468);
    expect(runtime.spawnProcess).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--config", "/home/tester/.tailserve/cloudflared-config.yml", "run", "tailserve-main"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
  });

  it("stop sends SIGTERM to the tracked process and clears runtime pid", async () => {
    const { stopConfiguredNamedTunnel } = await import("../src/tunnel.js");

    const state = createNamedTunnelState({ namedTunnelPid: 2468 });
    let terminated = false;
    let nowMs = 0;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGTERM") {
        terminated = true;
        return;
      }

      if (signal === 0 && terminated) {
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

    await expect(stopConfiguredNamedTunnel(state, { runtime })).resolves.toBe(true);
    expect(killProcess).toHaveBeenCalledWith(2468, "SIGTERM");
    expect(state.namedTunnelPid).toBeUndefined();
  });

  it("auto-starts named tunnel on server startup when configured and stopped", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-named-tunnel-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createNamedTunnelState();
    const fakeServer = new FakeServer();
    const writeState = vi.fn();
    const generateTunnelConfig = vi.fn();
    const resolveNamedTunnelPid = vi.fn(() => undefined);
    const startNamedTunnel = vi.fn(() => 2468);
    const stopNamedTunnel = vi.fn(async () => {});
    const cleanStaleTailscaleMapping = vi.fn(() => false);
    const findAvailablePort = vi.fn(() => undefined);
    const originalProcessOnce = process.once.bind(process);

    vi.doMock("../src/server.js", () => ({
      createTailserveServer: () => fakeServer,
    }));
    vi.doMock("../src/state.js", () => ({
      getServerPidPath: () => pidPath,
      readState: () => state,
      writeState,
    }));
    vi.doMock("../src/tunnel.js", () => ({
      generateTunnelConfig,
      resolveNamedTunnelPid,
      startNamedTunnel,
      stopNamedTunnel,
    }));
    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
    vi.spyOn(process, "once").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGTERM" || event === "SIGINT" || event === "exit") {
        return process;
      }

      return originalProcessOnce(event, listener as never);
    }) as typeof process.once);

    await expect(import("../src/server-entry.js")).resolves.toBeDefined();

    expect(generateTunnelConfig).toHaveBeenCalledTimes(1);
    expect(generateTunnelConfig).toHaveBeenCalledWith(state);
    expect(resolveNamedTunnelPid).toHaveBeenCalledTimes(1);
    expect(resolveNamedTunnelPid).toHaveBeenCalledWith(state);
    expect(startNamedTunnel).toHaveBeenCalledTimes(1);
    expect(startNamedTunnel).toHaveBeenCalledWith(state);
    expect(stopNamedTunnel).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    expect(cleanStaleTailscaleMapping).not.toHaveBeenCalled();
    expect(findAvailablePort).not.toHaveBeenCalled();
  });

  it("auto-stops named tunnel on server shutdown", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-named-tunnel-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createNamedTunnelState();
    const fakeServer = new FakeServer();
    const writeState = vi.fn();
    const generateTunnelConfig = vi.fn();
    const resolveNamedTunnelPid = vi.fn(() => 9876);
    const startNamedTunnel = vi.fn(() => 2468);
    const stopNamedTunnel = vi.fn(async () => {});
    const cleanStaleTailscaleMapping = vi.fn(() => false);
    const findAvailablePort = vi.fn(() => undefined);
    const originalProcessOnce = process.once.bind(process);
    let sigtermListener: (() => void) | undefined;

    vi.doMock("../src/server.js", () => ({
      createTailserveServer: () => fakeServer,
    }));
    vi.doMock("../src/state.js", () => ({
      getServerPidPath: () => pidPath,
      readState: () => state,
      writeState,
    }));
    vi.doMock("../src/tunnel.js", () => ({
      generateTunnelConfig,
      resolveNamedTunnelPid,
      startNamedTunnel,
      stopNamedTunnel,
    }));
    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
    vi.spyOn(process, "once").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGTERM") {
        sigtermListener = listener as () => void;
        return process;
      }

      if (event === "SIGINT" || event === "exit") {
        return process;
      }

      return originalProcessOnce(event, listener as never);
    }) as typeof process.once);
    vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    await expect(import("../src/server-entry.js")).resolves.toBeDefined();
    expect(sigtermListener).toBeDefined();

    sigtermListener?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(startNamedTunnel).not.toHaveBeenCalled();
    expect(stopNamedTunnel).toHaveBeenCalledTimes(1);
    expect(stopNamedTunnel).toHaveBeenCalledWith(9876);
    expect(fakeServer.closeCalls).toBe(1);
  });

  it("status reports running and stopped states correctly", async () => {
    const { run } = await import("../src/cli.js");

    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    writeStateFile(homeDir, createNamedTunnelState());

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakePsPath = path.join(fakeBinDir, "ps");
    writeFileSync(fakePsPath, "#!/bin/sh\nprintf \"%b\" \"$TAILSERVE_PS_OUTPUT\"\n", "utf8");
    chmodSync(fakePsPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;

    process.env.TAILSERVE_PS_OUTPUT = "2468 /usr/local/bin/cloudflared tunnel --config /tmp/c.yml run tailserve-main\\n";
    const runningStdout = new MemoryOutput();
    const runningStderr = new MemoryOutput();
    const runningExitCode = await run(["node", "ts", "tunnel", "status"], runningStdout, runningStderr);

    expect(runningExitCode).toBe(0);
    expect(runningStderr.toString()).toBe("");
    expect(runningStdout.toString()).toContain("Cloudflared");
    expect(runningStdout.toString()).toContain("running");
    expect(runningStdout.toString()).toContain("PID");
    expect(runningStdout.toString()).toContain("2468");

    process.env.TAILSERVE_PS_OUTPUT = "";
    const stoppedStdout = new MemoryOutput();
    const stoppedStderr = new MemoryOutput();
    const stoppedExitCode = await run(["node", "ts", "tunnel", "status"], stoppedStdout, stoppedStderr);

    expect(stoppedExitCode).toBe(0);
    expect(stoppedStderr.toString()).toBe("");
    expect(stoppedStdout.toString()).toContain("Cloudflared");
    expect(stoppedStdout.toString()).toContain("stopped");
    expect(stoppedStdout.toString()).not.toMatch(/(^|\n)PID(\s|$)/m);
  });
});
