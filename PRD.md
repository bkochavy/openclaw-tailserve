# PRD: TailServe

**Created:** 2026-02-16T04:10:00Z
**Status:** DRAFT

## 1. Overview

TailServe is a thin CLI that wraps `tailscale serve` to give Ava (and Ben) a reliable way to share files, previews, and editor links over Tailscale HTTPS. It solves the recurring problem of orphaned `tailscale serve` routes pointing at dead backends — currently 9 of 13 routes on this machine are dead.

It does NOT reimplement a text editor. The existing `md-editor` app (Express + WebSocket + CodeMirror, at `apps/md-editor/`) already handles that. TailServe just makes it easy to point the editor at any file and get a link.

**Primary user:** Ava (programmatic — stdout URL, exit 0)
**Secondary user:** Ben from terminal

## 2. Goals

- One command → working HTTPS URL: `ts share ./file.html` → clickable link
- Zero dead links: every URL either works or shows a clean "offline" page — never "connecting..."
- Intelligent link types: ephemeral (TTL) for quick shares, persistent named routes for projects
- Reuse existing md-editor for `ts edit` (no new editor)
- Single managed port with path-based routing (no port sprawl)
- Survive reboots: persistent projects and shares restored automatically
- Clean enough for agents to call programmatically

## 3. User Stories

### US-001: Share a Static File
**Description:** As an agent, I want to share a file so that Ben gets a clickable HTTPS link.

**Acceptance Criteria:**
- [x] `ts share ./file.html` outputs a single HTTPS URL to stdout and exits 0
- [x] Visiting the URL serves the file with correct Content-Type (mime-types lookup)
- [x] Binary files (images, PDFs) served correctly
- [x] URL format: `https://<ts-hostname>:<port>/s/<id>` where id is nanoid(8)
- [x] Share info persisted to `~/.tailserve/state.json`
- [x] `npm test` passes
- [x] `npm run typecheck` passes

**Priority:** P0

---

### US-002: Share a Directory
**Description:** As an agent, I want to share a directory so that Ben can browse it.

**Acceptance Criteria:**
- [x] `ts share ./my-dir/` serves a clean directory listing at the share URL
- [x] Clicking files serves them; subdirectories are navigable
- [x] Minimal clean styling on directory listing (not raw HTML)
- [x] Hidden files (dotfiles) excluded by default
- [x] `npm test` passes
- [x] `npm run typecheck` passes

**Priority:** P0

---

### US-003: Edit a File
**Description:** As an agent, I want to open a file in the browser editor so Ben can view/edit it.

**Acceptance Criteria:**
- [x] `ts edit ./config.json` outputs an HTTPS URL to stdout
- [x] URL opens the existing md-editor app with the target file loaded (not hardcoded todos.md)
- [x] The md-editor server is started automatically if not running
- [x] Saving in the editor writes back to the original file on disk
- [x] `ts edit --readonly ./file.json` opens in read-only mode

**Implementation note:** Requires a small patch to `apps/md-editor/server.js` — instead of hardcoding `TODO_FILE`, accept a file path from the URL query param `?file=`. TailServe registers the file path in state and proxies to the editor with the right context. The md-editor's `/api/content`, `/api/save`, and WebSocket `load` message must all respect the `?file=` param. Default to `todos.md` for backward compat.

**Priority:** P0

---

### US-004: List Active Shares
**Description:** As a user, I want to see all active shares and projects.

**Acceptance Criteria:**
- [x] `ts list` outputs a table: ID, Type (file/dir/edit/proxy), Path, URL, Status, Expires
- [x] `ts list --json` outputs JSON array
- [x] Expired shares not shown
- [x] Projects included with name instead of ID
- [x] `npm run typecheck` passes

**Priority:** P1

---

### US-005: Stop a Share
**Description:** As a user, I want to remove shares.

**Acceptance Criteria:**
- [x] `ts stop <id>` removes the share, returns exit 0
- [x] `ts stop --all` removes all ephemeral shares (not projects)
- [x] Stopped shares return 404 immediately
- [x] `npm test` passes

**Priority:** P1

---

### US-006: TTL & Auto-Cleanup
**Description:** Shares should auto-expire. Dead links should never exist.

**Acceptance Criteria:**
- [x] Default TTL: 24 hours
- [x] Override: `ts share --ttl 1h ./file.html`
- [x] Persist: `ts share --persist ./file.html` (no expiry)
- [x] TTL formats supported: `30m`, `2h`, `1d`, `7d`
- [x] Reaper runs every 60s in the server process, removes expired shares
- [x] On startup: sweep state.json, remove shares whose TTL expired while server was down
- [x] `npm test` passes

**Priority:** P0

---

### US-007: Tailscale Serve Integration
**Description:** TailServe manages its own `tailscale serve` route and cleans up stale routes.

**Acceptance Criteria:**
- [x] On first share, run `tailscale serve --bg --https=<port> http://localhost:<internal-port>`
- [x] On `ts stop --all` or server shutdown, run `tailscale serve --https=<port> off`
- [x] Detect TS hostname via `tailscale status --json` → `.Self.DNSName`
- [x] Output full HTTPS URL in share commands
- [x] If tailscale not available, fall back to `http://localhost:<port>` with stderr warning
- [x] **Startup cleanup:** parse `tailscale serve status`, remove any routes pointing to ports with no live process (`lsof -ti :<port>`)
- [x] `npm test` passes

**Priority:** P0

---

### US-008: Server Lifecycle (Auto-Start & State)
**Description:** The server should auto-start on first use and be reliable.

**Acceptance Criteria:**
- [x] `ts share` auto-starts the server if not running (spawn + detach)
- [x] Server listens on a single configurable port (default 7899)
- [x] `ts server stop` gracefully shuts down and removes tailscale serve route
- [x] `ts server status` shows: running/stopped, port, active shares, active projects, uptime
- [x] PID file at `~/.tailserve/server.pid`
- [x] On startup: restore persisted shares and projects (re-register routes, skip expired)
- [x] `npm test` passes

**Priority:** P0

---

### US-009: Register a Named Project
**Description:** As an agent, I want to register a dev project with a stable named URL.

**Acceptance Criteria:**
- [x] `ts project ./projects/reelfit --port 8794 --name reelfit` registers a named project
- [x] Project gets URL: `https://<ts-hostname>:<port>/p/reelfit`
- [x] Project config persisted to state.json under `projects` key
- [x] Projects are always persistent (no TTL) — removed only by `ts project rm <name>`
- [x] If `--port` provided, TailServe proxies to that port. If not, serves directory statically.
- [x] `npm test` passes
- [x] `npm run typecheck` passes

**Priority:** P0

---

### US-010: Project Management (List, Remove, Start Command)
**Description:** As a user, I want to manage registered projects.

**Acceptance Criteria:**
- [x] `ts project list` shows table: name, path, port, URL, status (online/offline), startCmd
- [x] `ts project list --json` outputs JSON array
- [x] `ts project rm <name>` removes the project and its route from state
- [x] `--start <cmd>` flag on `ts project` saves a start command (e.g. `--start "npm run dev"`) for boot recovery
- [x] `npm test` passes

**Priority:** P0

---

### US-011: Reverse Proxy with Health Checks
**Description:** As an agent, I want to proxy a local dev server and get clean behavior when it dies.

**Acceptance Criteria:**
- [x] `ts proxy 8794` creates a reverse proxy share to `localhost:8794`, returns HTTPS URL
- [x] `ts proxy 8794 --name reelfit` combines with project mode (named + proxy)
- [x] Health check every 10s: TCP connect to backend port, update `lastSeen` in state
- [x] If backend is down: serve HTML "offline" page with project name, port, last-seen time, and auto-refresh (retries every 5s)
- [x] If backend comes back: automatically resume proxying (no manual intervention)
- [x] WebSocket connections proxied (for HMR/live reload)
- [x] `npm test` passes

**Priority:** P0

---

### US-012: Boot Recovery
**Description:** On system restart, TailServe should restore persistent shares gracefully.

**Acceptance Criteria:**
- [x] On startup, read state.json and restore all `persist` shares and projects
- [x] Static file/dir shares: re-register route immediately
- [x] Proxy shares: re-register route; if backend dead, serve "offline" page; auto-recover when alive
- [x] Projects with `--start` + `autoRestart: true`: attempt to start the backend process
- [x] Expired TTL shares purged, not restored
- [x] Log restoration summary: "Restored 3 projects, 2 shares. 1 project offline."
- [x] `npm test` passes

**Priority:** P0

---

### US-013: Launchd Install
**Description:** TailServe itself should survive macOS reboots.

**Acceptance Criteria:**
- [x] `ts server install` creates `~/Library/LaunchAgents/dev.tailserve.plist` with KeepAlive
- [x] `ts server uninstall` removes the plist and unloads it
- [x] After install + reboot, TailServe auto-starts and restores shares/projects
- [x] `npm test` passes

**Priority:** P1

---

### US-014: Status Dashboard
**Description:** A web UI showing all links, their health, and uptime.

**Acceptance Criteria:**
- [x] `GET /` on the TailServe server serves an HTML dashboard
- [x] Shows all shares (ephemeral + persistent) and all projects
- [x] Each entry: name/ID, type, path, URL (clickable), status indicator (🟢/🔴/⏳), TTL/expires, last health check
- [x] Auto-refreshes every 10s (polling `/api/health`)
- [x] Clean dark theme matching md-editor aesthetic
- [x] `ts status` in CLI opens this URL in default browser (or prints it if `--json`)
- [x] `npm run typecheck` passes

**Priority:** P1

---

## 4. Functional Requirements

- FR-1: Single port (default 7899), routing: `/` = dashboard, `/s/<id>` = ephemeral shares, `/p/<name>` = projects, `/api/*` = internal API
- FR-2: CLI name is `ts` (short, fast to type). If conflicts, also register `tailserve` as fallback bin name.
- FR-3: CLI communicates with server via HTTP on localhost
- FR-4: State file is JSON at `~/.tailserve/state.json` (see Schema section)
- FR-5: Share IDs are nanoid(8) URL-safe strings. Project names are user-provided slugs (lowercase alphanum + hyphens).
- FR-6: CLI outputs ONLY the URL to stdout on success — no banners, no decoration. Errors to stderr.
- FR-7: `--json` flag on all commands for machine-readable output
- FR-8: Server logs to `~/.tailserve/tailserve.log` (max 5MB, rotate)
- FR-9: The md-editor patch should be minimal — parameterize file path via `?file=` query string, keep existing UI intact
- FR-10: Startup cleanup removes stale `tailscale serve` routes that point to ports with no live process (checks with `lsof -ti :<port>`)
- FR-11: Health checker runs every 10s for proxy/project shares — updates state with `lastSeen` timestamp
- FR-12: "Offline" page is a bundled HTML template with project name, port, last-seen time, and auto-refresh (retries every 5s)

## 5. Schema

### `~/.tailserve/state.json`

```json
{
  "port": 7899,
  "tsHostname": "example-host.tailxxxx.ts.net",
  "tsPort": 7899,
  "shares": {
    "x8f2k1ab": {
      "id": "x8f2k1ab",
      "type": "file",
      "path": "/home/user/README.md",
      "createdAt": "2026-02-16T04:10:00Z",
      "expiresAt": "2026-02-17T04:10:00Z",
      "persist": false,
      "readonly": false
    },
    "p9m3n2cd": {
      "id": "p9m3n2cd",
      "type": "proxy",
      "port": 3000,
      "createdAt": "2026-02-16T05:00:00Z",
      "expiresAt": null,
      "persist": true,
      "status": "online",
      "lastSeen": "2026-02-16T06:30:00Z"
    }
  },
  "projects": {
    "reelfit": {
      "name": "reelfit",
      "path": "/home/user/.openclaw/workspace/projects/reelfit",
      "port": 8794,
      "startCmd": "npm run dev",
      "autoRestart": false,
      "createdAt": "2026-02-16T04:15:00Z",
      "status": "online",
      "lastSeen": "2026-02-16T06:30:00Z"
    }
  }
}
```

**Field rules:**
- `shares` keyed by nanoid(8) string
- `projects` keyed by slug name (lowercase alphanum + hyphens)
- `type`: `"file" | "dir" | "edit" | "proxy"`
- `path`: absolute path on disk (required for file/dir/edit, absent for proxy)
- `port`: backend port number (required for proxy, optional for project)
- `expiresAt`: ISO timestamp or `null` if `persist: true`
- `status`: `"online" | "offline"` — only set for proxy/project types
- `lastSeen`: ISO timestamp of last successful health check
- `startCmd`: optional shell command string for boot recovery
- `autoRestart`: boolean, whether boot recovery should run startCmd

## 6. API Shape (Internal — localhost only)

```
# Shares
POST /api/shares
  body: { type: "file"|"dir"|"edit"|"proxy", path?: string, port?: number,
          ttl?: string, persist?: boolean, readonly?: boolean }
  response: { id: string, url: string, expiresAt: string|null }

GET /api/shares
  response: { shares: [{ id, type, path, port, url, expiresAt, createdAt,
              status: "online"|"offline"|null }] }

DELETE /api/shares/:id
  response: { ok: true }

DELETE /api/shares
  response: { ok: true, removed: number }

# Projects
POST /api/projects
  body: { name: string, path: string, port?: number, startCmd?: string,
          autoRestart?: boolean }
  response: { name: string, url: string, status: "online"|"offline" }

GET /api/projects
  response: { projects: [{ name, path, port, url, status, startCmd,
              lastSeen, createdAt }] }

DELETE /api/projects/:name
  response: { ok: true }

# Status
GET /api/status
  response: { running: true, port: number, shares: number, projects: number,
              uptime: number, tsHostname: string }

# File API (for editor)
GET /api/file?path=<absolute-path>
  response: file contents (text/plain or appropriate mime type)

PUT /api/file
  body: { path: string, content: string }
  response: { ok: true }

# Health (used by dashboard)
GET /api/health
  response: { shares: [{ id, status }], projects: [{ name, status, lastSeen }] }
```

**URL routing:**
- `/` → status dashboard (HTML)
- `/s/<id>` → ephemeral shares (file, dir, edit, proxy)
- `/p/<name>` → named project routes (proxy or static)
- `/api/*` → internal API

## 7. Constraints

- Node.js/TypeScript (match existing md-editor stack, fastest to build)
- macOS arm64 primary target
- No external services or API keys
- Reuse `apps/md-editor` — patch, don't rebuild
- Installable via `npm i -g` or just `npx`
- `ts` must not conflict with TypeScript's `ts-node` — check for conflicts, use `tailserve` as fallback bin name

## 8. Non-Goals

- Monaco editor (existing CodeMirror-based md-editor is sufficient)
- Multi-machine support
- Auth beyond Tailscale ACLs
- File upload from browser

## 9. Technical Considerations

- Use `commander` for CLI
- Use `fastify` or plain `http` for server (Express is fine too — match md-editor)
- `nanoid` for share IDs
- `mime-types` for Content-Type detection
- `tailscale serve status` output parsing for cleanup
- `lsof -ti :<port>` to check if a backend is alive
- md-editor patch: change `/api/content` to accept `?file=` param, same for WebSocket `load` message and `/api/save`. Default to `todos.md` for backward compat.
- The editor UI needs a small JS patch: read `?file=` from URL and pass it in API calls
- `http-proxy` or `http-proxy-middleware` for reverse proxying with WebSocket support

## 10. Success Metrics

- `ts share ./file` returns a working URL in < 1 second
- Zero dead links — every URL either resolves or shows a clean "offline" page
- Zero stale `tailscale serve` routes after startup cleanup
- Ben can click any URL on phone or laptop and it loads immediately
- Projects survive reboots with stable URLs
- Dashboard gives instant visibility into what's alive vs dead
- Editor works for any text file, not just todos.md

## 11. Verification Commands

```bash
npm test
npm run typecheck
npm run build

# Manual verification:
ts share ./README.md                                      # → HTTPS URL, serves file
ts edit ./package.json                                    # → HTTPS URL, editor loads
ts proxy 3000                                             # → HTTPS URL, proxies dev server
ts project ./projects/reelfit --port 8794 --name reelfit  # → stable /p/reelfit URL
ts list                                                   # → table with all shares + projects
ts project list                                           # → table with projects + status
ts status                                                 # → opens dashboard in browser
ts stop --all                                             # → cleans up ephemeral shares
ts project rm reelfit                                     # → removes project
ts server install                                         # → creates launchd plist
ts server status                                          # → running, shares, projects
tailscale serve status                                    # → only TailServe's managed route
```

## 12. File Structure

```
projects/tailserve/
├── PRD.md
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts              # Commander CLI entry point
│   ├── server.ts           # HTTP server + route handler + dashboard
│   ├── state.ts            # State persistence (read/write ~/.tailserve/state.json)
│   ├── tailscale.ts        # TS serve wrapper (setup/teardown/cleanup/hostname)
│   ├── shares.ts           # Share CRUD (create/list/delete/reap)
│   ├── projects.ts         # Project CRUD (register/list/remove)
│   ├── proxy.ts            # Reverse proxy with health check + offline page
│   ├── health.ts           # Health checker (10s interval, TCP connect)
│   ├── editor-proxy.ts     # Proxy/serve the md-editor with file param
│   ├── dashboard.ts        # Status dashboard HTML generation
│   ├── offline.ts          # Offline page HTML template
│   └── utils.ts            # nanoid, mime, logging
├── test/
│   ├── state.test.ts
│   ├── shares.test.ts
│   ├── projects.test.ts
│   ├── proxy.test.ts
│   ├── health.test.ts
│   ├── tailscale.test.ts
│   └── server.test.ts
└── bin/
    └── ts.js               # CLI bin entry
```

**Patch to `apps/md-editor/`:**
- `server.js`: parameterize file path via `?file=` query param on `/api/content`, `/api/save`, and WebSocket `load`. Default to `todos.md` when no param.
- `public/index.html`: read `?file=` from URL, pass in API calls and WebSocket messages.

## 13. Open Questions

None.
