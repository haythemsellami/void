/**
 * Tests for the read_file builtin: file reads with line numbering and
 * paging markers, directory listings, caps (lines, bytes, OutputLimits) and
 * the error taxonomy (missing path, binary file, invalid inputs).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../contracts/tools";
import { readFileTool } from "./read_file";

const cleanups: string[] = [];

function workspace(): { ws: string; ctx: ToolContext } {
  const ws = mkdtempSync(join(tmpdir(), "void-read-"));
  cleanups.push(ws);
  return {
    ws,
    ctx: {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: "/usr/bin:/bin" },
      requestPermission: async (request) => ({ action: "allow", message: `allow ${request.tool}` }),
      outputLimits: { maxTotalChars: 100_000, maxSectionChars: 100_000 },
    },
  };
}

function text(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("read_file: files", () => {
  it("numbers lines 1-based with the │ separator and a header", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "a.txt"), "one\ntwo\nthree\n");
    const res = await readFileTool.execute({ path: join(ws, "a.txt") }, ctx);
    expect(res.isError).toBe(false);
    expect(res.content[0]?.truncated).toBe(false);
    expect(text(res)).toBe("a.txt (lines 1-3 of 3)\n1│ one\n2│ two\n3│ three");
  });

  it("keeps a final line without trailing newline", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "a.txt"), "one\ntwo");
    const res = await readFileTool.execute({ path: join(ws, "a.txt") }, ctx);
    expect(text(res)).toBe("a.txt (lines 1-2 of 2)\n1│ one\n2│ two");
  });

  it("reports empty files without line noise", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "empty.txt"), "");
    const res = await readFileTool.execute({ path: join(ws, "empty.txt") }, ctx);
    expect(text(res)).toBe("empty.txt (empty file)");
  });

  it("windows lines with offset/limit and marks both omitted ranges", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(
      join(ws, "n.txt"),
      Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"),
    );
    const res = await readFileTool.execute({ path: join(ws, "n.txt"), offset: 5, limit: 3 }, ctx);
    expect(text(res)).toBe(
      [
        "n.txt (lines 5-7 of 20)",
        "… lines 1-4 not shown",
        "5│ line5",
        "6│ line6",
        "7│ line7",
        "… lines 8-20 not shown",
      ].join("\n"),
    );
    expect(res.content[0]?.truncated).toBe(true);
  });

  it("reads the line default from ctx.outputLimits.maxLines (gap #5)", async () => {
    const { ws, ctx } = workspace();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(ws, "cfg.txt"), `${lines.join("\n")}\n`);

    const capped = await readFileTool.execute(
      { path: join(ws, "cfg.txt") },
      { ...ctx, outputLimits: { ...ctx.outputLimits, maxLines: 3 } },
    );
    expect(text(capped)).toContain("lines 1-3 of 10");
    expect(text(capped)).toContain("… lines 4-10 not shown");
    expect(capped.content[0]?.truncated).toBe(true);

    // An explicit per-call limit still wins over the configured default.
    const explicit = await readFileTool.execute(
      { path: join(ws, "cfg.txt"), limit: 5 },
      { ...ctx, outputLimits: { ...ctx.outputLimits, maxLines: 3 } },
    );
    expect(text(explicit)).toContain("lines 1-5 of 10");
  });

  it("defaults to the first 500 lines with a bottom marker", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(
      join(ws, "big.txt"),
      `${Array.from({ length: 600 }, (_, i) => `row${i + 1}`).join("\n")}\n`,
    );
    const res = await readFileTool.execute({ path: join(ws, "big.txt") }, ctx);
    const out = text(res);
    expect(out).toContain("big.txt (lines 1-500 of 600)");
    expect(out).toContain("… lines 501-600 not shown");
    expect(out).toContain("500│ row500");
    expect(out).not.toContain("501│ row501");
    expect(res.content[0]?.truncated).toBe(true);
  });

  it("pads line numbers to a common width", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "p.txt"), "a\nb\nc\nd\nd\nd\nd\nd\nd\nd\nd\nd\n");
    const res = await readFileTool.execute({ path: join(ws, "p.txt") }, ctx);
    expect(text(res)).toContain("\n 9│ d\n10│ d");
  });

  it("caps bytes and says so", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "bytes.txt"), "abcdefghij\nklmnopqrst\n");
    const res = await readFileTool.execute({ path: join(ws, "bytes.txt"), maxBytes: 11 }, ctx);
    const out = text(res);
    expect(out).toContain("… byte cap reached: read 11 of 22 bytes");
    expect(res.content[0]?.truncated).toBe(true);
  });

  it("reports the TRUE total line count when the byte cap cuts the read (review minor)", async () => {
    const { ws, ctx } = workspace();
    // 10 lines x 10 bytes (9 chars + newline) = 100 bytes; a 50-byte cap
    // keeps exactly 5 complete lines.
    const rows = Array.from({ length: 10 }, (_, i) => `row${String(i + 1).padStart(2, "0")}xxxx`);
    writeFileSync(join(ws, "cut.txt"), `${rows.join("\n")}\n`);
    const res = await readFileTool.execute({ path: join(ws, "cut.txt"), maxBytes: 50 }, ctx);
    const out = text(res);
    // The header must count the whole file (10), not the byte-capped slice (5).
    expect(out).toContain("cut.txt (lines 1-5 of 10)");
    expect(out).toContain("… lines 6-10 not shown");
    expect(out).toContain("… byte cap reached: read 50 of 100 bytes");
    expect(res.content[0]?.truncated).toBe(true);
    expect(out).toContain("5│ row05xxxx");
    expect(out).not.toContain("6│ row06xxxx");
  });

  it("follows symlinks for reads (reads are unconfined)", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "real.txt"), "content\n");
    symlinkSync(join(ws, "real.txt"), join(ws, "link.txt"));
    const res = await readFileTool.execute({ path: join(ws, "link.txt") }, ctx);
    expect(text(res)).toContain("1│ content");
  });

  it("reads outside the workspace when given an absolute path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "void-read-out-"));
    cleanups.push(outside);
    writeFileSync(join(outside, "x.txt"), "external\n");
    const { ctx } = workspace();
    const res = await readFileTool.execute({ path: join(outside, "x.txt") }, ctx);
    expect(text(res)).toContain("1│ external");
  });
});

describe("read_file: directories", () => {
  it("lists entries with / on directories", async () => {
    const { ws, ctx } = workspace();
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "README.md"), "x");
    const res = await readFileTool.execute({ path: ws }, ctx);
    expect(text(res)).toBe(". (directory, 2 entries)\n1│ README.md\n2│ src/");
  });

  it("shows dot entries and caps the listing at the limit", async () => {
    const { ws, ctx } = workspace();
    for (let i = 1; i <= 5; i++) writeFileSync(join(ws, `f${i}.txt`), "x");
    const res = await readFileTool.execute({ path: ws, limit: 3 }, ctx);
    expect(text(res)).toContain("… 2 more entries not shown");
    expect(res.content[0]?.truncated).toBe(true);
  });
});

describe("read_file: errors and caps", () => {
  it("returns not_found for missing paths", async () => {
    const { ws, ctx } = workspace();
    const res = await readFileTool.execute({ path: join(ws, "nope.txt") }, ctx);
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("not_found");
  });

  it("refuses binary files with grep/glob guidance", async () => {
    const { ws, ctx } = workspace();
    const bytes = new Uint8Array(64).fill(65);
    bytes[10] = 0;
    writeFileSync(join(ws, "blob.bin"), bytes);
    const res = await readFileTool.execute({ path: join(ws, "blob.bin") }, ctx);
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("binary");
    expect(res.error?.message).toContain("grep");
  });

  it("rejects invalid path/offset/limit types", async () => {
    const { ws, ctx } = workspace();
    expect((await readFileTool.execute({}, ctx)).error?.code).toBe("invalid_input");
    expect((await readFileTool.execute({ path: "" }, ctx)).error?.code).toBe("invalid_input");
    expect((await readFileTool.execute({ path: 5 }, ctx)).error?.code).toBe("invalid_input");
    expect((await readFileTool.execute({ path: join(ws, "a"), offset: 0 }, ctx)).error?.code).toBe(
      "invalid_input",
    );
    expect((await readFileTool.execute({ path: join(ws, "a"), limit: -1 }, ctx)).error?.code).toBe(
      "invalid_input",
    );
    expect(
      (await readFileTool.execute({ path: join(ws, "a"), maxBytes: 1.5 }, ctx)).error?.code,
    ).toBe("invalid_input");
  });

  it("applies OutputLimits with the shared truncation marker", async () => {
    const { ws } = workspace();
    writeFileSync(join(ws, "long.txt"), `${"y".repeat(60)}\n${"z".repeat(60)}\n`);
    const ctx: ToolContext = {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: "/usr/bin:/bin" },
      requestPermission: async () => ({ action: "allow", message: "allow" }),
      outputLimits: { maxTotalChars: 50, maxSectionChars: 50 },
    };
    const res = await readFileTool.execute({ path: join(ws, "long.txt") }, ctx);
    expect(res.content[0]?.truncated).toBe(true);
    expect(text(res).length).toBeLessThanOrEqual(50);
    expect(text(res)).toContain("… [truncated]");
  });

  it("handles an offset beyond EOF", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "small.txt"), "only\n");
    const res = await readFileTool.execute({ path: join(ws, "small.txt"), offset: 99 }, ctx);
    expect(res.isError).toBe(false);
    expect(text(res)).toContain("no lines in range");
  });
});
