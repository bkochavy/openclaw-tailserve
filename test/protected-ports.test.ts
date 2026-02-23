import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readState } from "../src/state.js";
import { cleanupStaleTailscaleServeRoutes, type TailscaleRuntime } from "../src/tailscale.js";

const originalHome = process.env.HOME;
const originalProtectedPorts = process.env.TAILSERVE_PROTECTED_PORTS;
const originalTailscaleDryRun = process.env.TAILSERVE_TAILSCALE_DRY_RUN;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalProtectedPorts === undefined) {
    delete process.env.TAILSERVE_PROTECTED_PORTS;
  } else {
    process.env.TAILSERVE_PROTECTED_PORTS = originalProtectedPorts;
  }

  if (originalTailscaleDryRun === undefined) {
    delete process.env.TAILSERVE_TAILSCALE_DRY_RUN;
  } else {
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = originalTailscaleDryRun;
  }
});

describe("protected ports", () => {
  it("defaults to port 18789 when TAILSERVE_PROTECTED_PORTS is not set", () => {
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    delete process.env.TAILSERVE_PROTECTED_PORTS;

    const state = readState();

    expect(state.protectedPorts).toEqual([18789]);
  });

  it("parses TAILSERVE_PROTECTED_PORTS as a comma-separated list", () => {
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.TAILSERVE_PROTECTED_PORTS = "3000, 18789,3000,invalid,70000, 4000";

    const state = readState();

    expect(state.protectedPorts).toEqual([3000, 18789, 4000]);
  });

  it("does not disable routes on https 443 or protected backend ports during stale-route cleanup", () => {
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";
    process.env.TAILSERVE_PROTECTED_PORTS = "18789";

    const checkedBackendPorts: number[] = [];
    const disabledHttpsPorts: number[] = [];
    const runtime: TailscaleRuntime = {
      readStatusJson: () => null,
      readServeStatus: () =>
        [
          "https://demo.tailnet.ts.net",
          "|-- / proxy http://localhost:18789",
          "https://demo.tailnet.ts.net:8443",
          "|-- /protected proxy http://localhost:18789",
          "|-- /stale proxy http://localhost:4000",
          "https://demo.tailnet.ts.net:10443",
          "|-- /stale proxy http://localhost:5001",
          "https://demo.tailnet.ts.net:11443",
          "|-- /active proxy http://localhost:5000",
        ].join("\n"),
      isLocalPortInUse: (port) => {
        checkedBackendPorts.push(port);
        return port === 5000;
      },
      runServeInBackground: () => true,
      runServeOff: (httpsPort) => {
        disabledHttpsPorts.push(httpsPort);
      },
      runFunnelInBackground: () => true,
      runFunnelOff: () => {},
    };

    const summary = cleanupStaleTailscaleServeRoutes({ runtime });

    expect(checkedBackendPorts).toEqual([4000, 5001, 5000]);
    expect(disabledHttpsPorts).toEqual([10443]);
    expect(summary).toEqual({
      removed: [10443],
      protected: [443, 8443],
      skipped: [11443],
    });
  });
});
