---
name: ultimate-share
description: This skill should be used when deciding and executing the fastest safe sharing path for files, folders, previews, or local services. It selects between TailServe (tailnet), Cloudflare Tunnel (temporary external), Tailscale Funnel (persistent external), and direct Telegram attachment (small files), then verifies access before sending.
---

# Ultimate Share

## Purpose
- Choose one sharing path quickly.
- Run only the minimal command needed.
- Verify URL health before posting.
- Escalate failures to troubleshooting notes.

## Decision Tree
1. If the file is small and direct transfer is acceptable, use `small file -> telegram attachment`.
2. If the audience is inside tailnet only, use `tailnet -> TailServe`.
3. If the audience is external and short-lived, use `external temp -> cloudflare tunnel`.
4. If the audience is external and should stay reachable, use `external persistent -> funnel`.
5. If uncertain, start with tailnet scope and only widen access when explicitly requested.

## Methods

### tailnet -> TailServe
Use when all recipients are on the same tailnet.

```bash
ts share <path>
```

```bash
ts proxy <port>
```

### external temp -> cloudflare tunnel
Use for short-lived external access.

```bash
ts tunnel <port>
```

```bash
ts share --tunnel <path>
```

### external persistent -> funnel
Use for persistent external access and repeat recipients.

```bash
ts funnel <port>
```

```bash
ts share --public <path>
```

### small file -> telegram attachment
Use when URL creation is unnecessary and fast file transfer is enough.

- Send the file directly as a Telegram attachment.
- Skip URL creation unless the recipient explicitly requests a link.
- If a link is later required, fall back with:

```bash
ts share <path>
```

## URL Verification
Run verification after creating a link and before sharing it.

```bash
URL="$(ts share <path>)"
curl -fsSIL "$URL" >/dev/null
```

For tunnel/funnel/proxy links, replace the command in the first line and keep the same `curl` check.

## Non-Negotiable Rules
- Verify every URL before sharing.
- Never share+create in the same message.
- Never widen scope beyond what was requested.
- If verification fails, do not send the URL.
- Route all failure handling through `references/troubleshooting.md`.

## Troubleshooting
Load `references/troubleshooting.md` for known failure patterns and recovery steps.
