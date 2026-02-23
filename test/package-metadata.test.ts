import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

type PackageMetadata = {
  repository?: {
    type?: string;
    url?: string;
  };
  homepage?: string;
  bugs?: {
    url?: string;
  };
  keywords?: string[];
  engines?: {
    node?: string;
  };
  files?: string[];
};

describe("package metadata", () => {
  it("sets repository, homepage, bugs, and keywords", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as PackageMetadata;

    expect(packageJson.repository).toEqual({
      type: "git",
      url: "https://github.com/bkochavy/openclaw-tailserve.git",
    });
    expect(packageJson.homepage).toBe("https://github.com/bkochavy/openclaw-tailserve");
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/bkochavy/openclaw-tailserve/issues",
    });
    expect(packageJson.keywords).toEqual([
      "tailscale",
      "openclaw",
      "ai-agent",
      "file-sharing",
      "cli",
    ]);
  });

  it("pins node engine and publish files allowlist", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as PackageMetadata;
    const readmePath = path.join(projectRoot, "README.md");

    expect(packageJson.engines).toEqual({
      node: ">=18",
    });
    expect(packageJson.files).toEqual(["dist", "bin", "LICENSE", "README.md"]);
    expect(existsSync(readmePath)).toBe(true);
    expect(packageJson.files).not.toContain("src");
    expect(packageJson.files).not.toContain("test");
  });
});
