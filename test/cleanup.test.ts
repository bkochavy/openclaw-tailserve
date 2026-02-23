import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
const originalTailscaleDryRun = process.env.TAILSERVE_TAILSCALE_DRY_RUN;
const originalTailscaleBin = process.env.TAILSERVE_TAILSCALE_BIN;
const originalTailscaleCapture = process.env.TAILSERVE_TAILSCALE_CAPTURE;
const originalPath = process.env.PATH;

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

  if (originalTailscaleDryRun === undefined) {
    delete process.env.TAILSERVE_TAILSCALE_DRY_RUN;
  } else {
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = originalTailscaleDryRun;
  }

  if (originalTailscaleBin === undefined) {
    delete process.env.TAILSERVE_TAILSCALE_BIN;
  } else {
    process.env.TAILSERVE_TAILSCALE_BIN = originalTailscaleBin;
  }

  if (originalTailscaleCapture === undefined) {
    delete process.env.TAILSERVE_TAILSCALE_CAPTURE;
  } else {
    process.env.TAILSERVE_TAILSCALE_CAPTURE = originalTailscaleCapture;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe("ts cleanup", () => {
  it("removes stale non-protected routes and prints a summary", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    writeFileSync(tailscaleCapturePath, "", "utf8");

    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n" +
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'https://demo.tailnet.ts.net\\n'\n" +
        "  printf '|-- / proxy http://localhost:18789\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:8443\\n'\n" +
        "  printf '|-- /protected proxy http://localhost:18789\\n'\n" +
        "  printf '|-- /stale proxy http://localhost:4000\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:10443\\n'\n" +
        "  printf '|-- /stale proxy http://localhost:5001\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:11443\\n'\n" +
        "  printf '|-- /active proxy http://localhost:5000\\n'\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    const fakeLsofPath = path.join(homeDir, "lsof");
    writeFileSync(
      fakeLsofPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"-ti\" ] && [ \"$2\" = \":5000\" ]; then\n" +
        "  printf '2001\\n'\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeLsofPath, 0o755);
    process.env.PATH = `${homeDir}${path.delimiter}${originalPath ?? ""}`;

    writeState(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      tsProtocol: "https",
      protectedPorts: [18789],
      shares: {},
      projects: {},
      tunnels: {},
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "cleanup"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toBe("Removed 1 stale routes (ports 10443). Protected: 443, 8443. Skipped: 11443.\n");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["serve status", "serve --https=10443 off"]);
  });

  it("supports --dry-run and does not disable routes", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    writeFileSync(tailscaleCapturePath, "", "utf8");

    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n" +
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'https://demo.tailnet.ts.net:10443\\n'\n" +
        "  printf '|-- / proxy http://localhost:4000\\n'\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    const fakeLsofPath = path.join(homeDir, "lsof");
    writeFileSync(fakeLsofPath, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(fakeLsofPath, 0o755);
    process.env.PATH = `${homeDir}${path.delimiter}${originalPath ?? ""}`;

    writeState(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      tsProtocol: "https",
      protectedPorts: [18789],
      shares: {},
      projects: {},
      tunnels: {},
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "cleanup", "--dry-run"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toBe("Dry run: would remove 1 stale routes (ports 10443). Protected: none. Skipped: none.\n");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["serve status"]);
  });
});
