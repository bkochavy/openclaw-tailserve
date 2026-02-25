---
name: share
description: "Share files, directories, or local servers via HTTPS URLs on the tailnet or publicly. Use whenever you need to give anyone a link to something on this machine. MANDATORY for all link sharing — never construct URLs manually or use raw tailscale serve."
version: 1.0.0
homepage: https://github.com/bkochavy/openclaw-tailserve
metadata:
  openclaw:
    emoji: "🔗"
    requires:
      bins: [ts, tailscale]
      anyBins: [cloudflared]
    os: ["macos", "linux"]
---

# Share Skill

**Use this skill every time you need to share a link.** No exceptions.

## What TailServe Is

TailServe (`ts`) is a persistent server that wraps `tailscale serve` for sharing files, directories, and local ports over HTTPS. It runs as a daemon (launchd on macOS, systemd on Linux), auto-restarts on crash/reboot, and tracks all shares in `~/.tailserve/state.json`.

- **CLI:** `ts` (or `tailserve`)
- **Server:** always running, proxied via tailscale serve
- **Dashboard:** run `ts server status` to get the dashboard URL
- **State:** `~/.tailserve/state.json`

## Decision Tree

Read top-to-bottom. Take the first match.

1. **Small file, going directly via a messaging tool** — use the messaging tool's file attachment feature (skip URL creation entirely)
2. **Recipient is on the tailnet (you, other devices, other tailnet users)** — `ts share` / `ts proxy`
3. **External recipient, temporary link** — `ts share --tunnel` (Cloudflare quick tunnel)
4. **External recipient, persistent link** — `ts share --public` or `ts funnel` (requires prior tunnel/funnel setup)

## Commands

### Share a file or directory (tailnet)

```bash
ts share /path/to/file.html
ts share /path/to/directory
ts share /path/to/file.md --persist    # no expiry
ts share /path/to/file.md --ttl 7d     # custom TTL
```

Returns the HTTPS URL on stdout. Default TTL: 24h.

### Share with browser editing

```bash
ts edit /path/to/file.md               # editable in browser
ts edit /path/to/file.md --readonly    # view-only
```

### Proxy a local port (tailnet)

```bash
ts proxy 3000                          # anonymous proxy share
ts proxy 3000 --name my-app            # named project (persistent, accessible at /p/my-app)
```

### Share externally via Cloudflare tunnel (temporary)

```bash
ts share /path/to/file --tunnel
```

Spins up a quick cloudflared tunnel. URL is temporary — dies when the tunnel process ends. Requires `cloudflared` to be installed.

### Share externally via named tunnel (persistent)

```bash
# One-time setup:
ts tunnel setup share.example.com

# Then:
ts share /path/to/file --public
ts proxy 3000 --name app --public
```

### Share via Tailscale Funnel (persistent, public)

```bash
ts funnel 3000
ts funnel 3000 --name my-app
```

Requires Tailscale Funnel to be enabled in your tailnet ACLs.

### List active shares

```bash
ts list
ts list --json
```

### Stop/remove shares

```bash
ts stop <id>           # remove a specific share
ts stop --all          # remove all ephemeral shares
ts stop --tunnels      # kill all cloudflare tunnels
```

### Server management

```bash
ts server status       # running/stopped, uptime, share count, dashboard URL
ts server stop         # graceful shutdown (service manager will restart it)
ts doctor              # diagnostics: tailscale connected? server healthy? ports free?
ts doctor --fix        # auto-repair common issues
```

### Cleanup

```bash
ts cleanup --dry-run   # preview stale tailscale routes that would be removed
ts cleanup             # remove stale routes
```

## URL Verification (Mandatory)

**Always verify before sharing.** Create the share, capture the URL, curl-verify it, then share. Never combine these steps.

```bash
# Step 1: Create the share
URL="$(ts share /path/to/file)"

# Step 2: Verify it works
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
if [ "$HTTP_CODE" = "200" ]; then
  echo "Verified: $URL"
else
  echo "FAILED: $URL returned $HTTP_CODE" >&2
  # Diagnose: ts doctor
fi

# Step 3: Only now share the URL with the recipient
```

For tunnel shares, allow a few seconds for the tunnel to establish before verifying:

```bash
URL="$(ts share /path/to/file --tunnel)"
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
```

## Rules (Non-Negotiable)

1. **Every URL gets curl-verified before sharing.** 200 OK or don't share it.
2. **Never share a link in the same step as creating it.** Create, verify, then share. Three separate steps.
3. **Don't run raw `tailscale serve` commands.** Use `ts` — it manages the tailscale route mapping and state tracking.
4. **Cloudflare tunnel shares are temporary.** Clean up with `ts stop --tunnels` when done.
5. **Named projects (`--name`) persist until explicitly removed.** Use `ts stop <id>` to clean up.
6. **Use `ts doctor` before debugging manually.** It knows how to diagnose and fix most issues.

## Troubleshooting

```bash
# Server not responding?
ts doctor --fix

# Check service status (auto-detects platform)
ts server status

# macOS: check launchd
launchctl list | grep tailserve

# Linux: check systemd
systemctl --user status tailserve

# Tailscale not connected?
tailscale status
# If disconnected: tailscale up (may need sudo on Linux)

# Linux: permission denied?
# User needs operator mode set up:
sudo tailscale up --operator=$USER

# macOS: "tailscale serve" not supported?
# User has the App Store version — they need the Standalone variant
# See: https://tailscale.com/kb/1065/macos-variants

# Port conflict?
ts doctor --fix

# Check what tailscale is currently serving
tailscale serve status

# Stale routes?
ts cleanup --dry-run
ts cleanup
```

## Protected Ports

TailServe maintains a list of protected ports (configured in `~/.tailserve/config.json`) that it will never touch during cleanup. Check current protected ports:

```bash
ts list --json | jq '.config.protectedPorts'
```

Add protected ports by editing `~/.tailserve/config.json`:

```json
{
  "protectedPorts": [18789, 8080]
}
```

## What TailServe Does NOT Do

- It does not run your application. Use `ts proxy` to expose a running server.
- It does not provide authentication. Access control is handled by Tailscale ACLs.
- It does not work without Tailscale. If Tailscale is not connected, `ts` will fail fast and tell you.
- External shares via `--tunnel` are temporary. They die when the tunnel dies.
