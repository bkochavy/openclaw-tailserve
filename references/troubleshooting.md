# TailServe Troubleshooting

## TIME_WAIT ports
- Symptom: restart fails with `EADDRINUSE` after stopping a process.
- Why: sockets in `TIME_WAIT` can briefly block immediate rebind.
- Check: `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- Fix: wait a few seconds and retry, or use another port.

## tailscale serve holds ports
- Symptom: localhost app is down, but `tailscale serve status` still shows routes.
- Why: Tailscale route config can outlive the local process.
- Check: `tailscale serve status`.
- Fix:
  1. Run `ts cleanup` (safe dry run by default).
  2. If needed, remove manually: `tailscale serve --https=<port> off`.

## cloudflared not installed
- Symptom: tunnel command fails before URL is printed.
- Why: `cloudflared` binary is missing from `PATH`.
- Check: `command -v cloudflared`.
- Fix:
  1. Install cloudflared (Homebrew: `brew install cloudflared`).
  2. Re-run `ts tunnel <port>` or `ts share --tunnel <path>`.

## funnel ACL
- Symptom: `--public` or `ts funnel` fails, or URL is not reachable publicly.
- Why: Funnel requires ACL/device policy support in Tailscale admin settings.
- Check:
  1. `tailscale funnel status`
  2. Tailscale admin policy allows funnel for this user/device.
- Fix:
  1. Enable funnel for the node/account in ACL policy.
  2. Retry command after policy applies.

## port auto-retry
- Symptom: requested TailServe port is busy.
- Behavior: TailServe retries from `<port>` through `<port + 10>`.
- Notes:
  1. Retry messages are written to `stderr`.
  2. Active port is persisted in state (`port` and `tsPort`).
- If all retries fail: free a port, then restart server/share command.

## protected routes
- Symptom: cleanup skips routes you expected to remove.
- Why: protected backend ports are excluded from stale-route cleanup.
- Defaults: port `18789` and any HTTPS 443 route are protected.
- Override: set `TAILSERVE_PROTECTED_PORTS` (comma-separated ports).
- Example: `TAILSERVE_PROTECTED_PORTS=18789,3000 ts cleanup`.

## state corruption
- Symptom: malformed `~/.tailserve/state.json` or inconsistent runtime behavior.
- Why: interrupted writes, manual edits, or stale lock artifacts.
- Recovery:
  1. Stop server: `ts server stop`.
  2. Back up state: `cp ~/.tailserve/state.json ~/.tailserve/state.json.bak`.
  3. Validate JSON: `node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' ~/.tailserve/state.json`.
  4. If invalid, restore backup or replace with minimal valid object.
  5. Start server and verify with `ts list --json` and `ts server status`.
