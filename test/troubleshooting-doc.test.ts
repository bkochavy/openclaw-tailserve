import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const docPath = resolve(process.cwd(), "references/troubleshooting.md");

describe("troubleshooting reference", () => {
  it("stays under 150 lines", () => {
    const lines = readFileSync(docPath, "utf8").split(/\r?\n/);
    expect(lines.length).toBeLessThan(150);
  });

  it("covers all required troubleshooting topics", () => {
    const content = readFileSync(docPath, "utf8").toLowerCase();
    const requiredSnippets = [
      "time_wait",
      "tailscale serve",
      "cloudflared",
      "funnel acl",
      "port auto-retry",
      "protected routes",
      "state corruption",
    ];

    for (const snippet of requiredSnippets) {
      expect(content).toContain(snippet);
    }
  });
});
