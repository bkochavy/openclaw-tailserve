import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";
import { resolveRequest } from "../src/server.js";
import { getServerPidPath } from "../src/state.js";

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
const originalTailserveServerAutostart = process.env.TAILSERVE_SERVER_AUTOSTART;
const originalTailserveServerEntry = process.env.TAILSERVE_SERVER_ENTRY;
const originalCloudflaredCapture = process.env.TAILSERVE_CLOUDFLARED_CAPTURE;
const originalTailservePsOutput = process.env.TAILSERVE_PS_OUTPUT;
const originalPath = process.env.PATH;
const projectRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const TTL_FORMAT_CASES: ReadonlyArray<{ ttl: string; ttlMs: number }> = [
  { ttl: "30m", ttlMs: 30 * 60 * 1000 },
  { ttl: "2h", ttlMs: 2 * 60 * 60 * 1000 },
  { ttl: "1d", ttlMs: 24 * 60 * 60 * 1000 },
  { ttl: "7d", ttlMs: 7 * 24 * 60 * 60 * 1000 },
];

async function waitForFile(filePath: string, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  return existsSync(filePath);
}

async function waitForPredicate(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  return predicate();
}

function parseTableOutput(output: string): string[][] {
  return output
    .trimEnd()
    .split("\n")
    .map((line) => line.trimEnd().split(/\s{2,}/));
}

function writeStateFile(homeDir: string, state: Record<string, unknown>): void {
  const statePath = path.join(homeDir, ".tailserve", "state.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

function expectDefaultTtlWindow(createdAt: string, expiresAt: string | null): void {
  expectTtlWindow(createdAt, expiresAt, DEFAULT_SHARE_TTL_MS);
}

function expectTtlWindow(createdAt: string, expiresAt: string | null, ttlMsExpected: number): void {
  const createdAtMs = Date.parse(createdAt);
  const expiresAtMs = Date.parse(expiresAt ?? "");

  expect(Number.isNaN(createdAtMs)).toBe(false);
  expect(Number.isNaN(expiresAtMs)).toBe(false);
  expect(expiresAtMs).toBeGreaterThan(createdAtMs);

  const ttlMs = expiresAtMs - createdAtMs;
  expect(ttlMs).toBeGreaterThanOrEqual(ttlMsExpected - 5000);
  expect(ttlMs).toBeLessThanOrEqual(ttlMsExpected + 5000);
}

interface SpawnedCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runBinTs(args: string[], homeDir: string): Promise<SpawnedCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "bin", "ts"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
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

  if (originalTailserveServerAutostart === undefined) {
    delete process.env.TAILSERVE_SERVER_AUTOSTART;
  } else {
    process.env.TAILSERVE_SERVER_AUTOSTART = originalTailserveServerAutostart;
  }

  if (originalTailserveServerEntry === undefined) {
    delete process.env.TAILSERVE_SERVER_ENTRY;
  } else {
    process.env.TAILSERVE_SERVER_ENTRY = originalTailserveServerEntry;
  }

  if (originalCloudflaredCapture === undefined) {
    delete process.env.TAILSERVE_CLOUDFLARED_CAPTURE;
  } else {
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = originalCloudflaredCapture;
  }

  if (originalTailservePsOutput === undefined) {
    delete process.env.TAILSERVE_PS_OUTPUT;
  } else {
    process.env.TAILSERVE_PS_OUTPUT = originalTailservePsOutput;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe("ts share", () => {
  it("persists share metadata to ~/.tailserve/state.json", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "state-check.html");
    writeFileSync(filePath, "<h1>Persist me</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const url = stdout.toString().trim();
    const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(url);
    expect(match).not.toBeNull();
    const id = match?.[1] ?? "";

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      shares: Record<
        string,
        {
          id: string;
          type: string;
          path?: string;
          createdAt: string;
          expiresAt: string | null;
          persist: boolean;
          readonly: boolean;
        }
      >;
    };

    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.id).toBe(id);
    expect(share.type).toBe("file");
    expect(share.path).toBe(path.resolve(filePath));
    expect(share.persist).toBe(false);
    expect(share.readonly).toBe(false);

    expectDefaultTtlWindow(share.createdAt, share.expiresAt);
  });

  it("keeps both shares when two share commands run nearly simultaneously", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const firstFilePath = path.join(workspace, "first-concurrent.html");
    const secondFilePath = path.join(workspace, "second-concurrent.html");
    writeFileSync(firstFilePath, "<h1>first concurrent</h1>\n", "utf8");
    writeFileSync(secondFilePath, "<h1>second concurrent</h1>\n", "utf8");

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
        tunnels: {},
      })}\n`,
      "utf8",
    );

    const lockPath = `${statePath}.lock`;
    writeFileSync(lockPath, "busy\n", "utf8");

    let firstResult: SpawnedCliResult;
    let secondResult: SpawnedCliResult;
    const releaseLock = setTimeout(() => {
      rmSync(lockPath, { force: true });
    }, 150);

    try {
      [firstResult, secondResult] = await Promise.all([
        runBinTs(["share", firstFilePath], homeDir),
        runBinTs(["share", secondFilePath], homeDir),
      ]);
    } finally {
      clearTimeout(releaseLock);
      rmSync(lockPath, { force: true });
    }

    expect(firstResult.code).toBe(0);
    expect(secondResult.code).toBe(0);
    expect(firstResult.stderr).toBe("");
    expect(secondResult.stderr).toBe("");

    const firstUrl = firstResult.stdout.trim();
    const secondUrl = secondResult.stdout.trim();
    expect(firstUrl).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);
    expect(secondUrl).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);

    const firstId = new URL(firstUrl).pathname.split("/").pop() ?? "";
    const secondId = new URL(secondUrl).pathname.split("/").pop() ?? "";
    expect(firstId).toHaveLength(8);
    expect(secondId).toHaveLength(8);
    expect(firstId).not.toBe(secondId);

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      shares: Record<string, { path?: string; type: string }>;
    };
    expect(Object.keys(state.shares)).toHaveLength(2);
    expect(state.shares[firstId]?.type).toBe("file");
    expect(state.shares[firstId]?.path).toBe(path.resolve(firstFilePath));
    expect(state.shares[secondId]?.type).toBe("file");
    expect(state.shares[secondId]?.path).toBe(path.resolve(secondFilePath));

    const firstResolved = resolveRequest({
      method: "GET",
      url: `/s/${firstId}`,
    });
    expect(firstResolved.statusCode).toBe(200);
    expect(firstResolved.filePath).toBe(path.resolve(firstFilePath));

    const secondResolved = resolveRequest({
      method: "GET",
      url: `/s/${secondId}`,
    });
    expect(secondResolved.statusCode).toBe(200);
    expect(secondResolved.filePath).toBe(path.resolve(secondFilePath));

    const listStdout = new MemoryOutput();
    const listStderr = new MemoryOutput();
    const listExitCode = await run(["node", "ts", "list", "--json"], listStdout, listStderr);

    expect(listExitCode).toBe(0);
    expect(listStderr.toString()).toBe("");

    const rows = JSON.parse(listStdout.toString()) as Array<{
      id: string;
      type: string;
      path: string;
      url: string;
    }>;
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    expect(rowsById.get(firstId)).toMatchObject({
      id: firstId,
      type: "file",
      path: path.resolve(firstFilePath),
      url: firstUrl,
    });
    expect(rowsById.get(secondId)).toMatchObject({
      id: secondId,
      type: "file",
      path: path.resolve(secondFilePath),
      url: secondUrl,
    });

    const tableListStdout = new MemoryOutput();
    const tableListStderr = new MemoryOutput();
    const tableListExitCode = await run(["node", "ts", "list"], tableListStdout, tableListStderr);

    expect(tableListExitCode).toBe(0);
    expect(tableListStderr.toString()).toBe("");

    const tableRows = parseTableOutput(tableListStdout.toString());
    const tableIds = tableRows.slice(1).map((row) => row[0] ?? "");
    expect(tableIds).toContain(firstId);
    expect(tableIds).toContain(secondId);
  });

  it("supports relative paths and prints one https URL to stdout", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const previousCwd = process.cwd();
    process.chdir(workspace);

    try {
      writeFileSync("file.html", "<h1>Hello</h1>\n", "utf8");

      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await run(["node", "ts", "share", "./file.html"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const output = stdout.toString();
      const trimmed = output.trim();

      expect(trimmed).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);
      expect(output).toBe(`${trimmed}\n`);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        shares: Record<string, { path: string; type: string }>;
      };

      const share = Object.values(state.shares)[0];
      expect(share.path).toBe(path.resolve("file.html"));
      expect(share.type).toBe("file");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses the live server port in new share URLs when state.json has a stale port", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_SERVER_AUTOSTART = "1";

    const stalePort = 7899;
    const actualPort = 7900;
    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "port-mismatch-share.html");
    writeFileSync(filePath, "<h1>Port mismatch</h1>\n", "utf8");

    writeStateFile(homeDir, {
      port: stalePort,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: stalePort,
      shares: {},
      projects: {},
      tunnels: {},
    });

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${process.pid}\n`, "utf8");

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakeLsofPath = path.join(fakeBinDir, "lsof");
    writeFileSync(
      fakeLsofPath,
      "#!/bin/sh\n" +
        `if [ \"$1\" = \"-ti\" ] && [ \"$2\" = \":${stalePort}\" ]; then\n` +
        "  exit 1\n" +
        "fi\n" +
        "if [ \"$1\" = \"-Pan\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = \"$TAILSERVE_TEST_PID\" ]; then\n" +
        "  echo 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'\n" +
        "  echo \"node $3 user 20u IPv6 0x0 0t0 TCP *:$TAILSERVE_TEST_PORT (LISTEN)\"\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeLsofPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_TEST_PID = `${process.pid}`;
    process.env.TAILSERVE_TEST_PORT = `${actualPort}`;

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const shareUrl = stdout.toString().trim();
      const parsedUrl = new URL(shareUrl);
      const shareId = parsedUrl.pathname.split("/").pop() ?? "";
      expect(parsedUrl.port).toBe(`${actualPort}`);
      expect(shareId).toMatch(/^[A-Za-z0-9_-]{8}$/);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        port: number;
        tsPort: number;
        shares: Record<string, { id: string; path: string; type: string }>;
      };

      expect(state.port).toBe(actualPort);
      expect(state.tsPort).toBe(actualPort);
      expect(state.shares[shareId]).toBeDefined();
      expect(state.shares[shareId].path).toBe(path.resolve(filePath));
      expect(state.shares[shareId].type).toBe("file");
    } finally {
      delete process.env.TAILSERVE_TEST_PID;
      delete process.env.TAILSERVE_TEST_PORT;
    }
  });

  for (const ttlCase of TTL_FORMAT_CASES) {
    it(`supports --ttl ${ttlCase.ttl} to override share expiry`, async () => {
      const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
      process.env.HOME = homeDir;

      const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
      const filePath = path.join(workspace, `ttl-${ttlCase.ttl}.html`);
      writeFileSync(filePath, "<h1>TTL</h1>\n", "utf8");

      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await run(["node", "ts", "share", "--ttl", ttlCase.ttl, filePath], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const url = stdout.toString().trim();
      const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(url);
      expect(match).not.toBeNull();
      const id = match?.[1] ?? "";

      const statePath = path.join(homeDir, ".tailserve", "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        shares: Record<
          string,
          {
            createdAt: string;
            expiresAt: string | null;
          }
        >;
      };

      const share = state.shares[id];
      expect(share).toBeDefined();
      expectTtlWindow(share.createdAt, share.expiresAt, ttlCase.ttlMs);
    });
  }

  it("supports --persist with no expiry", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "persist-check.html");
    writeFileSync(filePath, "<h1>Persist</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", "--persist", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const url = stdout.toString().trim();
    const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(url);
    expect(match).not.toBeNull();
    const id = match?.[1] ?? "";

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      shares: Record<
        string,
        {
          createdAt: string;
          expiresAt: string | null;
          persist: boolean;
        }
      >;
    };

    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.persist).toBe(true);
    expect(share.expiresAt).toBeNull();
    expect(Number.isNaN(Date.parse(share.createdAt))).toBe(false);
  });

  it("supports directory shares and persists them as type dir", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const previousCwd = process.cwd();
    process.chdir(workspace);

    try {
      mkdirSync("my-dir", { recursive: true });
      writeFileSync(path.join("my-dir", "hello.txt"), "hello\n", "utf8");

      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await run(["node", "ts", "share", "./my-dir/"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const output = stdout.toString();
      const trimmed = output.trim();
      expect(trimmed).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);
      expect(output).toBe(`${trimmed}\n`);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        shares: Record<string, { path: string; type: string }>;
      };

      const share = Object.values(state.shares)[0];
      expect(share.type).toBe("dir");
      expect(share.path).toBe(path.resolve("my-dir"));
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses ts hostname and port in /s/<id> URL format", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stateDir = path.join(homeDir, ".tailserve");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "my-machine.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "file.html");
    writeFileSync(filePath, "<h1>Hello</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const url = stdout.toString().trim();
    expect(url).toMatch(/^https:\/\/my-machine\.tailnet\.ts\.net:8443\/s\/[A-Za-z0-9_-]{8}$/);
  });

  it("detects ts hostname from tailscale status JSON for first share", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n" +
        "if [ \"$1\" = \"status\" ] && [ \"$2\" = \"--json\" ]; then\n" +
        "  printf '{\"Self\":{\"DNSName\":\"detected.tailnet.ts.net.\"}}\\n'\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "first.html");
    writeFileSync(filePath, "<h1>first</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString().trim()).toMatch(/^https:\/\/detected\.tailnet\.ts\.net:8443\/s\/[A-Za-z0-9_-]{8}$/);

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      tsHostname: string;
    };
    expect(state.tsHostname).toBe("detected.tailnet.ts.net");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["status --json", "serve --bg --https=8443 http://localhost:7899"]);
  });

  it("falls back to localhost URL with stderr warning when tailscale is unavailable", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";
    process.env.TAILSERVE_TAILSCALE_BIN = path.join(homeDir, "missing-tailscale");

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "fallback.html");
    writeFileSync(filePath, "<h1>fallback</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString().trim()).toMatch(/^http:\/\/localhost:7899\/s\/[A-Za-z0-9_-]{8}$/);
    expect(stderr.toString().trim()).toBe("Warning: tailscale unavailable, using http://localhost:7899");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      tsHostname: string;
      tsPort: number;
      tsProtocol?: string;
    };
    expect(state.tsHostname).toBe("localhost");
    expect(state.tsPort).toBe(7899);
    expect(state.tsProtocol).toBe("http");
  });

  it("prints one https URL to stdout and exits 0", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "file.html");
    writeFileSync(filePath, "<h1>Hello</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const output = stdout.toString();
    const trimmed = output.trim();

    expect(trimmed).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);
    expect(output).toBe(`${trimmed}\n`);

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { path: string; type: string }>;
    };

    const share = Object.values(state.shares)[0];
    expect(share.path).toBe(path.resolve(filePath));
    expect(share.type).toBe("file");
  });

  it("runs tailscale serve in the background for the first share only", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const firstFilePath = path.join(workspace, "first.html");
    const secondFilePath = path.join(workspace, "second.html");
    writeFileSync(firstFilePath, "<h1>first</h1>\n", "utf8");
    writeFileSync(secondFilePath, "<h1>second</h1>\n", "utf8");

    const firstStdout = new MemoryOutput();
    const firstStderr = new MemoryOutput();
    const firstExitCode = await run(["node", "ts", "share", firstFilePath], firstStdout, firstStderr);

    const secondStdout = new MemoryOutput();
    const secondStderr = new MemoryOutput();
    const secondExitCode = await run(["node", "ts", "share", secondFilePath], secondStdout, secondStderr);

    expect(firstExitCode).toBe(0);
    expect(secondExitCode).toBe(0);
    expect(firstStderr.toString()).toBe("");
    expect(secondStderr.toString()).toBe("");
    expect(firstStdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);
    expect(secondStdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["status --json", "serve --bg --https=8443 http://localhost:7899"]);
  });

  it("supports --public by using the named tunnel hostname and marking the share public", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
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
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "public-share.html");
    writeFileSync(filePath, "<h1>public share</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", "--public", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const url = stdout.toString().trim();
    expect(url).toMatch(/^https:\/\/share\.example\.com\/s\/[A-Za-z0-9_-]{8}$/);
    const id = url.split("/").pop() ?? "";

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<
        string,
        {
          id: string;
          type: string;
          public?: boolean;
        }
      >;
    };

    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.id).toBe(id);
    expect(share.type).toBe("file");
    expect(share.public).toBe(true);

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["status --json", "serve --bg --https=8443 http://localhost:7899"]);
  });

  it("writes setup instructions when --public is requested without a configured named tunnel", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "public-share.html");
    writeFileSync(filePath, "<h1>public share</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", "--public", filePath], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Named tunnel is not configured");
    expect(stderr.toString()).toContain("ts tunnel setup <hostname>");
  });

  it("supports --tunnel by storing a tunnel for the share and printing the tunnel URL", async () => {
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
        "printf '%s\\n' 'https://share-test.trycloudflare.com'\n",
      "utf8",
    );
    chmodSync(fakeCloudflaredPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = cloudflaredCapturePath;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "tunneled-share.html");
    writeFileSync(filePath, "<h1>tunneled share</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", "--tunnel", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toBe("https://share-test.trycloudflare.com\n");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<
        string,
        {
          id: string;
          type: string;
          path?: string;
        }
      >;
      tunnels: Record<
        string,
        {
          pid: number;
          url: string;
          port: number;
          createdAt: string;
        }
      >;
    };

    const shareEntries = Object.entries(state.shares);
    expect(shareEntries).toHaveLength(1);
    const [shareId, share] = shareEntries[0];
    expect(share.id).toBe(shareId);
    expect(share.type).toBe("file");
    expect(share.path).toBe(path.resolve(filePath));

    const tunnel = state.tunnels[shareId];
    expect(tunnel).toBeDefined();
    expect(tunnel.pid).toBeGreaterThan(0);
    expect(tunnel.url).toBe("https://share-test.trycloudflare.com");
    expect(tunnel.port).toBe(7899);
    expect(Number.isNaN(Date.parse(tunnel.createdAt))).toBe(false);

    const capturedCalls = readFileSync(cloudflaredCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["tunnel --url http://localhost:7899"]);
  });

  it("rolls back the share when --tunnel fails to start cloudflared", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const emptyBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-empty-bin-"));
    process.env.PATH = emptyBinDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "failed-tunnel-share.html");
    writeFileSync(filePath, "<h1>failed tunnel share</h1>\n", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", "--tunnel", filePath], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("cloudflared not installed");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, unknown>;
      tunnels: Record<string, unknown>;
    };

    expect(state.shares).toEqual({});
    expect(state.tunnels).toEqual({});
  });

  it("auto-starts the tailserve server when the share port is not running", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_SERVER_AUTOSTART = "1";

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "autostart.html");
    writeFileSync(filePath, "<h1>autostart</h1>\n", "utf8");

    const markerPath = path.join(workspace, "tailserve-server-started.flag");
    const markerLiteral = JSON.stringify(markerPath);
    const pidPath = getServerPidPath();
    const entryPath = path.join(workspace, "tailserve-server-entry.cjs");
    writeFileSync(
      entryPath,
      "const { mkdirSync, writeFileSync } = require('node:fs');\n" +
        "const path = require('node:path');\n" +
        `const pidPath = ${JSON.stringify(pidPath)};\n` +
        `const markerPath = ${markerLiteral};\n` +
        "mkdirSync(path.dirname(pidPath), { recursive: true });\n" +
        "writeFileSync(pidPath, `${process.pid}\\n`, 'utf8');\n" +
        "writeFileSync(markerPath, 'started\\n', 'utf8');\n" +
        "setInterval(() => {}, 1000);\n",
      "utf8",
    );
    process.env.TAILSERVE_SERVER_ENTRY = entryPath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 46789,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    let startedPid: number | undefined;
    try {
      const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");
      expect(stdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/[A-Za-z0-9_-]{8}$/);
      expect(await waitForFile(markerPath)).toBe(true);

      startedPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      expect(Number.isInteger(startedPid)).toBe(true);
      expect(startedPid).toBeGreaterThan(0);
    } finally {
      if (typeof startedPid === "number") {
        try {
          process.kill(startedPid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }
  });

  it("restarts on the next share after a server kill and keeps recent ephemeral shares in state", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_SERVER_AUTOSTART = "1";

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const firstFilePath = path.join(workspace, "restart-share-1.html");
    const secondFilePath = path.join(workspace, "restart-share-2.html");
    const thirdFilePath = path.join(workspace, "restart-share-3.html");
    const fourthFilePath = path.join(workspace, "restart-share-4.html");
    writeFileSync(firstFilePath, "<h1>restart share 1</h1>\n", "utf8");
    writeFileSync(secondFilePath, "<h1>restart share 2</h1>\n", "utf8");
    writeFileSync(thirdFilePath, "<h1>restart share 3</h1>\n", "utf8");
    writeFileSync(fourthFilePath, "<h1>restart share 4</h1>\n", "utf8");

    const pidPath = getServerPidPath();
    const markerPath = path.join(workspace, "restart-server-pids.log");
    const entryPath = path.join(workspace, "tailserve-restart-server-entry.cjs");
    writeFileSync(
      entryPath,
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');\n" +
        "const path = require('node:path');\n" +
        `const pidPath = ${JSON.stringify(pidPath)};\n` +
        `const markerPath = ${JSON.stringify(markerPath)};\n` +
        "mkdirSync(path.dirname(pidPath), { recursive: true });\n" +
        "writeFileSync(pidPath, `${process.pid}\\n`, 'utf8');\n" +
        "appendFileSync(markerPath, `${process.pid}\\n`, 'utf8');\n" +
        "setInterval(() => {}, 1000);\n",
      "utf8",
    );
    process.env.TAILSERVE_SERVER_ENTRY = entryPath;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 48789,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const shareFileAndReturnId = async (targetPath: string): Promise<string> => {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "share", targetPath], stdout, stderr);
      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");
      const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(stdout.toString().trim());
      expect(match).not.toBeNull();
      return match?.[1] ?? "";
    };

    let initialPid = 0;
    try {
      const firstShareId = await shareFileAndReturnId(firstFilePath);
      expect(await waitForFile(markerPath)).toBe(true);
      expect(await waitForFile(pidPath)).toBe(true);

      initialPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      expect(Number.isInteger(initialPid)).toBe(true);
      expect(initialPid).toBeGreaterThan(0);

      const secondShareId = await shareFileAndReturnId(secondFilePath);
      const thirdShareId = await shareFileAndReturnId(thirdFilePath);

      const beforeRestartState = JSON.parse(readFileSync(statePath, "utf8")) as {
        shares: Record<
          string,
          {
            id: string;
            path?: string;
            expiresAt: string | null;
            persist: boolean;
          }
        >;
      };
      expect(Object.keys(beforeRestartState.shares).sort()).toEqual([firstShareId, secondShareId, thirdShareId].sort());

      process.kill(initialPid, "SIGKILL");
      const killed = await waitForPredicate(() => {
        try {
          process.kill(initialPid, 0);
          return false;
        } catch (error: unknown) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      });
      expect(killed).toBe(true);

      const fourthShareId = await shareFileAndReturnId(fourthFilePath);

      const restarted = await waitForPredicate(() => {
        if (!existsSync(pidPath)) {
          return false;
        }

        const rawPid = readFileSync(pidPath, "utf8").trim();
        if (!/^\d+$/.test(rawPid)) {
          return false;
        }

        const pid = Number.parseInt(rawPid, 10);
        if (pid <= 0 || pid === initialPid) {
          return false;
        }

        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      expect(restarted).toBe(true);
      expect(readFileSync(markerPath, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2);

      const resolved = resolveRequest({
        method: "GET",
        url: `/s/${fourthShareId}`,
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.filePath).toBe(path.resolve(fourthFilePath));

      const afterRestartState = JSON.parse(readFileSync(statePath, "utf8")) as {
        shares: Record<
          string,
          {
            id: string;
            path?: string;
            expiresAt: string | null;
            persist: boolean;
          }
        >;
      };

      const expectedShareIds = [firstShareId, secondShareId, thirdShareId, fourthShareId];
      expect(Object.keys(afterRestartState.shares).sort()).toEqual(expectedShareIds.sort());

      for (const shareId of [firstShareId, secondShareId, thirdShareId]) {
        const share = afterRestartState.shares[shareId];
        expect(share).toBeDefined();
        expect(share.persist).toBe(false);
        expect(share.expiresAt).not.toBeNull();
        expect(Date.parse(share.expiresAt ?? "")).toBeGreaterThan(Date.now());
      }
    } finally {
      await run(["node", "ts", "server", "stop"], new MemoryOutput(), new MemoryOutput());

      if (initialPid > 0) {
        try {
          process.kill(initialPid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }
  });

  it("recovers from a stale tailscale serve mapping by auto-starting and serving the shared content", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_SERVER_AUTOSTART = "1";
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    writeFileSync(tailscaleCapturePath, "", "utf8");

    const sharePort = 48789;
    const tsPort = 8443;
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n" +
        "if [ \"$1\" = \"status\" ] && [ \"$2\" = \"--json\" ]; then\n" +
        "  printf '{\"Self\":{\"DNSName\":\"demo.tailnet.ts.net.\"}}\\n'\n" +
        "fi\n" +
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'https://demo.tailnet.ts.net:8443\\n'\n" +
        `  printf '|-- / proxy http://localhost:${sharePort}\\n'\n` +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    const statePath = path.join(homeDir, ".tailserve", "state.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: sharePort,
        tsHostname: "demo.tailnet.ts.net",
        tsPort,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "stale-route-recovery.html");
    const fileContent = "<h1>stale route recovery</h1>\n";
    writeFileSync(filePath, fileContent, "utf8");
    const markerPath = path.join(workspace, "tailserve-server-stale-route-started.flag");
    const customServerEntryPath = path.join(workspace, "tailserve-test-server-entry.mjs");
    const distServerPath = path.resolve(process.cwd(), "dist", "server.js");
    const distStatePath = path.resolve(process.cwd(), "dist", "state.js");
    writeFileSync(
      customServerEntryPath,
      `import { mkdirSync, writeFileSync } from "node:fs";\n` +
      `import path from "node:path";\n` +
      `import { createTailserveServer } from ${JSON.stringify(distServerPath)};\n` +
        `import { getServerPidPath } from ${JSON.stringify(distStatePath)};\n` +
        `const markerPath = ${JSON.stringify(markerPath)};\n` +
        "createTailserveServer();\n" +
        "const pidPath = getServerPidPath();\n" +
        "mkdirSync(path.dirname(pidPath), { recursive: true });\n" +
        "writeFileSync(pidPath, `${process.pid}\\n`, 'utf8');\n" +
        "writeFileSync(markerPath, 'started\\n', 'utf8');\n" +
        "setInterval(() => {}, 1000);\n",
      "utf8",
    );
    process.env.TAILSERVE_SERVER_ENTRY = customServerEntryPath;

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");
      const shareUrl = stdout.toString().trim();
      const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(shareUrl);
      expect(match).not.toBeNull();
      const shareId = match?.[1] ?? "";
      expect(shareId).not.toBe("");
      expect(await waitForFile(markerPath)).toBe(true);

      const resolved = resolveRequest({
        method: "GET",
        url: `/s/${shareId}`,
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.filePath).toBe(path.resolve(filePath));
      expect(readFileSync(resolved.filePath ?? "", "utf8")).toBe(fileContent);

      const capturedCalls = readFileSync(tailscaleCapturePath, "utf8");
      expect(capturedCalls).toContain("serve status\n");
      expect(capturedCalls).toContain(`serve --bg --https=${tsPort} http://localhost:${sharePort}\n`);
    } finally {
      await run(["node", "ts", "server", "stop"], new MemoryOutput(), new MemoryOutput());
    }
  });

  it("fails gracefully when default port 7899 is already occupied", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_SERVER_AUTOSTART = "1";

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "port-in-use.html");
    writeFileSync(filePath, "<h1>port in use</h1>\n", "utf8");

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 7899,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const binDir = path.join(workspace, "bin");
    mkdirSync(binDir, { recursive: true });
    const lsofPath = path.join(binDir, "lsof");
    writeFileSync(
      lsofPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"-ti\" ] && [ \"$2\" = \":7899\" ]; then\n" +
        "  echo 4321\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(lsofPath, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "share", filePath], stdout, stderr);

      expect(exitCode).toBe(1);
      expect(stdout.toString()).toBe("");
      expect(stderr.toString()).toContain("port 7899 is already in use");
      expect(stderr.toString()).toContain("lsof -i :7899");
      expect(stderr.toString()).toContain("ts server stop");

      const state = JSON.parse(readFileSync(statePath, "utf8")) as { shares: Record<string, unknown> };
      expect(Object.keys(state.shares)).toHaveLength(0);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("writes errors to stderr and exits non-zero", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "share", "./missing.html"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("File not found");
  });
});

describe("ts edit", () => {
  it("prints one https URL to stdout and persists an edit share", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "file.json");
    writeFileSync(filePath, '{ "hello": "world" }\n', "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "edit", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const url = stdout.toString().trim();
    const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(url);
    expect(match).not.toBeNull();
    const id = match?.[1] ?? "";

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<
        string,
        {
          id: string;
          type: string;
          path: string;
          createdAt: string;
          expiresAt: string | null;
          persist: boolean;
          readonly: boolean;
        }
      >;
    };

    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.id).toBe(id);
    expect(share.type).toBe("edit");
    expect(share.path).toBe(path.resolve(filePath));
    expect(share.persist).toBe(false);
    expect(share.readonly).toBe(false);
    expectDefaultTtlWindow(share.createdAt, share.expiresAt);
  });

  it("supports --public by using the named tunnel hostname and marking the edit share public", async () => {
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
        hostname: "edit.example.com",
        credentialsPath: `${homeDir}/.cloudflared/tailserve.json`,
      },
    });

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "public-edit.json");
    writeFileSync(filePath, '{ "hello": "public" }\n', "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "edit", "--public", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const url = stdout.toString().trim();
    expect(url).toMatch(/^https:\/\/edit\.example\.com\/s\/[A-Za-z0-9_-]{8}$/);
    const id = url.split("/").pop() ?? "";

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { id: string; type: string; public?: boolean }>;
    };
    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.id).toBe(id);
    expect(share.type).toBe("edit");
    expect(share.public).toBe(true);
  });

  it("writes setup instructions when edit --public is requested without a configured named tunnel", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "missing-public-config.json");
    writeFileSync(filePath, '{ "hello": "world" }\n', "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "edit", "--public", filePath], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Named tunnel is not configured");
    expect(stderr.toString()).toContain("ts tunnel setup <hostname>");
  });

  it("supports --readonly and --persist options", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "readonly.json");
    writeFileSync(filePath, '{ "readonly": true }\n', "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "edit", "--readonly", "--persist", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    const url = stdout.toString().trim();
    const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(url);
    expect(match).not.toBeNull();
    const id = match?.[1] ?? "";

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { persist: boolean; readonly: boolean; expiresAt: string | null }>;
    };
    const share = state.shares[id];

    expect(share.persist).toBe(true);
    expect(share.readonly).toBe(true);
    expect(share.expiresAt).toBeNull();
  });

  it("supports --ttl overrides", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "ttl.json");
    writeFileSync(filePath, '{ "ttl": "1h" }\n', "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "edit", "--ttl", "1h", filePath], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    const url = stdout.toString().trim();
    const match = /^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/.exec(url);
    expect(match).not.toBeNull();
    const id = match?.[1] ?? "";

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { createdAt: string; expiresAt: string | null }>;
    };
    const share = state.shares[id];
    expectTtlWindow(share.createdAt, share.expiresAt, 60 * 60 * 1000);
  });
});

describe("ts project", () => {
  it("prints a /p/<name> project URL with ts hostname and port", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "my-machine.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const projectDir = path.join(workspace, "reelfit");
    mkdirSync(projectDir, { recursive: true });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", projectDir, "--name", "reelfit", "--port", "8794"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toBe("https://my-machine.tailnet.ts.net:8443/p/reelfit\n");
  });

  it("persists project configuration under state.projects[name]", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const projectDir = path.join(workspace, "reelfit");
    mkdirSync(projectDir, { recursive: true });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", projectDir, "--name", "reelfit", "--port", "8794"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/p\/reelfit$/);

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      projects: Record<
        string,
        {
          name: string;
          path: string;
          port: number;
          createdAt: string;
          status: string;
        }
      >;
    };

    expect(state.projects.reelfit).toBeDefined();
    expect(state.projects.reelfit.name).toBe("reelfit");
    expect(state.projects.reelfit.path).toBe(path.resolve(projectDir));
    expect(state.projects.reelfit.port).toBe(8794);
    expect(state.projects.reelfit.status).toBe("online");
    expect(Number.isNaN(Date.parse(state.projects.reelfit.createdAt))).toBe(false);
  });

  it("persists project start command when --start is provided", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const projectDir = path.join(workspace, "reelfit");
    mkdirSync(projectDir, { recursive: true });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(
      ["node", "ts", "project", projectDir, "--name", "reelfit", "--port", "8794", "--start", "npm run dev"],
      stdout,
      stderr,
    );

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/p\/reelfit$/);

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      projects: Record<string, { startCmd?: string }>;
    };

    expect(state.projects.reelfit).toBeDefined();
    expect(state.projects.reelfit.startCmd).toBe("npm run dev");
  });

  it("persists project configuration under projects when existing projects value is invalid", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "my-machine.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: "invalid",
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const projectDir = path.join(workspace, "reelfit");
    mkdirSync(projectDir, { recursive: true });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", projectDir, "--name", "reelfit", "--port", "8794"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toBe("https://my-machine.tailnet.ts.net:8443/p/reelfit\n");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      projects: Record<string, { name: string; path: string; port: number; status: string }>;
    };

    expect(state.projects).toHaveProperty("reelfit");
    expect(state.projects.reelfit.name).toBe("reelfit");
    expect(state.projects.reelfit.path).toBe(path.resolve(projectDir));
    expect(state.projects.reelfit.port).toBe(8794);
    expect(state.projects.reelfit.status).toBe("online");
  });

  it("stores projects without TTL fields", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const projectDir = path.join(workspace, "reelfit");
    mkdirSync(projectDir, { recursive: true });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", projectDir, "--name", "reelfit", "--port", "8794"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString().trim()).toMatch(/^https:\/\/[^/\s]+:\d+\/p\/reelfit$/);

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      projects: Record<string, Record<string, unknown>>;
    };

    expect(state.projects.reelfit).toBeDefined();
    expect("expiresAt" in state.projects.reelfit).toBe(false);
    expect("persist" in state.projects.reelfit).toBe(false);
  });

  it("removes projects only with ts project rm <name>", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const reelfitPath = path.join(workspace, "reelfit");
    const keptPath = path.join(workspace, "kept");
    mkdirSync(reelfitPath, { recursive: true });
    mkdirSync(keptPath, { recursive: true });

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {},
        projects: {
          reelfit: {
            name: "reelfit",
            path: reelfitPath,
            status: "online",
          },
          kept: {
            name: "kept",
            path: keptPath,
            status: "online",
          },
        },
      })}\n`,
      "utf8",
    );

    const routeBefore = resolveRequest({ method: "GET", url: "/p/reelfit" });
    expect(routeBefore.statusCode).toBe(200);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", "rm", "reelfit"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      projects: Record<string, { name: string; path: string; status: string }>;
    };

    expect(state.projects.reelfit).toBeUndefined();
    expect(state.projects.kept).toEqual({ name: "kept", path: keptPath, status: "online" });

    const routeAfter = resolveRequest({ method: "GET", url: "/p/reelfit" });
    expect(routeAfter.statusCode).toBe(404);
  });

  it("removes legacy project entries that match by stored project name", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {},
        projects: {
          "legacy-route": {
            name: "reelfit",
            path: "/tmp/reelfit",
            status: "online",
          },
          kept: {
            name: "kept",
            path: "/tmp/kept",
            status: "online",
          },
        },
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", "rm", "reelfit"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      projects: Record<string, { name: string; path: string; status: string }>;
    };

    expect(state.projects["legacy-route"]).toBeUndefined();
    expect(state.projects.kept).toEqual({ name: "kept", path: "/tmp/kept", status: "online" });
  });
});

describe("ts project list", () => {
  it("outputs project table with name, path, port, URL, status, and startCmd columns", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const docsPath = path.join(workspace, "docs");
    const reelfitPath = path.join(workspace, "reelfit");

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {},
        projects: {
          docs: {
            name: "docs",
            path: docsPath,
            status: "offline",
          },
          reelfit: {
            name: "reelfit",
            path: reelfitPath,
            port: 8794,
            status: "online",
            startCmd: "npm run dev",
          },
        },
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", "list"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const rows = parseTableOutput(stdout.toString());
    expect(rows[0]).toEqual(["Name", "Path", "Port", "URL", "Status", "StartCmd"]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(["docs", docsPath, "-", "https://demo.tailnet.ts.net:443/p/docs", "offline", "-"]);
    expect(rows[2]).toEqual([
      "reelfit",
      reelfitPath,
      "8794",
      "https://demo.tailnet.ts.net:443/p/reelfit",
      "online",
      "npm run dev",
    ]);
  });

  it("outputs JSON array with name, path, port, url, status, and startCmd fields", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const docsPath = path.join(workspace, "docs");
    const reelfitPath = path.join(workspace, "reelfit");

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {},
        projects: {
          docs: {
            name: "docs",
            path: docsPath,
          },
          reelfit: {
            name: "reelfit",
            path: reelfitPath,
            port: 8794,
            status: "online",
            startCmd: "npm run dev",
          },
        },
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "project", "list", "--json"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    expect(JSON.parse(stdout.toString())).toEqual([
      {
        name: "docs",
        path: docsPath,
        port: null,
        url: "https://demo.tailnet.ts.net:443/p/docs",
        status: "offline",
        startCmd: null,
      },
      {
        name: "reelfit",
        path: reelfitPath,
        port: 8794,
        url: "https://demo.tailnet.ts.net:443/p/reelfit",
        status: "online",
        startCmd: "npm run dev",
      },
    ]);
  });

  it("outputs a JSON array via the bin/ts entrypoint", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const reelfitPath = path.join(workspace, "reelfit");

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {},
        projects: {
          reelfit: {
            name: "reelfit",
            path: reelfitPath,
            port: 8794,
            status: "online",
            startCmd: "npm run dev",
          },
        },
      })}\n`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(projectRoot, "bin", "ts"), "project", "list", "--json"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeDir,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      {
        name: "reelfit",
        path: reelfitPath,
        port: 8794,
        url: "https://demo.tailnet.ts.net:443/p/reelfit",
        status: "online",
        startCmd: "npm run dev",
      },
    ]);
  });
});

describe("ts proxy", () => {
  it("creates a proxy share to localhost:<port> and prints one https URL", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "proxy", "8794"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const output = stdout.toString();
    const trimmed = output.trim();
    expect(trimmed).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/);
    expect(output).toBe(`${trimmed}\n`);

    const id = trimmed.split("/").pop() ?? "";
    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<
        string,
        {
          id: string;
          type: string;
          port?: number;
          createdAt: string;
          expiresAt: string | null;
          persist: boolean;
          readonly: boolean;
        }
      >;
    };

    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.id).toBe(id);
    expect(share.type).toBe("proxy");
    expect(share.port).toBe(8794);
    expect(share.persist).toBe(false);
    expect(share.readonly).toBe(false);
    expectDefaultTtlWindow(share.createdAt, share.expiresAt);
  });

  it("creates a named project proxy when --name is provided", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const originalCwd = process.cwd();
    process.chdir(workspace);
    const expectedProjectPath = path.resolve(process.cwd());

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await run(["node", "ts", "proxy", "8794", "--name", "reelfit"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const output = stdout.toString();
      const trimmed = output.trim();
      expect(trimmed).toMatch(/^https:\/\/[^/\s]+:\d+\/p\/reelfit$/);
      expect(output).toBe(`${trimmed}\n`);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        shares: Record<string, unknown>;
        projects: Record<
          string,
          {
            name: string;
            path: string;
            port: number;
            status: string;
            createdAt: string;
          }
        >;
      };

      expect(state.shares).toEqual({});
      expect(state.projects.reelfit).toBeDefined();
      expect(state.projects.reelfit.name).toBe("reelfit");
      expect(state.projects.reelfit.path).toBe(expectedProjectPath);
      expect(state.projects.reelfit.port).toBe(8794);
      expect(state.projects.reelfit.status).toBe("online");
      expect(Number.isNaN(Date.parse(state.projects.reelfit.createdAt))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("supports --public by using the named tunnel hostname and marking proxy shares public", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
        namedTunnel: {
          name: "tailserve",
          uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          hostname: "proxy.example.com",
          credentialsPath: `${homeDir}/.cloudflared/tailserve.json`,
        },
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "proxy", "8794", "--public"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const url = stdout.toString().trim();
    expect(url).toMatch(/^https:\/\/proxy\.example\.com\/s\/[A-Za-z0-9_-]{8}$/);
    const id = url.split("/").pop() ?? "";

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<
        string,
        {
          id: string;
          type: string;
          port?: number;
          public?: boolean;
        }
      >;
    };
    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.id).toBe(id);
    expect(share.type).toBe("proxy");
    expect(share.port).toBe(8794);
    expect(share.public).toBe(true);

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["status --json", "serve --bg --https=8443 http://localhost:7899"]);
  });

  it("supports --public with --name by creating a public project route on the named tunnel hostname", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
        namedTunnel: {
          name: "tailserve",
          uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          hostname: "projects.example.com",
          credentialsPath: `${homeDir}/.cloudflared/tailserve.json`,
        },
      })}\n`,
      "utf8",
    );

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const originalCwd = process.cwd();
    process.chdir(workspace);
    const expectedProjectPath = path.resolve(process.cwd());

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await run(["node", "ts", "proxy", "8794", "--name", "reelfit", "--public"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");
      expect(stdout.toString().trim()).toBe("https://projects.example.com/p/reelfit");

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        shares: Record<string, unknown>;
        projects: Record<
          string,
          {
            name: string;
            path: string;
            port: number;
            status: string;
            public?: boolean;
          }
        >;
      };

      expect(state.shares).toEqual({});
      expect(state.projects.reelfit).toBeDefined();
      expect(state.projects.reelfit.name).toBe("reelfit");
      expect(state.projects.reelfit.path).toBe(expectedProjectPath);
      expect(state.projects.reelfit.port).toBe(8794);
      expect(state.projects.reelfit.status).toBe("online");
      expect(state.projects.reelfit.public).toBe(true);

      const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
      expect(capturedCalls).toEqual(["status --json", "serve --bg --https=8443 http://localhost:7899"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("writes setup instructions when proxy --public is requested without a configured named tunnel", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "proxy", "8794", "--public"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Named tunnel is not configured");
    expect(stderr.toString()).toContain("ts tunnel setup <hostname>");
  });

  it("writes errors to stderr and exits non-zero for invalid ports", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "proxy", "99999"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Invalid port");
  });
});

describe("ts funnel", () => {
  it("creates a public proxy share and enables tailscale funnel route", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 8443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "funnel", "8794"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const output = stdout.toString();
    const trimmed = output.trim();
    expect(trimmed).toMatch(/^https:\/\/[^/\s]+:\d+\/s\/([A-Za-z0-9_-]{8})$/);
    expect(output).toBe(`${trimmed}\n`);

    const id = trimmed.split("/").pop() ?? "";
    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<
        string,
        {
          id: string;
          type: string;
          port?: number;
          createdAt: string;
          expiresAt: string | null;
          persist: boolean;
          readonly: boolean;
          public?: boolean;
        }
      >;
    };

    const share = state.shares[id];
    expect(share).toBeDefined();
    expect(share.id).toBe(id);
    expect(share.type).toBe("proxy");
    expect(share.port).toBe(8794);
    expect(share.persist).toBe(false);
    expect(share.readonly).toBe(false);
    expect(share.public).toBe(true);
    expectDefaultTtlWindow(share.createdAt, share.expiresAt);

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["status --json", "funnel --bg --https=8443 http://localhost:7899"]);
  });

  it("creates a named public project route when --name is provided", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const originalCwd = process.cwd();
    process.chdir(workspace);
    const expectedProjectPath = path.resolve(process.cwd());

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await run(["node", "ts", "funnel", "8794", "--name", "reelfit"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const output = stdout.toString();
      const trimmed = output.trim();
      expect(trimmed).toMatch(/^https:\/\/[^/\s]+:\d+\/p\/reelfit$/);
      expect(output).toBe(`${trimmed}\n`);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        shares: Record<string, unknown>;
        projects: Record<
          string,
          {
            name: string;
            path: string;
            port: number;
            status: string;
            createdAt: string;
            public?: boolean;
          }
        >;
      };

      expect(state.shares).toEqual({});
      expect(state.projects.reelfit).toBeDefined();
      expect(state.projects.reelfit.name).toBe("reelfit");
      expect(state.projects.reelfit.path).toBe(expectedProjectPath);
      expect(state.projects.reelfit.port).toBe(8794);
      expect(state.projects.reelfit.status).toBe("online");
      expect(state.projects.reelfit.public).toBe(true);
      expect(Number.isNaN(Date.parse(state.projects.reelfit.createdAt))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("writes errors to stderr and exits non-zero for invalid ports", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "funnel", "99999"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Invalid port");
  });
});

describe("ts tunnel setup", () => {
  it("configures a named tunnel, saves state, starts cloudflared, and prints url to stdout", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const certPath = path.join(homeDir, ".cloudflared", "cert.pem");
    mkdirSync(path.dirname(certPath), { recursive: true });
    writeFileSync(certPath, "auth-cert", "utf8");

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const cloudflaredCapturePath = path.join(homeDir, "cloudflared-calls.log");
    const fakeCloudflaredPath = path.join(fakeBinDir, "cloudflared");
    writeFileSync(
      fakeCloudflaredPath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_CLOUDFLARED_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_CLOUDFLARED_CAPTURE\"\n" +
        "fi\n" +
        "if [ \"$1\" = \"tunnel\" ] && [ \"$2\" = \"create\" ]; then\n" +
        "  printf '%s\\n' \"Created tunnel $3 with id f47ac10b-58cc-4372-a567-0e02b2c3d479\" >&2\n" +
        "  printf '%s\\n' \"$HOME/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json\" >&2\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeCloudflaredPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = cloudflaredCapturePath;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "tunnel", "setup", "share.example.com"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("✓ Named tunnel ready at https://share.example.com\n");
    expect(stdout.toString()).toBe("https://share.example.com\n");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      namedTunnel: {
        name: string;
        uuid: string;
        hostname: string;
        credentialsPath: string;
      };
      namedTunnelPid?: number;
    };

    expect(state.namedTunnel).toEqual({
      name: "tailserve",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      hostname: "share.example.com",
      credentialsPath: path.join(homeDir, ".cloudflared", "f47ac10b-58cc-4372-a567-0e02b2c3d479.json"),
    });
    expect(state.namedTunnelPid).toBeUndefined();

    const configPath = path.join(homeDir, ".tailserve", "cloudflared-config.yml");
    expect(existsSync(configPath)).toBe(true);
    const config = readFileSync(configPath, "utf8");
    expect(config).toBe(
      [
        "tunnel: f47ac10b-58cc-4372-a567-0e02b2c3d479",
        `credentials-file: ${path.join(homeDir, ".cloudflared", "f47ac10b-58cc-4372-a567-0e02b2c3d479.json")}`,
        "",
        "ingress:",
        "  - hostname: share.example.com",
        "    service: http://127.0.0.1:7899",
        "  - service: http_status:404",
        "",
      ].join("\n"),
    );

    await expect(
      waitForPredicate(() => {
        if (!existsSync(cloudflaredCapturePath)) {
          return false;
        }

        const calls = readFileSync(cloudflaredCapturePath, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line.length > 0);
        return calls.length >= 3;
      }),
    ).resolves.toBe(true);

    const capturedCalls = readFileSync(cloudflaredCapturePath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(capturedCalls).toEqual([
      "tunnel create tailserve",
      "tunnel route dns tailserve share.example.com",
      `tunnel --config ${configPath} run tailserve`,
    ]);
  });

  it("prints full auto-setup progress to stderr in order", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const installedMarkerPath = path.join(homeDir, ".tailserve", "cloudflared-installed");

    const fakeWhichPath = path.join(fakeBinDir, "which");
    writeFileSync(
      fakeWhichPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"cloudflared\" ] && [ -f \"$HOME/.tailserve/cloudflared-installed\" ]; then\n" +
        "  printf '%s\\n' \"$HOME/bin/cloudflared\"\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeWhichPath, 0o755);

    const fakeBrewPath = path.join(fakeBinDir, "brew");
    writeFileSync(
      fakeBrewPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"cloudflared\" ]; then\n" +
        "  mkdir -p \"$HOME/.tailserve\"\n" +
        "  : > \"$HOME/.tailserve/cloudflared-installed\"\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeBrewPath, 0o755);

    const fakeCloudflaredPath = path.join(fakeBinDir, "cloudflared");
    writeFileSync(
      fakeCloudflaredPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"tunnel\" ] && [ \"$2\" = \"login\" ]; then\n" +
        "  mkdir -p \"$HOME/.cloudflared\"\n" +
        "  : > \"$HOME/.cloudflared/cert.pem\"\n" +
        "  exit 0\n" +
        "fi\n" +
        "if [ \"$1\" = \"tunnel\" ] && [ \"$2\" = \"create\" ]; then\n" +
        "  printf '%s\\n' \"Created tunnel $3 with id f47ac10b-58cc-4372-a567-0e02b2c3d479\" >&2\n" +
        "  printf '%s\\n' \"$HOME/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json\" >&2\n" +
        "fi\n" +
        "exit 0\n",
      "utf8",
    );
    chmodSync(fakeCloudflaredPath, 0o755);

    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "tunnel", "setup", "share.example.com"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(existsSync(installedMarkerPath)).toBe(true);
    expect(stdout.toString()).toBe("https://share.example.com\n");

    const progress = stderr.toString();
    expect(progress).toContain("Installing cloudflared...");
    expect(progress).toContain("✓ cloudflared installed");
    expect(progress).toContain("Opening browser for Cloudflare login...");
    expect(progress).toContain("✓ Cloudflare authenticated");
    expect(progress).toContain("✓ Named tunnel ready at https://share.example.com");

    const installIndex = progress.indexOf("Installing cloudflared...");
    const installDoneIndex = progress.indexOf("✓ cloudflared installed");
    const loginIndex = progress.indexOf("Opening browser for Cloudflare login...");
    const loginDoneIndex = progress.indexOf("✓ Cloudflare authenticated");
    const readyIndex = progress.indexOf("✓ Named tunnel ready at https://share.example.com");

    expect(installDoneIndex).toBeGreaterThan(installIndex);
    expect(loginIndex).toBeGreaterThan(installDoneIndex);
    expect(loginDoneIndex).toBeGreaterThan(loginIndex);
    expect(readyIndex).toBeGreaterThan(loginDoneIndex);
  });

  it("auto-attempts cloudflare login when auth is missing", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    const loginAttemptMarkerPath = path.join(homeDir, ".cloudflared", "login-attempted");

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakeCloudflaredPath = path.join(fakeBinDir, "cloudflared");
    // fake cloudflared that succeeds for `which` but fails for `tunnel login`
    writeFileSync(
      fakeCloudflaredPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"tunnel\" ] && [ \"$2\" = \"login\" ]; then\n" +
        "  mkdir -p \"$HOME/.cloudflared\"\n" +
        "  : > \"$HOME/.cloudflared/login-attempted\"\n" +
        "  exit 1\n" +
        "fi\n" +
        "exit 0\n",
      "utf8",
    );
    chmodSync(fakeCloudflaredPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "tunnel", "setup", "share.example.com"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stderr.toString()).toContain("Opening browser for Cloudflare login");
    expect(existsSync(loginAttemptMarkerPath)).toBe(true);
    expect(existsSync(path.join(homeDir, ".tailserve", "state.json"))).toBe(false);
  });

  it("auto-attempts brew install when cloudflared is unavailable", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    const brewAttemptMarkerPath = path.join(homeDir, "brew-install-attempted");

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakeWhichPath = path.join(fakeBinDir, "which");
    writeFileSync(fakeWhichPath, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(fakeWhichPath, 0o755);
    const fakeBrewPath = path.join(fakeBinDir, "brew");
    writeFileSync(
      fakeBrewPath,
      "#!/bin/sh\n" +
        ": > \"$HOME/brew-install-attempted\"\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeBrewPath, 0o755);
    process.env.PATH = fakeBinDir;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "tunnel", "setup", "share.example.com"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stderr.toString()).toContain("Installing cloudflared...");
    expect(stderr.toString()).toContain("Failed to install cloudflared via brew");
    expect(existsSync(brewAttemptMarkerPath)).toBe(true);
    expect(existsSync(path.join(homeDir, ".tailserve", "state.json"))).toBe(false);
  });

  it("fails when a named tunnel already exists and prints the existing config", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
      tunnels: {},
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: "/home/example/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "tunnel", "setup", "new.example.com"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Named tunnel is already configured:");
    expect(stderr.toString()).toContain("tailserve-main");
    expect(stderr.toString()).toContain("share.example.com");
    expect(stderr.toString()).toContain("Run `ts tunnel remove` first.");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      namedTunnel: {
        name: string;
        uuid: string;
        hostname: string;
        credentialsPath: string;
      };
    };
    expect(state.namedTunnel).toEqual({
      name: "tailserve-main",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      hostname: "share.example.com",
      credentialsPath: "/home/example/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
    });
  });

  it("shows named tunnel config and running state in `ts tunnel status`", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
      tunnels: {},
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: "/home/example/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakePsPath = path.join(fakeBinDir, "ps");
    writeFileSync(fakePsPath, "#!/bin/sh\nprintf \"%b\" \"$TAILSERVE_PS_OUTPUT\"\n", "utf8");
    chmodSync(fakePsPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_PS_OUTPUT = "2468 /usr/local/bin/cloudflared tunnel --config /tmp/c.yml run tailserve-main\\n";

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "tunnel", "status"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("Name");
    expect(stdout.toString()).toContain("tailserve-main");
    expect(stdout.toString()).toContain("Hostname");
    expect(stdout.toString()).toContain("share.example.com");
    expect(stdout.toString()).toContain("UUID");
    expect(stdout.toString()).toContain("f47ac10b-58cc-4372-a567-0e02b2c3d479");
    expect(stdout.toString()).toContain("Cloudflared");
    expect(stdout.toString()).toContain("running");
  });

  it("reuses existing tunnel config when rerunning setup with no hostname", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
      tunnels: {},
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: path.join(homeDir, ".cloudflared", "f47ac10b-58cc-4372-a567-0e02b2c3d479.json"),
      },
    });

    mkdirSync(path.join(homeDir, ".cloudflared"), { recursive: true });
    writeFileSync(path.join(homeDir, ".cloudflared", "f47ac10b-58cc-4372-a567-0e02b2c3d479.json"), "{}\n", "utf8");

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const cloudflaredCapturePath = path.join(homeDir, "cloudflared-calls.log");
    const fakeCloudflaredPath = path.join(fakeBinDir, "cloudflared");
    writeFileSync(
      fakeCloudflaredPath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_CLOUDFLARED_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_CLOUDFLARED_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeCloudflaredPath, 0o755);

    const fakePsPath = path.join(fakeBinDir, "ps");
    writeFileSync(fakePsPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(fakePsPath, 0o755);

    process.env.PATH = fakeBinDir + path.delimiter + (originalPath ?? "");
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = cloudflaredCapturePath;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "tunnel", "setup"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("https://share.example.com\n");
    expect(stderr.toString()).toContain("✓ Named tunnel already configured at https://share.example.com");

    await expect(waitForFile(cloudflaredCapturePath)).resolves.toBe(true);
    const capturedCalls = readFileSync(cloudflaredCapturePath, "utf8").trim().split("\n").filter((line) => line.length > 0);
    const configPath = path.join(homeDir, ".tailserve", "cloudflared-config.yml");
    expect(capturedCalls).toEqual(["tunnel --config " + configPath + " run tailserve-main"]);
  });

  it("starts the named tunnel only when stopped", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
      tunnels: {},
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: "/home/example/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const cloudflaredCapturePath = path.join(homeDir, "cloudflared-calls.log");
    const fakeCloudflaredPath = path.join(fakeBinDir, "cloudflared");
    const fakePsPath = path.join(fakeBinDir, "ps");
    writeFileSync(
      fakeCloudflaredPath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_CLOUDFLARED_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_CLOUDFLARED_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    writeFileSync(fakePsPath, "#!/bin/sh\nprintf \"%b\" \"$TAILSERVE_PS_OUTPUT\"\n", "utf8");
    chmodSync(fakeCloudflaredPath, 0o755);
    chmodSync(fakePsPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = cloudflaredCapturePath;
    process.env.TAILSERVE_PS_OUTPUT = "";

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const firstExitCode = await run(["node", "ts", "tunnel", "start"], stdout, stderr);
    expect(firstExitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    await expect(waitForFile(cloudflaredCapturePath)).resolves.toBe(true);
    const startCalls = readFileSync(cloudflaredCapturePath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(startCalls).toEqual([`tunnel --config ${path.join(homeDir, ".tailserve", "cloudflared-config.yml")} run tailserve-main`]);

    writeFileSync(cloudflaredCapturePath, "", "utf8");
    process.env.TAILSERVE_PS_OUTPUT = "2468 /usr/local/bin/cloudflared tunnel --config /tmp/c.yml run tailserve-main\\n";

    const secondExitCode = await run(["node", "ts", "tunnel", "start"], stdout, stderr);
    expect(secondExitCode).toBe(0);
    expect(readFileSync(cloudflaredCapturePath, "utf8")).toBe("");
  });

  it("stops and removes a configured named tunnel", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    writeStateFile(homeDir, {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {},
      projects: {},
      tunnels: {},
      namedTunnel: {
        name: "tailserve-main",
        uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        hostname: "share.example.com",
        credentialsPath: "/home/example/.cloudflared/f47ac10b-58cc-4372-a567-0e02b2c3d479.json",
      },
    });

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const cloudflaredCapturePath = path.join(homeDir, "cloudflared-calls.log");
    const fakeCloudflaredPath = path.join(fakeBinDir, "cloudflared");
    const fakePsPath = path.join(fakeBinDir, "ps");
    writeFileSync(
      fakeCloudflaredPath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_CLOUDFLARED_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_CLOUDFLARED_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    writeFileSync(fakePsPath, "#!/bin/sh\nprintf \"%b\" \"$TAILSERVE_PS_OUTPUT\"\n", "utf8");
    chmodSync(fakeCloudflaredPath, 0o755);
    chmodSync(fakePsPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_CLOUDFLARED_CAPTURE = cloudflaredCapturePath;
    process.env.TAILSERVE_PS_OUTPUT = "2468 /usr/local/bin/cloudflared tunnel --config /tmp/c.yml run tailserve-main\\n";

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const stopExitCode = await run(["node", "ts", "tunnel", "stop"], stdout, stderr);
    expect(stopExitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const removeExitCode = await run(["node", "ts", "tunnel", "remove"], stdout, stderr);
    expect(removeExitCode).toBe(0);

    const removeCalls = readFileSync(cloudflaredCapturePath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(removeCalls).toContain("tunnel delete tailserve-main");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      namedTunnel?: unknown;
      namedTunnelPid?: unknown;
    };
    expect(state.namedTunnel).toBeUndefined();
    expect(state.namedTunnelPid).toBeUndefined();
  });
});

describe("ts list", () => {
  it("outputs table columns and rows with URL, access, status, and expires values, excluding expired shares", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "file.html");
    const dirPath = path.join(workspace, "my-dir");
    const projectPath = path.join(workspace, "reelfit");

    const futureExpiry = "2099-01-01T00:00:00.000Z";
    const pastExpiry = "2000-01-01T00:00:00.000Z";

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {
          file0001: {
            id: "file0001",
            type: "file",
            path: filePath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: futureExpiry,
            persist: false,
            readonly: false,
            public: false,
          },
          dir00001: {
            id: "dir00001",
            type: "dir",
            path: dirPath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: pastExpiry,
            persist: false,
            readonly: false,
          },
          prox0001: {
            id: "prox0001",
            type: "proxy",
            port: 5173,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
            public: true,
            status: "offline",
          },
        },
        projects: {
          reelfit: {
            id: "proj0001",
            name: "reelfit",
            path: projectPath,
            port: 8794,
            status: "online",
            public: true,
            createdAt: "2026-02-16T00:00:00.000Z",
          },
        },
        tunnels: {
          tun00001: {
            pid: 4242,
            url: "https://demo.trycloudflare.com",
            port: 4173,
            createdAt: "2026-02-16T00:00:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "list"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    const rows = parseTableOutput(stdout.toString());
    expect(rows[0]).toEqual(["ID", "Type", "Path", "URL", "Access", "Status", "Expires"]);
    expect(rows).toHaveLength(5);

    const rowsById = new Map(rows.slice(1).map((row) => [row[0], row]));
    expect(rowsById.get("file0001")).toEqual([
      "file0001",
      "file",
      filePath,
      "https://demo.tailnet.ts.net:443/s/file0001",
      "tailnet",
      "active",
      futureExpiry,
    ]);
    expect(rowsById.has("dir00001")).toBe(false);
    expect(rowsById.get("prox0001")).toEqual([
      "prox0001",
      "proxy",
      "localhost:5173",
      "https://demo.tailnet.ts.net:443/s/prox0001",
      "public",
      "offline",
      "never",
    ]);
    expect(rowsById.get("reelfit")).toEqual([
      "reelfit",
      "project",
      projectPath,
      "https://demo.tailnet.ts.net:443/p/reelfit",
      "public",
      "online",
      "never",
    ]);
    expect(rowsById.get("tun00001")).toEqual([
      "tun00001",
      "tunnel",
      "localhost:4173",
      "https://demo.trycloudflare.com",
      "public",
      "active",
      "never",
    ]);
  });

  it("uses the live server port in list URLs when state.json has a stale port", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stalePort = 7899;
    const actualPort = 7900;
    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "file.html");
    const projectPath = path.join(workspace, "reelfit");

    writeStateFile(homeDir, {
      port: stalePort,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: stalePort,
      shares: {
        file0001: {
          id: "file0001",
          type: "file",
          path: filePath,
          createdAt: "2026-02-16T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          persist: false,
          readonly: false,
        },
      },
      projects: {
        reelfit: {
          name: "reelfit",
          path: projectPath,
          port: 8794,
          status: "online",
          createdAt: "2026-02-16T00:00:00.000Z",
        },
      },
      tunnels: {},
    });

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${process.pid}\n`, "utf8");

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakeLsofPath = path.join(fakeBinDir, "lsof");
    writeFileSync(
      fakeLsofPath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"-Pan\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = \"$TAILSERVE_TEST_PID\" ]; then\n" +
        "  echo 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'\n" +
        "  echo \"node $3 user 20u IPv6 0x0 0t0 TCP *:$TAILSERVE_TEST_PORT (LISTEN)\"\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeLsofPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_TEST_PID = `${process.pid}`;
    process.env.TAILSERVE_TEST_PORT = `${actualPort}`;

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "list", "--json"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe("");

      const rows = JSON.parse(stdout.toString()) as Array<{ id: string; type: string; url: string }>;
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      expect(rowsById.get("file0001")?.url).toBe(`https://demo.tailnet.ts.net:${actualPort}/s/file0001`);
      expect(rowsById.get("reelfit")?.url).toBe(`https://demo.tailnet.ts.net:${actualPort}/p/reelfit`);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        port: number;
        tsPort: number;
      };
      expect(state.port).toBe(actualPort);
      expect(state.tsPort).toBe(actualPort);
    } finally {
      delete process.env.TAILSERVE_TEST_PID;
      delete process.env.TAILSERVE_TEST_PORT;
    }
  });

  it("outputs JSON array with id, type, path, url, access, status, and expires fields", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "file.html");
    const dirPath = path.join(workspace, "my-dir");
    const projectPath = path.join(workspace, "reelfit");
    const futureExpiry = "2099-01-01T00:00:00.000Z";
    const pastExpiry = "2000-01-01T00:00:00.000Z";

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {
          file0001: {
            id: "file0001",
            type: "file",
            path: filePath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: futureExpiry,
            persist: false,
            readonly: false,
            public: false,
          },
          dir00001: {
            id: "dir00001",
            type: "dir",
            path: dirPath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: pastExpiry,
            persist: false,
            readonly: false,
          },
          prox0001: {
            id: "prox0001",
            type: "proxy",
            port: 5173,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
            public: true,
            status: "offline",
          },
        },
        projects: {
          reelfit: {
            id: "proj0001",
            name: "reelfit",
            path: projectPath,
            port: 8794,
            status: "online",
            public: true,
            createdAt: "2026-02-16T00:00:00.000Z",
          },
        },
        tunnels: {
          tun00001: {
            pid: 4242,
            url: "https://demo.trycloudflare.com",
            port: 4173,
            createdAt: "2026-02-16T00:00:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "list", "--json"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");

    expect(JSON.parse(stdout.toString())).toEqual([
      {
        id: "file0001",
        type: "file",
        path: filePath,
        url: "https://demo.tailnet.ts.net:443/s/file0001",
        access: "tailnet",
        status: "active",
        expires: futureExpiry,
      },
      {
        id: "prox0001",
        type: "proxy",
        path: "localhost:5173",
        url: "https://demo.tailnet.ts.net:443/s/prox0001",
        access: "public",
        status: "offline",
        expires: "never",
      },
      {
        id: "reelfit",
        type: "project",
        path: projectPath,
        url: "https://demo.tailnet.ts.net:443/p/reelfit",
        access: "public",
        status: "online",
        expires: "never",
      },
      {
        id: "tun00001",
        type: "tunnel",
        path: "localhost:4173",
        url: "https://demo.trycloudflare.com",
        access: "public",
        status: "active",
        expires: "never",
      },
    ]);
  });
});

describe("ts stop", () => {
  it("returns 404 immediately for a stopped share URL", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "stopped-share.txt");
    writeFileSync(filePath, "hello\n", "utf8");

    const shareStdout = new MemoryOutput();
    const shareStderr = new MemoryOutput();
    const shareExitCode = await run(["node", "ts", "share", filePath], shareStdout, shareStderr);

    expect(shareExitCode).toBe(0);
    expect(shareStderr.toString()).toBe("");

    const shareUrl = shareStdout.toString().trim();
    const sharePathname = new URL(shareUrl).pathname;
    const shareId = sharePathname.split("/").pop() ?? "";

    const beforeStop = resolveRequest({
      method: "GET",
      url: sharePathname,
    });
    expect(beforeStop.statusCode).toBe(200);

    const stopStdout = new MemoryOutput();
    const stopStderr = new MemoryOutput();
    const stopExitCode = await run(["node", "ts", "stop", shareId], stopStdout, stopStderr);

    expect(stopExitCode).toBe(0);
    expect(stopStdout.toString()).toBe("");
    expect(stopStderr.toString()).toBe("");

    const afterStop = resolveRequest({
      method: "GET",
      url: sharePathname,
    });
    expect(afterStop.statusCode).toBe(404);
  });

  it("removes the requested share and exits 0", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const keepPath = path.join(workspace, "keep.txt");
    const stopPath = path.join(workspace, "stop.txt");
    const timestamp = "2026-02-16T00:00:00.000Z";

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {
          keep0001: {
            id: "keep0001",
            type: "file",
            path: keepPath,
            createdAt: timestamp,
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          stop0001: {
            id: "stop0001",
            type: "file",
            path: stopPath,
            createdAt: timestamp,
            expiresAt: null,
            persist: true,
            readonly: false,
          },
        },
        projects: {},
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "stop", "stop0001"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { id: string; path: string }>;
    };

    expect(state.shares.stop0001).toBeUndefined();
    expect(state.shares.keep0001).toMatchObject({
      id: "keep0001",
      path: keepPath,
    });
  });

  it("removes all ephemeral shares with --all and keeps projects", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const keepPath = path.join(workspace, "keep.txt");
    const ephPathA = path.join(workspace, "ephemeral-a.txt");
    const timestamp = "2026-02-16T00:00:00.000Z";

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {
          keep0001: {
            id: "keep0001",
            type: "file",
            path: keepPath,
            createdAt: timestamp,
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          epha0001: {
            id: "epha0001",
            type: "file",
            path: ephPathA,
            createdAt: timestamp,
            expiresAt: timestamp,
            persist: false,
            readonly: false,
          },
          ephb0001: {
            id: "ephb0001",
            type: "proxy",
            port: 5173,
            createdAt: timestamp,
            expiresAt: timestamp,
            persist: false,
            readonly: false,
          },
        },
        projects: {
          reelfit: {
            name: "reelfit",
            path: "/tmp/reelfit",
            status: "online",
          },
        },
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "stop", "--all"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
      shares: Record<string, { id: string; path?: string; persist: boolean }>;
      projects: Record<string, { name: string; path: string; status: string }>;
    };

    expect(Object.keys(state.shares)).toEqual(["keep0001"]);
    expect(state.shares.keep0001).toMatchObject({
      id: "keep0001",
      path: keepPath,
      persist: true,
    });
    expect(state.projects).toEqual({
      reelfit: {
        name: "reelfit",
        path: "/tmp/reelfit",
        status: "online",
      },
    });

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["serve --https=443 off"]);
  });

  it("checks tunnels when stopping by id and kills the matching tunnel process", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const timestamp = "2026-02-16T00:00:00.000Z";
    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 7899,
        shares: {},
        projects: {},
        tunnels: {
          tunl0001: {
            pid: 4321,
            url: "https://first.trycloudflare.com",
            port: 8787,
            createdAt: timestamp,
          },
        },
      })}\n`,
      "utf8",
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "stop", "tunl0001"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stdout.toString()).toBe("");
      expect(stderr.toString()).toBe("");
      expect(killSpy).toHaveBeenCalledWith(4321);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        tunnels: Record<string, unknown>;
      };
      expect(state.tunnels).toEqual({});
    } finally {
      killSpy.mockRestore();
    }
  });

  it("kills all tracked tunnels and removes them with --tunnels", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const timestamp = "2026-02-16T00:00:00.000Z";
    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 7899,
        shares: {
          keep0001: {
            id: "keep0001",
            type: "file",
            path: "/tmp/keep.txt",
            createdAt: timestamp,
            expiresAt: null,
            persist: true,
            readonly: false,
          },
        },
        projects: {},
        tunnels: {
          tunl0001: {
            pid: 1111,
            url: "https://first.trycloudflare.com",
            port: 8787,
            createdAt: timestamp,
          },
          tunl0002: {
            pid: 2222,
            url: "https://second.trycloudflare.com",
            port: 3000,
            createdAt: timestamp,
          },
        },
      })}\n`,
      "utf8",
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await run(["node", "ts", "stop", "--tunnels"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stdout.toString()).toBe("");
      expect(stderr.toString()).toBe("");
      expect(killSpy).toHaveBeenCalledWith(1111);
      expect(killSpy).toHaveBeenCalledWith(2222);
      expect(killSpy).toHaveBeenCalledTimes(2);

      const state = JSON.parse(readFileSync(path.join(homeDir, ".tailserve", "state.json"), "utf8")) as {
        shares: Record<string, unknown>;
        tunnels: Record<string, unknown>;
      };
      expect(state.shares.keep0001).toBeDefined();
      expect(state.tunnels).toEqual({});
    } finally {
      killSpy.mockRestore();
    }
  });
});
