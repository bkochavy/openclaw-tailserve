import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

type PackedFile = {
  path: string;
};

type PackResult = {
  files: PackedFile[];
};

const isAllowedPackPath = (entryPath: string): boolean =>
  entryPath === "package.json" ||
  entryPath === "LICENSE" ||
  entryPath === "README.md" ||
  entryPath.startsWith("dist/") ||
  entryPath.startsWith("bin/");

describe("npm pack --dry-run", () => {
  it("includes only publish allowlist files", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tailserve-npm-cache-"));

    try {
      const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: cacheDir,
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);

      const packOutput = JSON.parse(result.stdout) as PackResult[];
      const packedPaths = packOutput[0]?.files.map((file) => file.path) ?? [];
      const unexpected = packedPaths.filter((entryPath) => !isAllowedPackPath(entryPath));

      expect(packedPaths).toContain("LICENSE");
      expect(packedPaths).toContain("README.md");
      expect(packedPaths).toContain("package.json");
      expect(unexpected).toEqual([]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
