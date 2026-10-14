/**
 * Tests for AGENTS.md discovery: ordering, `.agents/` scope, the git-root
 * stop (plus worktree files and the no-git fallback), frontmatter
 * stripping, byte cap + truncation note, unreadable levels, symlinked start.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectAgentsContext, DEFAULT_AGENTS_MAX_BYTES, stripFrontmatter } from "./agents-md";

// macOS $TMPDIR lives under /var (a symlink to /private/var): canonicalize so
// fixtures compare equal against the discovery walk, which realpaths its start.
const base = realpathSync(mkdtempSync(join(tmpdir(), "void-agents-")));
const scratch: string[] = [base];
afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTree(name: string): string {
  const root = mkdtempSync(join(base, `${name}-`));
  scratch.push(root);
  return root;
}

describe("collectAgentsContext", () => {
  it("collects AGENTS.md at every ancestor level, deepest last", async () => {
    const root = makeTree("order");
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root instructions");
    writeFileSync(join(deep, "AGENTS.md"), "deep instructions");

    const ctx = await collectAgentsContext(deep);
    expect(ctx.files).toEqual([join(root, "AGENTS.md"), join(deep, "AGENTS.md")]);
    const deepIndex = ctx.text.indexOf("deep instructions");
    const rootIndex = ctx.text.indexOf("root instructions");
    expect(deepIndex).toBeGreaterThan(rootIndex);
    expect(ctx.text).toContain(`# AGENTS.md — ${join(root, "AGENTS.md")}`);
    expect(ctx.truncated).toBe(false);
  });

  it("collects .agents/AGENTS.md after AGENTS.md at the same level", async () => {
    const root = makeTree("dotagents");
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, "AGENTS.md"), "plain file");
    writeFileSync(join(root, ".agents", "AGENTS.md"), "scoped file");

    const ctx = await collectAgentsContext(root);
    expect(ctx.files).toEqual([join(root, "AGENTS.md"), join(root, ".agents", "AGENTS.md")]);
  });

  it("stops at the git root: an AGENTS.md ABOVE it is ignored, one inside is found", async () => {
    const root = makeTree("gitroot");
    const repo = join(root, "repo");
    const nested = join(repo, "pkg", "lib");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(root, "AGENTS.md"), "above git root");
    writeFileSync(join(repo, "AGENTS.md"), "inside the repo");
    writeFileSync(join(nested, "AGENTS.md"), "deepest level");

    const ctx = await collectAgentsContext(nested);
    expect(ctx.files).toEqual([join(repo, "AGENTS.md"), join(nested, "AGENTS.md")]);
    expect(ctx.text).toContain("inside the repo");
    expect(ctx.text).toContain("deepest level");
    expect(ctx.text).not.toContain("above git root"); // outside the project
  });

  it("counts a git worktree's .git FILE as a root (not just a directory)", async () => {
    const root = makeTree("worktree");
    const wt = join(root, "wt");
    const inner = join(wt, "src");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /somewhere/else/main/.git\n");
    writeFileSync(join(root, "AGENTS.md"), "above the worktree");
    writeFileSync(join(inner, "AGENTS.md"), "inside the worktree");

    const ctx = await collectAgentsContext(inner);
    expect(ctx.files).toEqual([join(inner, "AGENTS.md")]);
    expect(ctx.text).not.toContain("above the worktree");
  });

  it("still collects the whole ancestor chain when no git root exists", async () => {
    // Documented fallback: a workspace outside any checkout keeps walking to
    // the filesystem root, so non-git directories still union their chain.
    const root = makeTree("nogit");
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root instructions");
    writeFileSync(join(deep, "AGENTS.md"), "deep instructions");

    const ctx = await collectAgentsContext(deep);
    expect(ctx.files).toEqual([join(root, "AGENTS.md"), join(deep, "AGENTS.md")]);
  });

  it("returns empty text when no AGENTS.md exists anywhere on the chain", async () => {
    const root = makeTree("none");
    const ctx = await collectAgentsContext(root);
    expect(ctx.text).toBe("");
    expect(ctx.files).toEqual([]);
    expect(ctx.truncated).toBe(false);
  });

  it("strips YAML frontmatter (parsed and ignored at MVP)", async () => {
    const root = makeTree("frontmatter");
    writeFileSync(join(root, "AGENTS.md"), "---\nglobs: src/**\n---\n\nbody instructions\n");
    const ctx = await collectAgentsContext(root);
    expect(ctx.text).toContain("body instructions");
    expect(ctx.text).not.toContain("globs");
    expect(ctx.text).not.toContain("---");
  });

  it("caps the total size and appends a truncation note naming omitted files", async () => {
    const root = makeTree("cap");
    const deep = join(root, "mid", "deep");
    mkdirSync(deep, { recursive: true });
    const filler = "x".repeat(600);
    writeFileSync(join(deep, "AGENTS.md"), `deep ${filler}`); // discovered first
    writeFileSync(join(root, "AGENTS.md"), `root ${filler}`);

    const ctx = await collectAgentsContext(deep, { maxTotalBytes: 1024 });
    expect(ctx.truncated).toBe(true);
    expect(ctx.omitted).toContain(join(root, "AGENTS.md"));
    expect(ctx.text).toContain("truncated at 1024 bytes");
    expect(ctx.text).toContain(join(root, "AGENTS.md")); // named in the note
  });

  it("prefers keeping deeper files when the cap hits", async () => {
    const root = makeTree("prefer-deep");
    const deep = join(root, "a");
    mkdirSync(deep);
    writeFileSync(join(deep, "AGENTS.md"), "deep body");
    writeFileSync(join(root, "AGENTS.md"), "y".repeat(400));

    const ctx = await collectAgentsContext(deep, { maxTotalBytes: 256 });
    // The deep (most specific) file survives; the shallower one is dropped.
    expect(ctx.text).toContain("deep body");
    expect(ctx.files).toEqual([join(deep, "AGENTS.md")]);
    expect(ctx.omitted).toEqual([join(root, "AGENTS.md")]);
  });

  it("skips unreadable directories without failing", async () => {
    const root = makeTree("unreadable");
    const locked = join(root, "locked");
    const below = join(locked, "ws");
    mkdirSync(below, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "readable root");
    chmodSync(locked, 0o000);
    try {
      const ctx = await collectAgentsContext(below);
      // The locked level contributes nothing; ancestors above it still do.
      expect(ctx.files).toEqual([join(root, "AGENTS.md")]);
      expect(ctx.text).toContain("readable root");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("starts from the realpath of a symlinked directory", async () => {
    const root = makeTree("symlink");
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    writeFileSync(join(real, "AGENTS.md"), "real target");
    symlinkSync(real, link);

    const ctx = await collectAgentsContext(link);
    expect(ctx.files).toEqual([join(real, "AGENTS.md")]);
  });

  it("ignores unreadable paths (not just missing ones)", async () => {
    // The fixture puts a DIRECTORY at the AGENTS.md path: readFile fails with
    // EISDIR on every platform and for every euid. (The original fixture used
    // chmod 000, but root — which the offline Linux CI job runs as inside its
    // user namespace — bypasses permission bits, so the file stayed readable
    // there; EISDIR keeps this test meaningful in that job too.)
    const root = makeTree("unreadable-path");
    mkdirSync(join(root, "AGENTS.md"));
    const ctx = await collectAgentsContext(root);
    expect(ctx.files).toEqual([]);
    expect(ctx.text).toBe("");
  });

  it("default cap constant is 64 KiB", () => {
    expect(DEFAULT_AGENTS_MAX_BYTES).toBe(64 * 1024);
  });
});

describe("stripFrontmatter", () => {
  it("removes a well-formed block", () => {
    expect(stripFrontmatter("---\nfoo: 1\n---\nbody")).toBe("body");
  });

  it("keeps text without frontmatter intact", () => {
    expect(stripFrontmatter("--- not a fence\nbody")).toBe("--- not a fence\nbody");
  });

  it("keeps unterminated frontmatter as body", () => {
    expect(stripFrontmatter("---\nfoo: 1\nbody")).toBe("---\nfoo: 1\nbody");
  });
});

// Guard the helper assumption used by the ordering test: dirname of the test
// tree really is an ancestor (sanity for the chain walk on tmpfs).
describe("ancestor assumptions", () => {
  it("tmpdir is an ancestor of the scratch tree", () => {
    expect(dirname(base)).toContain(tmpdir().split("/").pop() ?? "");
  });
});
