/**
 * Guards the generated embedded explorer mode preset against drift with
 * prompts/modes/explorer.md (ADR-0013). If this fails after editing the
 * preset: run `bun run sync-prompt`.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EMBEDDED_EXPLORER_MODE_PROMPT } from "./explorer-mode-prompt";
import { MODE_PROMPTS_DIR } from "./prompts";

describe("embedded explorer mode preset", () => {
  it("matches prompts/modes/explorer.md byte-for-byte", async () => {
    const file = await readFile(`${MODE_PROMPTS_DIR}/explorer.md`, "utf8");
    expect(EMBEDDED_EXPLORER_MODE_PROMPT).toBe(file);
  });

  it("is non-empty", async () => {
    expect(EMBEDDED_EXPLORER_MODE_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it("instructs the child to investigate read-only and report findings", async () => {
    const text = await readFile(`${MODE_PROMPTS_DIR}/explorer.md`, "utf8");
    for (const section of ["Ground rules", "Method", "Final message format"]) {
      expect(text).toContain(`## ${section}`);
    }
    for (const section of ["Answer", "Findings", "Not verified"]) {
      expect(text).toContain(`**${section}**`);
    }
    // The two posture anchors: read-only by construction, evidence-cited.
    expect(text).toContain("read-only by");
    expect(text).toContain("absolute");
  });
});
