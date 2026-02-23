import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
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
const originalPath = process.env.PATH;

async function waitForChildExit(child: ChildProcess, timeoutMs = 2000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for child process to exit"));
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

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

describe("ts server stop", () => {
  it("gracefully stops the PID-tracked server process and tears down tailscale serve", async () => {
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
        tsPort: 443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const markerPath = path.join(homeDir, "graceful-shutdown.marker");
    const readyPath = path.join(homeDir, "graceful-shutdown.ready");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const { appendFileSync, writeFileSync } = require('node:fs');" +
          "const ready = process.env.TAILSERVE_TEST_READY;" +
          "const marker = process.env.TAILSERVE_TEST_MARKER;" +
          "writeFileSync(ready, 'ready\\n', 'utf8');" +
          "process.on('SIGTERM', () => { appendFileSync(marker, 'sigterm\\n', 'utf8'); process.exit(0); });" +
          "setInterval(() => {}, 1000);",
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          TAILSERVE_TEST_READY: readyPath,
          TAILSERVE_TEST_MARKER: markerPath,
        },
      },
    );

    if (typeof child.pid !== "number") {
      throw new Error("Failed to spawn test server process");
    }
    expect(await waitForFile(readyPath)).toBe(true);

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${child.pid}\n`, "utf8");

    try {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await run(["node", "ts", "server", "stop"], stdout, stderr);

      expect(exitCode).toBe(0);
      expect(stdout.toString()).toBe("");
      expect(stderr.toString()).toBe("");

      await waitForChildExit(child);
      expect(await waitForFile(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf8")).toContain("sigterm");

      const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
      expect(capturedCalls).toEqual(["serve --https=443 off", "serve status"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("treats a second consecutive stop as a no-op after stopping a running server", async () => {
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
        tsPort: 443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const markerPath = path.join(homeDir, "double-stop.marker");
    const readyPath = path.join(homeDir, "double-stop.ready");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const { appendFileSync, writeFileSync } = require('node:fs');" +
          "const ready = process.env.TAILSERVE_TEST_READY;" +
          "const marker = process.env.TAILSERVE_TEST_MARKER;" +
          "writeFileSync(ready, 'ready\\n', 'utf8');" +
          "process.on('SIGTERM', () => { appendFileSync(marker, 'sigterm\\n', 'utf8'); process.exit(0); });" +
          "setInterval(() => {}, 1000);",
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          TAILSERVE_TEST_READY: readyPath,
          TAILSERVE_TEST_MARKER: markerPath,
        },
      },
    );

    if (typeof child.pid !== "number") {
      throw new Error("Failed to spawn test server process");
    }
    expect(await waitForFile(readyPath)).toBe(true);

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${child.pid}\n`, "utf8");

    try {
      const firstStdout = new MemoryOutput();
      const firstStderr = new MemoryOutput();
      const firstExitCode = await run(["node", "ts", "server", "stop"], firstStdout, firstStderr);

      expect(firstExitCode).toBe(0);
      expect(firstStdout.toString()).toBe("");
      expect(firstStderr.toString()).toBe("");
      await waitForChildExit(child);
      expect(await waitForFile(markerPath)).toBe(true);
      expect(existsSync(pidPath)).toBe(false);

      const secondStdout = new MemoryOutput();
      const secondStderr = new MemoryOutput();
      const secondExitCode = await run(["node", "ts", "server", "stop"], secondStdout, secondStderr);

      expect(secondExitCode).toBe(0);
      expect(secondStdout.toString()).toBe("");
      expect(secondStderr.toString()).toBe("");
      expect(existsSync(pidPath)).toBe(false);

      const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
      expect(capturedCalls).toEqual(["serve --https=443 off", "serve status", "serve --https=443 off", "serve status"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("still removes tailscale serve route when no server pid file exists", async () => {
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
        tsPort: 443,
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await run(["node", "ts", "server", "stop"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["serve --https=443 off", "serve status"]);
  });

  it("clears persisted namedTunnelPid runtime value on server stop", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "1";

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    const statePath = path.join(homeDir, ".tailserve", "state.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {},
        projects: {},
        namedTunnel: {
          name: "tailserve-main",
          uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          hostname: "tailserve.example.com",
          credentialsPath: "/home/user/.cloudflared/id.json",
        },
        namedTunnelPid: 43210,
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "server", "stop"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const rawState = JSON.parse(readFileSync(statePath, "utf8")) as {
      namedTunnel?: unknown;
      namedTunnelPid?: unknown;
    };
    expect(rawState.namedTunnel).toEqual({
      name: "tailserve-main",
      uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      hostname: "tailserve.example.com",
      credentialsPath: "/home/user/.cloudflared/id.json",
    });
    expect(rawState.namedTunnelPid).toBeUndefined();
  });

  it("cleans up stale tailscale serve routes when no server process is running", async () => {
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
        "  printf '|-- / proxy http://localhost:7899\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:8443\\n'\n" +
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

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".tailserve", "state.json"),
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        protectedPorts: [18789],
        shares: {},
        projects: {},
      })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "server", "stop"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual(["serve --https=443 off", "serve status", "serve --https=8443 off"]);
  });
});
