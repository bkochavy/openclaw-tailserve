import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("repository license", () => {
  it("uses MIT with 2026 copyright notice", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const licenseText = readFileSync(path.join(projectRoot, "LICENSE"), "utf8");

    expect(licenseText).toContain("MIT License");
    expect(licenseText).toContain("Copyright (c) 2026");
    expect(licenseText).toContain("Permission is hereby granted, free of charge");
    expect(licenseText).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });
});
