/**
 * Loader tests: precedence (user < workspace < env shadows), the amended
 * permission-rule merge order (workspace rules FIRST, then user), pinned
 * nested defaults, per-name mcpServers merge, provenance, and the failure
 * policy (missing never fatal; existing-but-broken = loud problem, layer
 * excluded, no JSONC-twin fallback). All I/O through injected seams.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundSettingsFile } from "./discover";
import { userSettingsDir } from "./discover";
import { type LoadSettingsOptions, loadSettings } from "./load";

const XDG = "/xdg";
const USER_DIR = join(XDG, "void");
const USER_JSON = join(USER_DIR, "settings.json");
const WS = "/ws";
const WS_VOID = join(WS, ".void");
const WS_JSON = join(WS_VOID, "settings.json");
const WS_JSONC = join(WS_VOID, "settings.jsonc");

/** Minimal fake filesystem: path → file body. */
function fakeFs(files: Readonly<Record<string, string>>): {
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => boolean;
} {
  return {
    readFile: (path) =>
      files[path] !== undefined
        ? Promise.resolve(files[path])
        : Promise.reject(new Error(`ENOENT: ${path}`)),
    exists: (path) => files[path] !== undefined,
  };
}

interface Harness {
  readonly files: Record<string, string>;
  readonly logs: string[];
  readonly load: (
    env?: Record<string, string | undefined>,
    cwd?: string,
  ) => ReturnType<typeof loadSettings>;
}

function makeHarness(initial: Readonly<Record<string, string>> = {}): Harness {
  const files: Record<string, string> = { ...initial };
  const logs: string[] = [];
  const fs = fakeFs(files);
  const load = (
    env: Record<string, string | undefined> = { XDG_CONFIG_HOME: XDG },
    cwd: string = WS,
  ) =>
    loadSettings({
      env,
      cwd,
      readFile: fs.readFile,
      exists: fs.exists,
      log: (line) => {
        logs.push(line);
      },
    });
  return { files, logs, load };
}

const RULE = (tool: string, action: "allow" | "reject" = "allow") =>
  JSON.stringify({ tool, matches: "*", action });

describe("loadSettings: discovery sanity", () => {
  it("missing files are never fatal: empty effective, no problems, canonical paths reported", async () => {
    const { load } = makeHarness();
    const result = await load();
    expect(result.problems).toEqual([]);
    expect(result.effective).toEqual({ settingsVersion: 1 });
    expect(result.layers.user).toEqual({
      scope: "user",
      found: undefined,
      canonicalPath: `${userSettingsDir({ XDG_CONFIG_HOME: XDG })}/settings.json`,
    });
    expect(result.layers.workspace.canonicalPath).toBe(WS_JSON);
    expect(result.provenance).toEqual([]);
  });

  it("finds the user file in $XDG_CONFIG_HOME/void and the workspace file at cwd", async () => {
    const { load } = makeHarness({
      [USER_JSON]: '{"settingsVersion":1,"defaultModel":"user/m"}',
      [WS_JSON]: '{"settingsVersion":1,"defaultModel":"ws/m"}',
    });
    const result = await load();
    expect(result.layers.user.found?.path).toBe(USER_JSON);
    expect(result.layers.workspace.found?.path).toBe(WS_JSON);
    expect(result.effective.defaultModel).toBe("ws/m"); // workspace wins
  });
});

describe("loadSettings: precedence", () => {
  it("workspace overrides user for every scalar/leaf key", async () => {
    const { load } = makeHarness({
      [USER_JSON]:
        '{"settingsVersion":1,"defaultModel":"user/m","providerTimeoutMs":1000,' +
        '"skills":{"path":"/u/s"},"compaction":{"thresholdPercent":10,"keepTurns":5},' +
        '"asyncShell":{"maxLifetimeMs":60000}}',
      [WS_JSON]:
        '{"settingsVersion":1,"defaultModel":"ws/m","providerTimeoutMs":2000,' +
        '"skills":{"path":"/w/s"},"compaction":{"thresholdPercent":80},' +
        '"asyncShell":{"maxLifetimeMs":120000}}',
    });
    const result = await load();
    expect(result.effective.defaultModel).toBe("ws/m");
    expect(result.effective.providerTimeoutMs).toBe(2000);
    expect(result.effective.skills?.path).toBe("/w/s");
    expect(result.effective.compaction).toEqual({ thresholdPercent: 80, keepTurns: 5 }); // user keepTurns survives
    expect(result.effective.asyncShell).toEqual({ maxLifetimeMs: 120000 });
  });

  it("the env shadow beats both file layers; empty string means unset", async () => {
    const { load } = makeHarness({
      [WS_JSON]: '{"settingsVersion":1,"defaultModel":"ws/m"}',
    });
    const withEnv = await load({ XDG_CONFIG_HOME: XDG, VOID_DEFAULT_MODEL: "env/m" });
    expect(withEnv.effective.defaultModel).toBe("env/m");
    expect(withEnv.provenance).toContainEqual({
      key: "defaultModel",
      source: "env",
      envKey: "VOID_DEFAULT_MODEL",
    });

    const emptyEnv = await load({ XDG_CONFIG_HOME: XDG, VOID_DEFAULT_MODEL: "" });
    expect(emptyEnv.effective.defaultModel).toBe("ws/m"); // empty = unset
  });

  it("AMENDED order: effective.permissions = [workspace rules, then user rules]", async () => {
    const { load } = makeHarness({
      [USER_JSON]: `{"settingsVersion":1,"permissions":[${RULE("user-tool")},${RULE("shared")}]}`,
      [WS_JSON]: `{"settingsVersion":1,"permissions":[${RULE("ws-tool")}]}`,
    });
    const result = await load();
    expect(result.effective.permissions?.map((rule) => rule.tool)).toEqual([
      "ws-tool",
      "user-tool",
      "shared",
    ]);
    const perm = result.provenance.find((entry) => entry.key === "permissions");
    expect(perm?.contributors?.map((c) => c.layer)).toEqual(["workspace", "user"]);
  });

  it("mcpServers merge per name: workspace entry replaces the user entry with the same name", async () => {
    const { load } = makeHarness({
      [USER_JSON]:
        '{"settingsVersion":1,"mcpServers":{"a":{"command":"user-a"},"b":{"command":"user-b"}}}',
      [WS_JSON]:
        '{"settingsVersion":1,"mcpServers":{"b":{"command":"ws-b"},"c":{"command":"ws-c"}}}',
    });
    const result = await load();
    expect(result.effective.mcpServers).toEqual({
      a: { command: "user-a" },
      b: { command: "ws-b" },
      c: { command: "ws-c" },
    });
  });

  it("pinned nested defaults materialize when a block is present and omit nothing when absent", async () => {
    const { load } = makeHarness({
      [USER_JSON]: '{"settingsVersion":1,"compaction":{"thresholdPercent":90},"asyncShell":{}}',
    });
    const result = await load();
    expect(result.effective.compaction).toEqual({ thresholdPercent: 90, keepTurns: 2 });
    expect(result.effective.asyncShell).toEqual({ maxLifetimeMs: 1_800_000 });

    const bare = await makeHarness({ [WS_JSON]: '{"settingsVersion":1}' }).load();
    expect(bare.effective.compaction).toBeUndefined();
    expect(bare.effective.asyncShell).toBeUndefined();
  });

  it("JSONC files parse with comments and log the fallback notice", async () => {
    const { load, logs } = makeHarness({
      [WS_JSONC]: '{\n  // schema version\n  "settingsVersion": 1,\n  "defaultModel": "ws/m"\n}',
    });
    const result = await load();
    expect(result.problems).toEqual([]);
    expect(result.effective.defaultModel).toBe("ws/m");
    expect(result.layers.workspace.found?.format).toBe("jsonc");
    expect(logs.join("\n")).toContain(`JSONC settings at ${WS_JSONC}`);
  });

  it("JSON beats JSONC when both exist — and a broken JSON file never falls back to its JSONC twin", async () => {
    const { load } = makeHarness({
      [WS_JSON]: '{"settingsVersion":1, BROKEN',
      [WS_JSONC]: '{"settingsVersion":1,"defaultModel":"jsonc/m"}',
    });
    const result = await load();
    // The JSON file was chosen (it exists) and is loudly broken; the JSONC
    // twin is ignored — never a silent fallback (ADR-0006 amendment).
    expect(result.layers.workspace.found?.path).toBe(WS_JSON);
    expect(result.effective.defaultModel).toBeUndefined();
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]?.key).toBe("(syntax)");
  });
});

describe("loadSettings: failure policy", () => {
  it("schema-invalid file: problems name file + key + problem, layer excluded, other layer still merges", async () => {
    const { load } = makeHarness({
      [USER_JSON]: '{"settingsVersion":1,"frobnicate":true,"defaultModel":"user/m"}',
      [WS_JSON]: '{"settingsVersion":1,"defaultModel":"ws/m"}',
    });
    const result = await load();
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems[0]?.path).toBe(USER_JSON);
    expect(result.problems[0]?.key).toBe("frobnicate");
    expect(result.problems[0]?.message).toContain("Unknown setting");
    // The invalid user layer contributes nothing (fail closed), workspace still applies.
    expect(result.effective.defaultModel).toBe("ws/m");
    expect(result.effective.skills).toBeUndefined();
  });

  it("syntactically broken user JSON is a loud (syntax) problem naming the file", async () => {
    const { load } = makeHarness({ [USER_JSON]: "{oops" });
    const result = await load();
    expect(result.problems[0]).toMatchObject({ path: USER_JSON, key: "(syntax)" });
    expect(result.effective).toEqual({ settingsVersion: 1 });
  });

  it("unreadable and oversized files become (file) problems, never throws", async () => {
    const options = (body: string): LoadSettingsOptions => ({
      env: { XDG_CONFIG_HOME: XDG },
      cwd: WS,
      exists: () => true,
      readFile: () => Promise.resolve(body),
    });
    const unreadable = await loadSettings({
      ...options("x"),
      readFile: () => Promise.reject(new Error("EACCES: permission denied")),
    });
    expect(unreadable.problems[0]).toMatchObject({ key: "(file)" });
    expect(unreadable.problems[0]?.message).toContain("could not read");

    const found: FoundSettingsFile = { path: USER_JSON, format: "json", jsoncFallback: false };
    expect(found.path).toBe(USER_JSON);
    const oversized = await loadSettings({ ...options("x".repeat(1024 * 1024 + 1)) });
    expect(oversized.problems.some((p) => p.message.includes("byte cap"))).toBe(true);
  });

  it("validation errors from BOTH files are collected", async () => {
    const { load } = makeHarness({
      [USER_JSON]: '{"settingsVersion":1,"badUser":1}',
      [WS_JSON]: '{"settingsVersion":1,"badWs":1}',
    });
    const result = await load();
    expect(result.problems.map((p) => p.path).sort()).toEqual([USER_JSON, WS_JSON].sort());
  });
});

describe("loadSettings: workspace walk integration", () => {
  it("a nested cwd finds the file at the git root level (real walk via fake fs)", async () => {
    const nested = join(WS, "a", "b");
    const { load } = makeHarness({
      [`${WS}/.git/HEAD`]: "ref: refs/heads/main\n",
      [WS_JSON]: '{"settingsVersion":1,"defaultModel":"root/m"}',
    });
    const result = await load({ XDG_CONFIG_HOME: XDG }, nested);
    expect(result.effective.defaultModel).toBe("root/m");
    expect(result.layers.workspace.found?.path).toBe(WS_JSON);
  });
});
