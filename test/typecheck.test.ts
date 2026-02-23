import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

type TsConfig = {
  compilerOptions?: {
    strict?: boolean;
  };
};

type PackageScripts = {
  scripts?: Record<string, string>;
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe("typecheck", () => {
  it("passes with no TypeScript errors", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");

    expect(() =>
      execFileSync(npmCommand, ["run", "typecheck"], {
        cwd: projectRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("keeps TypeScript strict mode enabled", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const tsconfig = JSON.parse(
      readFileSync(path.join(projectRoot, "tsconfig.json"), "utf8"),
    ) as TsConfig;

    expect(tsconfig.compilerOptions?.strict).toBe(true);
  });

  it("keeps npm typecheck mapped to tsc --noEmit", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as PackageScripts;

    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit");
  });
});
