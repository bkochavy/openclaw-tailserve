#!/usr/bin/env bash
set -euo pipefail

NO_DAEMON=0
NO_SKILL=0

usage() {
  cat <<'USAGE'
Usage: install.sh [--no-daemon] [--no-skill]

Options:
  --no-daemon   Skip launchd/systemd daemon setup
  --no-skill    Skip OpenClaw skill installation
USAGE
}

log() {
  printf '[tailserve-install] %s\n' "$1"
}

warn() {
  printf '[tailserve-install] WARNING: %s\n' "$1" >&2
}

die() {
  printf '[tailserve-install] ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    die "Missing required command: ${command_name}"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-daemon)
        NO_DAEMON=1
        ;;
      --no-skill)
        NO_SKILL=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

check_node_version() {
  require_command node

  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if ! [[ "$major" =~ ^[0-9]+$ ]] || [[ "$major" -lt 18 ]]; then
    die "Node.js 18+ is required. Current version: $(node --version 2>/dev/null || printf 'unknown')"
  fi
}

check_tailscale_prereqs() {
  require_command tailscale

  local output
  local status
  set +e
  output="$(tailscale serve status 2>&1)"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    return
  fi

  local lowered
  lowered="$(printf '%s' "$output" | tr '[:upper:]' '[:lower:]')"

  if [[ "$lowered" == *"denied"* ]] || [[ "$lowered" == *"permission"* ]] || [[ "$lowered" == *"sandbox"* ]] || [[ "$lowered" == *"app store"* ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      die "Tailscale appears restricted (likely Mac App Store build). Install Standalone Tailscale: https://tailscale.com/kb/1065/macos-variants"
    fi

    warn "tailscale serve reported permission errors. On Linux run: sudo tailscale up --operator=$USER"
    return
  fi

  warn "tailscale serve status failed during preflight: $output"
}

install_tailserve_cli() {
  require_command npm

  log "Installing tailserve CLI via npm"
  npm install -g tailserve

  if ! command -v ts >/dev/null 2>&1; then
    die "tailserve installed but 'ts' command is not available in PATH"
  fi
}

run_doctor() {
  log "Running ts doctor"
  if ! ts doctor; then
    die "ts doctor reported issues. Run 'ts doctor --fix' and retry."
  fi
}

install_skill() {
  local destination_dir="$HOME/.openclaw/workspace/skills/tailserve"
  local destination_path="$destination_dir/SKILL.md"
  local script_dir
  local local_skill_path

  mkdir -p "$destination_dir"

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local_skill_path="${script_dir}/../skill/SKILL.md"

  if [[ -f "$local_skill_path" ]]; then
    cp "$local_skill_path" "$destination_path"
  else
    require_command curl
    curl -fsSL "https://raw.githubusercontent.com/bkochavy/openclaw-tailserve/main/skill/SKILL.md" -o "$destination_path"
  fi

  log "Installed OpenClaw skill at $destination_path"
}

setup_launchd_daemon() {
  if ts server install; then
    log "Configured launchd autostart via ts server install"
    return
  fi

  warn "launchd setup failed; run 'ts server install' manually"
}

resolve_global_server_entry() {
  local npm_root
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$npm_root" ]] && [[ -f "$npm_root/tailserve/dist/server-entry.js" ]]; then
    printf '%s\n' "$npm_root/tailserve/dist/server-entry.js"
    return
  fi

  printf '%s\n' ""
}

setup_systemd_daemon() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl is unavailable; skipping daemon setup"
    return
  fi

  local server_entry
  server_entry="$(resolve_global_server_entry)"
  if [[ -z "$server_entry" ]]; then
    warn "Could not find tailserve server-entry.js in global npm install; skipping systemd setup"
    return
  fi

  local unit_dir="$HOME/.config/systemd/user"
  local unit_path="$unit_dir/tailserve.service"
  local node_bin
  node_bin="$(command -v node)"

  mkdir -p "$unit_dir"
  cat > "$unit_path" <<EOF_UNIT
[Unit]
Description=TailServe daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${node_bin} ${server_entry}
Restart=always
RestartSec=2
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
EOF_UNIT

  if systemctl --user daemon-reload && systemctl --user enable --now tailserve; then
    log "Configured systemd user service at $unit_path"
  else
    warn "systemd setup incomplete. You may need: loginctl enable-linger $USER"
  fi
}

setup_daemon() {
  case "$(uname -s)" in
    Darwin)
      setup_launchd_daemon
      ;;
    Linux)
      setup_systemd_daemon
      ;;
    *)
      warn "Unsupported OS for daemon setup; skipping"
      ;;
  esac
}

main() {
  parse_args "$@"

  check_node_version
  check_tailscale_prereqs
  install_tailserve_cli
  run_doctor

  if [[ "$NO_SKILL" -eq 0 ]]; then
    install_skill
  else
    log "Skipping OpenClaw skill install (--no-skill)"
  fi

  if [[ "$NO_DAEMON" -eq 0 ]]; then
    setup_daemon
  else
    log "Skipping daemon setup (--no-daemon)"
  fi

  log "Install complete"
}

main "$@"
