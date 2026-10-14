/**
 * Unit tests for the `skill` / `reload_skills` builtins (ADR-0012 lazy
 * injection): load-by-name with resources, unknown-name remediation,
 * loud invalid-at-load failures, fresh rescans, and output clipping.
 * The composition path (runCli → engine → these tools) is covered by
 * src/app/skills-composition.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolContext, ToolInput } from "../contracts/tools";
import { DEFAULT_OUTPUT_LIMITS } from "../core/engine";
import { createSkillTools } from "./skill";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-skill-tool-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ctx: ToolContext = {
  workspaceRoot: scratch,
  workingDir: scratch,
  env: {},
  requestPermission: async () => ({ action: "allow" }),
  outputLimits: DEFAULT_OUTPUT_LIMITS,
};

function makeSkill(root: string, dirName: string, name: string, text?: string): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    text ?? `---\nname: ${name}\ndescription: ${name} description\n---\n${name} instructions\n`,
  );
  return file;
}

describe("skill tool", () => {
  it("returns the body and bundled resource list for a discovered name", async () => {
    const ws = mkdtempSync(join(scratch, "ws-"));
    const dir = join(ws, ".agents", "skills", "guide");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: commit-guide\ndescription: Write commits\n---\nBODY-MARKER line one\nline two\n",
    );
    mkdirSync(join(dir, "refs"));
    writeFileSync(join(dir, "refs", "types.md"), "reference\n");

    const { skill } = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });
    const result = await skill.execute({ name: "commit-guide" }, ctx);
    expect(result.isError).toBe(false);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("# Skill: commit-guide");
    expect(text).toContain(`Source: ${join(dir, "SKILL.md")}`);
    expect(text).toContain("- refs/types.md");
    expect(text).toContain("BODY-MARKER line one\nline two");
    expect(result.isError).toBe(false);
  });

  it("unknown name is a not_found error listing what IS discovered", async () => {
    const ws = mkdtempSync(join(scratch, "ws-"));
    makeSkill(join(ws, ".agents", "skills"), "one", "known-one");
    const { skill } = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });
    const result = await skill.execute({ name: "nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("not_found");
    expect(result.error?.message).toContain('"nope"');
    expect(result.error?.message).toContain("known-one");
  });

  it("with zero skills the error points at reload_skills", async () => {
    const ws = mkdtempSync(join(scratch, "ws-empty-"));
    const { skill } = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });
    const result = await skill.execute({ name: "anything" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.error?.message).toContain("no skills are currently discovered");
  });

  it("rejects a non-string or empty name as invalid_input", async () => {
    const ws = mkdtempSync(join(scratch, "ws-bad-name-"));
    const { skill } = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });
    for (const name of [undefined, "", 3, { x: 1 }]) {
      const result = await skill.execute({ name } as unknown as ToolInput, ctx);
      expect(result.isError, String(name)).toBe(true);
      expect(result.error?.code, String(name)).toBe("invalid_input");
    }
  });

  it("a skill that became INVALID after discovery fails loud, naming file + key", async () => {
    const ws = mkdtempSync(join(scratch, "ws-flip-"));
    const file = makeSkill(join(ws, ".agents", "skills"), "flip", "flipper");
    const tools = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });
    // Corrupt the skill between "discovery" and the tool call: the tool's
    // fresh scan re-validates, so the model gets a structured error instead
    // of silently-missing instructions.
    writeFileSync(file, "---\nname: flipper\ndescription: d\nmystery: 1\n---\nbody\n");
    const result = await tools.skill.execute({ name: "flipper" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("invalid_input");
    expect(result.error?.message).toContain(file);
    expect(result.error?.message).toContain("mystery");
    expect(result.error?.message).toContain("unknown frontmatter key");
  });

  it("clips its result through the output limits", async () => {
    const ws = mkdtempSync(join(scratch, "ws-clip-"));
    makeSkill(join(ws, ".agents", "skills"), "big", "biggie", undefined);
    const { skill } = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });
    const result = await skill.execute(
      { name: "biggie" },
      {
        ...ctx,
        outputLimits: { maxTotalChars: 64, maxSectionChars: 64 },
      },
    );
    expect(result.isError).toBe(false);
    const block = result.content[0];
    expect(block?.type === "text" && block.truncated).toBe(true);
  });
});

describe("reload_skills tool", () => {
  it("returns the fresh list including skills added after run start", async () => {
    const ws = mkdtempSync(join(scratch, "ws-reload-"));
    makeSkill(join(ws, ".agents", "skills"), "first", "first-skill");
    const tools = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });

    const before = await tools.reloadSkills.execute({}, ctx);
    expect(before.isError).toBe(false);
    const beforeText = before.content[0]?.type === "text" ? before.content[0].text : "";
    expect(beforeText).toContain("1 skill(s) discovered");
    expect(beforeText).toContain("- first-skill — first-skill description");

    makeSkill(join(ws, ".agents", "skills"), "second", "second-skill");
    const after = await tools.reloadSkills.execute({}, ctx);
    const afterText = after.content[0]?.type === "text" ? after.content[0].text : "";
    expect(afterText).toContain("2 skill(s) discovered");
    expect(afterText).toContain("- second-skill — second-skill description");
    // And the new skill is now loadable through the sibling tool.
    const loaded = await tools.skill.execute({ name: "second-skill" }, ctx);
    expect(loaded.isError).toBe(false);
  });

  it("reports invalid skills and roots scanned without erroring", async () => {
    const ws = mkdtempSync(join(scratch, "ws-reload-bad-"));
    makeSkill(join(ws, ".agents", "skills"), "good", "good-one");
    const file = makeSkill(join(ws, ".agents", "skills"), "bad", "bad-one");
    writeFileSync(file, "no frontmatter at all\n");
    const tools = createSkillTools({ workspaceRoot: ws, env: { HOME: scratch } });
    const result = await tools.reloadSkills.execute({}, ctx);
    expect(result.isError).toBe(false);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("- good-one — good-one description");
    expect(text).toContain("Validation problems");
    expect(text).toContain(file);
    expect(text).toContain("must start with a YAML frontmatter block");
  });
});
