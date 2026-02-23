import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/cleanup-shares.sh");

let fakeBinDir = "";
let capturePath = "";

beforeEach(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "tailserve-cleanup-shares-"));
  capturePath = join(fakeBinDir, "node-calls.log");
  writeFileSync(capturePath, "", "utf8");

  writeFileSync(
    join(fakeBinDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ge 3 && "$1" == "bin/ts" && "$2" == "list" && "$3" == "--json" ]]; then
  printf '%s\\n' "$*" >> "$TAILSERVE_NODE_CAPTURE"
  printf '%s' "\${TAILSERVE_LIST_JSON:-[]}"
  exit 0
fi

if [[ "$#" -ge 3 && "$1" == "bin/ts" && "$2" == "stop" && "$3" == "--all" ]]; then
  printf '%s\\n' "$*" >> "$TAILSERVE_NODE_CAPTURE"
  exit 0
fi

exec "$REAL_NODE_PATH" "$@"
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(fakeBinDir, "tmux"),
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ge 1 && "$1" == "list-sessions" ]]; then
  printf '%s' "\${TAILSERVE_TMUX_OUTPUT:-}"
  exit 0
fi

exit 1
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(fakeBinDir, "tailscale"),
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ge 2 && "$1" == "serve" && "$2" == "status" ]]; then
  printf '%s' "\${TAILSERVE_TAILSCALE_OUTPUT:-}"
  exit 0
fi

exit 1
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(fakeBinDir, { recursive: true, force: true });
});

function runScript(args: string[], env: Record<string, string> = {}) {
  return spawnSync(scriptPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      REAL_NODE_PATH: process.execPath,
      TAILSERVE_NODE_CAPTURE: capturePath,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("cleanup-shares.sh", () => {
  it("lists shares, tmux share sessions, tailscale routes, and prints a summary", () => {
    const result = runScript([], {
      TAILSERVE_LIST_JSON: JSON.stringify([
        { id: "a1", type: "file", expires: "-" },
        { id: "a2", type: "proxy", expires: "2000-01-01T00:00:00.000Z" },
      ]),
      TAILSERVE_TMUX_OUTPUT: "work: 1 windows\nshare-alpha: 1 windows\nshare-beta: 1 windows\n",
      TAILSERVE_TAILSCALE_OUTPUT:
        "https://demo.tailnet.ts.net\n|-- / proxy http://localhost:7899\nhttps://demo.tailnet.ts.net:10443\n|-- /s/a2 proxy http://localhost:4000\n",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("TailServe shares (2 total, 1 expired)");
    expect(result.stdout).toContain("a1\tfile\t-");
    expect(result.stdout).toContain("a2\tproxy\t2000-01-01T00:00:00.000Z");
    expect(result.stdout).toContain("tmux share sessions (2)");
    expect(result.stdout).toContain("share-alpha");
    expect(result.stdout).toContain("share-beta");
    expect(result.stdout).toContain("tailscale routes (2)");
    expect(result.stdout).toContain("Summary: shares=2 expired=1 tmux=2 routes=2");
    expect(result.stdout).not.toContain("Action: ran node bin/ts stop --all");
    expect(result.stdout).not.toContain("work: 1 windows");

    expect(readCapturedCalls()).toEqual(["bin/ts list --json"]);
  });

  it("runs ts stop --all when --kill-expired is passed", () => {
    const result = runScript(["--kill-expired"], {
      TAILSERVE_LIST_JSON: JSON.stringify([{ id: "z1", type: "file", expires: "-" }]),
      TAILSERVE_TMUX_OUTPUT: "",
      TAILSERVE_TAILSCALE_OUTPUT: "",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Action: ran node bin/ts stop --all");
    expect(readCapturedCalls()).toEqual(["bin/ts list --json", "bin/ts stop --all"]);
  });

  it("fails with usage for unknown flags", () => {
    const result = runScript(["--bad-flag"]);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("Usage: cleanup-shares.sh [--kill-expired]");
  });
});

function readCapturedCalls(): string[] {
  const content = readFileSync(capturePath, "utf8").trim();
  if (content.length === 0) {
    return [];
  }
  return content.split("\n");
}
