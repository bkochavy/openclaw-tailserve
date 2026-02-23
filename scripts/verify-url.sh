#!/usr/bin/env bash
set -euo pipefail

url="${1:-}"

if [[ -z "$url" ]]; then
  echo "FAIL 000"
  exit 1
fi

status_code="$(curl --silent --show-error --output /dev/null --max-time 10 --write-out "%{http_code}" "$url" || true)"

case "$status_code" in
  200|301|302)
    echo "PASS $status_code"
    exit 0
    ;;
  *)
    echo "FAIL $status_code"
    exit 1
    ;;
esac
