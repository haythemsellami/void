/**
 * Tests for the shared file-tool helpers: write confinement (including
 * symlink escapes and non-existent tails), display paths, binary sniffing,
 * and output-limit clipping. All on mkdtemp temp workspaces; no network.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BINARY_SNIFF_BYTES,
  clipToOutputLimit,
  errnoCode,
  isProbablyBinary,
  optionalBoolean,
  optionalPositiveInt,
  resolveInputPath,
  resolveInsideWorkspace,
  toDisplayPath,
} from "./paths";

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `void-${prefix}-`));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveInsideWorkspace", () => {
  it("accepts a plain file inside the workspace and returns its realpath", () => {
    const ws = tempDir("ws");
    writeFileSync(join(ws, "f.txt"), "x");
    const res = resolveInsideWorkspace("f.txt", ws);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe(join(realpathSync(ws), "f.txt"));
  });

  it("accepts an absolute path equal to the workspace root", () => {
    const ws = tempDir("ws");
    const res = resolveInsideWorkspace(ws, ws);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe(realpathSync(ws));
  });

  it("accepts a not-yet-existing tail under an existing directory", () => {
    const ws = tempDir("ws");
    mkdirSync(join(ws, "src"));
    const res = resolveInsideWorkspace("src/new/deep/file.ts", ws);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe(join(realpathSync(ws), "src", "new", "deep", "file.ts"));
  });

  it("rejects lexical .. escapes", () => {
    const ws = tempDir("ws");
    const res = resolveInsideWorkspace("../evil.txt", ws);
    expect(res.ok).toBe(false);
  });

  it("rejects absolute paths outside the workspace", () => {
    const ws = tempDir("ws");
    const other = tempDir("other");
    const res = resolveInsideWorkspace(join(other, "x.txt"), ws);
    expect(res.ok).toBe(false);
  });

  it("rejects a symlink pointing outside the workspace", () => {
    const ws = tempDir("ws");
    const outside = tempDir("outside"); // already created by mkdtemp
    symlinkSync(outside, join(ws, "escape"));
    expect(resolveInsideWorkspace("escape/file.txt", ws).ok).toBe(false);
    expect(resolveInsideWorkspace(join(ws, "escape"), ws).ok).toBe(false);
  });

  it("accepts symlinks that stay inside the workspace", () => {
    const ws = tempDir("ws");
    mkdirSync(join(ws, "real"));
    symlinkSync(join(ws, "real"), join(ws, "alias"));
    const res = resolveInsideWorkspace("alias/file.txt", ws);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe(join(realpathSync(ws), "real", "file.txt"));
  });

  it("rejects paths whose nearest existing ancestor is an outside symlink", () => {
    const ws = tempDir("ws");
    const outside = tempDir("outside");
    symlinkSync(outside, join(ws, "link"));
    // "link/x/y.txt" does not exist; the walk stops at the symlink itself.
    expect(resolveInsideWorkspace("link/x/y.txt", ws).ok).toBe(false);
  });

  it("rejects empty and NUL-containing paths", () => {
    const ws = tempDir("ws");
    expect(resolveInsideWorkspace("", ws).ok).toBe(false);
    expect(resolveInsideWorkspace("a\0b", ws).ok).toBe(false);
  });

  it("fails cleanly when the workspace root does not exist", () => {
    const res = resolveInsideWorkspace("x", "/definitely/missing/root");
    expect(res.ok).toBe(false);
  });
});

describe("resolveInputPath / toDisplayPath", () => {
  it("resolves relative inputs against the root, absolutes untouched", () => {
    expect(resolveInputPath("a/b.ts", "/ws")).toBe("/ws/a/b.ts");
    expect(resolveInputPath("/elsewhere/b.ts", "/ws")).toBe("/elsewhere/b.ts");
    expect(resolveInputPath("../x", "/ws/sub")).toBe("/ws/x");
  });

  it("shortens inside paths and keeps outside paths absolute", () => {
    expect(toDisplayPath("/a/b/c.ts", "/a/b")).toBe("c.ts");
    expect(toDisplayPath("/a/b/d/e.ts", "/a/b")).toBe("d/e.ts");
    expect(toDisplayPath("/a/b", "/a/b")).toBe(".");
    expect(toDisplayPath("/x/y", "/a/b")).toBe("/x/y");
  });
});

describe("isProbablyBinary", () => {
  it("detects a NUL byte within the first 8 KiB", () => {
    const bytes = new Uint8Array(100);
    bytes[42] = 0;
    expect(isProbablyBinary(bytes)).toBe(true);
  });

  it("ignores NUL bytes beyond the sniff window", () => {
    const bytes = new Uint8Array(BINARY_SNIFF_BYTES + 10);
    bytes.fill(65); // "A" — a fresh Uint8Array is all zeroes, i.e. binary
    bytes[BINARY_SNIFF_BYTES + 5] = 0;
    expect(isProbablyBinary(bytes)).toBe(false);
  });

  it("passes plain UTF-8 text through", () => {
    expect(isProbablyBinary(new TextEncoder().encode("hello\nworld\n"))).toBe(false);
  });
});

describe("clipToOutputLimit", () => {
  const limits = { maxTotalChars: 10, maxSectionChars: 100 };

  it("returns short text unchanged", () => {
    const res = clipToOutputLimit("short", limits);
    expect(res.text).toBe("short");
    expect(res.truncated).toBe(false);
  });

  it("clips at the smaller of the two caps and keeps the marker inside", () => {
    // maxTotalChars (30) wins over maxSectionChars (100); cap > marker length.
    const res = clipToOutputLimit("x".repeat(200), { maxTotalChars: 30, maxSectionChars: 100 });
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(30);
    expect(res.text.endsWith("… [truncated]")).toBe(true);
    // Same, with the section cap being the smaller one.
    const res2 = clipToOutputLimit("x".repeat(200), { maxTotalChars: 100, maxSectionChars: 30 });
    expect(res2.text).toBe(res.text);
  });

  it("never returns negative keep sizes on tiny caps", () => {
    const res = clipToOutputLimit("abcdef", { maxTotalChars: 2, maxSectionChars: 2 });
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(2);
  });
});

describe("input validators", () => {
  it("optionalPositiveInt accepts undefined and positive integers only", () => {
    expect(optionalPositiveInt(undefined, "n")).toEqual({ ok: true, value: undefined });
    expect(optionalPositiveInt(5, "n")).toEqual({ ok: true, value: 5 });
    expect(optionalPositiveInt(0, "n").ok).toBe(false);
    expect(optionalPositiveInt(-3, "n").ok).toBe(false);
    expect(optionalPositiveInt(2.5, "n").ok).toBe(false);
    expect(optionalPositiveInt("5", "n").ok).toBe(false);
  });

  it("optionalBoolean accepts undefined and booleans only", () => {
    expect(optionalBoolean(undefined, "b")).toEqual({ ok: true, value: undefined });
    expect(optionalBoolean(true, "b")).toEqual({ ok: true, value: true });
    expect(optionalBoolean("yes", "b").ok).toBe(false);
  });
});

describe("errnoCode", () => {
  it("extracts codes from node fs errors", () => {
    const err = Object.assign(new Error("nope"), { code: "ENOENT" });
    expect(errnoCode(err)).toBe("ENOENT");
    expect(errnoCode(new Error("plain"))).toBeUndefined();
    expect(errnoCode("string")).toBeUndefined();
  });
});
