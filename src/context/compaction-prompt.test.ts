/**
 * Guards the generated embedded compaction prompt against drift with
 * prompts/compaction.md (ADR-0008). If this fails after editing the prompt:
 * run `bun run sync-prompt`.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EMBEDDED_COMPACTION_PROMPT } from "./compaction-prompt";
import { COMPACTION_PROMPT_PATH } from "./prompts";

describe("embedded compaction prompt", () => {
  it("matches prompts/compaction.md byte-for-byte", async () => {
    const file = await readFile(COMPACTION_PROMPT_PATH, "utf8");
    expect(EMBEDDED_COMPACTION_PROMPT).toBe(file);
  });

  it("is non-empty", async () => {
    expect(EMBEDDED_COMPACTION_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it("instructs the model to produce a working-state handoff", async () => {
    const text = await readFile(COMPACTION_PROMPT_PATH, "utf8");
    for (const section of ["Goal", "Decisions", "File changes", "Open threads", "Tool"]) {
      expect(text).toContain(`**${section}`);
    }
    expect(text).toContain("ONLY the summary");
  });
});
