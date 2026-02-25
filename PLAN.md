# openclaw-tailserve: Packaging Plan

## 1. Why This Is the Best Tool for OpenClaw Users

### The core problem

Every OpenClaw agent eventually needs to give someone a link. A rendered HTML report. A CSV export. A live preview of a dev server. A log file. Without TailServe, the agent has to:

1. Figure out how to expose the file (raw `tailscale serve`? Python HTTP server? ngrok?)
2. Construct the URL manually (what's the hostname? what port? is HTTPS configured?)
3. Hope it works — no verification, no cleanup, no state tracking

This is the #1 source of "the agent gave me a broken link" failures. Every OpenClaw user hits it on day one.

### What TailServe solves

**One command, verified URL, every time.** The agent runs `ts share ./report.html`, gets back an HTTPS URL on stdout, curl-verifies it returns 200, and hands it to the user. No guessing hostnames. No port conflicts. No stale routes.

### Why it's better than alternatives

| Alternative | Problem |
|---|---|
| Raw `tailscale serve` | No state tracking, no cleanup, no file serving, no verification |
| Python `http.server` | HTTP only, no persistent state, no HTTPS, no tailnet integration |
| ngrok/localtunnel | External dependency, rate limits, requires account, no tailnet |
| Manual cloudflared | Complex setup, no state management, easy to leak tunnels |

TailServe wraps all of these into a single CLI with state tracking, auto-cleanup, and a verification workflow that agents can follow mechanically.

### Agent integration story

The skill tells the agent exactly three things:
1. **How to share** (which command for which situation)
2. **How to verify** (curl the URL, check for 200)
3. **How to clean up** (stop shares when done)

No decision-making required. The agent follows the decision tree and gets a working link every time.

---

## 2. Public Repo Structure

### Decision: single repo, CLI + skill together

The CLI (`tailserve`) is already on npm as its own package. The OpenClaw skill is a thin instruction layer on top. They belong in the same repo because:

- The skill is useless without the CLI
- The CLI version determines which commands the skill can reference
- Users install one thing, get both

### Repo: `openclaw-tailserve`

This is the **OpenClaw integration repo**, not the CLI source repo. The CLI source lives at `bkochavy/tailserve`. This repo provides:

```
openclaw-tailserve/
├── README.md              # Human-facing: what, why, install, configure
├── skill/
│   └── SKILL.md           # Agent-facing: the full skill document
├── scripts/
│   ├── install.sh         # curl-pipe installer (installs tailserve + configures skill)
│   ├── verify-url.sh      # Standalone URL verification script agents can call
│   └── doctor.sh          # Pre-flight check: tailscale running? ts installed? ports free?
├── config/
│   ├── tailserve.launchd.plist   # macOS launchd template
│   └── tailserve.service         # Linux systemd unit template
├── LICENSE                # MIT
└── .github/
    └── workflows/
        └── ci.yml         # Lint the skill, test install script
```

### npm situation

`tailserve` is already published on npm (`npm install -g tailserve`). This repo does NOT re-publish it. It installs it as a dependency and adds the OpenClaw skill layer.

### Skill installation

The skill gets symlinked or copied into `~/.openclaw/skills/share/` (or wherever the user's OpenClaw skill directory is). The install script handles this.

---

## 3. README Strategy

### Human README (README.md)

**Hook (first 3 lines):** "Your OpenClaw agent needs to share links. TailServe makes that work, every time."

**Structure:**
1. One-sentence description
2. What it does (3 bullet points max)
3. Prerequisites (Tailscale installed and logged in, Node 18+)
4. Install (one command)
5. Quick start (share a file, get a URL)
6. Configuration (protected ports, TTL defaults, service setup)
7. How agents use it (brief — points to SKILL.md)
8. Troubleshooting (the 3 most common problems)
9. Limitations (honest, upfront)

**Tone:** Direct. Opinionated. "This is how you share links with OpenClaw. There is one way. It works." No hedging, no "you might want to consider." Problem → solution → done.

### Agent README / SKILL.md

**Structure:**
1. Frontmatter (name, description, trigger conditions)
2. One-paragraph summary of what TailServe is and where it runs
3. Decision tree (what sharing method for what situation)
4. Command reference (every command, exact syntax, what stdout returns)
5. Verification protocol (mandatory — create → verify → share, never skip)
6. Rules (non-negotiable constraints)
7. Troubleshooting (commands to run when things break)
8. Protected ports (what not to touch)

**Key design principle:** The agent should NEVER need to ask the user "how do I share this?" The skill must cover every sharing scenario with a clear command.

---

## 4. Generalization Checklist

### Hardcoded personal values to remove

| Current value | Replacement | Notes |
|---|---|---|
| `https://example-host.tailxxxx.ts.net:7899/` | Dynamic: `https://$(tailscale status --json \| jq -r '.Self.DNSName' \| sed 's/\.$//'):<PORT>/` | Dashboard URL constructed at runtime |
| `example-host` hostname | `$(hostname)` or Tailscale DNS name | Never hardcode machine names |
| "Ben, other devices" | "you, other devices on your tailnet" | No personal names |
| Port 18789 (OpenClaw gateway) | Configurable via `~/.tailserve/config.json` `protectedPorts` array | Default should include common OpenClaw port |
| Port 7899 (TailServe server) | Configurable via `TAILSERVE_PORT` env var or config, default 7899 | Document the default, make it changeable |
| `launchctl list \| grep tailserve` | Platform-detected: launchctl on macOS, systemctl on Linux | Skill must handle both |
| `dev.tailserve` (launchd label) | Consistent across platforms: `dev.tailserve` (launchd) / `tailserve` (systemd) | Document both |
| Telegram-specific attachment advice | Generalize to "messaging tool file attachment" or remove | Not all OpenClaw users use Telegram |

### Assumptions that need to be configurable

1. **Server port** (7899) — env var `TAILSERVE_PORT` or `~/.tailserve/config.json`
2. **Protected ports** — array in config, default `[]` (user adds their own)
3. **Default TTL** (24h) — configurable in config
4. **Tailscale binary path** — default `tailscale`, configurable for non-standard installs
5. **Service manager** — auto-detected (launchd on macOS, systemd on Linux), with manual override
6. **Cloudflared binary path** — default `cloudflared`, skip tunnel features if not installed

---

## 5. OpenClaw Compatibility Check Items

### macOS (Standalone Tailscale) — Primary target

**CRITICAL: Mac App Store Tailscale does NOT work.** The App Store version runs in a macOS sandbox and does not support `tailscale serve`. Users MUST install the [Standalone variant](https://tailscale.com/kb/1065/macos-variants). The install script and `ts doctor` must detect this and warn loudly.

**Architecture note:** On macOS, even the Standalone variant restricts `tailscale serve`'s native file serving due to sandbox restrictions. However, TailServe works fine with Standalone because it runs its own HTTP server and only uses `tailscale serve` for **port proxying** (not native file serving). This is a key architectural advantage.

- [ ] Tailscale **Standalone** installed (not App Store)
- [ ] `tailscale` CLI available in PATH
- [ ] `tailscale status` returns connected state
- [ ] `tailscale serve` works (requires Tailscale 1.34+)
- [ ] launchd plist installs correctly to `~/Library/LaunchAgents/`
- [ ] Server survives reboot (launchd KeepAlive)
- [ ] `ts doctor` detects App Store variant and tells user to switch
- [ ] `ts doctor` detects and reports all issues
- [ ] File permissions: agent user can read/write `~/.tailserve/`

### Linux VPS/Ubuntu — Secondary target

- [ ] Tailscale installed via official package repo (`curl -fsSL https://tailscale.com/install.sh | sh`)
- [ ] `tailscale` CLI in PATH (usually `/usr/bin/tailscale`)
- [ ] `sudo tailscale up --operator=$USER` has been run (sets operator for non-root usage)
- [ ] `tailscale serve` works without root after operator is set
- [ ] Non-root users can run all `ts` commands without sudo
- [ ] systemd unit installs correctly to `~/.config/systemd/user/` (user service) or `/etc/systemd/system/` (system service)
- [ ] `systemctl --user enable tailserve` works (requires lingering: `loginctl enable-linger $USER`)
- [ ] Server survives reboot (systemd Restart=always)
- [ ] `ts doctor` detects missing `loginctl enable-linger`
- [ ] `ts doctor` detects missing operator mode and suggests `sudo tailscale up --operator=$USER`
- [ ] MagicDNS resolves correctly (no `systemd-resolved` conflicts)

### Tailscale NOT running

- [ ] `ts doctor` detects this immediately and prints clear error
- [ ] `ts share` fails fast with "Tailscale is not connected. Run `tailscale up` first."
- [ ] No silent failures — every command checks Tailscale status before proceeding
- [ ] Install script checks for Tailscale and offers to install it

### Automated agent workflows

- [ ] All commands are non-interactive (no prompts, no "press Y to continue")
- [ ] All output is machine-parseable (URLs on stdout, errors on stderr)
- [ ] Exit codes are meaningful (0=success, 1=error, 2=tailscale not running)
- [ ] `--json` flag on `ts list` for programmatic access
- [ ] URL verification script works in headless environments
- [ ] No commands require a TTY

---

## 6. Skill Design Decisions

### SKILL.md frontmatter convention

The OpenClaw ecosystem uses structured YAML frontmatter with a `metadata.openclaw` block. The skill must include:

```yaml
---
name: share
description: "..."
version: 1.0.0
metadata:
  openclaw:
    emoji: "🔗"
    requires:
      bins: [ts, tailscale]       # hard requirements — skill skipped if missing
      anyBins: [cloudflared]      # soft requirements — tunnel features disabled if missing
    os: ["macos", "linux"]
---
```

This allows the OpenClaw skill loader to gate the skill at load time: if `ts` or `tailscale` are not in PATH, the skill is silently skipped and the agent never sees it.

### What the skill MUST cover

1. **Decision tree** — Given a sharing scenario, which command to run. This is the most important part. The agent reads the tree top-to-bottom and takes the first matching branch.

2. **Command reference** — Every `ts` subcommand with exact syntax. No prose, just `command → what it does → what stdout returns`.

3. **Verification protocol** — The create-verify-share pattern. This is non-negotiable. The skill must make it clear that sharing an unverified URL is a rule violation.

4. **Cleanup expectations** — When to stop shares. Ephemeral shares expire (default 24h). Named projects persist. Tunnels must be explicitly killed.

### What the skill should NOT cover

1. **Installation** — That's the README's job. The skill assumes `ts` is installed and working.
2. **Tailscale configuration** — The skill assumes Tailscale is connected. If it's not, `ts doctor` handles it.
3. **Internal implementation** — The agent doesn't need to know about state.json, the HTTP proxy, or how tailscale serve mapping works.

### Dynamic values in the skill

The skill must NOT contain any values that change per-user. Instead:

- Dashboard URL: "Run `ts server status` to get the dashboard URL"
- Tailnet hostname: "The URL returned by `ts share` is the correct URL — use it directly"
- Protected ports: "Run `ts list --json` to see current configuration"

### Skill trigger conditions

The skill activates when the agent needs to:
- Share a file or directory with anyone
- Expose a local port/server to the tailnet or internet
- Create a preview link for rendered content
- Give someone a URL to access something on this machine

### Minimal instruction set

An agent needs exactly these capabilities:
1. `ts share <path>` — share a file/directory, get URL
2. `ts share <path> --tunnel` — share externally via Cloudflare
3. `ts proxy <port>` — expose a local port
4. `ts list` — see what's shared
5. `ts stop <id>` — remove a share
6. `ts doctor` — diagnose problems
7. URL verification pattern (curl + HTTP status check)

Everything else (edit, funnel, named projects, tunnel setup) is advanced and should be documented but not in the primary instruction path.

---

## 7. Honest Limitations

### What TailServe does NOT do

1. **Not a web server.** It serves static files and proxies ports. It doesn't run your app, compile your code, or handle dynamic routes. If you need Express/Flask/Rails, run that yourself and use `ts proxy`.

2. **Not a CDN.** Tailnet URLs are only accessible to devices on your tailnet. External sharing requires `--tunnel` (temporary Cloudflare) or `--public` (requires named tunnel setup). Neither is a production CDN.

3. **Not a file sync tool.** It shares files in-place. It doesn't copy, upload, or replicate. If the file moves or the machine goes offline, the link dies.

4. **Requires Tailscale Standalone (not App Store).** No Tailscale, no TailServe. On macOS, the Mac App Store version runs in a sandbox and does NOT support `tailscale serve`. You must install the [Standalone variant](https://tailscale.com/kb/1065/macos-variants). This is the single most common setup failure.

5. **Linux requires operator mode.** On Linux, `tailscale serve` requires either root or operator mode. Run `sudo tailscale up --operator=$USER` once after install. Without this, every `ts` command will fail with "permission denied."

6. **Single machine.** TailServe runs on one machine. It shares things from that machine. It doesn't orchestrate sharing across multiple machines.

7. **No Windows support.** macOS and Linux only. Windows might work but is untested and unsupported.

8. **Cloudflare tunnels are ephemeral.** Quick tunnels (via `--tunnel`) die when the process dies. They're for "here's a link, look at it now" sharing, not permanent URLs. Named tunnels require separate Cloudflare setup.

9. **Port conflicts are possible.** If something else is using port 7899 (or your configured port), TailServe can't start. `ts doctor --fix` handles most cases, but it can't kill other people's processes.

10. **Tailscale Funnel has limitations.** Funnel requires Tailscale ACL configuration and only works on ports 443, 8443, and 10000. Not all Tailscale plans support it.

11. **No authentication layer.** TailServe relies on Tailscale's built-in access control. Anyone on your tailnet can access tailnet shares. External shares (tunnel/funnel) are fully public. There's no per-share password or token system.

12. **"Background configuration already exists" is a known Tailscale bug.** Occasionally the serve/funnel config gets stuck in Tailscale's control plane and can't be cleared locally. `tailscale serve reset` sometimes fixes it; worst case requires removing the node from the tailnet admin console and re-authenticating.

---

## Implementation Priority

### Phase 1: Ship it (MVP)
1. Generalize SKILL.md (remove all personal values)
2. Write README.md
3. Create install.sh that installs `tailserve` via npm and copies skill
4. Create doctor.sh pre-flight script
5. Test on macOS + Linux

### Phase 2: Polish
1. Add systemd unit template
2. Add `verify-url.sh` as standalone script
3. CI workflow for linting skill/README
4. Add to OpenClaw recommended skills list

### Phase 3: Harden
1. Config file support (`~/.tailserve/config.json`)
2. Protected ports configuration
3. Graceful degradation when cloudflared is missing
4. Better error messages for headless Linux edge cases
