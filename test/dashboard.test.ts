import { describe, expect, it } from "vitest";

import { resolveRequest } from "../src/server.js";
import { type TailserveState } from "../src/state.js";

describe("dashboard", () => {
  it("shows all shares (ephemeral and persistent) and all projects", () => {
    const state: TailserveState = {
      port: 7899,
      tsHostname: "demo.tailnet.ts.net",
      tsPort: 443,
      tsProtocol: "https",
      protectedPorts: [18789],
      shares: {
        ephm0001: {
          id: "ephm0001",
          type: "file",
          path: "/tmp/notes.txt",
          createdAt: "2026-02-16T00:00:00.000Z",
          expiresAt: "2026-02-17T00:00:00.000Z",
          persist: false,
          readonly: false,
          public: false,
          status: "online",
          lastSeen: "2026-02-16T00:05:00.000Z",
        },
        pers0002: {
          id: "pers0002",
          type: "proxy",
          port: 5173,
          createdAt: "2026-02-16T00:10:00.000Z",
          expiresAt: null,
          persist: true,
          readonly: false,
          public: true,
          status: "offline",
        },
      },
      projects: {
        webapp: {
          name: "webapp",
          path: "/tmp/webapp",
          public: true,
          port: 3000,
          status: "online",
          lastSeen: "2026-02-16T00:20:00.000Z",
        },
        docs: {
          name: "docs",
          path: "/tmp/docs",
          public: false,
        },
      },
      tunnels: {
        preview: {
          pid: 4321,
          url: "https://preview.trycloudflare.com",
          port: 7899,
          createdAt: "2026-02-16T00:25:00.000Z",
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
    expect(resolved.body).toContain("2 shares · 2 projects");
    expect(resolved.body).toContain("ephm0001");
    expect(resolved.body).toContain("pers0002");
    expect(resolved.body).toContain("webapp");
    expect(resolved.body).toContain("docs");
    expect(resolved.body).toContain("https://demo.tailnet.ts.net:443/s/ephm0001");
    expect(resolved.body).toContain("https://demo.tailnet.ts.net:443/s/pers0002");
    expect(resolved.body).toContain("https://demo.tailnet.ts.net:443/p/webapp");
    expect(resolved.body).toContain("https://demo.tailnet.ts.net:443/p/docs");
    expect(resolved.body).toContain("<th>Name / ID</th>");
    expect(resolved.body).toContain("<th>Path</th>");
    expect(resolved.body).toContain("<th>Access</th>");
    expect(resolved.body).toContain("<th>TTL / Expires</th>");
    expect(resolved.body).toContain("<th>Last Health Check</th>");
    expect(resolved.body).toContain("/tmp/notes.txt");
    expect(resolved.body).toContain("localhost:5173");
    expect(resolved.body).toContain("/tmp/webapp");
    expect(resolved.body).toContain("/tmp/docs");
    expect(resolved.body).toContain("🟢");
    expect(resolved.body).toContain("🔴");
    expect(resolved.body).toContain("⏳");
    expect(resolved.body).toContain(">tailnet<");
    expect(resolved.body).toContain(">public<");
    expect(resolved.body).toContain("persistent");
    expect(resolved.body).toContain("2026-02-17T00:00:00.000Z");
    expect(resolved.body).toContain("2026-02-16T00:05:00.000Z");
    expect(resolved.body).toContain("2026-02-16T00:20:00.000Z");
    expect(resolved.body).toContain("<h2>Tunnels</h2>");
    expect(resolved.body).toContain("<th>Name</th><th>Port</th><th>URL</th><th>Created</th>");
    expect(resolved.body).toContain("preview");
    expect(resolved.body).toContain("https://preview.trycloudflare.com");
    expect(resolved.body).toContain("2026-02-16T00:25:00.000Z");
    expect(resolved.body).toContain("N/A");
    expect(resolved.body).toContain("DASHBOARD_POLL_INTERVAL_MS = 10000");
    expect(resolved.body).toContain("fetch('/api/health'");
    expect(resolved.body).toContain("window.location.reload()");
    expect(resolved.body).toContain("--bg: #0b0f14;");
    expect(resolved.body).toContain("--surface: #111821;");
    expect(resolved.body).toContain("radial-gradient(circle at 8% -15%");
    expect(resolved.body).toContain("section { margin-top: 1rem;");
  });

  it("returns a health payload at /api/health", () => {
    const resolved = resolveRequest({
      method: "GET",
      url: "/api/health",
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.contentType).toBe("application/json; charset=utf-8");
    expect(resolved.body).toBe("{\"ok\":true}");
  });
});
