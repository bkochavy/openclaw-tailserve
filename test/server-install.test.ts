import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const originalPath = process.env.PATH;
const originalLaunchctlCapture = process.env.TAILSERVE_LAUNCHCTL_CAPTURE;

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

  if (originalLaunchctlCapture === undefined) {
    delete process.env.TAILSERVE_LAUNCHCTL_CAPTURE;
  } else {
    process.env.TAILSERVE_LAUNCHCTL_CAPTURE = originalLaunchctlCapture;
  }
});

describe("ts server install", () => {
  it("creates and loads the launch agent plist with KeepAlive", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakeLaunchctlPath = path.join(fakeBinDir, "launchctl");
    const launchctlCapturePath = path.join(homeDir, "launchctl-calls.log");
    writeFileSync(launchctlCapturePath, "", "utf8");
    writeFileSync(
      fakeLaunchctlPath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_LAUNCHCTL_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_LAUNCHCTL_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeLaunchctlPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_LAUNCHCTL_CAPTURE = launchctlCapturePath;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "server", "install"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toBe("");

    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "dev.tailserve.plist");
    expect(existsSync(plistPath)).toBe(true);

    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>dev.tailserve</string>");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toMatch(/server-entry\.(js|ts)<\/string>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);

    const launchctlCalls = readFileSync(launchctlCapturePath, "utf8").trim().split("\n");
    expect(launchctlCalls).toEqual([`load ${plistPath}`]);
  });
});

describe("ts server uninstall", () => {
  it("unloads the launch agent and removes the plist", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    const fakeLaunchctlPath = path.join(fakeBinDir, "launchctl");
    const launchctlCapturePath = path.join(homeDir, "launchctl-calls.log");
    writeFileSync(launchctlCapturePath, "", "utf8");
    writeFileSync(
      fakeLaunchctlPath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_LAUNCHCTL_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_LAUNCHCTL_CAPTURE\"\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeLaunchctlPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSERVE_LAUNCHCTL_CAPTURE = launchctlCapturePath;

    const installStdout = new MemoryOutput();
    const installStderr = new MemoryOutput();
    const installCode = await run(["node", "ts", "server", "install"], installStdout, installStderr);
    expect(installCode).toBe(0);

    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "dev.tailserve.plist");
    expect(existsSync(plistPath)).toBe(true);

    const uninstallStdout = new MemoryOutput();
    const uninstallStderr = new MemoryOutput();
    const uninstallCode = await run(["node", "ts", "server", "uninstall"], uninstallStdout, uninstallStderr);
    expect(uninstallCode).toBe(0);
    expect(uninstallStdout.toString()).toBe("");
    expect(uninstallStderr.toString()).toBe("");
    expect(existsSync(plistPath)).toBe(false);

    const launchctlCalls = readFileSync(launchctlCapturePath, "utf8").trim().split("\n");
    expect(launchctlCalls).toEqual([`load ${plistPath}`, `unload ${plistPath}`]);

  });
});
