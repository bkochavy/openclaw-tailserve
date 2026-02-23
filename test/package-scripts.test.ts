import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type PackageScripts = {
  scripts?: Record<string, string>;
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe("package scripts", () => {
  it("keeps npm test mapped to vitest run", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as PackageScripts;

    expect(packageJson.scripts?.test).toBe("vitest run");
  });

  it("keeps npm lint mapped to typecheck", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as PackageScripts;

    expect(packageJson.scripts?.lint).toBe("npm run typecheck");
  });

  it("runs successfully via npm test", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const result = spawnSync(
      npmCommand,
      ["test", "--", "test/package-scripts.test.ts", "--testNamePattern", "keeps npm test mapped to vitest run"],
      {
        cwd: projectRoot,
        stdio: "pipe",
        encoding: "utf8",
      },
    );

    // Strip ANSI escape codes before matching (vitest output includes color codes)
    const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
    const stdout = stripAnsi(result.stdout);

    expect(result.status).toBe(0);
    expect(stdout).toContain("package-scripts.test.ts");
    expect(stdout).toMatch(/Test Files\s+1 passed/);
  });
});
