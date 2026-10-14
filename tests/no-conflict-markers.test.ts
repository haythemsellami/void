/**
 * Cheap guard for the committed-marker class (reviewer suggestion, 2026-10-14):
 * a conflicted merge's markers must never reach a commit. One native
 * `git grep` over the tree — a single process, cheap enough for every
 * runner/job (a per-file spawn design starved CI's parallel workers).
 * `git grep` exits 1 on "no matches" (the passing case here).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function markerOffenders(): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "-E", "^(<{7}|={7}|>{7})( |$)", "HEAD", "--", "."],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    // exit code 1 = no matches = the healthy case; anything else rethrows.
    if ((error as { status?: number }).status === 1) {
      return [];
    }
    throw error;
  }
}

describe("repo hygiene", () => {
  it("no merge-conflict markers in any tracked file", () => {
    expect(markerOffenders(), "files at HEAD containing conflict markers").toEqual([]);
  });
});
