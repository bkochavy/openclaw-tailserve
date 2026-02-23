import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkPortAvailability,
  checkShareIntegrity,
  checkStalePid,
  checkStateFile,
  checkTailscaleMappings,
  checkTailscaleServePermissions,
  checkZombieProcesses,
  cleanStalePid,
  cleanStaleTailscaleMapping,
  findAvailablePort,
  runDoctor,
  verifyServerStarted,
} from "../src/doctor.js";
import { getServerPidPath, readState, writeState } from "../src/state.js";
import * as serverProcess from "../src/server-process.js";

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalDryRun = process.env.TAILSERVE_TAILSCALE_DRY_RUN;
const originalTailscaleBin = process.env.TAILSERVE_TAILSCALE_BIN;
const originalBusyPorts = process.env.TAILSERVE_TEST_BUSY_PORTS;
const originalTailscaleCapture = process.env.TAILSERVE_TAILSCALE_CAPTURE;

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function chooseDeadPid(): number {
  const candidates = [999_999, 888_888, 777_777, 666_666];
  for (const candidate of candidates) {
    try {
      process.kill(candidate, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return candidate;
      }
    }
  }

  return 999_999;
}

function setupFakeLsof(binDir: string, busyPorts: ReadonlyArray<number>): void {
  const lsofPath = path.join(binDir, "lsof");
  writeFileSync(
    lsofPath,
    "#!/bin/sh\n" +
      "if [ \"$1\" = \"-ti\" ]; then\n" +
      "  port=\"${2#:}\"\n" +
      "  case \",$TAILSERVE_TEST_BUSY_PORTS,\" in\n" +
      "    *\",$port,\"*)\n" +
      "      printf '12345\\n'\n" +
      "      exit 0\n" +
      "      ;;\n" +
      "  esac\n" +
      "fi\n" +
      "exit 1\n",
    "utf8",
  );
  chmodSync(lsofPath, 0o755);
  process.env.TAILSERVE_TEST_BUSY_PORTS = busyPorts.join(",");
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}

afterEach(() => {
  restoreEnvVar("HOME", originalHome);
  restoreEnvVar("PATH", originalPath);
  restoreEnvVar("TAILSERVE_TAILSCALE_DRY_RUN", originalDryRun);
  restoreEnvVar("TAILSERVE_TAILSCALE_BIN", originalTailscaleBin);
  restoreEnvVar("TAILSERVE_TEST_BUSY_PORTS", originalBusyPorts);
  restoreEnvVar("TAILSERVE_TAILSCALE_CAPTURE", originalTailscaleCapture);
});

describe("doctor pid checks", () => {
  it("detects stale PID files and cleans them", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stalePid = chooseDeadPid();
    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${stalePid}\n`, "utf8");

    const beforeFix = checkStalePid(false);
    expect(beforeFix.ok).toBe(false);
    expect(beforeFix.message).toContain("stale");
    expect(existsSync(pidPath)).toBe(true);

    const fixed = checkStalePid(true);
    expect(fixed.ok).toBe(true);
    expect(fixed.fixed).toBe(true);
    expect(existsSync(pidPath)).toBe(false);

    expect(cleanStalePid()).toBe(false);
  });

  it("detects invalid PID content and removes it when fix is enabled", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const pidPath = getServerPidPath();
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, "not-a-pid\n", "utf8");

    const beforeFix = checkStalePid(false);
    expect(beforeFix.ok).toBe(false);
    expect(beforeFix.message).toContain("invalid");

    const fixed = checkStalePid(true);
    expect(fixed.ok).toBe(true);
    expect(fixed.fixed).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe("doctor port checks", () => {
  it("finds and applies a replacement port when configured port is busy", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    process.env.HOME = homeDir;
    setupFakeLsof(fakeBinDir, [43000, 43001]);

    const state = readState();
    state.port = 43000;
    state.tsPort = 43000;
    writeState(state);

    expect(findAvailablePort(43000, 5)).toBe(43002);

    const noFix = checkPortAvailability(43000, false);
    expect(noFix.ok).toBe(false);
    expect(noFix.message).toContain("in use");

    const withFix = checkPortAvailability(43000, true);
    expect(withFix.ok).toBe(true);
    expect(withFix.fixed).toBe(true);
    expect(readState().port).toBe(43002);
    expect(readState().tsPort).toBe(43002);
  });

  it("verifies server startup by polling local port usage", () => {
    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    setupFakeLsof(fakeBinDir, [44000]);

    expect(verifyServerStarted(44000, 100)).toBe(true);
    expect(verifyServerStarted(44001, 120)).toBe(false);
  });

  it("treats an in-use port as healthy when it belongs to the running tailserve server", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    process.env.HOME = homeDir;
    setupFakeLsof(fakeBinDir, [45000]);

    const statusSpy = vi.spyOn(serverProcess, "readTailserveServerStatus").mockReturnValue({
      running: true,
      port: 45000,
      pid: 1234,
      uptimeMs: 1000,
    });

    const result = checkPortAvailability(45000, false);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("running tailserve server");
    expect(statusSpy).toHaveBeenCalled();
  });
});

describe("doctor tailscale checks", () => {
  it("detects stale tailscale mappings and can clean them", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";
    setupFakeLsof(fakeBinDir, [5000]);

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'https://demo.tailnet.ts.net\\n'\n" +
        "  printf '|-- / proxy http://localhost:18789\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:10443\\n'\n" +
        "  printf '|-- /stale proxy http://localhost:4000\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:11443\\n'\n" +
        "  printf '|-- /active proxy http://localhost:5000\\n'\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    const dryRunCheck = checkTailscaleMappings(false);
    expect(dryRunCheck.ok).toBe(false);
    expect(dryRunCheck.message).toContain("stale");

    const fixedCheck = checkTailscaleMappings(true);
    expect(fixedCheck.ok).toBe(true);
    expect(fixedCheck.fixed).toBe(true);

    expect(cleanStaleTailscaleMapping(16443)).toBe(true);
    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toContain("serve --https=10443 off");
    expect(capturedCalls).toContain("serve --https=16443 off");
  });

  it("parses serve status output and only flags stale localhost mappings", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    const fakeBinDir = mkdtempSync(path.join(tmpdir(), "tailserve-bin-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";
    setupFakeLsof(fakeBinDir, [5000]);

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'https://demo.tailnet.ts.net\\n'\n" +
        "  printf '|-- /protected proxy http://localhost:18789\\n'\n" +
        "  printf '|-- /active proxy http://localhost:5000\\n'\n" +
        "  printf '|-- /remote proxy https://example.com:9443\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:12443\\n'\n" +
        "  printf '|-- /stale proxy http://127.0.0.1:4100\\n'\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    const noFix = checkTailscaleMappings(false);
    expect(noFix.ok).toBe(false);
    expect(noFix.message).toContain("1 stale route");

    const fixed = checkTailscaleMappings(true);
    expect(fixed.ok).toBe(true);
    expect(fixed.fixed).toBe(true);

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8");
    expect(capturedCalls).toContain("serve --https=12443 off");
    expect(capturedCalls).not.toContain("serve --https=443 off");
  });

  it("flags tailscale serve permission-denied errors with macOS standalone guidance", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'permission denied\\n' >&2\n" +
        "  exit 1\n" +
        "fi\n" +
        "exit 0\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;

    const result = checkTailscaleServePermissions();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("permission denied");
    expect(result.message).toContain("https://tailscale.com/kb/1065/macos-variants");
  });

  it("passes when tailscale serve status is accessible", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'https://demo.tailnet.ts.net\\n'\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 0\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;

    const result = checkTailscaleServePermissions();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("accessible");
  });
});

describe("doctor state and integrity checks", () => {
  it("repairs a corrupted state file", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{invalid", "utf8");

    const noFix = checkStateFile(false);
    expect(noFix.ok).toBe(false);

    const withFix = checkStateFile(true);
    expect(withFix.ok).toBe(true);
    expect(withFix.fixed).toBe(true);

    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { shares: Record<string, unknown> };
    expect(typeof parsed).toBe("object");
    expect(parsed.shares).toEqual({});
  });

  it("detects non-object state content as corruption and repairs it", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "[]", "utf8");

    const noFix = checkStateFile(false);
    expect(noFix.ok).toBe(false);
    expect(noFix.message).toContain("corrupted");

    const withFix = checkStateFile(true);
    expect(withFix.ok).toBe(true);
    expect(withFix.fixed).toBe(true);

    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { shares: Record<string, unknown> };
    expect(parsed.shares).toEqual({});
  });

  it("removes invalid shares when share integrity fix is enabled", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const validFile = path.join(workspace, "valid.txt");
    writeFileSync(validFile, "ok\n", "utf8");

    const state = readState();
    state.shares.good0001 = {
      id: "good0001",
      type: "file",
      path: validFile,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      persist: true,
      readonly: false,
    };
    state.shares.badf0001 = {
      id: "badf0001",
      type: "file",
      path: path.join(workspace, "missing.txt"),
      createdAt: new Date().toISOString(),
      expiresAt: null,
      persist: true,
      readonly: false,
    };
    state.shares.badd0001 = {
      id: "badd0001",
      type: "dir",
      path: validFile,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      persist: true,
      readonly: false,
    };
    writeState(state);

    const noFix = checkShareIntegrity(false);
    expect(noFix.ok).toBe(false);
    expect(noFix.message).toContain("invalid share");

    const withFix = checkShareIntegrity(true);
    expect(withFix.ok).toBe(true);
    expect(withFix.fixed).toBe(true);
    expect(Object.keys(readState().shares)).toEqual(["good0001"]);
  });

  it("removes dead tunnel entries from state when zombie fix is enabled", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (typeof child.pid !== "number") {
      throw new Error("Failed to start tunnel test process");
    }

    const stalePid = chooseDeadPid();
    const state = readState();
    state.tunnels.live0001 = {
      pid: child.pid,
      url: "https://live.trycloudflare.com",
      port: 7899,
      createdAt: new Date().toISOString(),
    };
    state.tunnels.dead0001 = {
      pid: stalePid,
      url: "https://dead.trycloudflare.com",
      port: 7899,
      createdAt: new Date().toISOString(),
    };
    writeState(state);

    try {
      const noFix = checkZombieProcesses(false);
      expect(noFix.ok).toBe(false);

      const withFix = checkZombieProcesses(true);
      expect(withFix.ok).toBe(true);
      expect(withFix.fixed).toBe(true);
      expect(Object.keys(readState().tunnels)).toEqual(["live0001"]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("flags dead tunnel pid entries as zombie processes", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const stalePid = chooseDeadPid();
    const state = readState();
    state.tunnels.broken0001 = {
      pid: stalePid,
      url: "https://broken.trycloudflare.com",
      port: 7899,
      createdAt: new Date().toISOString(),
    };
    writeState(state);

    const noFix = checkZombieProcesses(false);
    expect(noFix.ok).toBe(false);
    expect(noFix.message).toContain("1 zombie tunnel process");

    const withFix = checkZombieProcesses(true);
    expect(withFix.ok).toBe(true);
    expect(withFix.fixed).toBe(true);
    expect(readState().tunnels).toEqual({});
  });

  it("reports file shares as invalid after the target file is deleted", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const targetFile = path.join(workspace, "ephemeral.txt");
    writeFileSync(targetFile, "hello\n", "utf8");

    const state = readState();
    state.shares.file0001 = {
      id: "file0001",
      type: "file",
      path: targetFile,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      persist: true,
      readonly: false,
    };
    writeState(state);

    expect(checkShareIntegrity(false).ok).toBe(true);

    rmSync(targetFile, { force: true });

    const afterDelete = checkShareIntegrity(false);
    expect(afterDelete.ok).toBe(false);
    expect(afterDelete.message).toContain("1 invalid share");

    const fixed = checkShareIntegrity(true);
    expect(fixed.ok).toBe(true);
    expect(fixed.fixed).toBe(true);
    expect(readState().shares).toEqual({});
  });
});

describe("doctor summary", () => {
  it("returns all check results from runDoctor", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    writeState(readState());

    const summary = runDoctor({ fix: false, verbose: false });

    expect(summary.checks).toHaveLength(8);
    expect(summary.checks.map((check) => check.name)).toEqual([
      "checkStalePid",
      "checkPortAvailability",
      "checkTailscaleMappings",
      "checkTailscaleServePermissions",
      "checkStateFile",
      "checkServerHealth",
      "checkZombieProcesses",
      "checkShareIntegrity",
    ]);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(typeof summary.ok).toBe("boolean");
  });
});
