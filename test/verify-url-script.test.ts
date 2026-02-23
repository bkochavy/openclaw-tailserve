import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/verify-url.sh");
let fakeCurlDir = "";

beforeEach(() => {
  fakeCurlDir = mkdtempSync(join(tmpdir(), "tailserve-curl-"));
  const fakeCurlPath = join(fakeCurlDir, "curl");

  writeFileSync(
    fakeCurlPath,
    `#!/usr/bin/env bash
set -euo pipefail

url="\${!#}"
status_code="404"
exit_code=0

case "$url" in
  *"/200") status_code="200" ;;
  *"/301") status_code="301" ;;
  *"/302") status_code="302" ;;
  *"/fail")
    status_code="000"
    exit_code=6
    echo "curl: (6) Could not resolve host: test.invalid" >&2
    ;;
esac

printf "%s" "$status_code"
exit "$exit_code"
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(fakeCurlDir, { recursive: true, force: true });
});

function runScript(url?: string) {
  return spawnSync(scriptPath, url ? [url] : [], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeCurlDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("verify-url.sh", () => {
  it("passes for 200", () => {
    const result = runScript("https://unit.test/200");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("PASS 200");
  });

  it("passes for 301", () => {
    const result = runScript("https://unit.test/301");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("PASS 301");
  });

  it("passes for 302", () => {
    const result = runScript("https://unit.test/302");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("PASS 302");
  });

  it("fails for non-allowlisted status codes", () => {
    const result = runScript("https://unit.test/404");
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("FAIL 404");
  });

  it("fails when curl cannot resolve the host", () => {
    const result = runScript("https://unit.test/fail");
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("FAIL 000");
  });

  it("fails when URL argument is missing", () => {
    const result = runScript();
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("FAIL 000");
  });
});
