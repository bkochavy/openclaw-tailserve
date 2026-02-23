import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("ci workflow", () => {
  it("runs on push to main and pull requests", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const workflow = readFileSync(path.join(projectRoot, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("pull_request:");
  });

  it("tests node 18, 20, and 22", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const workflow = readFileSync(path.join(projectRoot, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("node-version: [18, 20, 22]");
    expect(workflow).toContain("node-version: ${{ matrix.node-version }}");
  });

  it("installs dependencies, builds, lints, and runs verbose vitest", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const workflow = readFileSync(path.join(projectRoot, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("uses: actions/checkout@v4");
    expect(workflow).toContain("uses: actions/setup-node@v4");
    expect(workflow).toContain("run: npm ci");
    expect(workflow).toContain("run: npm run build");
    expect(workflow).toContain("run: npm run lint");
    expect(workflow).toContain("name: npm test");
    expect(workflow).toContain("run: npx vitest run --reporter=verbose");
  });
});
