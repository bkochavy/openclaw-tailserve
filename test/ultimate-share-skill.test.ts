import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const skillPath = resolve(process.cwd(), "skills/ultimate-share/SKILL.md");

function readSkill(): string {
  return readFileSync(skillPath, "utf8");
}

function readBody(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md is missing valid YAML frontmatter");
  }

  return match[1];
}

describe("ultimate-share skill document", () => {
  it("has required frontmatter and body size", () => {
    const skill = readSkill();
    expect(skill).toContain("name: ultimate-share");
    expect(skill).toMatch(/description:\s*.+/);

    const body = readBody(skill);
    expect(body.trimEnd().split("\n").length).toBeLessThan(200);
  });

  it("contains the required decision tree mappings", () => {
    const skill = readSkill();
    expect(skill).toContain("tailnet -> TailServe");
    expect(skill).toContain("external temp -> cloudflare tunnel");
    expect(skill).toContain("external persistent -> funnel");
    expect(skill).toContain("small file -> telegram attachment");
  });

  it("contains required ts command patterns and non-negotiable rules", () => {
    const skill = readSkill();
    const base = "ts";

    expect(skill).toContain(`${base} share <path>`);
    expect(skill).toContain(`${base} proxy <port>`);
    expect(skill).toContain(`${base} tunnel <port>`);
    expect(skill).toContain(`${base} share --tunnel <path>`);
    expect(skill).toContain(`${base} funnel <port>`);
    expect(skill).toContain(`${base} share --public <path>`);

    expect(skill).toContain("Verify every URL before sharing.");
    expect(skill).toContain("Never share+create in the same message.");
    expect(skill).toContain("references/troubleshooting.md");
  });
});
