import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/doctor.js", () => ({
  runDoctor: vi.fn(),
}));

import { run } from "../src/cli.js";
import type { DoctorSummary } from "../src/doctor.js";
import { runDoctor } from "../src/doctor.js";

class MemoryOutput {
  private readonly chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

const mockedRunDoctor = vi.mocked(runDoctor);

function createSummary(summary: DoctorSummary): DoctorSummary {
  return summary;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ts doctor", () => {
  it("prints each check and exits 0 when all checks pass", async () => {
    mockedRunDoctor.mockReturnValue(
      createSummary({
        ok: true,
        failed: 0,
        fixed: 0,
        checks: [
          { name: "checkStalePid", ok: true, message: "ok" },
          { name: "checkStateFile", ok: true, message: "ok" },
        ],
      }),
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "doctor"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(mockedRunDoctor).toHaveBeenCalledWith({ fix: false, verbose: false });
    expect(stdout.toString()).toBe(
      "✓ checkStalePid: ok\n" + "✓ checkStateFile: ok\n" + "Summary: 0 issues found.\n",
    );
  });

  it("prints fixed summary and exits 0 when all issues were repaired", async () => {
    mockedRunDoctor.mockReturnValue(
      createSummary({
        ok: true,
        failed: 0,
        fixed: 2,
        checks: [
          { name: "checkStalePid", ok: true, message: "Removed stale PID", fixed: true },
          { name: "checkServerHealth", ok: true, message: "Server is healthy", fixed: true },
        ],
      }),
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "doctor", "--fix", "--verbose"], stdout, stderr);

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(mockedRunDoctor).toHaveBeenCalledWith({ fix: true, verbose: true });
    expect(stdout.toString()).toBe(
      "✓ checkStalePid: Removed stale PID\n" +
        "✓ checkServerHealth: Server is healthy\n" +
        "Summary: 2 issues found; all fixed (2 fixed).\n",
    );
  });

  it("exits 1 when unfixed issues remain", async () => {
    mockedRunDoctor.mockReturnValue(
      createSummary({
        ok: false,
        failed: 1,
        fixed: 0,
        checks: [
          { name: "checkStalePid", ok: true, message: "ok" },
          { name: "checkServerHealth", ok: false, message: "Server is not running" },
        ],
      }),
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await run(["node", "ts", "doctor"], stdout, stderr);

    expect(exitCode).toBe(1);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toBe(
      "✓ checkStalePid: ok\n" + "✗ checkServerHealth: Server is not running\n" + "Summary: 1 issue found; 1 unfixed.\n",
    );
  });
});
