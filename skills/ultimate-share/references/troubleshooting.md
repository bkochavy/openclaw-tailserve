# Ultimate Share Troubleshooting

Use this file as the first stop when a generated share URL is not reachable.

1. Check local TailServe process health.
2. Confirm target port is listening before using `proxy`, `tunnel`, or `funnel`.
3. Re-run URL verification with `curl -fsSIL <url>`.
4. If cloudflared is missing, install it and retry `ts tunnel`.
5. If Funnel fails, verify Tailscale ACL/funnel permissions.
6. If access scope is unclear, drop back to tailnet-only sharing.
