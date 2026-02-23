import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TailserveState } from "../src/state.js";

class FakeServer extends EventEmitter {
  private readonly failuresByPort: Map<number, number>;
  private readonly listenError?: NodeJS.ErrnoException;
  readonly listenCalls: number[] = [];
  readonly listenHosts: Array<string | undefined> = [];
  closeCalls = 0;

  constructor(failuresByPort: Record<number, number>, listenError?: NodeJS.ErrnoException) {
    super();
    this.failuresByPort = new Map<number, number>(Object.entries(failuresByPort).map(([port, count]) => [Number(port), count]));
    this.listenError = listenError;
  }

  listen(port: number, host?: string): this {
    this.listenCalls.push(port);
    this.listenHosts.push(host);
    if (this.listenError) {
      this.emit("error", this.listenError);
      return this;
    }

    const remainingFailures = this.failuresByPort.get(port) ?? 0;
    if (remainingFailures > 0) {
      this.failuresByPort.set(port, remainingFailures - 1);
      const error = new Error(`listen EADDRINUSE: address already in use :::${port}`) as NodeJS.ErrnoException;
      error.code = "EADDRINUSE";
      this.emit("error", error);
      return this;
    }

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

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/doctor.js");
  vi.doUnmock("../src/server.js");
  vi.doUnmock("../src/state.js");
  vi.doUnmock("../src/tunnel.js");
  vi.restoreAllMocks();
});

function createState(port = 7899, overrides: Partial<TailserveState> = {}): TailserveState {
  return {
    port,
    tsHostname: "demo.tailnet.ts.net",
    tsPort: port,
    tsProtocol: "https",
    protectedPorts: [18789],
    shares: {},
    projects: {},
    tunnels: {},
    ...overrides,
  };
}

describe("server entry port-in-use handling", () => {
  it("retries once on the same port when stale tailscale mapping cleanup succeeds", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-port-retry-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createState(7899);
    const writeState = vi.fn();
    const fakeServer = new FakeServer({ 7899: 1 });
    const cleanStaleTailscaleMapping = vi.fn(() => true);
    const findAvailablePort = vi.fn(() => undefined);

    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
    vi.doMock("../src/server.js", () => ({
      createTailserveServer: () => fakeServer,
    }));
    vi.doMock("../src/state.js", () => ({
      getServerPidPath: () => pidPath,
      readState: () => state,
      writeState,
    }));

    await expect(import("../src/server-entry.js")).resolves.toBeDefined();

    expect(fakeServer.listenCalls).toEqual([7899, 7899]);
    expect(fakeServer.listenHosts).toEqual(["127.0.0.1", "127.0.0.1"]);
    expect(cleanStaleTailscaleMapping).toHaveBeenCalledTimes(1);
    expect(cleanStaleTailscaleMapping).toHaveBeenCalledWith(7899);
    expect(findAvailablePort).not.toHaveBeenCalled();
    expect(state.port).toBe(7899);
    expect(state.tsPort).toBe(7899);
    expect(writeState).not.toHaveBeenCalled();
  });

  it("falls back to a discovered replacement port after retry fails", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-port-retry-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createState(7899);
    const writeState = vi.fn();
    const fakeServer = new FakeServer({ 7899: 2 });
    const cleanStaleTailscaleMapping = vi.fn(() => true);
    const findAvailablePort = vi.fn(() => 7902);

    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
    vi.doMock("../src/server.js", () => ({
      createTailserveServer: () => fakeServer,
    }));
    vi.doMock("../src/state.js", () => ({
      getServerPidPath: () => pidPath,
      readState: () => state,
      writeState,
    }));

    await expect(import("../src/server-entry.js")).resolves.toBeDefined();

    expect(fakeServer.listenCalls).toEqual([7899, 7899, 7902]);
    expect(fakeServer.listenHosts).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1"]);
    expect(cleanStaleTailscaleMapping).toHaveBeenCalledTimes(1);
    expect(findAvailablePort).toHaveBeenCalledTimes(1);
    expect(findAvailablePort).toHaveBeenCalledWith(7900, 10);
    expect(state.port).toBe(7902);
    expect(state.tsPort).toBe(7902);
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(writeState).toHaveBeenCalledWith(state);
  });

  it("regenerates named tunnel config with the active listen port and starts it when not running", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-port-retry-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createState(7899, {
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });
    const writeState = vi.fn();
    const fakeServer = new FakeServer({ 7899: 2 });
    const cleanStaleTailscaleMapping = vi.fn(() => true);
    const findAvailablePort = vi.fn(() => 7902);
    const generateTunnelConfig = vi.fn(() => "/home/tester/.tailserve/cloudflared-config.yml");
    const resolveNamedTunnelPid = vi.fn(() => undefined);
    const startNamedTunnel = vi.fn(() => 2468);
    const stopNamedTunnel = vi.fn(async () => {});

    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
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

    await expect(import("../src/server-entry.js")).resolves.toBeDefined();

    expect(state.port).toBe(7902);
    expect(state.tsPort).toBe(7902);
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(generateTunnelConfig).toHaveBeenCalledTimes(1);
    expect(generateTunnelConfig).toHaveBeenCalledWith(state);
    expect(resolveNamedTunnelPid).toHaveBeenCalledTimes(1);
    expect(resolveNamedTunnelPid).toHaveBeenCalledWith(state);
    expect(startNamedTunnel).toHaveBeenCalledTimes(1);
    expect(startNamedTunnel).toHaveBeenCalledWith(state);
    expect(stopNamedTunnel).not.toHaveBeenCalled();
  });

  it("regenerates named tunnel config but does not start another process when one is already running", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-port-retry-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createState(7899, {
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });
    const writeState = vi.fn();
    const fakeServer = new FakeServer({});
    const cleanStaleTailscaleMapping = vi.fn(() => true);
    const findAvailablePort = vi.fn(() => undefined);
    const generateTunnelConfig = vi.fn(() => "/home/tester/.tailserve/cloudflared-config.yml");
    const resolveNamedTunnelPid = vi.fn(() => 9876);
    const startNamedTunnel = vi.fn(() => 2468);
    const stopNamedTunnel = vi.fn(async () => {});

    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
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

    await expect(import("../src/server-entry.js")).resolves.toBeDefined();

    expect(generateTunnelConfig).toHaveBeenCalledTimes(1);
    expect(resolveNamedTunnelPid).toHaveBeenCalledTimes(1);
    expect(startNamedTunnel).not.toHaveBeenCalled();
    expect(stopNamedTunnel).not.toHaveBeenCalled();
  });

  it("stops the named tunnel on SIGTERM shutdown", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-port-retry-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createState(7899, {
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "tailserve.example.com",
        credentialsPath: "/home/tester/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });
    const writeState = vi.fn();
    const fakeServer = new FakeServer({});
    const cleanStaleTailscaleMapping = vi.fn(() => true);
    const findAvailablePort = vi.fn(() => undefined);
    const generateTunnelConfig = vi.fn(() => "/home/tester/.tailserve/cloudflared-config.yml");
    const resolveNamedTunnelPid = vi.fn(() => 9876);
    const startNamedTunnel = vi.fn(() => 2468);
    const stopNamedTunnel = vi.fn(async () => {});
    const originalProcessOnce = process.once.bind(process);
    let sigtermListener: (() => void) | undefined;

    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
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
    vi.spyOn(process, "once").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGTERM") {
        sigtermListener = listener as () => void;
        return process;
      }

      if (event === "SIGINT") {
        return process;
      }

      return originalProcessOnce(event, listener as never);
    }) as typeof process.once);
    vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    await expect(import("../src/server-entry.js")).resolves.toBeDefined();
    expect(sigtermListener).toBeDefined();

    sigtermListener?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopNamedTunnel).toHaveBeenCalledTimes(1);
    expect(stopNamedTunnel).toHaveBeenCalledWith(9876);
    expect(fakeServer.closeCalls).toBe(1);
    expect(startNamedTunnel).not.toHaveBeenCalled();
  });

  it("exits with a clear actionable error when retry and fallback both fail", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-port-retry-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createState(7899);
    const writeState = vi.fn();
    const fakeServer = new FakeServer({ 7899: 2 });
    const cleanStaleTailscaleMapping = vi.fn(() => true);
    const findAvailablePort = vi.fn(() => undefined);

    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
    vi.doMock("../src/server.js", () => ({
      createTailserveServer: () => fakeServer,
    }));
    vi.doMock("../src/state.js", () => ({
      getServerPidPath: () => pidPath,
      readState: () => state,
      writeState,
    }));

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit ${code ?? ""}`.trim());
    });

    await expect(import("../src/server-entry.js")).rejects.toThrow("exit 1");

    expect(fakeServer.listenCalls).toEqual([7899, 7899]);
    expect(fakeServer.listenHosts).toEqual(["127.0.0.1", "127.0.0.1"]);
    expect(cleanStaleTailscaleMapping).toHaveBeenCalledTimes(1);
    expect(findAvailablePort).toHaveBeenCalledTimes(1);
    expect(findAvailablePort).toHaveBeenCalledWith(7900, 10);
    expect(writeState).not.toHaveBeenCalled();
    expect(stderrWrites).toContain(
      "Failed to start tailserve server: port 7899 is already in use. Check with `lsof -i :7899` or run `ts server stop`.\n",
    );
  });

  it("keeps non-EADDRINUSE startup errors readable", async () => {
    const tmpPath = mkdtempSync(path.join(tmpdir(), "tailserve-port-retry-"));
    const pidPath = path.join(tmpPath, "server.pid");
    const state = createState(7899);
    const writeState = vi.fn();
    const error = new Error("listen EACCES: permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    const fakeServer = new FakeServer({}, error);
    const cleanStaleTailscaleMapping = vi.fn(() => true);
    const findAvailablePort = vi.fn(() => 7902);

    vi.doMock("../src/doctor.js", () => ({
      cleanStaleTailscaleMapping,
      findAvailablePort,
    }));
    vi.doMock("../src/server.js", () => ({
      createTailserveServer: () => fakeServer,
    }));
    vi.doMock("../src/state.js", () => ({
      getServerPidPath: () => pidPath,
      readState: () => state,
      writeState,
    }));

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit ${code ?? ""}`.trim());
    });

    await expect(import("../src/server-entry.js")).rejects.toThrow("exit 1");

    expect(fakeServer.listenCalls).toEqual([7899]);
    expect(fakeServer.listenHosts).toEqual(["127.0.0.1"]);
    expect(cleanStaleTailscaleMapping).not.toHaveBeenCalled();
    expect(findAvailablePort).not.toHaveBeenCalled();
    expect(state.port).toBe(7899);
    expect(state.tsPort).toBe(7899);
    expect(writeState).not.toHaveBeenCalled();
    expect(stderrWrites).toContain("Failed to start tailserve server: listen EACCES: permission denied\n");
  });
});
