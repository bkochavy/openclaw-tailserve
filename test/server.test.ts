import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileShare } from "../src/shares.js";
import {
  proxyProjectRequest,
  proxyProjectUpgradeRequest,
  proxyShareRequest,
  proxyShareUpgradeRequest,
  resolveRequest,
  type ProjectProxyRuntime,
} from "../src/server.js";
import { type TailserveState } from "../src/state.js";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
    return;
  }

  process.env.HOME = originalHome;
});

describe("tailserve server", () => {
  it("serves an HTML dashboard at the root path", () => {
    const state: TailserveState = {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      tsProtocol: "https",
      shares: {
        abcd1234: {
          id: "abcd1234",
          type: "file",
          path: "/tmp/notes.txt",
          createdAt: "2026-02-16T00:00:00.000Z",
          expiresAt: "2026-02-17T00:00:00.000Z",
          persist: false,
          readonly: false,
          status: "online",
          lastSeen: "2026-02-16T00:05:00.000Z",
        },
      },
      projects: {
        reelfit: {
          name: "reelfit",
          path: "/tmp/reelfit",
          status: "offline",
        },
      },
    };

    const resolved = resolveRequest(
      {
        method: "GET",
        url: "/",
      },
      state,
    );

    expect(resolved.statusCode).toBe(200);
    expect(resolved.contentType).toBe("text/html; charset=utf-8");
    expect(resolved.body).toContain("<title>TailServe Dashboard</title>");
    expect(resolved.body).toContain("TailServe Dashboard");
    expect(resolved.body).toContain("abcd1234");
    expect(resolved.body).toContain("reelfit");
    expect(resolved.body).toContain("https://demo.tailnet.ts.net:443/s/abcd1234");
    expect(resolved.body).toContain("https://demo.tailnet.ts.net:443/p/reelfit");
  });

  it("resolves directory shares with an HTML listing", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const dirPath = path.join(workspace, "my-dir");
    mkdirSync(path.join(dirPath, "nested"), { recursive: true });
    writeFileSync(path.join(dirPath, "hello.txt"), "hello\n", "utf8");

    const { id } = createFileShare(dirPath);
    const resolved = resolveRequest({
      method: "GET",
      url: `/s/${id}`,
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.contentType).toBe("text/html; charset=utf-8");
    expect(resolved.body).toContain("Index of my-dir");
    expect(resolved.body).toContain("<style>");
    expect(resolved.body).toContain("<main>");
    expect(resolved.body).toContain('class="entries"');
    expect(resolved.body).toContain('href="/s/');
    expect(resolved.body).toContain(">hello.txt<");
    expect(resolved.body).toContain(">nested/<");
  });

  it("excludes dotfiles from directory listings by default", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const dirPath = path.join(workspace, "my-dir");
    mkdirSync(path.join(dirPath, ".private"), { recursive: true });
    writeFileSync(path.join(dirPath, ".env"), "SECRET=true\n", "utf8");
    writeFileSync(path.join(dirPath, "public.txt"), "visible\n", "utf8");

    const { id } = createFileShare(dirPath);
    const resolved = resolveRequest({
      method: "GET",
      url: `/s/${id}`,
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.body).toContain(">public.txt<");
    expect(resolved.body).not.toContain(">.env<");
    expect(resolved.body).not.toContain(">.private/<");
  });

  it("serves files inside a shared directory", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const dirPath = path.join(workspace, "my-dir");
    mkdirSync(path.join(dirPath, "nested"), { recursive: true });
    writeFileSync(path.join(dirPath, "nested", "note.txt"), "nested content\n", "utf8");

    const { id } = createFileShare(dirPath);
    const resolved = resolveRequest({
      method: "GET",
      url: `/s/${id}/nested/note.txt`,
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.contentType).toBe("text/plain");
    expect(resolved.filePath).toBe(path.join(dirPath, "nested", "note.txt"));
    expect(readFileSync(resolved.filePath ?? "", "utf8")).toBe("nested content\n");
  });

  it("navigates to subdirectory listings for shared directories", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const dirPath = path.join(workspace, "my-dir");
    mkdirSync(path.join(dirPath, "nested"), { recursive: true });
    writeFileSync(path.join(dirPath, "nested", "note.txt"), "nested content\n", "utf8");

    const { id } = createFileShare(dirPath);
    const resolved = resolveRequest({
      method: "GET",
      url: `/s/${id}/nested/`,
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.contentType).toBe("text/html; charset=utf-8");
    expect(resolved.body).toContain("Index of my-dir/nested");
    expect(resolved.body).toContain(`href="/s/${id}/">../</a>`);
    expect(resolved.body).toContain(`href="/s/${id}/nested/note.txt"`);
  });

  it("rejects directory traversal attempts for shared directories", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const dirPath = path.join(workspace, "my-dir");
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(path.join(workspace, "secret.txt"), "secret\n", "utf8");

    const { id } = createFileShare(dirPath);
    const resolved = resolveRequest({
      method: "GET",
      url: `/s/${id}/%2e%2e/secret.txt`,
    });

    expect(resolved.statusCode).toBe(404);
  });

  it("returns 404 for hidden paths inside shared directories", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const dirPath = path.join(workspace, "my-dir");
    mkdirSync(path.join(dirPath, ".private"), { recursive: true });
    writeFileSync(path.join(dirPath, ".env"), "SECRET=true\n", "utf8");
    writeFileSync(path.join(dirPath, ".private", "note.txt"), "hidden\n", "utf8");

    const { id } = createFileShare(dirPath);

    const hiddenFile = resolveRequest({
      method: "GET",
      url: `/s/${id}/.env`,
    });
    expect(hiddenFile.statusCode).toBe(404);

    const hiddenNested = resolveRequest({
      method: "GET",
      url: `/s/${id}/.private/note.txt`,
    });
    expect(hiddenNested.statusCode).toBe(404);
  });

  it("serves project directories statically when no project port is configured", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const projectPath = path.join(workspace, "reelfit");
    mkdirSync(path.join(projectPath, "nested"), { recursive: true });
    writeFileSync(path.join(projectPath, "hello.txt"), "hello\n", "utf8");
    writeFileSync(path.join(projectPath, "nested", "note.txt"), "nested\n", "utf8");
    writeFileSync(path.join(projectPath, ".env"), "SECRET=true\n", "utf8");

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {},
      projects: {
        reelfit: {
          name: "reelfit",
          path: projectPath,
          status: "online",
        },
      },
    };

    const listing = resolveRequest(
      {
        method: "GET",
        url: "/p/reelfit",
      },
      state,
    );

    expect(listing.statusCode).toBe(200);
    expect(listing.contentType).toBe("text/html; charset=utf-8");
    expect(listing.body).toContain("Index of reelfit");
    expect(listing.body).toContain('href="/p/reelfit/hello.txt"');
    expect(listing.body).toContain('href="/p/reelfit/nested/"');
    expect(listing.body).not.toContain(">.env<");

    const nestedFile = resolveRequest(
      {
        method: "GET",
        url: "/p/reelfit/nested/note.txt",
      },
      state,
    );

    expect(nestedFile.statusCode).toBe(200);
    expect(nestedFile.contentType).toBe("text/plain");
    expect(nestedFile.filePath).toBe(path.join(projectPath, "nested", "note.txt"));
  });

  it("proxies project routes when a project port is configured", () => {
    const requestPipe = vi.fn((destination: unknown) => destination);
    const responseSetHeader = vi.fn();
    const responseEnd = vi.fn();
    const responseDestroy = vi.fn();

    const runtime: ProjectProxyRuntime = {
      request: vi.fn((options, callback) => {
        callback({
          statusCode: 201,
          headers: {
            "x-proxied-by": "tailserve-test",
          },
          pipe: (destination) => {
            destination.end("proxied response");
          },
        });

        return {
          on: vi.fn(),
        };
      }),
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {},
      projects: {
        reelfit: {
          name: "reelfit",
          path: "/tmp/reelfit",
          port: 8794,
          status: "online",
        },
      },
    };

    const handled = proxyProjectRequest(
      {
        method: "POST",
        url: "/p/reelfit/api/ping?x=1",
        headers: {
          "content-type": "text/plain",
        },
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      {
        headersSent: false,
        statusCode: 0,
        setHeader: responseSetHeader,
        end: responseEnd,
        destroy: responseDestroy,
      } as never,
      state,
      runtime,
    );

    expect(handled).toBe(true);
    expect(runtime.request).toHaveBeenCalledTimes(1);
    expect(runtime.request).toHaveBeenCalledWith(
      {
        hostname: "127.0.0.1",
        port: 8794,
        method: "POST",
        path: "/api/ping?x=1",
        headers: {
          "content-type": "text/plain",
          host: "127.0.0.1:8794",
        },
      },
      expect.any(Function),
    );
    expect(requestPipe).toHaveBeenCalledTimes(1);
    expect(responseSetHeader).toHaveBeenCalledWith("x-proxied-by", "tailserve-test");
    expect(responseEnd).toHaveBeenCalledWith("proxied response");
    expect(responseDestroy).not.toHaveBeenCalled();
  });

  it("serves an offline HTML page when a project backend is down", () => {
    const requestPipe = vi.fn((destination: unknown) => destination);
    const responseSetHeader = vi.fn();
    const responseEnd = vi.fn();
    const responseDestroy = vi.fn();

    const runtime: ProjectProxyRuntime = {
      request: vi.fn(() => {
        return {
          on: (eventName, listener) => {
            if (eventName === "error") {
              listener(new Error("connect ECONNREFUSED"));
            }
          },
        };
      }),
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {},
      projects: {
        reelfit: {
          name: "reelfit",
          path: "/tmp/reelfit",
          port: 8794,
          status: "offline",
          lastSeen: "2026-02-16T00:10:00.000Z",
        },
      },
    };

    const response = {
      headersSent: false,
      statusCode: 0,
      setHeader: responseSetHeader,
      end: responseEnd,
      destroy: responseDestroy,
    } as never;

    const handled = proxyProjectRequest(
      {
        method: "GET",
        url: "/p/reelfit",
        headers: {},
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      response,
      state,
      runtime,
    );

    expect(handled).toBe(true);
    expect(runtime.request).toHaveBeenCalledTimes(1);
    expect(requestPipe).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(503);
    expect(responseSetHeader).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
    const offlineHtml = responseEnd.mock.calls[0]?.[0] as string;
    expect(offlineHtml).toContain("Project is offline");
    expect(offlineHtml).toContain("reelfit");
    expect(offlineHtml).toContain("8794");
    expect(offlineHtml).toContain("2026-02-16T00:10:00.000Z");
    expect(offlineHtml).toContain('http-equiv="refresh" content="5"');
    expect(responseDestroy).not.toHaveBeenCalled();
  });

  it("resumes project proxying automatically when the backend returns", () => {
    const requestPipe = vi.fn((destination: unknown) => destination);
    const firstResponseSetHeader = vi.fn();
    const firstResponseEnd = vi.fn();
    const firstResponseDestroy = vi.fn();
    const secondResponseSetHeader = vi.fn();
    const secondResponseEnd = vi.fn();
    const secondResponseDestroy = vi.fn();

    let attemptCount = 0;
    const runtime: ProjectProxyRuntime = {
      request: vi.fn((options, callback) => {
        attemptCount += 1;
        if (attemptCount === 1) {
          return {
            on: (eventName, listener) => {
              if (eventName === "error") {
                listener(new Error("connect ECONNREFUSED"));
              }
            },
          };
        }

        callback({
          statusCode: 200,
          headers: {
            "x-proxied-by": "tailserve-test",
          },
          pipe: (destination) => {
            destination.end("backend recovered");
          },
        });

        return {
          on: vi.fn(),
        };
      }),
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {},
      projects: {
        reelfit: {
          name: "reelfit",
          path: "/tmp/reelfit",
          port: 8794,
          status: "offline",
          lastSeen: "2026-02-16T00:10:00.000Z",
        },
      },
    };

    const firstHandled = proxyProjectRequest(
      {
        method: "GET",
        url: "/p/reelfit",
        headers: {},
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      {
        headersSent: false,
        statusCode: 0,
        setHeader: firstResponseSetHeader,
        end: firstResponseEnd,
        destroy: firstResponseDestroy,
      } as never,
      state,
      runtime,
    );

    expect(firstHandled).toBe(true);
    const firstOfflineHtml = firstResponseEnd.mock.calls[0]?.[0] as string;
    expect(firstOfflineHtml).toContain("Project is offline");

    const secondHandled = proxyProjectRequest(
      {
        method: "GET",
        url: "/p/reelfit",
        headers: {},
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      {
        headersSent: false,
        statusCode: 0,
        setHeader: secondResponseSetHeader,
        end: secondResponseEnd,
        destroy: secondResponseDestroy,
      } as never,
      state,
      runtime,
    );

    expect(secondHandled).toBe(true);
    expect(runtime.request).toHaveBeenCalledTimes(2);
    expect(secondResponseSetHeader).toHaveBeenCalledWith("x-proxied-by", "tailserve-test");
    expect(secondResponseEnd).toHaveBeenCalledWith("backend recovered");
    expect(secondResponseDestroy).not.toHaveBeenCalled();

    const projectState = state.projects.reelfit as Record<string, unknown>;
    expect(projectState.status).toBe("online");
  });

  it("proxies share routes when a proxy share port is configured", () => {
    const requestPipe = vi.fn((destination: unknown) => destination);
    const responseSetHeader = vi.fn();
    const responseEnd = vi.fn();
    const responseDestroy = vi.fn();

    const runtime: ProjectProxyRuntime = {
      request: vi.fn((options, callback) => {
        callback({
          statusCode: 200,
          headers: {
            "x-proxied-by": "tailserve-test",
          },
          pipe: (destination) => {
            destination.end("proxied share response");
          },
        });

        return {
          on: vi.fn(),
        };
      }),
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {
        prox8794: {
          id: "prox8794",
          type: "proxy",
          port: 8794,
          createdAt: "2026-02-16T00:00:00.000Z",
          expiresAt: null,
          persist: true,
          readonly: false,
        },
      },
      projects: {},
    };

    const handled = proxyShareRequest(
      {
        method: "PUT",
        url: "/s/prox8794/api/ping?x=1",
        headers: {
          "content-type": "application/json",
        },
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      {
        headersSent: false,
        statusCode: 0,
        setHeader: responseSetHeader,
        end: responseEnd,
        destroy: responseDestroy,
      } as never,
      state,
      runtime,
    );

    expect(handled).toBe(true);
    expect(runtime.request).toHaveBeenCalledTimes(1);
    expect(runtime.request).toHaveBeenCalledWith(
      {
        hostname: "127.0.0.1",
        port: 8794,
        method: "PUT",
        path: "/api/ping?x=1",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:8794",
        },
      },
      expect.any(Function),
    );
    expect(requestPipe).toHaveBeenCalledTimes(1);
    expect(responseSetHeader).toHaveBeenCalledWith("x-proxied-by", "tailserve-test");
    expect(responseEnd).toHaveBeenCalledWith("proxied share response");
    expect(responseDestroy).not.toHaveBeenCalled();
  });

  it("serves an offline HTML page when a proxy share backend is down", () => {
    const requestPipe = vi.fn((destination: unknown) => destination);
    const responseSetHeader = vi.fn();
    const responseEnd = vi.fn();
    const responseDestroy = vi.fn();

    const runtime: ProjectProxyRuntime = {
      request: vi.fn(() => {
        return {
          on: (eventName, listener) => {
            if (eventName === "error") {
              listener(new Error("connect ECONNREFUSED"));
            }
          },
        };
      }),
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
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
    };

    const response = {
      headersSent: false,
      statusCode: 0,
      setHeader: responseSetHeader,
      end: responseEnd,
      destroy: responseDestroy,
    } as never;

    const handled = proxyShareRequest(
      {
        method: "GET",
        url: "/s/prox8794",
        headers: {},
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      response,
      state,
      runtime,
    );

    expect(handled).toBe(true);
    expect(runtime.request).toHaveBeenCalledTimes(1);
    expect(requestPipe).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(503);
    expect(responseSetHeader).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
    const offlineHtml = responseEnd.mock.calls[0]?.[0] as string;
    expect(offlineHtml).toContain("Proxy share is offline");
    expect(offlineHtml).toContain("prox8794");
    expect(offlineHtml).toContain("8794");
    expect(offlineHtml).toContain("2026-02-16T00:09:00.000Z");
    expect(offlineHtml).toContain('http-equiv="refresh" content="5"');
    expect(responseDestroy).not.toHaveBeenCalled();
  });

  it("resumes proxy shares automatically when the backend returns", () => {
    const requestPipe = vi.fn((destination: unknown) => destination);
    const firstResponseSetHeader = vi.fn();
    const firstResponseEnd = vi.fn();
    const firstResponseDestroy = vi.fn();
    const secondResponseSetHeader = vi.fn();
    const secondResponseEnd = vi.fn();
    const secondResponseDestroy = vi.fn();

    let attemptCount = 0;
    const runtime: ProjectProxyRuntime = {
      request: vi.fn((options, callback) => {
        attemptCount += 1;
        if (attemptCount === 1) {
          return {
            on: (eventName, listener) => {
              if (eventName === "error") {
                listener(new Error("connect ECONNREFUSED"));
              }
            },
          };
        }

        callback({
          statusCode: 200,
          headers: {
            "x-proxied-by": "tailserve-test",
          },
          pipe: (destination) => {
            destination.end("share backend recovered");
          },
        });

        return {
          on: vi.fn(),
        };
      }),
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
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
    };

    const firstHandled = proxyShareRequest(
      {
        method: "GET",
        url: "/s/prox8794",
        headers: {},
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      {
        headersSent: false,
        statusCode: 0,
        setHeader: firstResponseSetHeader,
        end: firstResponseEnd,
        destroy: firstResponseDestroy,
      } as never,
      state,
      runtime,
    );

    expect(firstHandled).toBe(true);
    const firstOfflineHtml = firstResponseEnd.mock.calls[0]?.[0] as string;
    expect(firstOfflineHtml).toContain("Proxy share is offline");

    const secondHandled = proxyShareRequest(
      {
        method: "GET",
        url: "/s/prox8794",
        headers: {},
        pipe: requestPipe as (destination: NodeJS.WritableStream, options?: { end?: boolean }) => NodeJS.WritableStream,
      },
      {
        headersSent: false,
        statusCode: 0,
        setHeader: secondResponseSetHeader,
        end: secondResponseEnd,
        destroy: secondResponseDestroy,
      } as never,
      state,
      runtime,
    );

    expect(secondHandled).toBe(true);
    expect(runtime.request).toHaveBeenCalledTimes(2);
    expect(secondResponseSetHeader).toHaveBeenCalledWith("x-proxied-by", "tailserve-test");
    expect(secondResponseEnd).toHaveBeenCalledWith("share backend recovered");
    expect(secondResponseDestroy).not.toHaveBeenCalled();
    expect(state.shares.prox8794.status).toBe("online");
  });

  it("proxies WebSocket upgrades for project routes", () => {
    let onConnect: (() => void) | undefined;
    const backendOn = vi.fn((eventName: string, listener: () => void) => {
      if (eventName === "connect") {
        onConnect = listener;
      }
    });
    const backendWrite = vi.fn();
    const backendPipe = vi.fn((destination: unknown) => destination);
    const backendDestroy = vi.fn();
    const backendSocket = {
      on: backendOn,
      write: backendWrite,
      pipe: backendPipe,
      destroy: backendDestroy,
    } as never;

    const socketWrite = vi.fn();
    const socketPipe = vi.fn((destination: unknown) => destination);
    const socketDestroy = vi.fn();
    const socketOn = vi.fn();
    const clientSocket = {
      write: socketWrite,
      pipe: socketPipe,
      destroy: socketDestroy,
      on: socketOn,
    } as never;

    const writeStateMock = vi.fn();
    const runtime: ProjectProxyRuntime = {
      request: vi.fn() as never,
      connect: vi.fn(() => backendSocket),
      nowIso: () => "2026-02-16T23:40:00.000Z",
      writeState: writeStateMock,
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {},
      projects: {
        reelfit: {
          name: "reelfit",
          path: "/tmp/reelfit",
          port: 8794,
          status: "offline",
        },
      },
    };

    const head = Buffer.from("head-bytes");
    const handled = proxyProjectUpgradeRequest(
      {
        method: "GET",
        url: "/p/reelfit/sockjs-node?transport=websocket",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          host: "tailserve.local",
        },
        rawHeaders: [
          "Connection",
          "Upgrade",
          "Upgrade",
          "websocket",
          "Sec-WebSocket-Key",
          "abc123",
          "Host",
          "tailserve.local",
        ],
        httpVersion: "1.1",
      },
      clientSocket,
      head,
      state,
      runtime,
    );

    expect(handled).toBe(true);
    expect(runtime.connect).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 8794,
    });
    expect(onConnect).toBeTypeOf("function");

    onConnect?.();

    const serializedRequest = backendWrite.mock.calls[0]?.[0] as string;
    expect(serializedRequest).toContain("GET /sockjs-node?transport=websocket HTTP/1.1");
    expect(serializedRequest).toContain("Host: 127.0.0.1:8794");
    expect(serializedRequest).toContain("Sec-WebSocket-Key: abc123");
    expect(backendWrite).toHaveBeenNthCalledWith(2, head);
    expect(socketPipe).toHaveBeenCalledWith(backendSocket);
    expect(backendPipe).toHaveBeenCalledWith(clientSocket);
    expect(socketWrite).not.toHaveBeenCalled();
    expect(socketDestroy).not.toHaveBeenCalled();
    expect(backendDestroy).not.toHaveBeenCalled();
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    expect((state.projects.reelfit as Record<string, unknown>).status).toBe("online");
    expect((state.projects.reelfit as Record<string, unknown>).lastSeen).toBe("2026-02-16T23:40:00.000Z");
  });

  it("proxies WebSocket upgrades for proxy share routes", () => {
    let onConnect: (() => void) | undefined;
    const backendOn = vi.fn((eventName: string, listener: () => void) => {
      if (eventName === "connect") {
        onConnect = listener;
      }
    });
    const backendWrite = vi.fn();
    const backendPipe = vi.fn((destination: unknown) => destination);
    const backendDestroy = vi.fn();
    const backendSocket = {
      on: backendOn,
      write: backendWrite,
      pipe: backendPipe,
      destroy: backendDestroy,
    } as never;

    const socketWrite = vi.fn();
    const socketPipe = vi.fn((destination: unknown) => destination);
    const socketDestroy = vi.fn();
    const socketOn = vi.fn();
    const clientSocket = {
      write: socketWrite,
      pipe: socketPipe,
      destroy: socketDestroy,
      on: socketOn,
    } as never;

    const writeStateMock = vi.fn();
    const runtime: ProjectProxyRuntime = {
      request: vi.fn() as never,
      connect: vi.fn(() => backendSocket),
      nowIso: () => "2026-02-16T23:45:00.000Z",
      writeState: writeStateMock,
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
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
        },
      },
      projects: {},
    };

    const handled = proxyShareUpgradeRequest(
      {
        method: "GET",
        url: "/s/prox8794/_next/webpack-hmr?page=/",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          host: "tailserve.local",
        },
        rawHeaders: [
          "Connection",
          "Upgrade",
          "Upgrade",
          "websocket",
          "Sec-WebSocket-Version",
          "13",
          "Host",
          "tailserve.local",
        ],
        httpVersion: "1.1",
      },
      clientSocket,
      Buffer.alloc(0),
      state,
      runtime,
    );

    expect(handled).toBe(true);
    expect(onConnect).toBeTypeOf("function");

    onConnect?.();

    const serializedRequest = backendWrite.mock.calls[0]?.[0] as string;
    expect(serializedRequest).toContain("GET /_next/webpack-hmr?page=/ HTTP/1.1");
    expect(serializedRequest).toContain("Host: 127.0.0.1:8794");
    expect(serializedRequest).toContain("Sec-WebSocket-Version: 13");
    expect(socketPipe).toHaveBeenCalledWith(backendSocket);
    expect(backendPipe).toHaveBeenCalledWith(clientSocket);
    expect(socketWrite).not.toHaveBeenCalled();
    expect(socketDestroy).not.toHaveBeenCalled();
    expect(backendDestroy).not.toHaveBeenCalled();
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    expect(state.shares.prox8794.status).toBe("online");
    expect(state.shares.prox8794.lastSeen).toBe("2026-02-16T23:45:00.000Z");
  });

  it("returns 503 for WebSocket upgrades when proxy share backend is down", () => {
    let onError: (() => void) | undefined;
    const backendOn = vi.fn((eventName: string, listener: () => void) => {
      if (eventName === "error") {
        onError = listener;
      }
    });
    const backendWrite = vi.fn();
    const backendPipe = vi.fn((destination: unknown) => destination);
    const backendDestroy = vi.fn();
    const backendSocket = {
      on: backendOn,
      write: backendWrite,
      pipe: backendPipe,
      destroy: backendDestroy,
    } as never;

    const socketWrite = vi.fn();
    const socketPipe = vi.fn((destination: unknown) => destination);
    const socketDestroy = vi.fn();
    const socketOn = vi.fn();
    const clientSocket = {
      write: socketWrite,
      pipe: socketPipe,
      destroy: socketDestroy,
      on: socketOn,
    } as never;

    const writeStateMock = vi.fn();
    const runtime: ProjectProxyRuntime = {
      request: vi.fn() as never,
      connect: vi.fn(() => backendSocket),
      writeState: writeStateMock,
    };

    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {
        prox8794: {
          id: "prox8794",
          type: "proxy",
          port: 8794,
          createdAt: "2026-02-16T00:00:00.000Z",
          expiresAt: null,
          persist: true,
          readonly: false,
          status: "online",
          lastSeen: "2026-02-16T23:00:00.000Z",
        },
      },
      projects: {},
    };

    const handled = proxyShareUpgradeRequest(
      {
        method: "GET",
        url: "/s/prox8794",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          host: "tailserve.local",
        },
        rawHeaders: [
          "Connection",
          "Upgrade",
          "Upgrade",
          "websocket",
          "Host",
          "tailserve.local",
        ],
        httpVersion: "1.1",
      },
      clientSocket,
      Buffer.alloc(0),
      state,
      runtime,
    );

    expect(handled).toBe(true);
    expect(onError).toBeTypeOf("function");

    onError?.();

    const errorResponse = socketWrite.mock.calls[0]?.[0] as string;
    expect(errorResponse).toContain("HTTP/1.1 503 Service Unavailable");
    expect(errorResponse).toContain("Proxy share is offline");
    expect(socketPipe).not.toHaveBeenCalled();
    expect(backendPipe).not.toHaveBeenCalled();
    expect(backendWrite).not.toHaveBeenCalled();
    expect(socketDestroy).toHaveBeenCalledTimes(1);
    expect(backendDestroy).not.toHaveBeenCalled();
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    expect(state.shares.prox8794.status).toBe("offline");
  });

  it("resolves binary files with correct MIME types and file bytes", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));

    const imagePath = path.join(workspace, "image.png");
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]);
    writeFileSync(imagePath, imageBytes);
    const imageShare = createFileShare(imagePath);

    const pdfPath = path.join(workspace, "file.pdf");
    const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0x61]);
    writeFileSync(pdfPath, pdfBytes);
    const pdfShare = createFileShare(pdfPath);

    const imageResolved = resolveRequest({
      method: "GET",
      url: `/s/${imageShare.id}`,
    });

    expect(imageResolved.statusCode).toBe(200);
    expect(imageResolved.contentType).toBe("image/png");
    expect(readFileSync(imageResolved.filePath ?? "").equals(imageBytes)).toBe(true);

    const pdfResolved = resolveRequest({
      method: "GET",
      url: `/s/${pdfShare.id}`,
    });

    expect(pdfResolved.statusCode).toBe(200);
    expect(pdfResolved.contentType).toBe("application/pdf");
    expect(readFileSync(pdfResolved.filePath ?? "").equals(pdfBytes)).toBe(true);
  });

  it("resolves /s/:id requests with mime-type Content-Type", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "snippet.css");
    const body = "body { color: red; }\n";
    writeFileSync(filePath, body, "utf8");

    const { id, share } = createFileShare(filePath);

    const resolved = resolveRequest({
      method: "GET",
      url: `/s/${id}`,
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.contentType).toBe(share.mimeType);
    expect(resolved.filePath).toBe(path.resolve(filePath));
    expect(readFileSync(resolved.filePath ?? "", "utf8")).toBe(body);
  });

  it("uses mime-types lookup for Content-Type resolution", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "styles.css");
    const body = "body { color: blue; }\n";
    writeFileSync(filePath, body, "utf8");

    const id = "abcd1234";
    const now = new Date().toISOString();
    const state: TailserveState = {
      port: 7899,
      tsHostname: "localhost",
      tsPort: 7899,
      shares: {
        [id]: {
          id,
          type: "file",
          path: filePath,
          createdAt: now,
          expiresAt: now,
          persist: false,
          readonly: false,
          mimeType: "application/json",
        },
      },
      projects: {},
    };

    const resolved = resolveRequest(
      {
        method: "GET",
        url: `/s/${id}`,
      },
      state,
    );

    expect(resolved.statusCode).toBe(200);
    expect(resolved.contentType).toBe("text/css");
    expect(readFileSync(resolved.filePath ?? "", "utf8")).toBe(body);
  });

  it("returns 404 for /s/:id when id length is not 8", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const resolved = resolveRequest({
      method: "GET",
      url: "/s/abc123",
    });

    expect(resolved.statusCode).toBe(404);
  });

});
