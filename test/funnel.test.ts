import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultState, type TailserveState } from "../src/state.js";
import { enableTailscaleFunnelRoute, type TailscaleRuntime } from "../src/tailscale.js";

const originalTailscaleDryRun = process.env.TAILSERVE_TAILSCALE_DRY_RUN;

function createRuntime(overrides: Partial<TailscaleRuntime> = {}): TailscaleRuntime {
  return {
    readStatusJson: () => null,
    readServeStatus: () => null,
    isLocalPortInUse: () => false,
    runServeInBackground: () => true,
    runServeOff: () => {},
    runFunnelInBackground: () => true,
    runFunnelOff: () => {},
    ...overrides,
  };
}

function createState(): TailserveState {
  const state = createDefaultState();
  state.port = 7899;
  state.tsPort = 8443;
  state.tsHostname = "initial.tailnet.ts.net";
  return state;
}

afterEach(() => {
  vi.restoreAllMocks();

  if (originalTailscaleDryRun === undefined) {
    delete process.env.TAILSERVE_TAILSCALE_DRY_RUN;
  } else {
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = originalTailscaleDryRun;
  }
});

describe("tailscale funnel route setup", () => {
  it("is dry-run safe and skips runtime funnel calls", () => {
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "1";
    const state = createState();
    state.tsProtocol = "http";

    const runFunnelInBackground = vi.fn(() => true);
    const runtime = createRuntime({ runFunnelInBackground });

    const result = enableTailscaleFunnelRoute(state, { runtime });

    expect(result).toEqual({});
    expect(state.tsProtocol).toBe("https");
    expect(runFunnelInBackground).not.toHaveBeenCalled();
  });

  it("enables a funnel route and updates hostname when tailscale succeeds", () => {
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";
    const state = createState();

    const runFunnelInBackground = vi.fn(() => true);
    const runtime = createRuntime({
      readStatusJson: () => JSON.stringify({ Self: { DNSName: "demo.tailnet.ts.net." } }),
      runFunnelInBackground,
    });

    const result = enableTailscaleFunnelRoute(state, { runtime });

    expect(result).toEqual({});
    expect(state.tsHostname).toBe("demo.tailnet.ts.net");
    expect(state.tsProtocol).toBe("https");
    expect(runFunnelInBackground).toHaveBeenCalledWith(8443, 7899);
  });

  it("falls back to localhost URL settings when funnel setup fails", () => {
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";
    const state = createState();

    const runtime = createRuntime({
      runFunnelInBackground: () => false,
    });

    const result = enableTailscaleFunnelRoute(state, { runtime });

    expect(result).toEqual({
      warning: "Warning: tailscale unavailable, using http://localhost:7899",
    });
    expect(state.tsHostname).toBe("localhost");
    expect(state.tsPort).toBe(7899);
    expect(state.tsProtocol).toBe("http");
  });
});
