/**
 * Tests for edit_file: application semantics (unique/replace_all, trailing
 * newline preservation, confinement), the error taxonomy (zero-match with
 * near-miss hint, multi-match, outside-workspace, not_found, binary), and
 * the dependency-free unified differ (insert/delete/modify, context lines,
 * hunk headers, no-newline markers, multi-hunk separation).
 */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../contracts/tools";
import {
  computeUnifiedDiff,
  editFileTool,
  findClosestMatchLine,
  findOccurrences,
} from "./edit_file";

const cleanups: string[] = [];

function workspace(): { ws: string; ctx: ToolContext } {
  const ws = mkdtempSync(join(tmpdir(), "void-edit-"));
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

function text(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("edit_file: application semantics", () => {
  it("applies a unique replacement and returns summary plus unified diff", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "code.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const res = await editFileTool.execute(
      { path: join(ws, "code.ts"), old_str: "const b = 2;", new_str: "const b = 42;" },
      ctx,
    );
    expect(res.isError).toBe(false);
    expect(res.content[0]?.truncated).toBe(false);
    expect(text(res)).toContain("Edited code.ts: 1 replacement applied");
    expect(text(res)).toContain("--- a/code.ts");
    expect(text(res)).toContain("+++ b/code.ts");
    expect(text(res)).toContain("-const b = 2;");
    expect(text(res)).toContain("+const b = 42;");
    expect(readFileSync(join(ws, "code.ts"), "utf8")).toBe(
      "const a = 1;\nconst b = 42;\nconst c = 3;\n",
    );
  });

  it("replaces every occurrence with replace_all", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "r.txt"), "x TODO y\nz TODO w\n");
    const res = await editFileTool.execute(
      { path: join(ws, "r.txt"), old_str: "TODO", new_str: "DONE", replace_all: true },
      ctx,
    );
    expect(text(res)).toContain("2 replacements applied");
    expect(readFileSync(join(ws, "r.txt"), "utf8")).toBe("x DONE y\nz DONE w\n");
  });

  it("preserves a trailing newline when present", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "nl.txt"), "a\nb\n");
    await editFileTool.execute({ path: join(ws, "nl.txt"), old_str: "b", new_str: "c" }, ctx);
    expect(readFileSync(join(ws, "nl.txt"), "utf8")).toBe("a\nc\n");
  });

  it("preserves the absence of a trailing newline and marks it in the diff", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "nonl.txt"), "a\nb");
    const res = await editFileTool.execute(
      { path: join(ws, "nonl.txt"), old_str: "b", new_str: "c" },
      ctx,
    );
    expect(readFileSync(join(ws, "nonl.txt"), "utf8")).toBe("a\nc");
    const out = text(res);
    expect(out.split("\\ No newline at end of file").length - 1).toBe(2);
  });

  it("counts non-overlapping occurrences for multi-line old_str", () => {
    expect(findOccurrences("aaa", "aa")).toEqual([0]);
    expect(findOccurrences("ababab", "ab")).toEqual([0, 2, 4]);
    expect(findOccurrences("abc", "z")).toEqual([]);
  });

  it("supports multi-line old_str spanning the whole file", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "m.txt"), "alpha\nbeta\ngamma\n");
    await editFileTool.execute(
      { path: join(ws, "m.txt"), old_str: "alpha\nbeta\ngamma", new_str: "one\ntwo" },
      ctx,
    );
    expect(readFileSync(join(ws, "m.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("writes through an inside-workspace symlink to the real file", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "real.txt"), "keep\n");
    symlinkSync(join(ws, "real.txt"), join(ws, "alias.txt"));
    const res = await editFileTool.execute(
      { path: join(ws, "alias.txt"), old_str: "keep", new_str: "kept" },
      ctx,
    );
    expect(res.isError).toBe(false);
    expect(readFileSync(join(ws, "real.txt"), "utf8")).toBe("kept\n");
  });
});

describe("edit_file: error taxonomy", () => {
  it("zero matches returns invalid_input with the closest similar line", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "f.ts"), "const value = compute(x);\nreturn value;\n");
    const res = await editFileTool.execute(
      { path: join(ws, "f.ts"), old_str: "const value = compute(y);", new_str: "z" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("old_str not found");
    expect(res.error?.message).toContain("line 1");
    expect(res.error?.message).toContain("compute(x)");
    // Structured details (contracts gap #2): zero-match carries matchCount.
    expect(res.error?.details).toEqual({ matchCount: 0 });
  });

  it("zero matches flags whitespace/case-only differences", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "w.txt"), "Hello World\n");
    const res = await editFileTool.execute(
      { path: join(ws, "w.txt"), old_str: "hello   world", new_str: "x" },
      ctx,
    );
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("except for whitespace or case");
    expect(res.error?.message).toContain("Line 1");
  });

  it("multiple matches without replace_all list the line numbers", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "dup.txt"), "one\ntwo X three\nfour\ntwo X five\nsix two X\n");
    const res = await editFileTool.execute(
      { path: join(ws, "dup.txt"), old_str: "two X", new_str: "Z" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("3 locations");
    expect(res.error?.message).toContain("lines 2, 4, 5");
    // Structured details (contracts gap #2): count + line numbers, capped at 20.
    expect(res.error?.details).toEqual({ matchCount: 3, lineNumbers: [2, 4, 5] });
    expect(readFileSync(join(ws, "dup.txt"), "utf8")).toContain("two X"); // unchanged
  });

  it("rejects writes outside the workspace (absolute and relative escapes)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "void-edit-out-"));
    cleanups.push(outside);
    writeFileSync(join(outside, "x.txt"), "target\n");
    const { ctx } = workspace();
    const abs = await editFileTool.execute(
      { path: join(outside, "x.txt"), old_str: "target", new_str: "z" },
      ctx,
    );
    expect(abs.isError).toBe(true);
    expect(abs.error?.code).toBe("invalid_input");
    expect(abs.error?.message).toContain("workspace");
    const rel = await editFileTool.execute(
      { path: "../escape.txt", old_str: "a", new_str: "b" },
      ctx,
    );
    expect(rel.error?.code).toBe("invalid_input");
    expect(readFileSync(join(outside, "x.txt"), "utf8")).toBe("target\n"); // untouched
  });

  it("rejects edits through a symlink escaping the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "void-edit-out2-"));
    cleanups.push(outside);
    writeFileSync(join(outside, "victim.txt"), "data\n");
    const { ws, ctx } = workspace();
    symlinkSync(outside, join(ws, "escape"));
    const res = await editFileTool.execute(
      { path: join(ws, "escape", "victim.txt"), old_str: "data", new_str: "pwned" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("invalid_input");
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("data\n");
  });

  it("returns not_found for missing files (edit_file cannot create)", async () => {
    const { ws, ctx } = workspace();
    const res = await editFileTool.execute(
      { path: join(ws, "new.txt"), old_str: "a", new_str: "b" },
      ctx,
    );
    expect(res.error?.code).toBe("not_found");
    expect(res.error?.message).toContain("cannot create");
  });

  it("rejects directories and invalid inputs", async () => {
    const { ws, ctx } = workspace();
    mkdirSync(join(ws, "d"));
    expect(
      (await editFileTool.execute({ path: join(ws, "d"), old_str: "a", new_str: "b" }, ctx)).error
        ?.code,
    ).toBe("invalid_input");
    expect((await editFileTool.execute({ path: join(ws, "f") }, ctx)).error?.code).toBe(
      "invalid_input",
    );
    expect(
      (await editFileTool.execute({ path: join(ws, "f"), old_str: "", new_str: "b" }, ctx)).error
        ?.code,
    ).toBe("invalid_input");
    expect(
      (await editFileTool.execute({ path: join(ws, "f"), old_str: "a" }, ctx)).error?.code,
    ).toBe("invalid_input");
    expect(
      (await editFileTool.execute({ path: join(ws, "f"), old_str: "a", new_str: "a" }, ctx)).error
        ?.code,
    ).toBe("invalid_input");
    expect(
      (
        await editFileTool.execute(
          { path: join(ws, "f"), old_str: "a", new_str: "b", replace_all: "yes" },
          ctx,
        )
      ).error?.code,
    ).toBe("invalid_input");
  });

  it("refuses binary files", async () => {
    const { ws, ctx } = workspace();
    const bytes = new Uint8Array(64).fill(66);
    bytes[5] = 0;
    writeFileSync(join(ws, "bin.dat"), bytes);
    const res = await editFileTool.execute(
      { path: join(ws, "bin.dat"), old_str: "B", new_str: "C" },
      ctx,
    );
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("binary");
  });
});

describe("edit_file: text encoding (review major 6)", () => {
  it("rejects a Latin-1 file cleanly and leaves it byte-identical", async () => {
    const { ws, ctx } = workspace();
    // "é\ncafé\n" in Latin-1: 0xE9 is an invalid standalone UTF-8 byte.
    const bytes = Buffer.from([0xe9, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a]);
    writeFileSync(join(ws, "latin1.txt"), bytes);
    const res = await editFileTool.execute(
      { path: join(ws, "latin1.txt"), old_str: "café", new_str: "CAFE" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("not valid UTF-8");
    expect(res.error?.message).toContain("UTF-8 text");
    // The file must be untouched: no lossy re-encode, no U+FFFD substitution.
    expect(readFileSync(join(ws, "latin1.txt"))).toEqual(bytes);
  });

  it("edits valid multibyte UTF-8 correctly and preserves every other byte", async () => {
    const { ws, ctx } = workspace();
    const content = "héllo wörld\n日本語テキスト\nplain ascii\n";
    writeFileSync(join(ws, "u8.txt"), Buffer.from(content, "utf8"));
    const res = await editFileTool.execute(
      { path: join(ws, "u8.txt"), old_str: "wörld", new_str: "WELT" },
      ctx,
    );
    expect(res.isError).toBe(false);
    expect(readFileSync(join(ws, "u8.txt"), "utf8")).toBe(
      "héllo WELT\n日本語テキスト\nplain ascii\n",
    );
    expect(Buffer.from(readFileSync(join(ws, "u8.txt")))).toEqual(
      Buffer.from("héllo WELT\n日本語テキスト\nplain ascii\n", "utf8"),
    );
  });

  it("rejects a truncated multibyte sequence at end-of-file", async () => {
    const { ws, ctx } = workspace();
    const bytes = Buffer.concat([Buffer.from("ok text\n", "utf8"), Buffer.from([0xf0, 0x9f])]);
    writeFileSync(join(ws, "trunc.txt"), bytes);
    const res = await editFileTool.execute(
      { path: join(ws, "trunc.txt"), old_str: "ok text", new_str: "x" },
      ctx,
    );
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("not valid UTF-8");
    expect(readFileSync(join(ws, "trunc.txt"))).toEqual(bytes);
  });
});

// Root (uid 0) bypasses permission bits — the Linux CI job runs as root
// inside its user namespace, so the EACCES fixture is only meaningful as a
// regular user (same guard rationale as the EISDIR trick elsewhere).
const canTestPermissionBits = typeof process.getuid === "function" ? process.getuid() !== 0 : true;

describe.skipIf(!canTestPermissionBits)("edit_file: read failures are structured", () => {
  it("reports an unreadable file as a structured permission error, never a throw", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "locked.txt"), "secret\n");
    chmodSync(join(ws, "locked.txt"), 0o000);
    try {
      const res = await editFileTool.execute(
        { path: join(ws, "locked.txt"), old_str: "secret", new_str: "x" },
        ctx,
      );
      // Which guard fires is runtime-dependent: under Bun, realpathSync on a
      // mode-000 file itself fails EACCES (resolveInsideWorkspace ->
      // invalid_input); under Node the path resolves and the guarded read
      // maps EACCES to permission_denied. Either way: structured, mentions
      // the permission problem, and the tool never throws.
      expect(res.isError).toBe(true);
      expect(res.error?.message.toLowerCase()).toContain("permission denied");
    } finally {
      chmodSync(join(ws, "locked.txt"), 0o644);
    }
  });
});

describe("edit_file: write hardening (review minors)", () => {
  it("rejects files over the output-limits-derived byte cap without reading them", async () => {
    const { ws } = workspace();
    // maxTotalChars 1000 -> byte cap 4000; the file is 5000 bytes.
    const big = "x".repeat(5000);
    writeFileSync(join(ws, "big.txt"), big);
    const ctx: ToolContext = {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: "/usr/bin:/bin" },
      requestPermission: async () => ({ action: "allow", message: "allow" }),
      outputLimits: { maxTotalChars: 1000, maxSectionChars: 1000 },
    };
    const res = await editFileTool.execute(
      { path: join(ws, "big.txt"), old_str: "x", new_str: "y" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("5000 bytes");
    expect(res.error?.message).toContain("4000-byte edit cap");
    expect(res.error?.message).toContain("maxTotalChars");
    expect(readFileSync(join(ws, "big.txt"), "utf8")).toBe(big); // untouched
  });

  it("rejects hard-linked files (st_nlink > 1) and changes neither name", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "original.txt"), "shared\n");
    linkSync(join(ws, "original.txt"), join(ws, "alias.txt"));
    const res = await editFileTool.execute(
      { path: join(ws, "original.txt"), old_str: "shared", new_str: "solo" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("hard links");
    expect(res.error?.message).toContain("st_nlink");
    expect(readFileSync(join(ws, "original.txt"), "utf8")).toBe("shared\n");
    expect(readFileSync(join(ws, "alias.txt"), "utf8")).toBe("shared\n");
  });

  it("writes atomically: final content lands via rename and no temp file remains", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "atomic.txt"), "before\n");
    const res = await editFileTool.execute(
      { path: join(ws, "atomic.txt"), old_str: "before", new_str: "after" },
      ctx,
    );
    expect(res.isError).toBe(false);
    expect(readFileSync(join(ws, "atomic.txt"), "utf8")).toBe("after\n");
    const strays = readdirSync(ws).filter((name) => name.includes("voidtmp"));
    expect(strays).toEqual([]);
  });
});

describe.skipIf(!canTestPermissionBits)("edit_file: atomic-write failure paths", () => {
  it("cleans up the temp file and keeps the target when the write fails", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "ro.txt"), "keep me\n");
    // Read-only directory: the temp write (not the earlier file read) fails.
    chmodSync(ws, 0o555);
    try {
      const res = await editFileTool.execute(
        { path: join(ws, "ro.txt"), old_str: "keep me", new_str: "dropped" },
        ctx,
      );
      expect(res.isError).toBe(true);
      expect(res.error?.message.toLowerCase()).toContain("permission denied");
      expect(readFileSync(join(ws, "ro.txt"), "utf8")).toBe("keep me\n"); // never truncated
      expect(readdirSync(ws).filter((name) => name.includes("voidtmp"))).toEqual([]);
    } finally {
      chmodSync(ws, 0o755); // restore so the shared afterEach cleanup works
    }
  });
});

describe("computeUnifiedDiff", () => {
  const lines = (n: number, prefix = "l"): string =>
    `${Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n")}\n`;

  it("shows 3 context lines around a mid-file modification", () => {
    const oldText = lines(10);
    const newText = oldText.replace("l4\n", "L4\n");
    expect(computeUnifiedDiff(oldText, newText, "f")).toBe(
      [
        "--- a/f",
        "+++ b/f",
        "@@ -1,7 +1,7 @@",
        " l1",
        " l2",
        " l3",
        "-l4",
        "+L4",
        " l5",
        " l6",
        " l7",
      ].join("\n"),
    );
  });

  it("splits distant changes into separate hunks", () => {
    const oldText = lines(30);
    const newText = oldText.replace("l2\n", "L2\n").replace("l20\n", "L20\n");
    const diff = computeUnifiedDiff(oldText, newText, "f");
    const headers = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(headers).toEqual(["@@ -1,5 +1,5 @@", "@@ -17,7 +17,7 @@"]);
    expect(diff).toContain("-l2\n+L2");
    expect(diff).toContain("-l20\n+L20");
  });

  it("emits zero-count headers for insertion into an empty file", () => {
    expect(computeUnifiedDiff("", "x\n", "f")).toBe(
      ["--- a/f", "+++ b/f", "@@ -0,0 +1,1 @@", "+x"].join("\n"),
    );
  });

  it("handles pure deletion of the last line without trailing newline", () => {
    const diff = computeUnifiedDiff("a\nb\nc", "a\nb\n", "f");
    expect(diff).toBe(
      [
        "--- a/f",
        "+++ b/f",
        "@@ -1,3 +1,2 @@",
        " a",
        " b",
        "-c",
        "\\ No newline at end of file",
      ].join("\n"),
    );
  });

  it("handles insertion at the top", () => {
    const diff = computeUnifiedDiff("x1\nx2\nx3\n", "y0\nx1\nx2\nx3\n", "f");
    expect(diff).toContain("@@ -1,3 +1,4 @@");
    expect(diff).toContain("+y0");
  });

  it("returns only headers for identical content", () => {
    const diff = computeUnifiedDiff("same\nsame\n", "same\nsame\n", "f");
    expect(diff).toBe("--- a/f\n+++ b/f");
  });

  it("falls back to a single whole hunk for very large middles", () => {
    // 3000 x 3000 distinct lines => 9M cells > LCS_CELL_CAP: one big hunk.
    const big = (p: string): string =>
      `${Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join("\n")}\n`;
    const diff = computeUnifiedDiff(big("a"), big("b"), "f");
    expect(diff.match(/^-a\d+$/gm)).toHaveLength(3000);
    expect(diff.match(/^\+b\d+$/gm)).toHaveLength(3000);
    expect(diff.split("\n").filter((l) => l.startsWith("@@"))).toHaveLength(1);
  });
});

describe("findClosestMatchLine", () => {
  it("returns null when old_str is only whitespace", () => {
    expect(findClosestMatchLine("a\nb\n", "  \n \n")).toBeNull();
  });

  it("returns null below the similarity threshold", () => {
    expect(findClosestMatchLine("alpha beta\n", "zebra quantum leap")).toBeNull();
  });

  it("picks the most token-similar line deterministically", () => {
    const hit = findClosestMatchLine(
      "import fs from 'node:fs'\nconst x = 1;\n",
      "import fs from 'node:path'",
    );
    expect(hit?.line).toBe(1);
    expect(hit?.onlyWhitespaceOrCase).toBe(false);
  });
});
