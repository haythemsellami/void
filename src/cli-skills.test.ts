/**
 * CLI tests for the `skills` subcommand (ADR-0012): parseArgs table, help
 * rendering per house style, and `runSkillsList` output through runCli with
 * real temp-dir fixtures (valid / invalid / shadowed / skills.path roots /
 * broken settings). The full run path (prompt + skill tool) is covered by
 * src/app/skills-composition.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CliDeps, parseArgs, renderMainHelp, renderSubcommandHelp, runCli } from "./cli";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-cli-skills-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeDeps(
  cwd: string,
  env: Record<string, string | undefined> = {},
): {
  deps: CliDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
      env,
      cwd,
    },
    out,
    err,
  };
}

function makeSkill(root: string, dirName: string, name: string, text?: string): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    text ?? `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`,
  );
  return file;
}

describe("parseArgs: skills", () => {
  it("accepts exactly `skills list`", () => {
    expect(parseArgs(["skills", "list"])).toEqual({ kind: "skillsList" });
    expect(parseArgs(["skills", "list"])).toEqual({ kind: "skillsList" });
  });

  it("rejects other shapes with usage errors (no add/install at P1)", () => {
    expect(parseArgs(["skills"])).toEqual({
      kind: "usageError",
      message: expect.stringContaining("skills expects exactly: skills list"),
    });
    expect(parseArgs(["skills", "add", "https://example.invalid/x"])).toEqual({
      kind: "usageError",
      message: expect.stringContaining("skills list"),
    });
    expect(parseArgs(["skills", "list", "extra"])).toEqual({
      kind: "usageError",
      message: "extra: unexpected argument",
    });
  });

  it("routes --help/-h anywhere in the tail to the skills help page", () => {
    expect(parseArgs(["skills", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "skills",
    });
    expect(parseArgs(["skills", "-h"])).toEqual({ kind: "subcommandHelp", subcommand: "skills" });
    expect(parseArgs(["skills", "list", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "skills",
    });
  });
});

describe("skills help (house style)", () => {
  it("the main help lists the subcommand", () => {
    const help = renderMainHelp();
    expect(help).toContain("skills list");
    expect(help).toContain("list discovered skills and their validation status");
  });

  it("the subcommand page has usage, examples, and the P1 scope note", () => {
    const page = renderSubcommandHelp("skills");
    expect(page).toContain("void skills list — list discovered skills and their validation status");
    expect(page).toContain("Usage:");
    expect(page).toContain("  void skills list");
    expect(page).toContain("Examples:");
    expect(page).toContain("first-wins");
  });

  it("runCli serves the help page and exits 0", async () => {
    const { deps, out } = makeDeps(scratch);
    const code = await runCli(["skills", "--help"], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("void skills list");
  });
});

describe("runCli: void skills list", () => {
  it("renders roots, valid skills, invalid entries, and shadowed duplicates", async () => {
    const ws = mkdtempSync(join(scratch, "ws-"));
    const good = makeSkill(join(ws, ".agents", "skills"), "good", "good-skill");
    const bad = makeSkill(
      join(ws, ".agents", "skills"),
      "bad",
      "bad-skill",
      "---\nname: bad-skill\ndescription: d\nmystery: 1\n---\nbody\n",
    );
    const home = mkdtempSync(join(scratch, "home-"));
    makeSkill(
      join(home, ".config", "void", "skills"),
      "sh",
      "shadowed",
      "---\nname: good-skill\ndescription: user twin\n---\ntwin body\n",
    );

    const { deps, out, err } = makeDeps(ws, { HOME: home });
    const code = await runCli(["skills", "list"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Skills roots (in first-wins order):");
    expect(text).toContain(join(ws, ".agents", "skills"));
    expect(text).toContain(join(home, ".config", "void", "skills"));
    expect(text).toContain(`good-skill  ${"workspace".padEnd(13)}  ${good}`);
    expect(text).toContain(`Invalid (loud — runs fail until fixed):`);
    expect(text).toContain(`${bad}: mystery: unknown frontmatter key "mystery"`);
    expect(text).toContain("Shadowed (later same-name duplicates, ignored):");
    expect(text).toContain(
      `good-skill  ${join(home, ".config", "void", "skills", "sh", "SKILL.md")}`,
    );
    expect(err).toEqual([]);
  });

  it("shows a workspace `skills/` root and a settings skills.path root", async () => {
    const ws = mkdtempSync(join(scratch, "ws2-"));
    const extra = mkdtempSync(join(scratch, "extra-"));
    const viaPath = makeSkill(extra, "extra-skill", "extra-skill");
    mkdirSync(join(ws, ".void"));
    writeFileSync(
      join(ws, ".void", "settings.json"),
      JSON.stringify({ settingsVersion: 1, skills: { path: extra } }),
    );

    const { deps, out } = makeDeps(ws, { HOME: mkdtempSync(join(scratch, "home2-")) });
    const code = await runCli(["skills", "list"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("skills.path[0]");
    expect(text).toContain(`extra-skill  settings-path  ${viaPath}`);
    // A configured-but-missing entry stays visible as missing.
    const missing = mkdtempSync(join(scratch, "gone-"));
    writeFileSync(
      join(ws, ".void", "settings.json"),
      JSON.stringify({ settingsVersion: 1, skills: { path: `${extra}:${join(missing, "nope")}` } }),
    );
    const second = makeDeps(ws, { HOME: mkdtempSync(join(scratch, "home3-")) });
    await runCli(["skills", "list"], second.deps);
    expect(second.out.join("\n")).toContain(`${join(missing, "nope")} (missing)`);
  });

  it("empty discovery prints a full map with no skills, exit 0", async () => {
    const ws = mkdtempSync(join(scratch, "ws3-"));
    const { deps, out } = makeDeps(ws, { HOME: mkdtempSync(join(scratch, "home4-")) });
    const code = await runCli(["skills", "list"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Skills (0 valid):");
    expect(text).toContain("(none)");
  });

  it("broken settings do not fail the listing: stderr note, skills.path skipped, exit 0", async () => {
    const ws = mkdtempSync(join(scratch, "ws4-"));
    mkdirSync(join(ws, ".void"));
    writeFileSync(join(ws, ".void", "settings.json"), "{ not json");
    const { deps, out, err } = makeDeps(ws, { HOME: mkdtempSync(join(scratch, "home5-")) });
    const code = await runCli(["skills", "list"], deps);
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("skills.path cannot be read");
    expect(out.join("\n")).toContain("Skills (0 valid):");
  });
});
