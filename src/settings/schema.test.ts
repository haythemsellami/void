/**
 * Settings schema validator tests: the full error matrix (unknown keys,
 * missing/wrong version, per-key type errors, nested mcpServers/skills/
 * compaction shapes) plus a maximal valid file round-trip. Every error must
 * name the offending key — the ADR-0006 contract for validation messages.
 */
import { describe, expect, it } from "vitest";
import type { SettingsValidationError } from "./schema";
import { SETTINGS_VERSION, validateSettings } from "./schema";

/** All errors as "key: message" strings for concise assertions. */
function problems(value: unknown): string[] {
  const result = validateSettings(value);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    return result.errors.map((error: SettingsValidationError) => `${error.key}: ${error.message}`);
  }
  throw new Error("unreachable");
}

describe("validateSettings", () => {
  it("accepts a maximal valid file and returns it typed", () => {
    const file = {
      settingsVersion: 1,
      permissions: [{ tool: "bash", matches: { command: "/^git status$/" }, action: "allow" }],
      defaultModel: "ollama/qwen3:14b",
      mcpServers: {
        fancy: { command: "npx", args: ["-y", "fancy-mcp"], env: { KEY: "v" } },
        plain: { command: "/usr/local/bin/plain-mcp" },
      },
      skills: { path: "/srv/skills" },
      providerTimeoutMs: 30_000,
      compaction: { thresholdPercent: 90, keepTurns: 4 },
      asyncShell: { maxLifetimeMs: 3_600_000 },
    };
    const result = validateSettings(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings).toEqual(file);
      expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
    }
  });

  it("accepts the minimal skeleton file", () => {
    const result = validateSettings({ settingsVersion: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings).toEqual({ settingsVersion: 1 });
    }
  });

  it("rejects non-object roots naming (root)", () => {
    expect(problems([])).toEqual(["(root): settings must be a JSON object"]);
    expect(problems("nope")).toEqual(["(root): settings must be a JSON object"]);
    expect(problems(null)).toEqual(["(root): settings must be a JSON object"]);
  });

  it("rejects unknown top-level keys with an Unknown setting error", () => {
    const messages = problems({ settingsVersion: 1, defaultModell: "typo", mcp: {} });
    expect(messages.some((m) => m.startsWith("defaultModell: Unknown setting"))).toBe(true);
    expect(messages.some((m) => m.startsWith("mcp: Unknown setting"))).toBe(true);
  });

  it("rejects nested unknown keys inside mcpServers, skills, and compaction", () => {
    expect(
      problems({ settingsVersion: 1, mcpServers: { s: { command: "x", typoo: 1 } } }),
    ).toContainEqual(expect.stringMatching(/^mcpServers\.s: Unknown setting "typoo"/));
    expect(problems({ settingsVersion: 1, skills: { path: "/s", extra: true } })).toContainEqual(
      expect.stringMatching(/^skills: Unknown setting "extra"/),
    );
    expect(
      problems({ settingsVersion: 1, compaction: { thresholdPercent: 50, mode: "auto" } }),
    ).toContainEqual(expect.stringMatching(/^compaction: Unknown setting "mode"/));
  });

  it("requires settingsVersion to be present and exactly 1", () => {
    expect(problems({})).toContainEqual(expect.stringMatching(/^settingsVersion: must be present/));
    expect(problems({ settingsVersion: 2 })).toContainEqual(
      expect.stringMatching(/^settingsVersion: must be the number 1/),
    );
    expect(problems({ settingsVersion: "1" })).toContainEqual(
      expect.stringMatching(/^settingsVersion: must be the number 1/),
    );
  });

  it("defaultModel must be a non-empty string", () => {
    expect(problems({ settingsVersion: 1, defaultModel: 7 })).toContainEqual(
      expect.stringMatching(/^defaultModel: must be a non-empty string/),
    );
    expect(problems({ settingsVersion: 1, defaultModel: "  " })).toContainEqual(
      expect.stringMatching(/^defaultModel: must be a non-empty string/),
    );
  });

  it("providerTimeoutMs must be a positive integer", () => {
    for (const bad of [0, -5, 1.5, "1000", true]) {
      expect(problems({ settingsVersion: 1, providerTimeoutMs: bad })).toContainEqual(
        expect.stringMatching(/^providerTimeoutMs: must be a positive integer/),
      );
    }
  });

  it("compaction.thresholdPercent must be an integer in 0..100", () => {
    for (const bad of [-1, 101, 50.5, "90", null]) {
      expect(
        problems({ settingsVersion: 1, compaction: { thresholdPercent: bad } }),
      ).toContainEqual(expect.stringMatching(/^compaction\.thresholdPercent: must be an integer/));
    }
    expect(problems({ settingsVersion: 1, compaction: {} })).toContainEqual(
      expect.stringMatching(/^compaction\.thresholdPercent: must be an integer/),
    );
  });

  it("compaction.keepTurns is a known key: optional positive int, omitted is valid", () => {
    expect(validateSettings({ settingsVersion: 1, compaction: { thresholdPercent: 50 } }).ok).toBe(
      true,
    );
    const good = validateSettings({
      settingsVersion: 1,
      compaction: { thresholdPercent: 50, keepTurns: 3 },
    });
    expect(good.ok && good.settings.compaction?.keepTurns).toBe(3);
    for (const bad of [0, -1, 2.5, "2"]) {
      expect(
        problems({ settingsVersion: 1, compaction: { thresholdPercent: 50, keepTurns: bad } }),
      ).toContainEqual(expect.stringMatching(/^compaction\.keepTurns: must be a positive integer/));
    }
  });

  it("asyncShell.maxLifetimeMs is a known key: positive int, 4h cap, omitted is valid", () => {
    expect(validateSettings({ settingsVersion: 1, asyncShell: {} }).ok).toBe(true);
    const good = validateSettings({ settingsVersion: 1, asyncShell: { maxLifetimeMs: 60_000 } });
    expect(good.ok && good.settings.asyncShell?.maxLifetimeMs).toBe(60_000);
    for (const bad of [0, -1, 1.5, "x", 14_400_001]) {
      expect(problems({ settingsVersion: 1, asyncShell: { maxLifetimeMs: bad } })).toContainEqual(
        expect.stringMatching(/^asyncShell\.maxLifetimeMs: must be a positive integer/),
      );
    }
    // Exactly at the cap is valid.
    expect(
      validateSettings({ settingsVersion: 1, asyncShell: { maxLifetimeMs: 14_400_000 } }).ok,
    ).toBe(true);
    expect(problems({ settingsVersion: 1, asyncShell: { maxLifetime: 1 } })).toContainEqual(
      expect.stringMatching(/^asyncShell: Unknown setting "maxLifetime"/),
    );
  });

  it("mcpServers shape errors name the server, field, and problem", () => {
    expect(problems({ settingsVersion: 1, mcpServers: [] })).toContainEqual(
      expect.stringMatching(/^mcpServers: must be an object/),
    );
    expect(problems({ settingsVersion: 1, mcpServers: { s: "x" } })).toContainEqual(
      expect.stringMatching(/^mcpServers\.s: must be an object/),
    );
    expect(problems({ settingsVersion: 1, mcpServers: { s: { args: [] } } })).toContainEqual(
      expect.stringMatching(/^mcpServers\.s\.command: must be a non-empty string/),
    );
    expect(
      problems({ settingsVersion: 1, mcpServers: { s: { command: "x", args: ["a", 2] } } }),
    ).toContainEqual(expect.stringMatching(/^mcpServers\.s\.args: must be an array of strings/));
    expect(
      problems({ settingsVersion: 1, mcpServers: { s: { command: "x", env: { K: 3 } } } }),
    ).toContainEqual(expect.stringMatching(/^mcpServers\.s\.env: must be an object mapping/));
  });

  it("permissions validation reuses the rules engine, keyed per rule index", () => {
    const messages = problems({
      settingsVersion: 1,
      permissions: [
        { tool: "bogus*middle", matches: "*", action: "allow" },
        { tool: "bash", matches: "*", action: "maybe" },
      ],
    });
    expect(messages.some((m) => m.startsWith("permissions[0]:"))).toBe(true);
    expect(messages).toContainEqual(
      expect.stringMatching(/^permissions\[1\]: rule\.action "maybe" is not one of/),
    );
  });

  it("permissions non-object entries are reported as rule objects, not engine garbage", () => {
    expect(problems({ settingsVersion: 1, permissions: ["not a rule", 3] })).toEqual([
      "permissions[0]: must be a permission rule object",
      "permissions[1]: must be a permission rule object",
    ]);
  });

  it("collects multiple problems in one pass (full report, not first error)", () => {
    const messages = problems({
      settingsVersion: 9,
      unknownKey: true,
      defaultModel: 5,
    });
    expect(messages.length).toBeGreaterThanOrEqual(3);
  });
});
