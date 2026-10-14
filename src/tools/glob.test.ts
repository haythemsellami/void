/**
 * Tests for the glob builtin: the glob-to-RegExp translator matrix, walker
 * behavior (skip node_modules/.git/dot-entries, no symlink descent, deep
 * matching), sorting, result caps, and the error taxonomy.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../contracts/tools";
import { globTool, globToRegExp, MAX_GLOB_RESULTS, walkTree } from "./glob";

const cleanups: string[] = [];

function workspace(): { ws: string; ctx: ToolContext } {
  const ws = mkdtempSync(join(tmpdir(), "void-glob-"));
  cleanups.push(ws);
  return {
    ws,
    ctx: {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: "/usr/bin:/bin" },
      requestPermission: async () => ({ action: "allow", message: "allow" }),
      outputLimits: { maxTotalChars: 200_000, maxSectionChars: 200_000 },
    },
  };
}

function mk(ws: string, ...segments: string[]): void {
  const abs = join(ws, ...segments);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, "f.txt"), "x");
}

function text(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function paths(result: { content: readonly { text: string }[] }): string[] {
  return text(result)
    .split("\n")
    .slice(1) // drop header
    .filter((l) => !l.startsWith("…"))
    .map((l) => l.trim());
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("globToRegExp translator matrix", () => {
  const matrix: Array<[string, string[], string[]]> = [
    ["*.ts", ["a.ts", "a.d.ts"], ["src/a.ts", "a.tsx"]],
    ["**/*.ts", ["a.ts", "src/a.ts", "src/deep/a.ts"], []],
    ["src/**/*.ts", ["src/a.ts", "src/x/y/a.ts"], ["a.ts", "srcx/a.ts", "src.tsx"]],
    ["src/**", ["src", "src/a.ts", "src/x/y"], []],
    ["**", ["anything/deep/file.txt"], []],
    ["?.ts", ["a.ts"], ["ab.ts", ".ts"]],
    ["src/?.ts", ["src/a.ts"], ["src/ab.ts"]],
    ["*.{ts,tsx}", ["a.ts", "a.tsx"], ["a.js", "a.tsxx"]],
    ["{a,b}.txt", ["a.txt", "b.txt"], ["c.txt"]],
    ["[ab].txt", ["a.txt", "b.txt"], ["c.txt", "ab.txt"]],
    ["[a-c]*.log", ["a1.log", "b-x.log", "c9.log"], ["d1.log", "xa.log"]],
    ["[!a]*.log", ["b.log", "zz.log"], ["a.log", "ab.log"]],
    ["file.name.txt", ["file.name.txt"], ["fileXname.txt"]],
    ["file[0-9].txt", ["file7.txt"], ["filex.txt", "file77.txt"]],
    ["a/b/c.txt", ["a/b/c.txt"], ["a/bx/c.txt", "a/c.txt"]],
    ["make*[0-9].mk", ["make3.mk"], ["make.mk", "makex.mk"]],
  ];
  for (const [pattern, yes, no] of matrix) {
    it(`translates ${pattern}`, () => {
      const re = globToRegExp(pattern);
      expect(re, pattern).not.toBeNull();
      if (!re) return;
      for (const p of yes) expect(re.test(p), `${pattern} should match ${p}`).toBe(true);
      for (const p of no) {
        if (p === "") continue;
        expect(re.test(p), `${pattern} should NOT match ${p}`).toBe(false);
      }
    });
  }

  it("normalizes leading ./ and / but rejects empty patterns", () => {
    expect(globToRegExp("./a.ts")?.test("a.ts")).toBe(true);
    expect(globToRegExp("/a.ts")?.test("a.ts")).toBe(true);
    expect(globToRegExp("./**/a.ts")?.test("x/a.ts")).toBe(true);
    expect(globToRegExp("")).toBeNull();
    expect(globToRegExp("//")).toBeNull();
    expect(globToRegExp("src//a.ts")).toBeNull();
    expect(globToRegExp("a\0b")).toBeNull();
  });

  it("treats unclosed classes and stray brace groups as invalid", () => {
    const unclosed = globToRegExp("ab["); // unclosed [ falls back to literal
    expect(unclosed).not.toBeNull();
    expect(unclosed?.test("ab[")).toBe(true);
    expect(globToRegExp("a{b.txt")).toBeNull(); // unbalanced brace
    expect(globToRegExp("a{b}c.txt")).toBeNull(); // braces without comma
  });

  it("supports nested braces one level deep", () => {
    expect(globToRegExp("a.{ts,b.{js,mjs}}")).not.toBeNull();
    expect(globToRegExp("a.{ts,b.{js,mjs}}")?.test("a.b.js")).toBe(true);
    expect(globToRegExp("a.{ts,b.{js,mjs}}")?.test("a.b.mjs")).toBe(true);
    expect(globToRegExp("a.{ts,b.{js,mjs}}")?.test("a.ts")).toBe(true);
    expect(globToRegExp("a.{ts,b.{js,mjs}}")?.test("a.b.css")).toBe(false);
  });
});

describe("walkTree", () => {
  it("skips node_modules, .git and dot-entries by default", () => {
    const { ws } = workspace();
    mk(ws, "src");
    mk(ws, "node_modules", "pkg");
    mk(ws, ".git", "objects");
    writeFileSync(join(ws, ".hidden.ts"), "x");
    const rels = walkTree(ws, false);
    expect(rels).toContain("src");
    expect(rels).toContain("src/f.txt");
    expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
    expect(rels.some((r) => r.includes(".git"))).toBe(false);
    expect(rels.some((r) => r.startsWith("."))).toBe(false);
  });

  it("keeps dot-entries when asked", () => {
    const { ws } = workspace();
    mkdirSync(join(ws, ".github"));
    writeFileSync(join(ws, ".github", "ci.yml"), "x");
    const rels = walkTree(ws, true);
    expect(rels).toContain(".github/ci.yml");
  });

  it("does not descend into directory symlinks", () => {
    const { ws } = workspace();
    const outside = mkdtempSync(join(tmpdir(), "void-glob-out-"));
    cleanups.push(outside);
    writeFileSync(join(outside, "leak.txt"), "x");
    mkdirSync(join(ws, "real"));
    symlinkSync(outside, join(ws, "linkdir"));
    const rels = walkTree(ws, false);
    expect(rels).toContain("linkdir");
    expect(rels.some((r) => r.startsWith("linkdir/"))).toBe(false);
    expect(rels).toContain("real");
  });
});

describe("glob tool", () => {
  it("matches across depths from the workspace root by default", async () => {
    const { ws, ctx } = workspace();
    mk(ws, "src", "tools"); // creates f.txt, which must NOT match *.ts
    mk(ws, "docs");
    writeFileSync(join(ws, "a.ts"), "x");
    writeFileSync(join(ws, "src", "tools", "tool.ts"), "x");
    const res = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(res.isError).toBe(false);
    expect(paths(res)).toEqual(["a.ts", "src/tools/tool.ts"]);
  });

  it("finds files with dir patterns and sorts depth-first then lexicographic", async () => {
    const { ws, ctx } = workspace();
    mkdirSync(join(ws, "b"));
    writeFileSync(join(ws, "b", "two.ts"), "x");
    writeFileSync(join(ws, "zz.ts"), "x");
    mkdirSync(join(ws, "a", "deep"), { recursive: true });
    writeFileSync(join(ws, "a", "one.ts"), "x");
    writeFileSync(join(ws, "a", "deep", "three.ts"), "x");
    const res = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(paths(res)).toEqual(["zz.ts", "a/one.ts", "b/two.ts", "a/deep/three.ts"]);
  });

  it("searches under an explicit path", async () => {
    const { ws, ctx } = workspace();
    mk(ws, "src", "sub");
    const res = await globTool.execute({ pattern: "**/*.txt", path: join(ws, "src", "sub") }, ctx);
    expect(paths(res)).toEqual(["f.txt"]);
    expect(text(res)).toContain("under src/sub");
  });

  it("returns a friendly empty result", async () => {
    const { ctx } = workspace();
    const res = await globTool.execute({ pattern: "**/*.nope" }, ctx);
    expect(res.isError).toBe(false);
    expect(text(res)).toContain('No paths matched "**/*.nope"');
  });

  it("matches hidden trees when the pattern starts with a dot segment", async () => {
    const { ws, ctx } = workspace();
    mkdirSync(join(ws, ".github"), { recursive: true });
    writeFileSync(join(ws, ".github", "workflows.yml"), "x");
    const res = await globTool.execute({ pattern: ".github/**" }, ctx);
    // Directories carry a trailing / (review minor) so they are
    // distinguishable from files in results.
    expect(paths(res)).toEqual([".github/", ".github/workflows.yml"]);
  });

  it("suffixes directories with / in results (consistent with read_file)", async () => {
    const { ws, ctx } = workspace();
    mkdirSync(join(ws, "pkg"));
    writeFileSync(join(ws, "pkg", "mod.ts"), "x");
    writeFileSync(join(ws, "top.ts"), "x");
    const res = await globTool.execute({ pattern: "**" }, ctx);
    // Depth-first then lexicographic: pkg before top.ts at depth 1.
    expect(paths(res)).toEqual(["pkg/", "top.ts", "pkg/mod.ts"]);
  });

  it("caps results with an explicit marker", async () => {
    const { ws, ctx } = workspace();
    mkdirSync(join(ws, "many"));
    for (let i = 0; i < MAX_GLOB_RESULTS + 5; i++) {
      writeFileSync(join(ws, "many", `f${String(i).padStart(4, "0")}.txt`), "x");
    }
    const res = await globTool.execute({ pattern: "many/*.txt" }, ctx);
    expect(paths(res)).toHaveLength(MAX_GLOB_RESULTS);
    expect(text(res)).toContain(`… results capped at ${MAX_GLOB_RESULTS}; 5 more omitted`);
    expect(res.content[0]?.truncated).toBe(true);
  });

  it("returns structured errors for bad input", async () => {
    const { ws, ctx } = workspace();
    expect((await globTool.execute({}, ctx)).error?.code).toBe("invalid_input");
    expect((await globTool.execute({ pattern: "" }, ctx)).error?.code).toBe("invalid_input");
    expect((await globTool.execute({ pattern: "a{b" }, ctx)).error?.code).toBe("invalid_input");
    expect(
      (await globTool.execute({ pattern: "x", path: join(ws, "missing") }, ctx)).error?.code,
    ).toBe("not_found");
    writeFileSync(join(ws, "file.txt"), "x");
    expect(
      (await globTool.execute({ pattern: "x", path: join(ws, "file.txt") }, ctx)).error?.code,
    ).toBe("invalid_input");
  });
});

describe("glob: gitignore-lite (documented subset)", () => {
  // Pattern "**" does not allow dot-entries, so the .gitignore files that
  // drive these fixtures never appear in the expected results themselves.
  it("excludes files matched by an unanchored pattern at any depth", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, ".gitignore"), "*.log\n");
    writeFileSync(join(ws, "keep.ts"), "x");
    writeFileSync(join(ws, "noise.log"), "x");
    mkdirSync(join(ws, "deep", "deeper"), { recursive: true });
    writeFileSync(join(ws, "deep", "deeper", "also.log"), "x");
    writeFileSync(join(ws, "deep", "keep2.ts"), "x");
    const res = await globTool.execute({ pattern: "**" }, ctx);
    expect(paths(res)).toEqual(["deep/", "keep.ts", "deep/deeper/", "deep/keep2.ts"]);
  });

  it("re-includes via ! negation (last matching rule wins)", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, ".gitignore"), "*.tmp\n!keep.tmp\n");
    writeFileSync(join(ws, "a.tmp"), "x");
    writeFileSync(join(ws, "keep.tmp"), "x");
    const res = await globTool.execute({ pattern: "**" }, ctx);
    expect(paths(res)).toEqual(["keep.tmp"]);
  });

  it("trailing-/ patterns ignore directories (and their contents) but not same-named files", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, ".gitignore"), "build/\n");
    mkdirSync(join(ws, "build"));
    writeFileSync(join(ws, "build", "inside.txt"), "x");
    mkdirSync(join(ws, "nested"));
    writeFileSync(join(ws, "nested", "build"), "x"); // a FILE named build stays visible
    const res = await globTool.execute({ pattern: "**" }, ctx);
    expect(paths(res)).toEqual(["nested/", "nested/build"]);
  });

  it("anchored patterns apply only inside their .gitignore's directory", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, ".gitignore"), "/top-only.txt\n");
    writeFileSync(join(ws, "top-only.txt"), "x");
    mkdirSync(join(ws, "sub"));
    writeFileSync(join(ws, "sub", "top-only.txt"), "x"); // same name, deeper: kept
    const res = await globTool.execute({ pattern: "**" }, ctx);
    expect(paths(res)).toEqual(["sub/", "sub/top-only.txt"]);
  });

  it("nested .gitignore files stack (deeper rules evaluated last)", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, ".gitignore"), "*.gen.ts\n");
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "a.gen.ts"), "x"); // parent rule applies…
    writeFileSync(join(ws, "src", ".gitignore"), "!a.gen.ts\nlocal.txt\n");
    writeFileSync(join(ws, "src", "local.txt"), "x"); // nested rule applies
    const res = await globTool.execute({ pattern: "**" }, ctx);
    // …but the deeper ! rule re-includes a.gen.ts (dot file not listed).
    expect(paths(res)).toEqual(["src/", "src/a.gen.ts"]);
  });

  it("comments and blank lines are skipped; nothing is fatal", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, ".gitignore"), "# a comment\n\nkeep-me.txt\n");
    writeFileSync(join(ws, "keep-me.txt"), "x");
    writeFileSync(join(ws, "other.txt"), "x");
    const res = await globTool.execute({ pattern: "**" }, ctx);
    expect(paths(res)).toEqual(["other.txt"]);
  });

  it("gitignore rules are honored even when dot-entries are not listed", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, ".gitignore"), "hidden-thing.txt\n");
    writeFileSync(join(ws, "hidden-thing.txt"), "x");
    writeFileSync(join(ws, "shown.txt"), "x");
    const res = await globTool.execute({ pattern: "**" }, ctx);
    expect(paths(res)).toEqual(["shown.txt"]);
  });
});
