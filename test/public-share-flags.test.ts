import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";
import { createTailserveServer } from "../src/server.js";

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

function writeStateFile(homeDir: string, state: Record<string, unknown>): void {
  const statePath = path.join(homeDir, ".tailserve", "state.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalCloudflaredCapture = process.env.TAILSERVE_CLOUDFLARED_CAPTURE;

afterEach(() => {
  vi.useRealTimers();

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

  if (originalCloudflaredCapture === undefined) {
    delete process.env.TAILSERVE_CLOUDFLARED_CAPTURE;
  } else {
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = originalCloudflaredCapture;
  }
});

describe("public share flags", () => {
  it("returns the named tunnel hostname URL when share --public is used", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 8443,
      shares: {},
      projects: {},
      namedTunnel: {
        name: "tailserve",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: `${homeDir}/.cloudflared/tailserve.json`,
      },
    });

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "public-share.html");
    writeFileSync(filePath, "<h1>public share</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "share", "--public", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString().trim()).toMatch(/^https:\/\/share\.example\.com\/s\/[A-Za-z0-9_-]{8}$/);
  });

  it("shows setup guidance when share --public is used without a named tunnel", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "missing-public-tunnel.html");
    writeFileSync(filePath, "<h1>missing tunnel</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "share", "--public", filePath], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Named tunnel is not configured");
    expect(stderr.toString()).toContain("ts tunnel setup <hostname>");
  });

  it("expires public TTL shares and keeps named tunnel configuration intact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T00:00:00.000Z"));

    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const namedTunnel = {
      name: "tailserve",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      hostname: "share.example.com",
      credentialsPath: `${homeDir}/.cloudflared/tailserve.json`,
    };
    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 8443,
      shares: {},
      projects: {},
      namedTunnel,
    });

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "public-expiring.html");
    writeFileSync(filePath, "<h1>public expiring share</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "share", "--public", "--ttl", "30m", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    const shareId = stdout.toString().trim().split("/").pop() ?? "";
    expect(shareId).toMatch(/^[A-Za-z0-9_-]{8}$/);

    const server = createTailserveServer();
    try {
      vi.advanceTimersByTime(30 * 60 * 1000);
      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        shares: Record<string, unknown>;
        namedTunnel?: typeof namedTunnel;
      };
      expect(state.shares[shareId]).toBeUndefined();
      expect(state.namedTunnel).toEqual(namedTunnel);
    } finally {
      server.emit("close");
    }
  });

  it("supports --persist for public shares", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 8443,
      shares: {},
      projects: {},
      namedTunnel: {
        name: "tailserve",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: `${homeDir}/.cloudflared/tailserve.json`,
      },
    });

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "public-persist.html");
    writeFileSync(filePath, "<h1>public persist share</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "share", "--public", "--persist", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    const shareId = stdout.toString().trim().split("/").pop() ?? "";
    expect(shareId).toMatch(/^[A-Za-z0-9_-]{8}$/);

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { public?: boolean; persist: boolean; expiresAt: string | null }>;
    };
    const share = state.shares[shareId];
    expect(share).toBeDefined();
    expect(share.public).toBe(true);
    expect(share.persist).toBe(true);
    expect(share.expiresAt).toBeNull();
  });

  it("keeps quick tunnels independent when --tunnel is used with named tunnel configured", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const cloudflaredCapturePath = path.join(homeDir, "cloudflared-calls.log");
    const fakeCloudflaredPath = path.join(fakeBinDir, "cloudflared");
    writeFileSync(
      fakeCloudflaredPath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_CLOUDFLARED_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_CLOUDFLARED_CAPTURE\"\n" +
        "fi\n" +
        "printf '%s\\n' 'https://independent.trycloudflare.com'\n",
      "utf8",
    );
    chmodSync(fakeCloudflaredPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = cloudflaredCapturePath;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 8443,
      shares: {},
      projects: {},
      namedTunnel: {
        name: "tailserve",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: `${homeDir}/.cloudflared/tailserve.json`,
      },
    });

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "quick-tunnel.html");
    writeFileSync(filePath, "<h1>quick tunnel</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "share", "--tunnel", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toBe("https://independent.trycloudflare.com\n");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { id: string; public?: boolean }>;
      tunnels: Record<string, { url: string }>;
      namedTunnel?: { hostname: string };
    };
    const [shareId, share] = Object.entries(state.shares)[0];
    expect(share.id).toBe(shareId);
    expect(share.public).toBeUndefined();
    expect(state.tunnels[shareId]?.url).toBe("https://independent.trycloudflare.com");
    expect(state.namedTunnel?.hostname).toBe("share.example.com");

    const capturedCalls = readFileSync(cloudflaredCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["tunnel --url http://localhost:7899"]);
  });
});
