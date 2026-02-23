import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEditShare, SHARE_ID_LENGTH } from "../src/shares.js";
import { readState } from "../src/state.js";

const originalHome = process.env.HOME;
const DEFAULT_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

function expectTtlWindow(createdAt: string, expiresAt: string | null, ttlMsExpected: number): void {
  const createdAtMs = Date.parse(createdAt);
  const expiresAtMs = Date.parse(expiresAt ?? "");

  expect(Number.isNaN(createdAtMs)).toBe(false);
  expect(Number.isNaN(expiresAtMs)).toBe(false);
  expect(expiresAtMs).toBeGreaterThan(createdAtMs);

  const ttlMs = expiresAtMs - createdAtMs;
  expect(ttlMs).toBeGreaterThanOrEqual(ttlMsExpected - 5000);
  expect(ttlMs).toBeLessThanOrEqual(ttlMsExpected + 5000);
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
    return;
  }

  process.env.HOME = originalHome;
});

describe("createEditShare", () => {
  it("creates an edit share for a regular file and persists readonly", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "notes.md");
    writeFileSync(filePath, "# notes\n", "utf8");

    const result = createEditShare(filePath, { readonly: true });

    expect(result.id).toHaveLength(SHARE_ID_LENGTH);
    expect(result.url).toMatch(new RegExp(`/s/${result.id}$`));
    expect(result.share.type).toBe("edit");
    expect(result.share.path).toBe(path.resolve(filePath));
    expect(result.share.persist).toBe(false);
    expect(result.share.readonly).toBe(true);
    expectTtlWindow(result.share.createdAt, result.share.expiresAt, DEFAULT_SHARE_TTL_MS);

    const state = readState();
    const persistedShare = state.shares[result.id];
    expect(persistedShare).toBeDefined();
    expect(persistedShare.type).toBe("edit");
    expect(persistedShare.path).toBe(path.resolve(filePath));
    expect(persistedShare.readonly).toBe(true);
    expect(persistedShare.persist).toBe(false);
  });

  it("defaults readonly to false and supports persist mode", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "config.json");
    writeFileSync(filePath, "{ \"name\": \"tailserve\" }\n", "utf8");

    const result = createEditShare(filePath, { persist: true });

    expect(result.share.type).toBe("edit");
    expect(result.share.readonly).toBe(false);
    expect(result.share.persist).toBe(true);
    expect(result.share.expiresAt).toBeNull();
  });

  it("supports custom ttlMs", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const filePath = path.join(workspace, "ttl.md");
    writeFileSync(filePath, "# ttl\n", "utf8");

    const ttlMs = 45 * 60 * 1000;
    const result = createEditShare(filePath, { ttlMs });

    expect(result.share.type).toBe("edit");
    expect(result.share.persist).toBe(false);
    expect(result.share.expiresAt).not.toBeNull();
    expectTtlWindow(result.share.createdAt, result.share.expiresAt, ttlMs);
  });

  it("throws when the target file does not exist", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const missingPath = path.join(tmpdir(), `tailserve-missing-${Date.now()}.txt`);

    expect(() => {
      createEditShare(missingPath);
    }).toThrow(`File not found: ${missingPath}`);
  });

  it("throws when the target path is a directory", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "tailserve-home-"));
    process.env.HOME = homeDir;

    const workspace = mkdtempSync(path.join(tmpdir(), "tailserve-work-"));
    const directoryPath = path.join(workspace, "docs");
    mkdirSync(directoryPath, { recursive: true });

    expect(() => {
      createEditShare(directoryPath);
    }).toThrow(`Not a regular file: ${directoryPath}`);
  });
});
