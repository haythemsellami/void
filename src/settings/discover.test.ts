/**
 * Settings discovery tests: user-scope XDG/HOME precedence, the workspace
 * cwd-to-git-root walk (stop at git root; filesystem-root fallback), and the
 * JSON-beats-JSONC rule. Filesystem tests use a real temp tree (git roots and
 * symlinks are exactly what existsSync+realpath semantics need); the XDG
 * precedence table uses an injected exists probe to stay hermetic.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findUserSettingsFile, findWorkspaceSettingsFile, userSettingsDir } from "./discover";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-settings-disc-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Create dir (recursive) and return its absolute path. */
function dir(...parts: string[]): string {
  const path = join(scratch, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function gitRoot(parts: readonly string[]): void {
  mkdirSync(join(scratch, ...parts, ".git"), { recursive: true });
}

describe("userSettingsDir", () => {
  it("prefers absolute $XDG_CONFIG_HOME", () => {
    expect(userSettingsDir({ XDG_CONFIG_HOME: "/xdg-conf" })).toBe("/xdg-conf/void");
  });

  it("ignores a non-absolute $XDG_CONFIG_HOME (XDG spec) and falls back to $HOME", () => {
    expect(userSettingsDir({ XDG_CONFIG_HOME: "relative/xdg", HOME: "/home/u" })).toBe(
      "/home/u/.config/void",
    );
    expect(userSettingsDir({ XDG_CONFIG_HOME: "", HOME: "/home/u" })).toBe("/home/u/.config/void");
  });

  it("without XDG or HOME, uses the injected homedir fallback", () => {
    expect(userSettingsDir({}, () => "/fallback-home")).toBe("/fallback-home/.config/void");
  });
});

describe("findUserSettingsFile", () => {
  it("finds settings.json in the user config dir", () => {
    const xdg = dir("user-json", "xdg");
    mkdirSync(join(xdg, "void"), { recursive: true });
    writeFileSync(join(xdg, "void", "settings.json"), "{}");
    const found = findUserSettingsFile({ XDG_CONFIG_HOME: xdg });
    expect(found).toEqual({
      path: join(xdg, "void", "settings.json"),
      format: "json",
      jsoncFallback: false,
    });
  });

  it("falls back to settings.jsonc only when settings.json is absent", () => {
    const xdg = dir("user-jsonc", "xdg");
    mkdirSync(join(xdg, "void"), { recursive: true });
    writeFileSync(join(xdg, "void", "settings.jsonc"), "{}");
    const found = findUserSettingsFile({ XDG_CONFIG_HOME: xdg });
    expect(found?.format).toBe("jsonc");
    expect(found?.jsoncFallback).toBe(true);

    // Adding settings.json flips the choice: JSON wins, JSONC ignored.
    writeFileSync(join(xdg, "void", "settings.json"), "{}");
    expect(findUserSettingsFile({ XDG_CONFIG_HOME: xdg })?.format).toBe("json");
  });

  it("returns undefined when neither syntax exists", () => {
    const xdg = dir("user-none", "xdg");
    expect(findUserSettingsFile({ XDG_CONFIG_HOME: xdg })).toBeUndefined();
  });
});

describe("findWorkspaceSettingsFile", () => {
  it("finds .void/settings.json at the start directory", () => {
    const root = dir("ws-here");
    mkdirSync(join(root, ".void"));
    writeFileSync(join(root, ".void", "settings.json"), "{}");
    expect(findWorkspaceSettingsFile(root)?.path).toBe(join(root, ".void", "settings.json"));
  });

  it("walks up: finds a file at an ancestor between cwd and git root", () => {
    gitRoot(["ws-walk"]);
    const ancestor = dir("ws-walk");
    mkdirSync(join(ancestor, ".void"));
    writeFileSync(join(ancestor, ".void", "settings.json"), "{}");
    const nested = dir("ws-walk", "a", "b", "c");
    expect(findWorkspaceSettingsFile(nested)?.path).toBe(join(ancestor, ".void", "settings.json"));
  });

  it("deepest wins: a file at cwd beats one at an ancestor", () => {
    gitRoot(["ws-deep"]);
    const ancestor = dir("ws-deep");
    mkdirSync(join(ancestor, ".void"));
    writeFileSync(join(ancestor, ".void", "settings.json"), "{}");
    const nested = dir("ws-deep", "inner");
    mkdirSync(join(nested, ".void"));
    writeFileSync(join(nested, ".void", "settings.json"), "{}");
    expect(findWorkspaceSettingsFile(nested)?.path).toBe(join(nested, ".void", "settings.json"));
  });

  it("STOPS at the git root: files above it are never admitted", () => {
    // ws-gitstop/checkout has its own .git; the tempting file lives one level
    // ABOVE that git root and must never be seen from inside the checkout.
    gitRoot(["ws-gitstop", "checkout"]);
    const aboveRoot = dir("ws-gitstop"); // parent of the git root
    mkdirSync(join(aboveRoot, ".void"));
    writeFileSync(join(aboveRoot, ".void", "settings.json"), "{}");
    const inside = dir("ws-gitstop", "checkout", "sub");
    expect(findWorkspaceSettingsFile(inside)).toBeUndefined();
  });

  it("a worktree-style .git FILE counts as the git root", () => {
    const root = dir("ws-worktree");
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/main/.git\n");
    // A tempting file one level ABOVE the worktree root must not be admitted.
    mkdirSync(join(root, "..", ".void"), { recursive: true });
    writeFileSync(join(root, "..", ".void", "settings.json"), "{}");
    expect(findWorkspaceSettingsFile(root)).toBeUndefined();
  });

  it("without any git root, the walk continues to the filesystem root", () => {
    // scratch itself is under os.tmpdir() which is NOT a git root; a file at
    // the scratch root must be found from a deeply nested non-git directory.
    // (recursive: an earlier test may already have planted scratch/.void)
    mkdirSync(join(scratch, ".void"), { recursive: true });
    writeFileSync(join(scratch, ".void", "settings.json"), "{}");
    const nested = dir("no-git", "a", "b");
    expect(findWorkspaceSettingsFile(nested)?.path).toBe(join(scratch, ".void", "settings.json"));
  });

  it("JSON beats JSONC at the workspace layer too", () => {
    const root = dir("ws-jsonc");
    mkdirSync(join(root, ".void"));
    writeFileSync(join(root, ".void", "settings.jsonc"), "{}");
    const jsonc = findWorkspaceSettingsFile(root);
    expect(jsonc?.format).toBe("jsonc");
    expect(jsonc?.jsoncFallback).toBe(true);
    writeFileSync(join(root, ".void", "settings.json"), "{}");
    const json = findWorkspaceSettingsFile(root);
    expect(json?.format).toBe("json");
    expect(json?.path).toBe(join(root, ".void", "settings.json"));
  });

  it("returns undefined when nothing exists on the chain", () => {
    // Own git root so the walk stops before reaching the shared scratch dir
    // (which another test deliberately plants with a settings file).
    gitRoot(["ws-empty"]);
    const empty = dir("ws-empty", "sub");
    expect(findWorkspaceSettingsFile(empty)).toBeUndefined();
  });
});
