#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: cleanup-shares.sh [--kill-expired]" >&2
}

count_non_empty_lines() {
  local text="$1"
  if [[ -z "$text" ]]; then
    echo "0"
    return
  fi

  printf "%s\n" "$text" | sed "/^[[:space:]]*$/d" | wc -l | tr -d " "
}

kill_expired=0

if [[ $# -gt 1 ]]; then
  usage
  exit 1
fi

if [[ $# -eq 1 ]]; then
  if [[ "$1" != "--kill-expired" ]]; then
    usage
    exit 1
  fi
  kill_expired=1
fi

shares_json="$(node bin/ts list --json 2>/dev/null || printf "[]")"

share_counts="$(
  TAILSERVE_SHARES_JSON="$shares_json" node -e '
const raw = process.env.TAILSERVE_SHARES_JSON ?? "[]";
let rows = [];
try {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    rows = parsed;
  }
} catch {}

const now = Date.now();
const expired = rows.filter((row) => {
  if (!row || typeof row !== "object") return false;
  const expires = typeof row.expires === "string" ? row.expires : "";
  if (expires.length === 0 || expires === "-") return false;
  const ms = Date.parse(expires);
  return Number.isFinite(ms) && ms <= now;
}).length;

process.stdout.write(`${rows.length} ${expired}`);
'
)"

share_count="${share_counts%% *}"
expired_count="${share_counts##* }"

share_rows="$(
  TAILSERVE_SHARES_JSON="$shares_json" node -e '
const raw = process.env.TAILSERVE_SHARES_JSON ?? "[]";
let rows = [];
try {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    rows = parsed;
  }
} catch {}

for (const row of rows) {
  if (!row || typeof row !== "object") continue;
  const id = typeof row.id === "string" ? row.id : "-";
  const type = typeof row.type === "string" ? row.type : "-";
  const expires = typeof row.expires === "string" ? row.expires : "-";
  process.stdout.write(`${id}\t${type}\t${expires}\n`);
}
'
)"

tmux_sessions="$(tmux list-sessions 2>/dev/null | grep "share-" || true)"
tmux_count="$(count_non_empty_lines "$tmux_sessions")"

tailscale_routes="$(tailscale serve status 2>/dev/null | grep -E "^https://|^\|--" || true)"
if [[ -n "$tailscale_routes" ]]; then
  tailscale_route_count="$(printf "%s\n" "$tailscale_routes" | grep "^https://" | wc -l | tr -d " ")"
else
  tailscale_route_count="0"
fi

printf "TailServe shares (%s total, %s expired)\n" "$share_count" "$expired_count"
if [[ -n "$share_rows" ]]; then
  printf "%s\n" "$share_rows"
else
  echo "(none)"
fi

echo
printf "tmux share sessions (%s)\n" "$tmux_count"
if [[ -n "$tmux_sessions" ]]; then
  printf "%s\n" "$tmux_sessions"
else
  echo "(none)"
fi

echo
printf "tailscale routes (%s)\n" "$tailscale_route_count"
if [[ -n "$tailscale_routes" ]]; then
  printf "%s\n" "$tailscale_routes"
else
  echo "(none)"
fi

if [[ "$kill_expired" -eq 1 ]]; then
  node bin/ts stop --all >/dev/null
  echo
  echo "Action: ran node bin/ts stop --all"
fi

echo
printf "Summary: shares=%s expired=%s tmux=%s routes=%s\n" \
  "$share_count" \
  "$expired_count" \
  "$tmux_count" \
  "$tailscale_route_count"
