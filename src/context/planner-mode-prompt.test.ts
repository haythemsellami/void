/**
 * Guards the generated embedded planner mode preset against drift with
 * prompts/modes/planner.md (ADR-0013). If this fails after editing the
 * preset: run `bun run sync-prompt`.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EMBEDDED_PLANNER_MODE_PROMPT } from "./planner-mode-prompt";
import { MODE_PROMPTS_DIR } from "./prompts";

describe("embedded planner mode preset", () => {
  it("matches prompts/modes/planner.md byte-for-byte", async () => {
    const file = await readFile(`${MODE_PROMPTS_DIR}/planner.md`, "utf8");
    expect(EMBEDDED_PLANNER_MODE_PROMPT).toBe(file);
  });

  it("is non-empty", async () => {
    expect(EMBEDDED_PLANNER_MODE_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it("instructs the child to produce a numbered step plan with risks", async () => {
    const text = await readFile(`${MODE_PROMPTS_DIR}/planner.md`, "utf8");
    for (const section of ["Ground rules", "Method", "Final message format"]) {
      expect(text).toContain(`## ${section}`);
    }
    for (const section of ["Plan summary", "Steps", "Risks", "Assumptions"]) {
      expect(text).toContain(`**${section}**`);
    }
    expect(text).toContain("numbered");
  });
});
