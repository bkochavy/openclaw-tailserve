import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface MockState {
  port: number;
  tsHostname: string;
  tsPort: number;
  tsProtocol: "https" | "http";
  protectedPorts: number[];
  shares: Record<string, unknown>;
  projects: Record<string, unknown>;
  tunnels: Record<string, unknown>;
}

function createMockState(overrides?: Partial<MockState>): MockState {
  return {
    port: 7899,
    tsHostname: "old.tailnet.ts.net",
    tsPort: 7899,
    tsProtocol: "https",
    protectedPorts: [18789],
    shares: {},
    projects: {},
    tunnels: {},
    ...overrides,
  };
}

function cloneState(state: MockState): MockState {
  return {
    ...state,
    protectedPorts: [...state.protectedPorts],
    shares: { ...state.shares },
    projects: { ...state.projects },
    tunnels: { ...state.tunnels },
  };
}

async function loadSharesWithMocks(readStates: MockState[]): Promise<{
  createFileShare: (targetPath: string) => { id: string; url: string };
  createEditShare: (targetPath: string) => { id: string; url: string };
  createProxyShare: (port: number) => { id: string; url: string };
  ensureTailserveServerRunningMock: ReturnType<typeof vi.fn>;
  readStateMock: ReturnType<typeof vi.fn>;
  toShareUrlMock: ReturnType<typeof vi.fn>;
}> {
  const queue = readStates.map((state) => cloneState(state));
  const fallback = cloneState(readStates[readStates.length - 1] ?? createMockState());

  const readStateMock = vi.fn(() => {
    const next = queue.shift();
    if (!next) {
      return cloneState(fallback);
    }

    return cloneState(next);
  });

  const updateStateMock = vi.fn((mutator: (state: MockState) => void) => {
    const current = cloneState(fallback);
    mutator(current);
    return current;
  });

  const toShareUrlMock = vi.fn((state: MockState, id: string) => {
    const protocol = state.tsProtocol === "http" ? "http" : "https";
    return `${protocol}://${state.tsHostname}:${state.tsPort}/s/${id}`;
  });

  const ensureTailserveServerRunningMock = vi.fn(() => true);
  const ensureTailscaleServeForFirstShareMock = vi.fn(() => ({}));
  const enableTailscaleFunnelRouteMock = vi.fn(() => ({}));

  vi.doMock("../src/server-process.js", () => ({
    ensureTailserveServerRunning: ensureTailserveServerRunningMock,
  }));
  vi.doMock("../src/tailscale.js", () => ({
    ensureTailscaleServeForFirstShare: ensureTailscaleServeForFirstShareMock,
    enableTailscaleFunnelRoute: enableTailscaleFunnelRouteMock,
  }));
  vi.doMock("../src/state.js", () => ({
    readState: readStateMock,
    updateState: updateStateMock,
    toShareUrl: toShareUrlMock,
    writeState: vi.fn(),
  }));

  const shares = await import("../src/shares.js");
  return {
    createFileShare: shares.createFileShare,
    createEditShare: shares.createEditShare,
    createProxyShare: shares.createProxyShare,
    ensureTailserveServerRunningMock,
    readStateMock,
    toShareUrlMock,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/server-process.js");
  vi.doUnmock("../src/tailscale.js");
  vi.doUnmock("../src/state.js");
  vi.restoreAllMocks();
});

describe("share URL state refresh after server spawn", () => {
  it("uses the spawned server port for file share URL when initial state still has default port", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-default-port-refresh-"));
    const filePath = path.join(workspace, "index.html");
    writeFileSync(filePath, "<h1>Hello</h1>\n", "utf8");

    const initialState = createMockState({ tsHostname: "old.tailnet.ts.net", tsPort: 7899, tsProtocol: "https" });
    const refreshedState = createMockState({ tsHostname: "new.tailnet.ts.net", tsPort: 7903, tsProtocol: "https" });
    const { createFileShare, ensureTailserveServerRunningMock, readStateMock, toShareUrlMock } = await loadSharesWithMocks([
      initialState,
      refreshedState,
    ]);

    const result = createFileShare(filePath);

    expect(ensureTailserveServerRunningMock).toHaveBeenCalledTimes(1);
    expect(readStateMock).toHaveBeenCalledTimes(2);
    expect(result.url).toBe(`https://new.tailnet.ts.net:7903/s/${result.id}`);
    expect(result.url).not.toContain(":7899/");
    expect(toShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tsHostname: "new.tailnet.ts.net",
        tsPort: 7903,
        tsProtocol: "https",
      }),
      result.id,
    );
  });

  it("uses refreshed state for file share URLs when server startup writes new routing data", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-share-refresh-"));
    const filePath = path.join(workspace, "index.html");
    writeFileSync(filePath, "<h1>Hello</h1>\n", "utf8");

    const initialState = createMockState({ tsHostname: "old.tailnet.ts.net", tsPort: 7443, tsProtocol: "https" });
    const refreshedState = createMockState({ tsHostname: "new.tailnet.ts.net", tsPort: 8443, tsProtocol: "https" });
    const { createFileShare, ensureTailserveServerRunningMock, readStateMock, toShareUrlMock } = await loadSharesWithMocks([
      initialState,
      refreshedState,
    ]);

    const result = createFileShare(filePath);

    expect(ensureTailserveServerRunningMock).toHaveBeenCalledTimes(1);
    expect(readStateMock).toHaveBeenCalledTimes(2);
    expect(result.url).toBe(`https://new.tailnet.ts.net:8443/s/${result.id}`);
    expect(toShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tsHostname: "new.tailnet.ts.net",
        tsPort: 8443,
        tsProtocol: "https",
      }),
      result.id,
    );
  });

  it("uses refreshed state for edit share URLs when server startup updates protocol/port", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-edit-refresh-"));
    const filePath = path.join(workspace, "notes.md");
    writeFileSync(filePath, "# Notes\n", "utf8");

    const initialState = createMockState({ tsHostname: "old.tailnet.ts.net", tsPort: 7443, tsProtocol: "https" });
    const refreshedState = createMockState({ tsHostname: "localhost", tsPort: 7901, tsProtocol: "http" });
    const { createEditShare, ensureTailserveServerRunningMock, readStateMock, toShareUrlMock } = await loadSharesWithMocks([
      initialState,
      refreshedState,
    ]);

    const result = createEditShare(filePath);

    expect(ensureTailserveServerRunningMock).toHaveBeenCalledTimes(1);
    expect(readStateMock).toHaveBeenCalledTimes(2);
    expect(result.url).toBe(`http://localhost:7901/s/${result.id}`);
    expect(toShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tsHostname: "localhost",
        tsPort: 7901,
        tsProtocol: "http",
      }),
      result.id,
    );
  });

  it("uses refreshed state for proxy share URLs when server startup rewrites host and port", async () => {
    const initialState = createMockState({ tsHostname: "old.tailnet.ts.net", tsPort: 7443, tsProtocol: "https" });
    const refreshedState = createMockState({ tsHostname: "fresh.tailnet.ts.net", tsPort: 9443, tsProtocol: "https" });
    const { createProxyShare, ensureTailserveServerRunningMock, readStateMock, toShareUrlMock } = await loadSharesWithMocks([
      initialState,
      refreshedState,
    ]);

    const result = createProxyShare(3000);

    expect(ensureTailserveServerRunningMock).toHaveBeenCalledTimes(1);
    expect(readStateMock).toHaveBeenCalledTimes(2);
    expect(result.url).toBe(`https://fresh.tailnet.ts.net:9443/s/${result.id}`);
    expect(toShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tsHostname: "fresh.tailnet.ts.net",
        tsPort: 9443,
        tsProtocol: "https",
      }),
      result.id,
    );
  });
});
