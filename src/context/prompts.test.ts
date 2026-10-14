/**
 * Tests for the prompt loaders (ADR-0002 property 2: prompts are versioned
 * repo files, loaded loudly — never fetched, never silently empty), the
 * compaction prompt loader added by ADR-0008, and the task-mode preset
 * loader added by ADR-0013.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  COMPACTION_PROMPT_PATH,
  DEFAULT_PROMPT_PATH,
  isTaskMode,
  loadCompactionPrompt,
  loadDefaultPrompt,
  loadModePrompt,
  MODE_PROMPTS_DIR,
  PromptLoadError,
  TASK_MODES,
} from "./prompts";

const scratch = mkdtempSync(join(tmpdir(), "void-prompts-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("loadDefaultPrompt", () => {
  it("loads the in-repo prompts/default.md by default", async () => {
    const text = await loadDefaultPrompt();
    expect(text).toContain("You are Void");
    // The loader must find the repo file regardless of test-runner cwd.
    expect(DEFAULT_PROMPT_PATH.endsWith(join("prompts", "default.md"))).toBe(true);
  });

  it("describes the builtin tools and the sandbox", async () => {
    const text = await loadDefaultPrompt();
    for (const tool of ["bash", "read_file", "edit_file", "grep", "glob"]) {
      expect(text).toContain(`\`${tool}\``);
    }
    expect(text).toContain("sandbox");
    expect(text).toContain("absolute");
  });

  it("reads an explicit path", async () => {
    const path = join(scratch, "custom.md");
    writeFileSync(path, "custom prompt body");
    await expect(loadDefaultPrompt({ path })).resolves.toBe("custom prompt body");
  });

  it("rejects a missing file with PromptLoadError naming the path", async () => {
    const path = join(scratch, "missing.md");
    const failure = await loadDefaultPrompt({ path }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PromptLoadError);
    expect((failure as PromptLoadError).path).toBe(path);
    expect((failure as PromptLoadError).message).toContain(path);
  });

  it("rejects an empty prompt", async () => {
    const path = join(scratch, "empty.md");
    writeFileSync(path, "   \n");
    await expect(loadDefaultPrompt({ path })).rejects.toBeInstanceOf(PromptLoadError);
  });
});

describe("loadCompactionPrompt (ADR-0008)", () => {
  it("loads the in-repo prompts/compaction.md by default", async () => {
    const text = await loadCompactionPrompt();
    expect(text).toContain("working-state handoff");
    expect(COMPACTION_PROMPT_PATH.endsWith(join("prompts", "compaction.md"))).toBe(true);
  });

  it("reads an explicit path", async () => {
    const path = join(scratch, "custom-compaction.md");
    writeFileSync(path, "custom compaction body");
    await expect(loadCompactionPrompt({ path })).resolves.toBe("custom compaction body");
  });

  it("rejects a missing file with PromptLoadError naming the path and the prompt", async () => {
    const path = join(scratch, "missing-compaction.md");
    const failure = await loadCompactionPrompt({ path }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PromptLoadError);
    expect((failure as PromptLoadError).path).toBe(path);
    expect((failure as PromptLoadError).message).toContain("compaction prompt");
    expect((failure as PromptLoadError).message).toContain(path);
  });

  it("rejects an empty compaction prompt", async () => {
    const path = join(scratch, "empty-compaction.md");
    writeFileSync(path, "\t\n");
    await expect(loadCompactionPrompt({ path })).rejects.toBeInstanceOf(PromptLoadError);
  });

  it("falls back to the embedded copy when the live file is unreadable", async () => {
    const readFailed = async (): Promise<string> => {
      throw new Error("ENOENT: compiled binary has no prompts/ tree");
    };
    const text = await loadCompactionPrompt({ readFile: readFailed });
    expect(text).toContain("working-state handoff");
  });
});

describe("loadModePrompt (ADR-0013)", () => {
  it("TASK_MODES is exactly explorer + planner and isTaskMode guards it", () => {
    expect([...TASK_MODES]).toEqual(["explorer", "planner"]);
    expect(isTaskMode("explorer")).toBe(true);
    expect(isTaskMode("planner")).toBe(true);
    for (const rejected of ["researcher", "", 42, undefined, null]) {
      expect(isTaskMode(rejected)).toBe(false);
    }
  });

  it("loads each mode's in-repo prompts/modes/<mode>.md by default", async () => {
    const explorer = await loadModePrompt("explorer");
    expect(explorer).toContain("explorer subagent");
    expect(explorer).toContain("Final message format");
    const planner = await loadModePrompt("planner");
    expect(planner).toContain("planner subagent");
    expect(MODE_PROMPTS_DIR.endsWith(join("prompts", "modes"))).toBe(true);
  });

  it("reads an explicit path", async () => {
    const path = join(scratch, "custom-mode.md");
    writeFileSync(path, "custom mode body");
    await expect(loadModePrompt("planner", { path })).resolves.toBe("custom mode body");
  });

  it("rejects a missing file with PromptLoadError naming the mode and the path", async () => {
    const path = join(scratch, "missing-mode.md");
    const failure = await loadModePrompt("explorer", { path }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PromptLoadError);
    expect((failure as PromptLoadError).path).toBe(path);
    expect((failure as PromptLoadError).message).toContain("explorer mode preset");
    expect((failure as PromptLoadError).message).toContain(path);
  });

  it("rejects an empty preset", async () => {
    const path = join(scratch, "empty-mode.md");
    writeFileSync(path, " \n");
    await expect(loadModePrompt("planner", { path })).rejects.toBeInstanceOf(PromptLoadError);
  });

  it("falls back to the embedded copy when the live file is unreadable", async () => {
    const readFailed = async (): Promise<string> => {
      throw new Error("ENOENT: compiled binary has no prompts/ tree");
    };
    const text = await loadModePrompt("explorer", { readFile: readFailed });
    expect(text).toContain("explorer subagent");
  });
});
