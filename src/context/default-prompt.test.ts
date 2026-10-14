/**
 * Guards the generated embedded prompt against drift with prompts/default.md.
 * If this fails after editing the prompt: run `bun run sync-prompt`.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EMBEDDED_DEFAULT_PROMPT } from "./default-prompt";
import { DEFAULT_PROMPT_PATH } from "./prompts";

describe("embedded default prompt", () => {
  it("matches prompts/default.md byte-for-byte", async () => {
    const file = await readFile(DEFAULT_PROMPT_PATH, "utf8");
    expect(EMBEDDED_DEFAULT_PROMPT).toBe(file);
  });

  it("is non-empty", () => {
    expect(EMBEDDED_DEFAULT_PROMPT.trim().length).toBeGreaterThan(0);
  });
});
