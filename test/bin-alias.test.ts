import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

type PackageJson = {
  bin?: Record<string, string>;
};

describe("package bin aliases", () => {
  it("maps both ts and tailserve to ./bin/ts", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as PackageJson;

    expect(packageJson.bin?.ts).toBe("./bin/ts");
    expect(packageJson.bin?.tailserve).toBe("./bin/ts");
  });
});
