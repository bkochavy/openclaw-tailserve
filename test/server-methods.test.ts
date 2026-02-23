import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileShare } from "../src/shares.js";
import { createTailserveServer, proxyShareRequest, resolveRequest, runProxyHealthCheck, type ProjectProxyRuntime } from "../src/server.js";
import { readState, writeState } from "../src/state.js";

const originalHome = process.env.HOME;
const originalTailscaleDryRun = process.env.TAILSERVE_TAILSCALE_DRY_RUN;
const originalTailscaleBin = process.env.TAILSERVE_TAILSCALE_BIN;
const originalTailscaleCapture = process.env.TAILSERVE_TAILSCALE_CAPTURE;
const originalPath = process.env.PATH;

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
  vi.useRealTimers();

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

describe("tailserve server methods", () => {
  it("returns 405 and Allow header for non-GET methods", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const resolved = resolveRequest({
      method: "POST",
      url: "/s/abcd1234",
    });

    expect(resolved.statusCode).toBe(405);
    expect(resolved.allow).toBe("GET");
  });

  it("restores persisted startup routes and skips expired shares", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T00:00:00.000Z"));

    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const expiredPath = path.join(workspace, "expired.txt");
    const activePath = path.join(workspace, "active.txt");
    const persistentPath = path.join(workspace, "persistent.txt");
    const stalePersistentPath = path.join(workspace, "stale-persistent.txt");
    writeFileSync(expiredPath, "expired\n", "utf8");
    writeFileSync(activePath, "active\n", "utf8");
    writeFileSync(persistentPath, "persistent\n", "utf8");
    writeFileSync(stalePersistentPath, "stale persistent\n", "utf8");

    const expiredShare = createFileShare(expiredPath, { ttlMs: 30_000 });
    const activeShare = createFileShare(activePath, { ttlMs: 5 * 60_000 });
    const persistentShare = createFileShare(persistentPath, { persist: true });
    const stalePersistentShare = createFileShare(stalePersistentPath, { persist: true });

    const stateBeforeRestart = readState();
    stateBeforeRestart.shares[stalePersistentShare.id] = {
      ...stateBeforeRestart.shares[stalePersistentShare.id],
      expiresAt: "2026-02-15T23:00:00.000Z",
    };
    stateBeforeRestart.projects = {
      reelfit: {
        name: "reelfit",
        path: "/tmp/reelfit",
        status: "online",
      },
    };
    writeState(stateBeforeRestart);

    vi.setSystemTime(new Date("2026-02-16T00:02:00.000Z"));

    const server = createTailserveServer();
    try {
      expect(readState().shares[expiredShare.id]).toBeUndefined();
      expect(readState().shares[activeShare.id]).toBeDefined();
      expect(readState().shares[persistentShare.id]).toBeDefined();
      expect(readState().shares[stalePersistentShare.id]).toBeUndefined();
      expect(readState().projects.reelfit).toBeDefined();

      const restored = resolveRequest({
        method: "GET",
        url: `/s/${persistentShare.id}`,
      });
      expect(restored.statusCode).toBe(200);

      const activeRestored = resolveRequest({
        method: "GET",
        url: `/s/${activeShare.id}`,
      });
      expect(activeRestored.statusCode).toBe(200);
    } finally {
      server.emit("close");
    }
  });

  it("purges expired TTL shares on startup and does not restore their routes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T00:00:00.000Z"));

    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const expiredPath = path.join(workspace, "expired.txt");
    const persistedPath = path.join(workspace, "persisted.txt");
    writeFileSync(expiredPath, "expired\n", "utf8");
    writeFileSync(persistedPath, "persisted\n", "utf8");

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 443,
        shares: {
          expi0001: {
            id: "expi0001",
            type: "file",
            path: expiredPath,
            createdAt: "2026-02-15T20:00:00.000Z",
            expiresAt: "2026-02-15T22:00:00.000Z",
            persist: false,
            readonly: false,
          },
          keep0001: {
            id: "keep0001",
            type: "file",
            path: persistedPath,
            createdAt: "2026-02-15T20:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
        },
        projects: {},
      })}\n`,
      "utf8",
    );

    const server = createTailserveServer();
    try {
      const state = readState();
      expect(state.shares.expi0001).toBeUndefined();
      expect(state.shares.keep0001).toBeDefined();

      const expiredResponse = resolveRequest({
        method: "GET",
        url: "/s/expi0001",
      });
      expect(expiredResponse.statusCode).toBe(404);

      const persistedResponse = resolveRequest({
        method: "GET",
        url: "/s/keep0001",
      });
      expect(persistedResponse.statusCode).toBe(200);
    } finally {
      server.emit("close");
    }
  });

  it("restores persisted shares and valid projects from state.json on startup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T00:00:00.000Z"));

    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const restoredFilePath = path.join(workspace, "restored.txt");
    const restoredDirPath = path.join(workspace, "restored-dir");
    const staticProjectPath = path.join(workspace, "static-project");
    mkdirSync(restoredDirPath, { recursive: true });
    mkdirSync(staticProjectPath, { recursive: true });
    writeFileSync(restoredFilePath, "restored\n", "utf8");
    writeFileSync(path.join(restoredDirPath, "nested.txt"), "nested\n", "utf8");
    writeFileSync(path.join(staticProjectPath, "index.txt"), "project\n", "utf8");

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {
          keepf001: {
            id: "legacy01",
            type: "file",
            path: restoredFilePath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          keepd001: {
            id: "keepd001",
            type: "dir",
            path: restoredDirPath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          keepp001: {
            id: "keepp001",
            type: "proxy",
            port: 3000,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          dropf001: {
            id: "dropf001",
            type: "file",
            path: restoredFilePath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: false,
            readonly: false,
          },
          expir001: {
            id: "expir001",
            type: "file",
            path: restoredFilePath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: "2026-02-15T23:00:00.000Z",
            persist: true,
            readonly: false,
          },
          broken01: null,
        },
        projects: {
          static: {
            name: "static",
            path: staticProjectPath,
            status: "online",
          },
          proxy: {
            name: "proxy",
            path: workspace,
            port: 3100,
            status: "offline",
          },
          invalidType: "oops",
          invalidPort: {
            name: "invalid-port",
            path: workspace,
            port: 70000,
          },
        },
      })}\n`,
      "utf8",
    );

    const server = createTailserveServer();
    try {
      const state = readState();

      expect(Object.keys(state.shares).sort()).toEqual(["dropf001", "keepd001", "keepf001", "keepp001"]);
      expect(state.shares.keepf001.id).toBe("keepf001");
      expect(state.shares.keepd001.id).toBe("keepd001");
      expect(state.shares.keepp001.id).toBe("keepp001");
      expect(state.shares.dropf001.id).toBe("dropf001");
      expect(state.projects.static).toBeDefined();
      expect(state.projects.proxy).toBeDefined();
      expect(state.projects.invalidType).toBeUndefined();
      expect(state.projects.invalidPort).toBeUndefined();

      const restoredFileShare = resolveRequest({
        method: "GET",
        url: "/s/keepf001",
      });
      expect(restoredFileShare.statusCode).toBe(200);

      const restoredDirectoryShare = resolveRequest({
        method: "GET",
        url: "/s/keepd001",
      });
      expect(restoredDirectoryShare.statusCode).toBe(200);
      expect(restoredDirectoryShare.body).toContain("nested.txt");

      const restoredStaticProject = resolveRequest({
        method: "GET",
        url: "/p/static",
      });
      expect(restoredStaticProject.statusCode).toBe(200);

      const ephemeralShare = resolveRequest({
        method: "GET",
        url: "/s/dropf001",
      });
      expect(ephemeralShare.statusCode).toBe(200);
    } finally {
      server.emit("close");
    }
  });

  it("logs a startup restoration summary including offline projects", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const sharePath = path.join(workspace, "keep.txt");
    const staticProjectPath = path.join(workspace, "static");
    mkdirSync(staticProjectPath, { recursive: true });
    writeFileSync(sharePath, "keep\n", "utf8");

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
        shares: {
          keepf001: {
            id: "keepf001",
            type: "file",
            path: sharePath,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          keepp001: {
            id: "keepp001",
            type: "proxy",
            port: 8794,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
          },
        },
        projects: {
          static: {
            name: "static",
            path: staticProjectPath,
            status: "online",
          },
          proxy: {
            name: "proxy",
            path: workspace,
            port: 3000,
            status: "offline",
          },
          docs: {
            name: "docs",
            path: workspace,
          },
        },
      })}\n`,
      "utf8",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const server = createTailserveServer();
    try {
      expect(stderrSpy).toHaveBeenCalledWith("Restored 3 projects, 2 shares. 1 project offline.\n");
    } finally {
      server.emit("close");
      stderrSpy.mockRestore();
    }
  });

  it("attempts to start project backends on startup when autoRestart is enabled", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const projectPath = path.join(workspace, "reelfit");
    mkdirSync(projectPath, { recursive: true });

    const markerPath = path.join(projectPath, "backend-started.flag");
    const markerLiteral = JSON.stringify(markerPath);
    writeFileSync(
      path.join(projectPath, "start-backend.cjs"),
      `const { writeFileSync } = require("node:fs");\nwriteFileSync(${markerLiteral}, "started\\n", "utf8");\n`,
      "utf8",
    );

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 443,
        shares: {},
        projects: {
          reelfit: {
            name: "reelfit",
            path: projectPath,
            port: 45731,
            startCmd: "node start-backend.cjs",
            autoRestart: true,
            status: "offline",
            createdAt: "2026-02-16T00:00:00.000Z",
          },
          noauto: {
            name: "noauto",
            path: projectPath,
            port: 45732,
            startCmd: "node should-not-run.cjs",
            autoRestart: false,
            status: "offline",
            createdAt: "2026-02-16T00:00:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );

    const server = createTailserveServer();
    try {
      expect(await waitForFile(markerPath)).toBe(true);
    } finally {
      server.emit("close");
    }
  });

  it("removes expired shares every 60 seconds while the server process is running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T00:00:00.000Z"));

    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const expiringPath = path.join(workspace, "expiring.txt");
    const activePath = path.join(workspace, "active.txt");
    const persistentPath = path.join(workspace, "persistent.txt");
    writeFileSync(expiringPath, "expiring\n", "utf8");
    writeFileSync(activePath, "active\n", "utf8");
    writeFileSync(persistentPath, "persistent\n", "utf8");

    const server = createTailserveServer();
    try {
      const expiringShare = createFileShare(expiringPath, { ttlMs: 30_000 });
      const activeShare = createFileShare(activePath, { ttlMs: 120_000 });
      const persistentShare = createFileShare(persistentPath, { persist: true });

      vi.advanceTimersByTime(59_999);
      expect(readState().shares[expiringShare.id]).toBeDefined();
      expect(readState().shares[activeShare.id]).toBeDefined();
      expect(readState().shares[persistentShare.id]).toBeDefined();

      vi.advanceTimersByTime(1);
      expect(readState().shares[expiringShare.id]).toBeUndefined();
      expect(readState().shares[activeShare.id]).toBeDefined();
      expect(readState().shares[persistentShare.id]).toBeDefined();

      vi.advanceTimersByTime(60_000);
      expect(readState().shares[activeShare.id]).toBeUndefined();
      expect(readState().shares[persistentShare.id]).toBeDefined();
    } finally {
      server.emit("close");
    }
  });

  it("updates proxy and project backend lastSeen values during health checks", async () => {
    const createdAt = "2026-02-16T00:00:00.000Z";
    const lastSeenBefore = "2026-02-16T00:01:00.000Z";
    const checkedAt = "2026-02-16T00:10:00.000Z";

    const state = {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      shares: {
        onshare1: {
          id: "onshare1",
          type: "proxy",
          port: 3000,
          createdAt,
          expiresAt: null,
          persist: true,
          readonly: false,
          status: "offline",
        },
        offshare1: {
          id: "offshare1",
          type: "proxy",
          port: 4000,
          createdAt,
          expiresAt: null,
          persist: true,
          readonly: false,
          status: "online",
          lastSeen: lastSeenBefore,
        },
      },
      projects: {
        online: {
          name: "online",
          path: "/tmp/online",
          port: 3000,
          status: "offline",
        },
        offline: {
          name: "offline",
          path: "/tmp/offline",
          port: 4000,
          status: "online",
          lastSeen: lastSeenBefore,
        },
        static: {
          name: "static",
          path: "/tmp/static",
        },
      },
    };

    const writeStateMock = vi.fn();
    const checkPortMock = vi.fn(async (port: number) => port === 3000);

    await runProxyHealthCheck({
      readState: () => state,
      writeState: writeStateMock,
      nowIso: () => checkedAt,
      checkPort: checkPortMock,
    });

    expect(checkPortMock).toHaveBeenCalledTimes(2);
    expect(checkPortMock).toHaveBeenNthCalledWith(1, 3000);
    expect(checkPortMock).toHaveBeenNthCalledWith(2, 4000);
    expect(writeStateMock).toHaveBeenCalledTimes(1);

    expect(state.shares.onshare1.status).toBe("online");
    expect(state.shares.onshare1.lastSeen).toBe(checkedAt);
    expect(state.shares.offshare1.status).toBe("offline");
    expect(state.shares.offshare1.lastSeen).toBe(lastSeenBefore);

    const onlineProject = state.projects.online as Record<string, unknown>;
    const offlineProject = state.projects.offline as Record<string, unknown>;
    const staticProject = state.projects.static as Record<string, unknown>;
    expect(onlineProject.status).toBe("online");
    expect(onlineProject.lastSeen).toBe(checkedAt);
    expect(offlineProject.status).toBe("offline");
    expect(offlineProject.lastSeen).toBe(lastSeenBefore);
    expect(staticProject.lastSeen).toBeUndefined();
  });

  it("runs backend health checks every 10 seconds", async () => {
    vi.useFakeTimers();
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const healthCheckRunner = vi.fn(async () => {
      return;
    });

    const server = createTailserveServer({ healthCheckRunner });
    try {
      await Promise.resolve();
      expect(healthCheckRunner).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(9_999);
      await Promise.resolve();
      expect(healthCheckRunner).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(healthCheckRunner).toHaveBeenCalledTimes(2);
    } finally {
      server.emit("close");
    }

    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(healthCheckRunner).toHaveBeenCalledTimes(2);
  });

  it("removes stale tailscale serve routes on startup", () => {
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
        "if [ \"$1\" = \"serve\" ] && [ \"$2\" = \"status\" ]; then\n" +
        "  printf 'https://demo.tailnet.ts.net\\n'\n" +
        "  printf '|-- / proxy http://127.0.0.1:3000\\n'\n" +
        "  printf 'https://demo.tailnet.ts.net:8443\\n'\n" +
        "  printf '|-- / proxy http://localhost:4000\\n'\n" +
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
        "if [ \"$1\" = \"-ti\" ] && [ \"$2\" = \":3000\" ]; then\n" +
        "  printf '2001\\n'\n" +
        "  exit 0\n" +
        "fi\n" +
        "exit 1\n",
      "utf8",
    );
    chmodSync(fakeLsofPath, 0o755);
    process.env.PATH = `${homeDir}${path.delimiter}${originalPath ?? ""}`;

    const timestamp = "2026-02-16T00:00:00.000Z";
    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    const statePath = path.join(homeDir, ".tailserve", "state.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
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
      })}\n`,
      "utf8",
    );

    const server = createTailserveServer();
    server.emit("close");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual([
      "serve status",
      "serve --https=8443 off",
      "status --json",
      "serve --bg --https=443 http://localhost:7899",
      "serve --https=443 off",
    ]);
  });

  it("re-registers tailscale serve immediately for restored static file and directory shares", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "0";

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const restoredFilePath = path.join(workspace, "restored.txt");
    const restoredDirPath = path.join(workspace, "restored-dir");
    mkdirSync(restoredDirPath, { recursive: true });
    writeFileSync(restoredFilePath, "restored\n", "utf8");
    writeFileSync(path.join(restoredDirPath, "nested.txt"), "nested\n", "utf8");

    const tailscaleCapturePath = path.join(homeDir, "tailscale-calls.log");
    const fakeTailscalePath = path.join(homeDir, "fake-tailscale.sh");
    writeFileSync(
      fakeTailscalePath,
      "#!/bin/sh\n" +
        "if [ -n \"$TAILSERVE_TAILSCALE_CAPTURE\" ]; then\n" +
        "  printf '%s\\n' \"$*\" >> \"$TAILSERVE_TAILSCALE_CAPTURE\"\n" +
        "fi\n" +
        "if [ \"$1\" = \"status\" ] && [ \"$2\" = \"--json\" ]; then\n" +
        "  printf '{\"Self\":{\"DNSName\":\"demo.tailnet.ts.net.\"}}\\n'\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    const timestamp = "2026-02-16T00:00:00.000Z";
    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    const statePath = path.join(homeDir, ".tailserve", "state.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 443,
        shares: {
          keepf001: {
            id: "keepf001",
            type: "file",
            path: restoredFilePath,
            createdAt: timestamp,
            expiresAt: null,
            persist: true,
            readonly: false,
          },
          keepd001: {
            id: "keepd001",
            type: "dir",
            path: restoredDirPath,
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

    const server = createTailserveServer();
    try {
      const restoredFileShare = resolveRequest({
        method: "GET",
        url: "/s/keepf001",
      });
      expect(restoredFileShare.statusCode).toBe(200);

      const restoredDirectoryShare = resolveRequest({
        method: "GET",
        url: "/s/keepd001",
      });
      expect(restoredDirectoryShare.statusCode).toBe(200);
      expect(restoredDirectoryShare.body).toContain("nested.txt");
    } finally {
      server.emit("close");
    }

    const state = readState();
    expect(state.tsHostname).toBe("demo.tailnet.ts.net");
    expect(state.tsProtocol).toBe("https");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual([
      "serve status",
      "status --json",
      "serve --bg --https=443 http://localhost:7899",
      "serve --https=443 off",
    ]);
  });

  it("re-registers restored proxy shares and recovers once the backend is online", () => {
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
        "  printf '{\"Self\":{\"DNSName\":\"demo.tailnet.ts.net.\"}}\\n'\n" +
        "fi\n",
      "utf8",
    );
    chmodSync(fakeTailscalePath, 0o755);
    process.env.TAILSERVE_TAILSCALE_BIN = fakeTailscalePath;
    process.env.TAILSERVE_TAILSCALE_CAPTURE = tailscaleCapturePath;

    const statePath = path.join(homeDir, ".tailserve", "state.json");
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 443,
        shares: {
          prox8794: {
            id: "prox8794",
            type: "proxy",
            port: 8794,
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: null,
            persist: true,
            readonly: false,
            status: "offline",
            lastSeen: "2026-02-16T00:09:00.000Z",
          },
        },
        projects: {},
      })}\n`,
      "utf8",
    );

    let backendOnline = false;
    const requestPipe = vi.fn((destination: unknown) => destination);
    const runtime: ProjectProxyRuntime = {
      request: vi.fn((options, callback) => {
        if (backendOnline) {
          callback({
            statusCode: 200,
            headers: {
              "x-restored-proxy": "online",
            },
            pipe: (destination) => {
              destination.end("proxy online");
            },
          });
        }

        return {
          on: (eventName, listener) => {
            if (!backendOnline && eventName === "error") {
              listener(new Error("connect ECONNREFUSED"));
            }
          },
        };
      }),
      nowIso: () => "2026-02-16T00:20:00.000Z",
      writeState,
    };

    const healthCheckRunner = vi.fn(async () => {
      return;
    });

    const server = createTailserveServer({ healthCheckRunner });
    try {
      const offlineResponseSetHeader = vi.fn();
      const offlineResponseEnd = vi.fn();
      const offlineResponseDestroy = vi.fn();
      const offlineHandled = proxyShareRequest(
        {
          method: "GET",
          url: "/s/prox8794/app?x=1",
          headers: {
            "content-type": "text/plain",
          },
          pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
        },
        {
          headersSent: false,
          statusCode: 0,
          setHeader: offlineResponseSetHeader,
          end: offlineResponseEnd,
          destroy: offlineResponseDestroy,
        } as never,
        readState(),
        runtime,
      );

      expect(offlineHandled).toBe(true);
      expect(offlineResponseSetHeader).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
      expect(offlineResponseEnd).toHaveBeenCalledTimes(1);
      const offlineHtml = offlineResponseEnd.mock.calls[0]?.[0] as string;
      expect(offlineHtml).toContain("Proxy share is offline");
      expect(offlineHtml).toContain("prox8794");
      expect(offlineHtml).toContain("8794");
      expect(offlineHtml).toContain("2026-02-16T00:09:00.000Z");
      expect(readState().shares.prox8794.status).toBe("offline");

      backendOnline = true;

      const onlineResponseSetHeader = vi.fn();
      const onlineResponseEnd = vi.fn();
      const onlineResponseDestroy = vi.fn();
      const onlineHandled = proxyShareRequest(
        {
          method: "GET",
          url: "/s/prox8794/app?x=1",
          headers: {
            "content-type": "text/plain",
          },
          pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
        },
        {
          headersSent: false,
          statusCode: 0,
          setHeader: onlineResponseSetHeader,
          end: onlineResponseEnd,
          destroy: onlineResponseDestroy,
        } as never,
        readState(),
        runtime,
      );

      expect(onlineHandled).toBe(true);
      expect(onlineResponseSetHeader).toHaveBeenCalledWith("x-restored-proxy", "online");
      expect(onlineResponseEnd).toHaveBeenCalledWith("proxy online");
      expect(readState().shares.prox8794.status).toBe("online");
      expect(readState().shares.prox8794.lastSeen).toBe("2026-02-16T00:20:00.000Z");
      expect(offlineResponseDestroy).not.toHaveBeenCalled();
      expect(onlineResponseDestroy).not.toHaveBeenCalled();

      expect(runtime.request).toHaveBeenCalledTimes(2);
      expect(runtime.request).toHaveBeenNthCalledWith(
        1,
        {
          hostname: "127.0.0.1",
          port: 8794,
          method: "GET",
          path: "/app?x=1",
          headers: {
            "content-type": "text/plain",
            host: "127.0.0.1:8794",
          },
        },
        expect.any(Function),
      );
      expect(runtime.request).toHaveBeenNthCalledWith(
        2,
        {
          hostname: "127.0.0.1",
          port: 8794,
          method: "GET",
          path: "/app?x=1",
          headers: {
            "content-type": "text/plain",
            host: "127.0.0.1:8794",
          },
        },
        expect.any(Function),
      );
    } finally {
      server.emit("close");
    }

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual([
      "serve status",
      "status --json",
      "serve --bg --https=443 http://localhost:7899",
      "serve --https=443 off",
    ]);
  });

  it("runs tailscale serve off on server shutdown", () => {
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

    const timestamp = "2026-02-16T00:00:00.000Z";
    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    const statePath = path.join(homeDir, ".tailserve", "state.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "demo.tailnet.ts.net",
        tsPort: 443,
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
      })}\n`,
      "utf8",
    );

    const server = createTailserveServer();
    server.emit("close");

    const capturedCalls = readFileSync(tailscaleCapturePath, "utf8").trim().split("\n");
    expect(capturedCalls).toEqual([
      "serve status",
      "status --json",
      "serve --bg --https=443 http://localhost:7899",
      "serve --https=443 off",
    ]);
  });

  it("kills tracked tunnel processes on server shutdown", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;
    process.env.TAILSERVE_TAILSCALE_DRY_RUN = "1";

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    mkdirSync(path.join(homeDir, ".tailserve"), { recursive: true });
    const statePath = path.join(homeDir, ".tailserve", "state.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        port: 7899,
        tsHostname: "localhost",
        tsPort: 7899,
        shares: {},
        projects: {},
        tunnels: {
          first: {
            pid: 1234,
            url: "https://first.trycloudflare.com",
            port: 7899,
            createdAt: "2026-02-17T00:00:00.000Z",
          },
          second: {
            pid: 5678,
            url: "https://second.trycloudflare.com",
            port: 7899,
            createdAt: "2026-02-17T00:01:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );

    const server = createTailserveServer();
    server.emit("close");

    expect(killSpy).toHaveBeenCalledWith(1234);
    expect(killSpy).toHaveBeenCalledWith(5678);
    expect(killSpy).toHaveBeenCalledTimes(2);
  });
});
