import { spawn } from "node:child_process";
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { type Duplex } from "node:stream";

import { lookup as lookupMimeType } from "mime-types";

import { generateCodeEditorHtml, generateMarkdownEditorHtml, getEditorMode } from "./editor.js";
import { renderOfflinePage } from "./offline.js";
import { removeExpiredShares, SHARE_ID_LENGTH } from "./shares.js";
import { readState, type ShareRecord, type ShareType, type TailserveState, toShareOrigin, writeState } from "./state.js";
import { cleanupStaleTailscaleServeRoutes, disableTailscaleServe, ensureTailscaleServeForRestoredRoutes } from "./tailscale.js";
import { killTunnelProcess } from "./tunnel.js";

export interface ResolvedRequest {
  statusCode: number;
  allow?: string;
  filePath?: string;
  contentType?: string;
  body?: string;
}

const SHARE_REAPER_INTERVAL_MS = 60 * 1000;
const PROXY_HEALTH_CHECK_INTERVAL_MS = 10 * 1000;
const PROXY_HEALTH_CHECK_TIMEOUT_MS = 1000;

function isFileShare(share: ShareRecord | undefined): share is ShareRecord & { path: string } {
  return share?.type === "file" && typeof share.path === "string" && share.path.length > 0;
}

function isDirectoryShare(share: ShareRecord | undefined): share is ShareRecord & { path: string } {
  return share?.type === "dir" && typeof share.path === "string" && share.path.length > 0;
}

function isEditShare(share: ShareRecord | undefined): share is ShareRecord & { path: string } {
  return share?.type === "edit" && typeof share.path === "string" && share.path.length > 0;
}

function isProxyShare(share: ShareRecord | undefined): share is ShareRecord & { port: number } {
  return share?.type === "proxy" && typeof share.port === "number" && Number.isInteger(share.port) && share.port > 0 && share.port <= 65_535;
}

function resolveMimeType(filePath: string, fallbackType?: string): string {
  const detectedType = lookupMimeType(filePath);
  if (typeof detectedType === "string") {
    return detectedType;
  }

  if (typeof fallbackType === "string" && fallbackType.length > 0) {
    return fallbackType;
  }

  return "application/octet-stream";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildRouteHref(routePrefix: string, segments: string[], isDirectory: boolean): string {
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  if (encodedPath.length === 0) {
    return isDirectory ? `${routePrefix}/` : routePrefix;
  }

  return isDirectory ? `${routePrefix}/${encodedPath}/` : `${routePrefix}/${encodedPath}`;
}

function isHiddenPathSegment(segment: string): boolean {
  return segment.startsWith(".");
}

function buildDirectoryListing(
  routePrefix: string,
  shareRootPath: string,
  directoryPath: string,
  segments: string[],
): string | undefined {
  try {
    const entries = readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => !isHiddenPathSegment(entry.name))
      .map((entry) => ({
        entryType: entry.isDirectory() ? "dir" : "file",
        displayName: entry.isDirectory() ? `${entry.name}/` : entry.name,
        href: buildRouteHref(routePrefix, [...segments, entry.name], entry.isDirectory()),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base", numeric: true }));

    const listItems: string[] = [];
    if (segments.length > 0) {
      listItems.push(
        `<li class="entry entry-up"><a href="${escapeHtml(buildRouteHref(routePrefix, segments.slice(0, -1), true))}">../</a></li>`,
      );
    }

    for (const entry of entries) {
      listItems.push(
        `<li class="entry entry-${entry.entryType}"><a href="${escapeHtml(entry.href)}">${escapeHtml(entry.displayName)}</a></li>`,
      );
    }

    const rootName = path.basename(shareRootPath) || shareRootPath;
    const title = segments.length === 0 ? rootName : `${rootName}/${segments.join("/")}`;
    const entryCountText = `${entries.length} item${entries.length === 1 ? "" : "s"}`;

    return [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "  <meta charset=\"utf-8\">",
      `  <title>Index of ${escapeHtml(title)}</title>`,
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      "  <style>",
      "    :root {",
      "      color-scheme: light;",
      "      font-family: \"Segoe UI\", \"Helvetica Neue\", Helvetica, Arial, sans-serif;",
      "    }",
      "    body {",
      "      margin: 0;",
      "      background: #f3f5fa;",
      "      color: #0f172a;",
      "    }",
      "    main {",
      "      box-sizing: border-box;",
      "      width: min(760px, 100vw - 2rem);",
      "      margin: 2rem auto;",
      "      padding: 1.25rem;",
      "      background: #ffffff;",
      "      border: 1px solid #d7deea;",
      "      border-radius: 12px;",
      "      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);",
      "    }",
      "    h1 {",
      "      margin: 0;",
      "      font-size: 1.25rem;",
      "      line-height: 1.4;",
      "      font-weight: 700;",
      "    }",
      "    .path {",
      "      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace;",
      "      font-size: 0.95em;",
      "    }",
      "    .meta {",
      "      margin: 0.5rem 0 1rem;",
      "      color: #475569;",
      "      font-size: 0.92rem;",
      "    }",
      "    .entries {",
      "      margin: 0;",
      "      padding: 0;",
      "      list-style: none;",
      "      border: 1px solid #d7deea;",
      "      border-radius: 10px;",
      "      overflow: hidden;",
      "      background: #ffffff;",
      "    }",
      "    .entry + .entry {",
      "      border-top: 1px solid #e2e8f0;",
      "    }",
      "    .entry a {",
      "      display: block;",
      "      padding: 0.65rem 0.85rem;",
      "      color: inherit;",
      "      text-decoration: none;",
      "      transition: background-color 120ms ease;",
      "    }",
      "    .entry a:hover {",
      "      background: #eff6ff;",
      "    }",
      "  </style>",
      "</head>",
      "<body>",
      "  <main>",
      `    <h1>Index of <span class="path">${escapeHtml(title)}</span></h1>`,
      `    <p class="meta">${entryCountText}</p>`,
      `    <ul class="entries">${listItems.join("")}</ul>`,
      "  </main>",
      "</body>",
      "</html>",
    ].join("\n");
  } catch {
    return undefined;
  }
}

function formatDashboardValue(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    return "N/A";
  }

  return value;
}

function toDashboardStatus(value: unknown): string {
  if (value === "online" || value === "offline") {
    return value;
  }

  return "unknown";
}

function toDashboardStatusIndicator(value: unknown): { label: string; icon: string } {
  const status = toDashboardStatus(value);
  if (status === "online") {
    return { label: "online", icon: "🟢" };
  }

  if (status === "offline") {
    return { label: "offline", icon: "🔴" };
  }

  return { label: "unknown", icon: "⏳" };
}

function toDashboardAccess(value: unknown): string {
  return value === true ? "public" : "tailnet";
}

function buildDashboardHtml(state: TailserveState): string {
  const origin = toShareOrigin(state);
  const shareRows = Object.entries(state.shares)
    .map(([shareId, share]) => {
      const displayPath = share.type === "proxy" ? `localhost:${share.port ?? "N/A"}` : formatDashboardValue(share.path);
      const status = toDashboardStatusIndicator(share.status);
      const access = toDashboardAccess(share.public);
      const href = `${origin}/s/${shareId}`;

      return [
        "<tr>",
        `  <td>${escapeHtml(shareId)}</td>`,
        `  <td>${escapeHtml(share.type)}</td>`,
        `  <td>${escapeHtml(displayPath)}</td>`,
        `  <td><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></td>`,
        `  <td>${escapeHtml(access)}</td>`,
        `  <td><span class="status-icon" title="${escapeHtml(status.label)}">${status.icon}</span>${escapeHtml(status.label)}</td>`,
        `  <td>${escapeHtml(share.expiresAt ?? "persistent")}</td>`,
        `  <td>${escapeHtml(formatDashboardValue(share.lastSeen))}</td>`,
        "</tr>",
      ].join("\n");
    })
    .join("\n");

  const projectRows = Object.entries(state.projects)
    .map(([projectKey, projectValue]) => {
      const project = toProjectRecord(projectValue);
      if (!project) {
        return "";
      }

      const name = toProjectName(projectKey, projectValue);
      const status = toDashboardStatusIndicator(isProjectRecord(projectValue) ? projectValue.status : undefined);
      const access = toDashboardAccess(isProjectRecord(projectValue) ? projectValue.public : undefined);
      const href = `${origin}/p/${name}`;

      return [
        "<tr>",
        `  <td>${escapeHtml(name)}</td>`,
        "  <td>project</td>",
        `  <td>${escapeHtml(project.path)}</td>`,
        `  <td><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></td>`,
        `  <td>${escapeHtml(access)}</td>`,
        `  <td><span class="status-icon" title="${escapeHtml(status.label)}">${status.icon}</span>${escapeHtml(status.label)}</td>`,
        "  <td>persistent</td>",
        `  <td>${escapeHtml(formatDashboardValue(toProjectLastSeen(projectValue)))}</td>`,
        "</tr>",
      ].join("\n");
    })
    .filter((row) => row.length > 0)
    .join("\n");

  const tunnelRows = Object.entries(state.tunnels ?? {})
    .map(([tunnelName, tunnel]) => {
      const displayPort =
        Number.isInteger(tunnel.port) && tunnel.port > 0 && tunnel.port <= 65_535 ? String(tunnel.port) : "N/A";
      const displayCreatedAt = formatDashboardValue(tunnel.createdAt);
      const displayUrl = formatDashboardValue(tunnel.url);

      return [
        "<tr>",
        `  <td>${escapeHtml(tunnelName)}</td>`,
        `  <td>${escapeHtml(displayPort)}</td>`,
        displayUrl === "N/A"
          ? `  <td>${escapeHtml(displayUrl)}</td>`
          : `  <td><a href="${escapeHtml(displayUrl)}">${escapeHtml(displayUrl)}</a></td>`,
        `  <td>${escapeHtml(displayCreatedAt)}</td>`,
        "</tr>",
      ].join("\n");
    })
    .join("\n");

  const shareCount = Object.keys(state.shares).length;
  const projectCount = Object.keys(state.projects).length;

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <title>TailServe Dashboard</title>",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <style>",
    "    :root {",
    "      color-scheme: dark;",
    "      --bg: #0b0f14;",
    "      --surface: #111821;",
    "      --surface-strong: #0d141d;",
    "      --border: #223144;",
    "      --text: #dbe7f6;",
    "      --muted: #8ea5bf;",
    "      --link: #82cfff;",
    "      font-family: \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif;",
    "    }",
    "    body {",
    "      margin: 0;",
    "      background:",
    "        radial-gradient(circle at 8% -15%, rgba(130, 207, 255, 0.24), transparent 45%),",
    "        radial-gradient(circle at 92% -20%, rgba(96, 165, 250, 0.14), transparent 40%),",
    "        var(--bg);",
    "      color: var(--text);",
    "    }",
    "    main { width: min(1120px, 100vw - 2rem); margin: 1.5rem auto 2rem; }",
    "    h1 { margin: 0 0 0.45rem; font-size: 1.35rem; letter-spacing: 0.01em; }",
    "    p { margin: 0 0 1rem; color: var(--muted); }",
    "    section { margin-top: 1rem; padding: 0.8rem; border: 1px solid var(--border); border-radius: 12px; background: rgba(13, 20, 29, 0.9); }",
    "    h2 { margin: 0 0 0.55rem; font-size: 0.98rem; color: #c5d7ed; letter-spacing: 0.01em; }",
    "    table { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: var(--surface); }",
    "    th, td { text-align: left; padding: 0.6rem 0.7rem; border-bottom: 1px solid var(--border); font-size: 0.89rem; }",
    "    tr:last-child td { border-bottom: 0; }",
    "    th { color: #bbcee6; background: var(--surface-strong); }",
    "    td { color: var(--text); word-break: break-word; }",
    "    tbody tr:hover td { background: rgba(130, 207, 255, 0.08); }",
    "    a { color: var(--link); }",
    "    .status-icon { display: inline-block; width: 1.2rem; }",
    "    .empty { color: var(--muted); font-style: italic; }",
    "  </style>",
    "  <script>",
    "    const DASHBOARD_POLL_INTERVAL_MS = 10000;",
    "    async function pollDashboardHealth() {",
    "      try {",
    "        const response = await fetch('/api/health', { cache: 'no-store' });",
    "        if (response.ok) {",
    "          window.location.reload();",
    "        }",
    "      } catch {",
    "        return;",
    "      }",
    "    }",
    "    setInterval(() => {",
    "      void pollDashboardHealth();",
    "    }, DASHBOARD_POLL_INTERVAL_MS);",
    "  </script>",
    "</head>",
    "<body>",
    "  <main>",
    "    <h1>TailServe Dashboard</h1>",
    `    <p>${shareCount} share${shareCount === 1 ? "" : "s"} · ${projectCount} project${projectCount === 1 ? "" : "s"}</p>`,
    "    <section>",
    "      <h2>Shares</h2>",
    shareRows.length > 0
      ? [
          "      <table>",
          "        <thead><tr><th>Name / ID</th><th>Type</th><th>Path</th><th>URL</th><th>Access</th><th>Status</th><th>TTL / Expires</th><th>Last Health Check</th></tr></thead>",
          `        <tbody>${shareRows}</tbody>`,
          "      </table>",
        ].join("\n")
      : "      <p class=\"empty\">No shares</p>",
    "    </section>",
    "    <section>",
    "      <h2>Projects</h2>",
    projectRows.length > 0
      ? [
          "      <table>",
          "        <thead><tr><th>Name / ID</th><th>Type</th><th>Path</th><th>URL</th><th>Access</th><th>Status</th><th>TTL / Expires</th><th>Last Health Check</th></tr></thead>",
          `        <tbody>${projectRows}</tbody>`,
          "      </table>",
        ].join("\n")
      : "      <p class=\"empty\">No projects</p>",
    "    </section>",
    "    <section>",
    "      <h2>Tunnels</h2>",
    tunnelRows.length > 0
      ? [
          "      <table>",
          "        <thead><tr><th>Name</th><th>Port</th><th>URL</th><th>Created</th></tr></thead>",
          `        <tbody>${tunnelRows}</tbody>`,
          "      </table>",
        ].join("\n")
      : "      <p class=\"empty\">No tunnels</p>",
    "    </section>",
    "  </main>",
    "</body>",
    "</html>",
  ].join("\n");
}

interface ParsedSharePath {
  id: string;
  segments: string[];
}

interface ParsedProjectPath {
  name: string;
  segments: string[];
}

interface ParsedSubPath {
  segments: string[];
}

interface ProjectRecord {
  path: string;
  port?: number;
}

interface AutoRestartProjectRecord {
  path: string;
  startCmd: string;
}

interface ProxyUpstreamResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  pipe: (destination: ServerResponse) => void;
}

interface ProxyRequest {
  on: (eventName: "error", listener: (...args: unknown[]) => void) => void;
}

interface UpgradeProxyRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  httpVersion: string;
}

export interface ProjectProxyRuntime {
  request: (
    options: {
      hostname: string;
      port: number;
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
    },
    callback: (upstreamResponse: ProxyUpstreamResponse) => void,
  ) => ProxyRequest;
  connect?: (options: { host: string; port: number }) => Socket;
  nowIso?: () => string;
  writeState?: (state: TailserveState) => void;
}

export interface ProxyHealthCheckRuntime {
  readState: () => TailserveState;
  writeState: (state: TailserveState) => void;
  nowIso: () => string;
  checkPort: (port: number) => Promise<boolean>;
}

export interface CreateTailserveServerOptions {
  healthCheckRunner?: () => Promise<void>;
}

function countOfflineProjects(projects: Record<string, unknown>): number {
  let offlineProjects = 0;
  for (const project of Object.values(projects)) {
    if (isProjectRecord(project) && project.status === "offline") {
      offlineProjects += 1;
    }
  }

  return offlineProjects;
}

function formatRestoreSummary(state: TailserveState): string {
  const projectCount = Object.keys(state.projects).length;
  const shareCount = Object.keys(state.shares).length;
  const offlineProjectCount = countOfflineProjects(state.projects);
  const projectLabel = projectCount === 1 ? "project" : "projects";
  const shareLabel = shareCount === 1 ? "share" : "shares";
  const offlineProjectLabel = offlineProjectCount === 1 ? "project" : "projects";

  return `Restored ${projectCount} ${projectLabel}, ${shareCount} ${shareLabel}. ${offlineProjectCount} ${offlineProjectLabel} offline.`;
}

function parseSubPath(rawSubPath: string): ParsedSubPath | undefined {
  if (rawSubPath.length === 0) {
    return {
      segments: [],
    };
  }

  const segments: string[] = [];
  for (const rawSegment of rawSubPath.split("/")) {
    if (rawSegment.length === 0) {
      continue;
    }

    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }

    if (
      decodedSegment.length === 0 ||
      decodedSegment === "." ||
      decodedSegment === ".." ||
      decodedSegment.includes("/") ||
      decodedSegment.includes("\\")
    ) {
      return undefined;
    }

    segments.push(decodedSegment);
  }

  return {
    segments,
  };
}

function parseSharePath(pathname: string): ParsedSharePath | undefined {
  const shareMatch = new RegExp(`^/s/([A-Za-z0-9_-]{${SHARE_ID_LENGTH}})(?:/(.*))?$`).exec(pathname);
  if (!shareMatch) {
    return undefined;
  }

  const parsedSubPath = parseSubPath(shareMatch[2] ?? "");
  if (!parsedSubPath) {
    return undefined;
  }

  return {
    id: shareMatch[1],
    segments: parsedSubPath.segments,
  };
}

function parseProjectPath(pathname: string): ParsedProjectPath | undefined {
  const projectMatch = /^\/p\/([a-z0-9-]+)(?:\/(.*))?$/.exec(pathname);
  if (!projectMatch) {
    return undefined;
  }

  const parsedSubPath = parseSubPath(projectMatch[2] ?? "");
  if (!parsedSubPath) {
    return undefined;
  }

  return {
    name: projectMatch[1],
    segments: parsedSubPath.segments,
  };
}

function resolveSharePath(rootPath: string, segments: string[]): string | undefined {
  const resolvedPath = path.resolve(rootPath, ...segments);
  const relativePath = path.relative(rootPath, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return resolvedPath;
}

function hasShareExpired(share: ShareRecord, nowMs: number): boolean {
  if (share.expiresAt === null) {
    return false;
  }

  const expiresAtMs = Date.parse(share.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }

  return expiresAtMs <= nowMs;
}

function isShareType(value: unknown): value is ShareType {
  return value === "file" || value === "dir" || value === "edit" || value === "proxy";
}

function isEditContentPath(segments: string[]): boolean {
  return segments.length === 2 && segments[0] === "api" && segments[1] === "content";
}

function isEditSavePath(segments: string[]): boolean {
  return segments.length === 2 && segments[0] === "api" && segments[1] === "save";
}

function resolveEditShareRequest(
  parsedSharePath: ParsedSharePath,
  share: ShareRecord & { path: string },
): ResolvedRequest {
  if (parsedSharePath.segments.length === 0) {
    const filename = path.basename(share.path);
    const editorHtml =
      getEditorMode(filename) === "markdown-editor"
        ? generateMarkdownEditorHtml(filename, share.readonly)
        : generateCodeEditorHtml(filename, share.readonly);

    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: editorHtml,
    };
  }

  if (isEditContentPath(parsedSharePath.segments)) {
    try {
      return {
        statusCode: 200,
        contentType: "text/plain; charset=utf-8",
        body: readFileSync(share.path, "utf8"),
      };
    } catch {
      return {
        statusCode: 404,
      };
    }
  }

  return {
    statusCode: 404,
  };
}

function isProjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toRestoredShareRecord(shareId: string, value: unknown): ShareRecord | undefined {
  if (!isProjectRecord(value)) {
    return undefined;
  }

  if (!isShareType(value.type)) {
    return undefined;
  }

  if (typeof value.createdAt !== "string" || value.createdAt.length === 0) {
    return undefined;
  }

  if (typeof value.persist !== "boolean" || typeof value.readonly !== "boolean") {
    return undefined;
  }

  const expiresAt = value.expiresAt;
  if (expiresAt !== null && typeof expiresAt !== "string") {
    return undefined;
  }

  const baseShare: ShareRecord = {
    id: shareId,
    type: value.type,
    createdAt: value.createdAt,
    expiresAt,
    persist: value.persist,
    readonly: value.readonly,
  };

  if (typeof value.mimeType === "string" && value.mimeType.length > 0) {
    baseShare.mimeType = value.mimeType;
  }

  if (value.status === "online" || value.status === "offline") {
    baseShare.status = value.status;
  }

  if (typeof value.lastSeen === "string" && value.lastSeen.length > 0) {
    baseShare.lastSeen = value.lastSeen;
  }

  if (value.type === "proxy") {
    if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65_535) {
      return undefined;
    }

    return {
      ...baseShare,
      port: value.port,
    };
  }

  if (typeof value.path !== "string" || value.path.length === 0) {
    return undefined;
  }

  return {
    ...baseShare,
    path: value.path,
  };
}

function toProjectRecord(value: unknown): ProjectRecord | undefined {
  if (!isProjectRecord(value)) {
    return undefined;
  }

  if (typeof value.path !== "string" || value.path.length === 0) {
    return undefined;
  }

  const rawPort = value.port;
  if (rawPort === undefined) {
    return { path: value.path };
  }

  if (typeof rawPort !== "number" || !Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65_535) {
    return undefined;
  }

  return {
    path: value.path,
    port: rawPort,
  };
}

function toAutoRestartProjectRecord(value: unknown): AutoRestartProjectRecord | undefined {
  if (!isProjectRecord(value)) {
    return undefined;
  }

  if (value.autoRestart !== true) {
    return undefined;
  }

  if (typeof value.path !== "string" || value.path.length === 0) {
    return undefined;
  }

  if (typeof value.startCmd !== "string" || value.startCmd.trim().length === 0) {
    return undefined;
  }

  return {
    path: value.path,
    startCmd: value.startCmd.trim(),
  };
}

function attemptProjectAutoRestart(state: TailserveState): void {
  for (const projectValue of Object.values(state.projects)) {
    const project = toAutoRestartProjectRecord(projectValue);
    if (!project) {
      continue;
    }

    try {
      const child = spawn(project.startCmd, {
        cwd: project.path,
        detached: true,
        shell: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        return;
      });
      child.unref();
    } catch {
      continue;
    }
  }
}

function toProjectName(projectKey: string, value: unknown): string {
  if (!isProjectRecord(value)) {
    return projectKey;
  }

  if (typeof value.name !== "string" || value.name.length === 0) {
    return projectKey;
  }

  return value.name;
}

function toProjectLastSeen(value: unknown): string | undefined {
  if (!isProjectRecord(value)) {
    return undefined;
  }

  return typeof value.lastSeen === "string" && value.lastSeen.length > 0 ? value.lastSeen : undefined;
}

function updateProjectProxyStatus(
  projectState: unknown,
  status: "online" | "offline",
  state: TailserveState,
  runtime: ProjectProxyRuntime,
): void {
  if (!isProjectRecord(projectState)) {
    return;
  }

  if (projectState.status === status) {
    return;
  }

  projectState.status = status;
  if (status === "online") {
    projectState.lastSeen = (runtime.nowIso ?? (() => new Date().toISOString()))();
  }

  runtime.writeState?.(state);
}

function updateShareProxyStatus(
  share: ShareRecord & { port: number },
  status: "online" | "offline",
  state: TailserveState,
  runtime: ProjectProxyRuntime,
): void {
  if (share.status === status) {
    return;
  }

  share.status = status;
  if (status === "online") {
    share.lastSeen = (runtime.nowIso ?? (() => new Date().toISOString()))();
  }

  runtime.writeState?.(state);
}

function checkPortOverTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp({
      host: "127.0.0.1",
      port,
    });

    let settled = false;
    const settle = (isOnline: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(isOnline);
    };

    socket.setTimeout(PROXY_HEALTH_CHECK_TIMEOUT_MS);
    socket.once("connect", () => {
      settle(true);
    });
    socket.once("error", () => {
      settle(false);
    });
    socket.once("timeout", () => {
      settle(false);
    });
  });
}

function buildDefaultProxyHealthCheckRuntime(): ProxyHealthCheckRuntime {
  return {
    readState,
    writeState,
    nowIso: () => new Date().toISOString(),
    checkPort: checkPortOverTcp,
  };
}

interface ProjectHealthTarget {
  project: Record<string, unknown>;
  port: number;
}

function getProjectHealthTargets(state: TailserveState): ProjectHealthTarget[] {
  const targets: ProjectHealthTarget[] = [];
  for (const projectValue of Object.values(state.projects)) {
    if (!isProjectRecord(projectValue)) {
      continue;
    }

    const project = toProjectRecord(projectValue);
    if (!project || project.port === undefined) {
      continue;
    }

    targets.push({
      project: projectValue,
      port: project.port,
    });
  }

  return targets;
}

export async function runProxyHealthCheck(runtime = buildDefaultProxyHealthCheckRuntime()): Promise<void> {
  const state = runtime.readState();
  const proxyShares = Object.values(state.shares).filter(isProxyShare);
  const projectTargets = getProjectHealthTargets(state);
  if (proxyShares.length === 0 && projectTargets.length === 0) {
    return;
  }

  const uniquePorts = new Set<number>();
  for (const share of proxyShares) {
    uniquePorts.add(share.port);
  }
  for (const target of projectTargets) {
    uniquePorts.add(target.port);
  }

  const healthByPort = new Map<number, boolean>(
    await Promise.all(
      Array.from(uniquePorts, async (port) => {
        const isOnline = await runtime.checkPort(port);
        return [port, isOnline] as const;
      }),
    ),
  );

  const nowIso = runtime.nowIso();
  let hasUpdates = false;

  for (const share of proxyShares) {
    const isOnline = healthByPort.get(share.port) === true;
    const status = isOnline ? "online" : "offline";
    if (share.status !== status) {
      share.status = status;
      hasUpdates = true;
    }

    if (isOnline && share.lastSeen !== nowIso) {
      share.lastSeen = nowIso;
      hasUpdates = true;
    }
  }

  for (const target of projectTargets) {
    const isOnline = healthByPort.get(target.port) === true;
    const status = isOnline ? "online" : "offline";
    if (target.project.status !== status) {
      target.project.status = status;
      hasUpdates = true;
    }

    if (isOnline && target.project.lastSeen !== nowIso) {
      target.project.lastSeen = nowIso;
      hasUpdates = true;
    }
  }

  if (hasUpdates) {
    runtime.writeState(state);
  }
}

function startProxyHealthCheckLoop(runHealthCheck: () => Promise<void>): NodeJS.Timeout {
  let isRunning = false;
  const runTick = (): void => {
    if (isRunning) {
      return;
    }

    isRunning = true;
    void runHealthCheck()
      .catch(() => {
        return;
      })
      .finally(() => {
        isRunning = false;
      });
  };

  runTick();

  const interval = setInterval(() => {
    runTick();
  }, PROXY_HEALTH_CHECK_INTERVAL_MS);
  interval.unref();
  return interval;
}

function stopTrackedTunnels(state: TailserveState): void {
  for (const tunnel of Object.values(state.tunnels)) {
    const pid = (tunnel as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    try {
      killTunnelProcess(pid);
    } catch {
      continue;
    }
  }
}

function resolveStaticDirectoryRequest(routePrefix: string, rootPath: string, segments: string[]): ResolvedRequest {
  if (segments.some(isHiddenPathSegment)) {
    return {
      statusCode: 404,
    };
  }

  const resolvedPath = resolveSharePath(rootPath, segments);
  if (!resolvedPath) {
    return {
      statusCode: 404,
    };
  }

  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch {
    return {
      statusCode: 404,
    };
  }

  if (stats.isDirectory()) {
    const listing = buildDirectoryListing(routePrefix, rootPath, resolvedPath, segments);
    if (listing === undefined) {
      return {
        statusCode: 404,
      };
    }

    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: listing,
    };
  }

  if (!stats.isFile()) {
    return {
      statusCode: 404,
    };
  }

  return {
    statusCode: 200,
    filePath: resolvedPath,
    contentType: resolveMimeType(resolvedPath),
  };
}

export function restorePersistedRoutesOnStartup(nowMs = Date.now()): void {
  const state = readState();
  let changed = false;

  for (const [shareId, rawShare] of Object.entries(state.shares as Record<string, unknown>)) {
    const share = toRestoredShareRecord(shareId, rawShare);
    // Remove malformed or expired shares. Keep both persistent and ephemeral
    // shares that haven't expired — the reaper interval handles TTL cleanup,
    // and dropping ephemeral shares here races with the CLI creating them.
    if (!share || hasShareExpired(share, nowMs)) {
      delete state.shares[shareId];
      changed = true;
    } else {
      // Normalize: toRestoredShareRecord may fix the id to match the key
      state.shares[shareId] = share;
    }
  }

  for (const [projectName, project] of Object.entries(state.projects)) {
    if (!toProjectRecord(project)) {
      delete state.projects[projectName];
      changed = true;
    }
  }

  if (changed) {
    writeState(state);
  }
}

function writeNotFound(response: ServerResponse): void {
  response.statusCode = 404;
  response.end("Not found\n");
}

function writeJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function resolveRequest(
  request: Pick<IncomingMessage, "method" | "url">,
  state = readState(),
): ResolvedRequest {
  if (request.method !== "GET") {
    return {
      statusCode: 405,
      allow: "GET",
    };
  }

  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/api/health") {
    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ ok: true }),
    };
  }

  if (requestUrl.pathname === "/") {
    return {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: buildDashboardHtml(state),
    };
  }

  const parsedSharePath = parseSharePath(requestUrl.pathname);
  if (parsedSharePath) {
    const share = state.shares[parsedSharePath.id];
    if (isEditShare(share)) {
      return resolveEditShareRequest(parsedSharePath, share);
    }

    if (isDirectoryShare(share)) {
      return resolveStaticDirectoryRequest(`/s/${parsedSharePath.id}`, share.path, parsedSharePath.segments);
    }

    if (!isFileShare(share)) {
      return {
        statusCode: 404,
      };
    }

    if (parsedSharePath.segments.length > 0) {
      return {
        statusCode: 404,
      };
    }

    return {
      statusCode: 200,
      filePath: share.path,
      contentType: resolveMimeType(share.path, share.mimeType),
    };
  }

  const parsedProjectPath = parseProjectPath(requestUrl.pathname);
  if (!parsedProjectPath) {
    return {
      statusCode: 404,
    };
  }

  const project = toProjectRecord(state.projects[parsedProjectPath.name]);
  if (!project || project.port !== undefined) {
    return {
      statusCode: 404,
    };
  }

  return resolveStaticDirectoryRequest(`/p/${parsedProjectPath.name}`, project.path, parsedProjectPath.segments);
}

function handleResolvedRequest(response: ServerResponse, resolved: ResolvedRequest): void {
  if (resolved.statusCode === 405) {
    response.statusCode = 405;
    response.setHeader("Allow", resolved.allow ?? "GET");
    response.end("Method not allowed\n");
    return;
  }

  if (resolved.statusCode !== 200) {
    writeNotFound(response);
    return;
  }

  if (typeof resolved.body === "string") {
    response.setHeader("Content-Type", resolved.contentType ?? "text/html; charset=utf-8");
    response.end(resolved.body);
    return;
  }

  if (!resolved.filePath) {
    writeNotFound(response);
    return;
  }

  response.setHeader("Content-Type", resolved.contentType ?? "application/octet-stream");

  const stream = createReadStream(resolved.filePath);
  stream.on("error", () => {
    if (!response.headersSent) {
      writeNotFound(response);
      return;
    }

    response.destroy();
  });
  stream.pipe(response);
}

function handleShareRequest(request: IncomingMessage, response: ServerResponse, state: TailserveState): void {
  if (handleEditSaveRequest(request, response, state)) {
    return;
  }

  const resolved = resolveRequest(request, state);
  handleResolvedRequest(response, resolved);
}

function handleEditSaveRequest(request: IncomingMessage, response: ServerResponse, state: TailserveState): boolean {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const parsedSharePath = parseSharePath(requestUrl.pathname);
  if (!parsedSharePath || !isEditSavePath(parsedSharePath.segments)) {
    return false;
  }

  const share = state.shares[parsedSharePath.id];
  if (!isEditShare(share)) {
    return false;
  }

  if (request.method !== "POST") {
    response.statusCode = 405;
    response.setHeader("Allow", "POST");
    response.end("Method not allowed\n");
    return true;
  }

  if (share.readonly) {
    writeJson(response, 403, { ok: false, error: "readonly" });
    return true;
  }

  const chunks: Buffer[] = [];
  let settled = false;
  const settle = (statusCode: number, payload: Record<string, unknown>): void => {
    if (settled) {
      return;
    }

    settled = true;
    writeJson(response, statusCode, payload);
  };

  request.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  request.on("error", () => {
    settle(500, { ok: false, error: "read_failed" });
  });
  request.on("end", () => {
    if (settled) {
      return;
    }

    try {
      writeFileSync(share.path, Buffer.concat(chunks).toString("utf8"), "utf8");
      settle(200, { ok: true });
    } catch {
      settle(500, { ok: false, error: "write_failed" });
    }
  });

  return true;
}

function buildUpgradeHeaderLines(request: UpgradeProxyRequest, backendHost: string): string[] {
  const headerLines: string[] = [];
  let hasHost = false;

  if (request.rawHeaders.length > 0) {
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const headerName = request.rawHeaders[index];
      const headerValue = request.rawHeaders[index + 1] ?? "";
      if (headerName.toLowerCase() === "host") {
        if (!hasHost) {
          headerLines.push(`${headerName}: ${backendHost}`);
          hasHost = true;
        }
        continue;
      }

      headerLines.push(`${headerName}: ${headerValue}`);
    }
  } else {
    for (const [headerName, rawValue] of Object.entries(request.headers)) {
      if (rawValue === undefined) {
        continue;
      }

      if (headerName.toLowerCase() === "host") {
        if (!hasHost) {
          headerLines.push(`Host: ${backendHost}`);
          hasHost = true;
        }
        continue;
      }

      if (Array.isArray(rawValue)) {
        for (const value of rawValue) {
          headerLines.push(`${headerName}: ${value}`);
        }
        continue;
      }

      headerLines.push(`${headerName}: ${rawValue}`);
    }
  }

  if (!hasHost) {
    headerLines.push(`Host: ${backendHost}`);
  }

  return headerLines;
}

function writeUpgradeHttpResponse(socket: Duplex, statusCode: number, statusText: string, body: string): void {
  const contentLength = Buffer.byteLength(body, "utf8");
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Connection: close",
      "Content-Type: text/html; charset=utf-8",
      `Content-Length: ${contentLength}`,
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}

function proxyUpgradeToBackend(
  request: UpgradeProxyRequest,
  socket: Duplex,
  head: Buffer,
  backendPath: string,
  backendPort: number,
  runtime: ProjectProxyRuntime,
  onBackendOnline: () => void,
  onBackendOffline: () => void,
): void {
  const connect = runtime.connect ?? connectTcp;
  const backendSocket = connect({
    host: "127.0.0.1",
    port: backendPort,
  });
  let upstreamConnected = false;

  backendSocket.on("connect", () => {
    upstreamConnected = true;
    onBackendOnline();

    const backendHost = `127.0.0.1:${backendPort}`;
    const headerLines = buildUpgradeHeaderLines(request, backendHost);
    const httpVersion = request.httpVersion.length > 0 ? request.httpVersion : "1.1";
    backendSocket.write(
      `${request.method ?? "GET"} ${backendPath} HTTP/${httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`,
    );

    if (head.length > 0) {
      backendSocket.write(head);
    }

    socket.pipe(backendSocket);
    backendSocket.pipe(socket);
  });

  backendSocket.on("error", () => {
    if (upstreamConnected) {
      socket.destroy();
      return;
    }

    onBackendOffline();
  });

  socket.on("error", () => {
    backendSocket.destroy();
  });
}

export function proxyProjectRequest(
  request: Pick<IncomingMessage, "method" | "url" | "headers" | "pipe">,
  response: ServerResponse,
  state = readState(),
  runtime: ProjectProxyRuntime = { request: httpRequest },
): boolean {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const parsedProjectPath = parseProjectPath(requestUrl.pathname);
  if (!parsedProjectPath) {
    return false;
  }

  const projectState = state.projects[parsedProjectPath.name];
  const project = toProjectRecord(projectState);
  if (!project || project.port === undefined) {
    return false;
  }
  const projectPort = project.port;
  const projectName = toProjectName(parsedProjectPath.name, projectState);
  const projectLastSeen = toProjectLastSeen(projectState);

  const projectPrefix = `/p/${parsedProjectPath.name}`;
  const backendPathname = requestUrl.pathname.slice(projectPrefix.length);
  const backendPath = `${backendPathname.length === 0 ? "/" : backendPathname}${requestUrl.search}`;

  const proxy = runtime.request(
    {
      hostname: "127.0.0.1",
      port: projectPort,
      method: request.method ?? "GET",
      path: backendPath,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${projectPort}`,
      },
    },
    (upstreamResponse) => {
      updateProjectProxyStatus(projectState, "online", state, runtime);
      response.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [headerName, headerValue] of Object.entries(upstreamResponse.headers)) {
        if (headerValue !== undefined) {
          response.setHeader(headerName, headerValue);
        }
      }

      upstreamResponse.pipe(response);
    },
  );

  proxy.on("error", () => {
    updateProjectProxyStatus(projectState, "offline", state, runtime);
    if (response.headersSent) {
      response.destroy();
      return;
    }

    response.statusCode = 503;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      renderOfflinePage({
        label: "Project",
        name: projectName,
        port: projectPort,
        lastSeen: projectLastSeen,
      }),
    );
  });

  request.pipe(proxy as NodeJS.WritableStream);
  return true;
}

export function proxyProjectUpgradeRequest(
  request: UpgradeProxyRequest,
  socket: Duplex,
  head: Buffer,
  state = readState(),
  runtime: ProjectProxyRuntime = { request: httpRequest, connect: connectTcp },
): boolean {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const parsedProjectPath = parseProjectPath(requestUrl.pathname);
  if (!parsedProjectPath) {
    return false;
  }

  const projectState = state.projects[parsedProjectPath.name];
  const project = toProjectRecord(projectState);
  if (!project || project.port === undefined) {
    return false;
  }
  const projectPort = project.port;
  const projectName = toProjectName(parsedProjectPath.name, projectState);
  const projectLastSeen = toProjectLastSeen(projectState);

  const projectPrefix = `/p/${parsedProjectPath.name}`;
  const backendPathname = requestUrl.pathname.slice(projectPrefix.length);
  const backendPath = `${backendPathname.length === 0 ? "/" : backendPathname}${requestUrl.search}`;

  proxyUpgradeToBackend(
    request,
    socket,
    head,
    backendPath,
    projectPort,
    runtime,
    () => {
      updateProjectProxyStatus(projectState, "online", state, runtime);
    },
    () => {
      updateProjectProxyStatus(projectState, "offline", state, runtime);
      writeUpgradeHttpResponse(
        socket,
        503,
        "Service Unavailable",
        renderOfflinePage({
          label: "Project",
          name: projectName,
          port: projectPort,
          lastSeen: projectLastSeen,
        }),
      );
    },
  );

  return true;
}

export function proxyShareRequest(
  request: Pick<IncomingMessage, "method" | "url" | "headers" | "pipe">,
  response: ServerResponse,
  state = readState(),
  runtime: ProjectProxyRuntime = { request: httpRequest },
): boolean {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const parsedSharePath = parseSharePath(requestUrl.pathname);
  if (!parsedSharePath) {
    return false;
  }

  const share = state.shares[parsedSharePath.id];
  if (!isProxyShare(share)) {
    return false;
  }

  const sharePrefix = `/s/${parsedSharePath.id}`;
  const backendPathname = requestUrl.pathname.slice(sharePrefix.length);
  const backendPath = `${backendPathname.length === 0 ? "/" : backendPathname}${requestUrl.search}`;

  const proxy = runtime.request(
    {
      hostname: "127.0.0.1",
      port: share.port,
      method: request.method ?? "GET",
      path: backendPath,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${share.port}`,
      },
    },
    (upstreamResponse) => {
      updateShareProxyStatus(share, "online", state, runtime);
      response.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [headerName, headerValue] of Object.entries(upstreamResponse.headers)) {
        if (headerValue !== undefined) {
          response.setHeader(headerName, headerValue);
        }
      }

      upstreamResponse.pipe(response);
    },
  );

  proxy.on("error", () => {
    updateShareProxyStatus(share, "offline", state, runtime);
    if (response.headersSent) {
      response.destroy();
      return;
    }

    response.statusCode = 503;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      renderOfflinePage({
        label: "Proxy share",
        name: parsedSharePath.id,
        port: share.port,
        lastSeen: share.lastSeen,
      }),
    );
  });

  request.pipe(proxy as NodeJS.WritableStream);
  return true;
}

export function proxyShareUpgradeRequest(
  request: UpgradeProxyRequest,
  socket: Duplex,
  head: Buffer,
  state = readState(),
  runtime: ProjectProxyRuntime = { request: httpRequest, connect: connectTcp },
): boolean {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const parsedSharePath = parseSharePath(requestUrl.pathname);
  if (!parsedSharePath) {
    return false;
  }

  const share = state.shares[parsedSharePath.id];
  if (!isProxyShare(share)) {
    return false;
  }

  const sharePrefix = `/s/${parsedSharePath.id}`;
  const backendPathname = requestUrl.pathname.slice(sharePrefix.length);
  const backendPath = `${backendPathname.length === 0 ? "/" : backendPathname}${requestUrl.search}`;

  proxyUpgradeToBackend(
    request,
    socket,
    head,
    backendPath,
    share.port,
    runtime,
    () => {
      updateShareProxyStatus(share, "online", state, runtime);
    },
    () => {
      updateShareProxyStatus(share, "offline", state, runtime);
      writeUpgradeHttpResponse(
        socket,
        503,
        "Service Unavailable",
        renderOfflinePage({
          label: "Proxy share",
          name: parsedSharePath.id,
          port: share.port,
          lastSeen: share.lastSeen,
        }),
      );
    },
  );

  return true;
}

export function createTailserveServer(options?: CreateTailserveServerOptions): Server {
  cleanupStaleTailscaleServeRoutes();
  restorePersistedRoutesOnStartup();
  removeExpiredShares();
  const startupState = readState();
  const hasRestoredRoutes = Object.keys(startupState.shares).length > 0 || Object.keys(startupState.projects).length > 0;
  if (hasRestoredRoutes) {
    process.stderr.write(`${formatRestoreSummary(startupState)}\n`);
  }

  attemptProjectAutoRestart(startupState);
  if (hasRestoredRoutes) {
    ensureTailscaleServeForRestoredRoutes(startupState);
    writeState(startupState);
  }

  const server = createServer((request, response) => {
    const state = readState();
    const proxyRuntime: ProjectProxyRuntime = {
      request: httpRequest,
      nowIso: () => new Date().toISOString(),
      writeState,
    };
    if (proxyShareRequest(request, response, state, proxyRuntime)) {
      return;
    }

    if (proxyProjectRequest(request, response, state, proxyRuntime)) {
      return;
    }

    handleShareRequest(request, response, state);
  });

  server.on("upgrade", (request, socket, head) => {
    const state = readState();
    const proxyRuntime: ProjectProxyRuntime = {
      request: httpRequest,
      connect: connectTcp,
      nowIso: () => new Date().toISOString(),
      writeState,
    };

    if (proxyShareUpgradeRequest(request, socket, head, state, proxyRuntime)) {
      return;
    }

    if (proxyProjectUpgradeRequest(request, socket, head, state, proxyRuntime)) {
      return;
    }

    writeUpgradeHttpResponse(socket, 404, "Not Found", "Not found\n");
  });

  const reaper = setInterval(() => {
    removeExpiredShares();
  }, SHARE_REAPER_INTERVAL_MS);
  reaper.unref();
  const proxyHealthChecker = startProxyHealthCheckLoop(options?.healthCheckRunner ?? runProxyHealthCheck);

  server.once("close", () => {
    clearInterval(reaper);
    clearInterval(proxyHealthChecker);

    try {
      const state = readState();
      stopTrackedTunnels(state);
      disableTailscaleServe(state);
    } catch {
      return;
    }
  });

  return server;
}
