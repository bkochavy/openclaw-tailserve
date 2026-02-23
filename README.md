# openclaw-tailserve

Your OpenClaw agent needs to share links. TailServe makes that work, every time.

TailServe is a CLI that wraps `tailscale serve` into a single command: share a file, get an HTTPS URL, verify it works, hand it to someone. It tracks state, cleans up after itself, and runs as a persistent daemon. This repo packages it as an OpenClaw skill so your agents know how to use it without asking you.

## What you get

- **`ts share ./file.html`** — HTTPS URL on your tailnet, stdout, verified
- **`ts proxy 3000`** — expose a local dev server to your tailnet
- **`ts share ./file --tunnel`** — temporary public URL via Cloudflare tunnel
- **`ts list`**, **`ts stop`**, **`ts doctor`** — manage, clean up, diagnose
- **Agent skill** — your agent knows exactly when and how to share links

## Prerequisites

1. **Tailscale Standalone** installed and logged in (`tailscale status` shows "connected")
   - **macOS:** Must be the [Standalone variant](https://tailscale.com/kb/1065/macos-variants), NOT the Mac App Store version. The App Store version runs in a sandbox and does not support `tailscale serve`.
   - **Linux:** Standard package install (`curl -fsSL https://tailscale.com/install.sh | sh`). Run `sudo tailscale up --operator=$USER` once to allow non-root usage.
2. **Node.js 18+** (`node --version`)
3. **npm** (comes with Node)

Optional:
- **cloudflared** — only needed for `--tunnel` (external sharing via Cloudflare)

## Install

```bash
# Install the CLI
npm install -g tailserve

# Install the OpenClaw skill
curl -fsSL https://raw.githubusercontent.com/AvaProtocol/openclaw-tailserve/main/scripts/install.sh | bash
```

Or manually:

```bash
npm install -g tailserve
mkdir -p ~/.openclaw/skills/share
cp skill/SKILL.md ~/.openclaw/skills/share/SKILL.md
```

## Quick start

```bash
# Share a file on your tailnet
ts share ./report.html
# → https://your-machine.tail1234.ts.net:7899/s/abc123/report.html

# Share a directory
ts share ./build/

# Expose a local port
ts proxy 3000

# Share externally (temporary Cloudflare tunnel)
ts share ./report.html --tunnel
# → https://random-words.trycloudflare.com/s/abc123/report.html

# See what's shared
ts list

# Clean up
ts stop abc123
ts stop --all
```

Every URL is HTTPS. Every URL goes through Tailscale's certificate infrastructure. No self-signed certs, no HTTP.

## How it works

TailServe runs its own HTTP server (default port 7899) that handles file serving, directory listings, and port proxying. It registers this port with `tailscale serve` as a proxy target, so all content is accessible via your Tailscale HTTPS hostname. This architecture means TailServe works with Tailscale's Standalone variant on macOS — it never uses `tailscale serve`'s native file serving (which is sandbox-restricted), only port proxying. State is persisted to `~/.tailserve/state.json` so shares survive server restarts.

```
your-file.html
    ↓
TailServe server (localhost:7899)
    ↓
tailscale serve (HTTPS termination + DNS)
    ↓
https://your-machine.tail1234.ts.net:7899/s/abc123/your-file.html
```

## Configuration

### Service setup (persistent daemon)

**macOS (launchd):**
```bash
ts server install    # installs launchd plist, starts automatically
ts server status     # check it's running
```

**Linux (systemd):**
```bash
ts server install    # installs systemd user unit
systemctl --user enable tailserve
systemctl --user start tailserve
loginctl enable-linger $USER    # survive logout
```

### Protected ports

If you have services that TailServe should never touch during cleanup (like an OpenClaw gateway), add them to your config:

```bash
# ~/.tailserve/config.json
{
  "protectedPorts": [18789],
  "defaultTTL": "24h",
  "port": 7899
}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `TAILSERVE_PORT` | `7899` | Server listen port |
| `TAILSERVE_HOME` | `~/.tailserve` | State and config directory |

## How agents use it

The installed skill (`~/.openclaw/skills/share/SKILL.md`) teaches your agent the complete sharing workflow:

1. **Decision tree** — which sharing method for which situation
2. **Commands** — exact syntax, what to expect on stdout
3. **Verification** — mandatory curl-check before handing URLs to anyone
4. **Cleanup** — when and how to remove shares

The agent never needs to ask you "how do I share this?" The skill covers every scenario.

See [`skill/SKILL.md`](skill/SKILL.md) for the full agent-facing documentation.

## Troubleshooting

### TailServe not responding

```bash
ts doctor          # diagnose
ts doctor --fix    # auto-repair
```

### Tailscale not connected

```bash
tailscale status
# If disconnected:
tailscale up       # macOS / Linux with GUI
sudo tailscale up  # Linux headless
```

### Port already in use

```bash
ts doctor --fix    # finds and resolves port conflicts
# Or manually:
lsof -i :7899     # see what's using the port
```

### Stale tailscale routes

```bash
ts cleanup --dry-run    # preview what would be removed
ts cleanup              # remove stale routes
```

### Linux: service doesn't survive logout

```bash
loginctl enable-linger $USER
systemctl --user enable tailserve
```

### Linux: "permission denied" from tailscale commands

```bash
# Set yourself as the Tailscale operator (one-time, requires sudo)
sudo tailscale up --operator=$USER
```

### Linux: MagicDNS not resolving tailnet hostnames

This is a known conflict between Tailscale's MagicDNS and `systemd-resolved`. Check with:
```bash
resolvectl status
# If Tailscale's 100.100.100.100 isn't listed as a DNS server, restart tailscaled
sudo systemctl restart tailscaled
```

### "background configuration already exists"

A known Tailscale issue where the serve config gets stuck in the control plane. Try:
```bash
tailscale serve reset
# If that fails, remove the node from your tailnet admin and re-authenticate
```

### `--tunnel` fails with "failed to request quick Tunnel"

If you have an existing `~/.cloudflared/config.yaml` from a named tunnel setup, quick tunnels will fail. Rename or remove it:
```bash
mv ~/.cloudflared/config.yaml ~/.cloudflared/config.yaml.bak
```

### Linux: tailnet traffic blocked by firewall

UFW default-deny policies may block traffic on the Tailscale interface:
```bash
sudo ufw allow in on tailscale0
```

## Platform support

| Platform | Status | Service manager | Notes |
|---|---|---|---|
| macOS (Standalone Tailscale) | Supported | launchd | Primary target. **Must use Standalone variant, not App Store.** |
| macOS (App Store Tailscale) | **Not supported** | - | App Store sandbox blocks `tailscale serve`. [Switch to Standalone.](https://tailscale.com/kb/1065/macos-variants) |
| Linux (Ubuntu/Debian) | Supported | systemd | Headless OK. Run `sudo tailscale up --operator=$USER` once. |
| Linux (other) | Should work | systemd | Untested on non-Debian distros |
| Windows | Not supported | - | PRs welcome |

## Limitations

Be aware of what this tool does and doesn't do:

- **Requires Tailscale.** No Tailscale, no TailServe. This is by design — Tailscale provides HTTPS, DNS, and access control.
- **Not a web server.** It serves static files and proxies ports. For dynamic apps, run your own server and use `ts proxy`.
- **Not a CDN.** Tailnet URLs are only for your tailnet. External sharing needs `--tunnel` (temporary) or Tailscale Funnel (requires ACL config).
- **Single machine.** Shares things from this machine only. Not a distributed system.
- **Cloudflare tunnels are temporary.** Quick tunnels die when the process dies. For persistent external URLs, set up a named Cloudflare tunnel or use Tailscale Funnel.
- **No per-share auth.** Access control is Tailscale's job (tailnet ACLs). External shares are fully public.
- **macOS and Linux only.** No Windows support.

## Related

- [tailserve](https://github.com/AvaProtocol/tailserve) — the CLI itself (this repo is the OpenClaw integration layer)
- [Tailscale Serve docs](https://tailscale.com/kb/1312/serve) — what's under the hood
- [Tailscale Funnel docs](https://tailscale.com/kb/1223/funnel) — public sharing via Tailscale

## License

MIT
