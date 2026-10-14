/**
 * Discovery tests for `src/skills/discover` (ADR-0012): root enumeration in
 * first-wins order across the three tiers, the cwd→git-root workspace walk,
 * `skills.path` parsing (~ expansion, colon separation, relative entries),
 * the loud-problem posture, and the bounded resource listing.
 *
 * The walk semantics (realpath + `.git` stop) need real directories: the
 * workspace fixtures are temp dirs. Pure-fs cases (unreadable/oversized
 * files) inject only the seam they exercise.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverSkills, expandTilde, listSkillResources, MAX_RESOURCE_ENTRIES } from "./discover";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-skills-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a valid SKILL.md for `name` under `<root>/<dirName>/SKILL.md`. */
function makeSkill(
  root: string,
  dirName: string,
  name: string,
  options: {
    readonly description?: string;
    readonly body?: string;
    readonly file?: string;
    readonly text?: string;
  } = {},
): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, options.file ?? "SKILL.md");
  writeFileSync(
    file,
    options.text ??
      `---\nname: ${name}\ndescription: ${options.description ?? `${name} description`}\n---\n${options.body ?? `${name} body`}\n`,
  );
  return file;
}

function temp(name: string): string {
  return mkdtempSync(join(scratch, `${name}-`));
}

describe("discoverSkills: workspace tier", () => {
  it("finds skills under .agents/skills/*/SKILL.md and skills/*/skill.md", async () => {
    const ws = temp("ws-basic");
    const a = makeSkill(join(ws, ".agents", "skills"), "alpha", "alpha-skill");
    const b = makeSkill(join(ws, "skills"), "beta", "beta-skill");
    const result = await discoverSkills({ workspaceRoot: ws, env: { HOME: temp("home-none") } });
    expect(result.problems).toEqual([]);
    expect(result.skills.map((skill) => skill.name)).toEqual(["alpha-skill", "beta-skill"]);
    expect(result.skills.map((skill) => skill.path)).toEqual([a, b]);
    expect(result.skills.every((skill) => skill.source === "workspace")).toBe(true);
  });

  // NOTE: SKILL.md vs skill.md spelling is only observable on case-SENSITIVE
  // filesystems (on default APFS/NFS the two names alias one file), so both
  // case-dimension tests drive the existence/read seams with exact spellings.
  it("discovers a lowercase skill.md file (seam-driven exact spelling)", async () => {
    const ws = temp("ws-lower");
    makeSkill(join(ws, "skills"), "gamma", "gamma-skill", { file: "skill.md" });
    const result = await discoverSkills({
      workspaceRoot: ws,
      env: { HOME: temp("home-lower") },
      fs: {
        exists: (path) => !path.endsWith("/SKILL.md") && existsSync(path),
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.skills.map((skill) => skill.name)).toEqual(["gamma-skill"]);
    expect(result.skills[0]?.path.endsWith(join("gamma", "skill.md"))).toBe(true);
  });

  it("SKILL.md beats skill.md when both exist in one skill directory (seam-driven)", async () => {
    const ws = temp("ws-case");
    const skills = join(ws, "skills");
    const upper = makeSkill(skills, "duo", "shared-name");
    const result = await discoverSkills({
      workspaceRoot: ws,
      env: { HOME: temp("home-x") },
      fs: {
        exists: existsSync, // both spellings "exist" on a case-insensitive fs
        readFile: (path) =>
          Promise.resolve(
            path.endsWith("/SKILL.md")
              ? "---\nname: shared-name\ndescription: upper wins\n---\nupper body\n"
              : "---\nname: shared-name\ndescription: lower loses\n---\nlower body\n",
          ),
      },
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe("shared-name");
    expect(result.skills[0]?.description).toBe("upper wins");
    expect(result.skills[0]?.path).toBe(upper);
    // The lower-case twin was never admitted: no shadow entry, no problem.
    expect(result.shadowed).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("walks cwd → git root: a nested start still finds git-root-level skills", async () => {
    const repo = temp("repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const root = makeSkill(join(repo, ".agents", "skills"), "repo-wide", "repo-wide");
    const deep = temp("deep-outside"); // NOT under repo: isolated home
    const result = await discoverSkills({
      workspaceRoot: join(repo, "packages", "app"),
      env: { HOME: deep },
    });
    expect(result.skills.map((skill) => skill.path)).toEqual([root]);
  });

  it("stops at the innermost git root: skills above it are not admitted", async () => {
    const outer = temp("outer");
    mkdirSync(join(outer, ".git"), { recursive: true });
    makeSkill(join(outer, "skills"), "outer-skill", "outer-skill");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, ".git"), "gitdir: /nowhere\n"); // worktree-style file counts
    const innerSkill = makeSkill(join(inner, "skills"), "inner-skill", "inner-skill");
    const result = await discoverSkills({
      workspaceRoot: join(inner, "sub"),
      env: { HOME: temp("home-inner") },
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(["inner-skill"]);
    expect(result.skills[0]?.path).toBe(innerSkill);
  });

  it("per level .agents/skills precedes skills; deeper levels precede shallower (first-wins)", async () => {
    const repo = temp("ws-order");
    mkdirSync(join(repo, ".git"), { recursive: true });
    makeSkill(join(repo, "skills"), "dir-s", "shared", { description: "root-skills-tier" });
    makeSkill(join(repo, ".agents", "skills"), "dir-a", "shared", {
      description: "root-agents-tier",
    });
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    makeSkill(join(sub, ".agents", "skills"), "dir-sub", "shared", {
      description: "sub-agents-tier",
    });
    const result = await discoverSkills({ workspaceRoot: sub, env: { HOME: temp("home-o") } });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe("sub-agents-tier");
    expect(result.shadowed.map((entry) => entry.name)).toEqual(["shared", "shared"]);
  });
});

describe("discoverSkills: user tier and settings.path tier", () => {
  it("reads the user root from $HOME/.config/void/skills and from absolute $XDG_CONFIG_HOME", async () => {
    const home = temp("home");
    const userSkill = makeSkill(join(home, ".config", "void", "skills"), "mine", "mine");
    const ws = temp("ws-user");
    const byHome = await discoverSkills({ workspaceRoot: ws, env: { HOME: home } });
    expect(byHome.skills.map((skill) => skill.path)).toEqual([userSkill]);
    expect(byHome.skills[0]?.source).toBe("user");

    const xdg = temp("xdg");
    const xdgSkill = makeSkill(join(xdg, "void", "skills"), "xdg-skill", "xdg-skill");
    const byXdg = await discoverSkills({
      workspaceRoot: ws,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    expect(byXdg.skills.map((skill) => skill.path)).toEqual([xdgSkill]);
  });

  it("skills.path: colon-separated, ~ expanded, relative resolved against the workspace, missing skipped", async () => {
    const ws = temp("ws-path");
    const extra = temp("extra");
    const home = temp("path-home");
    const e1 = makeSkill(extra, "one", "path-one");
    const homeSkills = join(home, "more-skills");
    const e2 = makeSkill(homeSkills, "two", "path-two");
    const rel = join(ws, "vendored-skills");
    const e3 = makeSkill(rel, "three", "path-three");

    const result = await discoverSkills({
      workspaceRoot: ws,
      env: { HOME: home },
      skillsPath: `${extra}: :~/more-skills::${join("vendored-skills")}:${join(ws, "does-not-exist")}`,
    });
    expect(result.problems).toEqual([]);
    expect(result.skills.map((skill) => skill.path)).toEqual([e1, e2, e3]);
    expect(result.skills.every((skill) => skill.source === "settings-path")).toBe(true);
    // Configured-but-missing roots stay visible (informational), absent ones never fatal.
    expect(
      result.roots.filter((root) => root.kind === "settings-path").map((root) => root.found),
    ).toEqual([true, true, true, false]);
  });

  it("tier order: workspace shadows user, user shadows skills.path (first wins)", async () => {
    const ws = temp("ws-tiers");
    makeSkill(join(ws, ".agents", "skills"), "dir-a", "a", { description: "ws-copy" });
    const home = temp("tiers-home");
    makeSkill(join(home, ".config", "void", "skills"), "dir-a", "a", { description: "user-copy" });
    makeSkill(join(home, ".config", "void", "skills"), "dir-b", "b", { description: "user-only" });
    const extra = temp("tiers-extra");
    makeSkill(extra, "dir-a", "a", { description: "path-copy" });
    makeSkill(extra, "dir-b", "b", { description: "path-copy-b" });
    makeSkill(extra, "dir-c", "c", { description: "path-only" });

    const result = await discoverSkills({
      workspaceRoot: ws,
      env: { HOME: home },
      skillsPath: extra,
    });
    const byName = new Map(result.skills.map((skill) => [skill.name, skill.description]));
    expect(byName.get("a")).toBe("ws-copy");
    expect(byName.get("b")).toBe("user-only");
    expect(byName.get("c")).toBe("path-only");
    expect(result.shadowed.map((entry) => entry.name).sort()).toEqual(["a", "a", "b"]);
  });

  it("earlier skills.path entries win over later ones for the same name", async () => {
    const first = temp("sp-first");
    const second = temp("sp-second");
    makeSkill(first, "dir-x", "x", { description: "first-copy" });
    makeSkill(second, "dir-x", "x", { description: "second-copy" });
    const result = await discoverSkills({
      workspaceRoot: temp("ws-sp"),
      env: { HOME: temp("sp-home") },
      skillsPath: `${first}:${second}`,
    });
    expect(result.skills[0]?.description).toBe("first-copy");
    expect(result.shadowed).toEqual([{ name: "x", path: join(second, "dir-x", "SKILL.md") }]);
  });
});

describe("discoverSkills: posture and validation wiring", () => {
  it("the skill name comes from frontmatter, not the directory name", async () => {
    const ws = temp("ws-naming");
    makeSkill(join(ws, "skills"), "totally-different-dir", "frontmatter-name");
    const result = await discoverSkills({ workspaceRoot: ws, env: { HOME: temp("home-n") } });
    expect(result.skills.map((skill) => skill.name)).toEqual(["frontmatter-name"]);
    expect(result.skills[0]?.dir).toBe(join(ws, "skills", "totally-different-dir"));
  });

  it("an invalid skill is excluded and reported with file + key (loud, never silently loaded)", async () => {
    const ws = temp("ws-invalid");
    makeSkill(join(ws, "skills"), "good", "good-skill");
    const bad = makeSkill(join(ws, "skills"), "bad", "bad-skill", {
      text: "---\nname: bad-skill\ndescription: d\nallowedTools: bash\n---\nbody\n",
    });
    const result = await discoverSkills({ workspaceRoot: ws, env: { HOME: temp("home-i") } });
    expect(result.skills.map((skill) => skill.name)).toEqual(["good-skill"]);
    expect(result.problems).toEqual([
      {
        path: bad,
        key: "allowedTools",
        message: expect.stringContaining("unknown frontmatter key"),
      },
    ]);
  });

  it("an existing-but-unreadable SKILL.md is a loud (file) problem (seam-injected)", async () => {
    const ws = temp("ws-unreadable");
    const target = makeSkill(join(ws, "skills"), "locked", "locked-skill");
    const result = await discoverSkills({
      workspaceRoot: ws,
      env: { HOME: temp("home-u") },
      fs: {
        readFile: (path) =>
          path === target
            ? Promise.reject(new Error("EACCES: permission denied"))
            : Promise.resolve(""),
      },
    });
    // The readFile seam returns "" for other files, so only the locked skill
    // produces a meaningful outcome here: a (file) problem naming the path.
    expect(result.problems).toEqual([
      { path: target, key: "(file)", message: expect.stringContaining("EACCES") },
    ]);
  });

  it("an oversized SKILL.md exceeds the byte cap loudly (seam-injected)", async () => {
    const ws = temp("ws-oversize");
    const target = makeSkill(join(ws, "skills"), "big", "big-skill");
    const result = await discoverSkills({
      workspaceRoot: ws,
      env: { HOME: temp("home-b") },
      fs: {
        readFile: (path) => Promise.resolve(path === target ? "x".repeat(256 * 1024 + 1) : "x"),
      },
    });
    expect(result.problems).toEqual([
      {
        path: target,
        key: "(file)",
        message: expect.stringContaining("exceeds the 262144-byte cap"),
      },
    ]);
  });

  it("subdirectories without SKILL.md|skill.md and plain files in roots are ignored", async () => {
    const ws = temp("ws-noise");
    const skills = join(ws, "skills");
    mkdirSync(join(skills, "not-a-skill"), { recursive: true });
    writeFileSync(join(skills, "not-a-skill", "README.md"), "no skill file here\n");
    writeFileSync(join(skills, "loose-file.md"), "loose\n");
    const good = makeSkill(skills, "real", "real-skill");
    const result = await discoverSkills({ workspaceRoot: ws, env: { HOME: temp("home-g") } });
    expect(result.skills.map((skill) => skill.path)).toEqual([good]);
    expect(result.problems).toEqual([]);
    expect(result.shadowed).toEqual([]);
  });

  it("subdirectories are scanned in name order (deterministic output)", async () => {
    const ws = temp("ws-sorted");
    const skills = join(ws, "skills");
    for (const name of ["zeta", "alpha", "mid"]) {
      makeSkill(skills, name, name);
    }
    const result = await discoverSkills({ workspaceRoot: ws, env: { HOME: temp("home-s") } });
    expect(result.skills.map((skill) => skill.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("empty workspace and absent roots discover nothing, never throw", async () => {
    const result = await discoverSkills({
      workspaceRoot: temp("ws-empty"),
      env: { HOME: temp("home-e") },
    });
    expect(result.skills).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.shadowed).toEqual([]);
    expect(result.roots.length).toBeGreaterThan(0); // user root always listed (missing)
    expect(result.roots.every((root) => !root.found)).toBe(true);
  });
});

describe("expandTilde", () => {
  it("expands ~ and ~/…, leaves everything else alone", () => {
    expect(expandTilde("~", { HOME: "/h" })).toBe("/h");
    expect(expandTilde("~/skills", { HOME: "/h" })).toBe(join("/h", "skills"));
    expect(expandTilde("/abs", { HOME: "/h" })).toBe("/abs");
    expect(expandTilde("rel", { HOME: "/h" })).toBe("rel");
    expect(expandTilde("~other", { HOME: "/h" })).toBe("~other"); // only the user's own ~
    expect(expandTilde("~", {}, () => "/fallback-home")).toBe("/fallback-home");
  });
});

describe("listSkillResources", () => {
  it("lists bundled files recursively, excluding the skill file, sorted", async () => {
    const dir = temp("res");
    writeFileSync(join(dir, "SKILL.md"), "---\nname: r\ndescription: d\n---\nbody\n");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh\n");
    writeFileSync(join(dir, "notes.md"), "notes\n");
    const resources = await listSkillResources(dir);
    expect(resources.files).toEqual(["notes.md", "scripts/run.sh"]);
    expect(resources.truncated).toBe(false);
  });

  it("caps the listing at the documented entry count with a truncation flag", async () => {
    const dir = temp("res-many");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i <= MAX_RESOURCE_ENTRIES; i += 1) {
      writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.txt`), "x");
    }
    const resources = await listSkillResources(dir);
    expect(resources.files).toHaveLength(MAX_RESOURCE_ENTRIES);
    expect(resources.truncated).toBe(true);
  });

  it("never follows directory symlinks (cycle safety)", async () => {
    const dir = temp("res-link");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "deep.txt"), "x");
    symlinkSync(dir, join(dir, "loop"));
    const resources = await listSkillResources(dir);
    expect(resources.files).toEqual(["sub/deep.txt"]);
  });
});
