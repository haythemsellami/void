/**
 * Renderer + edit-skeleton tests: the exact line/byte formats the CLI prints
 * and writes (ADR-0006: skeleton content is exactly `{"settingsVersion":1}`).
 */
import { describe, expect, it } from "vitest";
import { ensureSettingsFile, SETTINGS_SKELETON } from "./edit";
import type { SettingsLoadResult } from "./load";
import { formatSettingsProblems, renderSettingsEffective, renderSettingsPaths } from "./render";

const BASE: SettingsLoadResult = {
  effective: { settingsVersion: 1 },
  layers: {
    user: { scope: "user", found: undefined, canonicalPath: "/u/.config/void/settings.json" },
    workspace: { scope: "workspace", found: undefined, canonicalPath: "/ws/.void/settings.json" },
  },
  provenance: [],
  problems: [],
};

describe("renderSettingsPaths", () => {
  it("prints both layers with existence", () => {
    expect(renderSettingsPaths(BASE)).toEqual([
      "user:      /u/.config/void/settings.json — missing",
      "workspace: /ws/.void/settings.json — missing",
    ]);
  });

  it("shows the found file (including JSONC fallback) instead of the canonical path", () => {
    const result: SettingsLoadResult = {
      ...BASE,
      layers: {
        user: {
          scope: "user",
          found: { path: "/u/.config/void/settings.json", format: "json", jsoncFallback: false },
          canonicalPath: "/u/.config/void/settings.json",
        },
        workspace: {
          scope: "workspace",
          found: { path: "/ws/.void/settings.jsonc", format: "jsonc", jsoncFallback: true },
          canonicalPath: "/ws/.void/settings.json",
        },
      },
    };
    expect(renderSettingsPaths(result)).toEqual([
      "user:      /u/.config/void/settings.json — found",
      "workspace: /ws/.void/settings.jsonc — found (JSONC fallback)",
    ]);
  });
});

describe("renderSettingsEffective", () => {
  it("emits pretty JSON; with no layers set there are no provenance lines", () => {
    const lines = renderSettingsEffective(BASE);
    expect(lines[0]).toBe("{");
    expect(lines.join("\n")).toBe(JSON.stringify(BASE.effective, null, 2));
  });

  it("appends provenance comment lines after a blank line", () => {
    const result: SettingsLoadResult = {
      ...BASE,
      effective: {
        settingsVersion: 1,
        defaultModel: "env/m",
        permissions: [{ tool: "bash", matches: "*", action: "allow" }],
      },
      provenance: [
        { key: "defaultModel", source: "env", envKey: "VOID_DEFAULT_MODEL" },
        {
          key: "permissions",
          source: "workspace",
          contributors: [
            { layer: "workspace", path: "/ws/.void/settings.json" },
            { layer: "user", path: "/u/settings.json" },
          ],
        },
      ],
    };
    const text = renderSettingsEffective(result).join("\n");
    expect(text).toContain("# defaultModel: VOID_DEFAULT_MODEL");
    expect(text).toContain(
      "# permissions: workspace (/ws/.void/settings.json) + user (/u/settings.json)",
    );
    expect(text).toContain('"defaultModel": "env/m"');
  });
});

describe("formatSettingsProblems", () => {
  it("names file, key, and problem on each line", () => {
    expect(
      formatSettingsProblems([
        { path: "/p/settings.json", key: "frobnicate", message: 'Unknown setting "frobnicate"' },
      ]),
    ).toEqual(['void: /p/settings.json: frobnicate: Unknown setting "frobnicate"']);
  });
});

describe("ensureSettingsFile", () => {
  it("creates parent dirs and writes the EXACT skeleton, reporting created", async () => {
    expect(SETTINGS_SKELETON).toBe('{"settingsVersion":1}');
    const ops: { dir: string; file: string; data: string }[] = [];
    const result = await ensureSettingsFile("/xdg/void/settings.json", {
      mkdir: async (dir) => {
        ops.push({ dir, file: "", data: "" });
      },
      writeFile: async (file, data) => {
        ops.push({ dir: "", file, data });
      },
    });
    expect(result.created).toBe(true);
    expect(ops[0]?.dir).toBe("/xdg/void");
    expect(ops[1]?.file).toBe("/xdg/void/settings.json");
    expect(ops[1]?.data).toBe('{"settingsVersion":1}');
  });

  it("EEXIST means the file was already there: created=false, no throw", async () => {
    const eexist = new Error("exists") as NodeJS.ErrnoException;
    eexist.code = "EEXIST";
    const result = await ensureSettingsFile("/x/settings.json", {
      mkdir: async () => {},
      writeFile: () => Promise.reject(eexist),
    });
    expect(result.created).toBe(false);
  });

  it("other write errors propagate for the CLI to report", async () => {
    const denied = new Error("EACCES") as NodeJS.ErrnoException;
    denied.code = "EACCES";
    await expect(
      ensureSettingsFile("/x/settings.json", {
        mkdir: async () => {},
        writeFile: () => Promise.reject(denied),
      }),
    ).rejects.toThrow("EACCES");
  });
});
