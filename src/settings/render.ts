/**
 * `src/settings/render` — pure output formatting for the `void settings`
 * subcommands (ADR-0006 UX: `path` prints both layers + existence, `effective`
 * prints the merged view plus provenance comment lines — the transparency
 * pattern). Returns LINES; the CLI owns the
 * stdout/stderr sinks. No filesystem, no env — everything comes from a
 * {@link SettingsLoadResult}.
 */
import type { KeyProvenance, SettingsLoadResult, SettingsProblem } from "./load";

/** `void settings path`: one line per layer, path + existence (+ fallback). */
export function renderSettingsPaths(result: SettingsLoadResult): string[] {
  const line = (scope: string, info: SettingsLoadResult["layers"]["user"]): string => {
    const path = info.found?.path ?? info.canonicalPath;
    const state =
      info.found === undefined
        ? "missing"
        : info.found.jsoncFallback
          ? "found (JSONC fallback)"
          : "found";
    return `${scope.padEnd(11)}${path} — ${state}`;
  };
  return [line("user:", result.layers.user), line("workspace:", result.layers.workspace)];
}

/** One provenance entry → one comment line (`# key: source (where)`). */
function provenanceLine(entry: KeyProvenance): string {
  const where =
    entry.source === "env"
      ? (entry.envKey ?? "env")
      : entry.contributors !== undefined
        ? entry.contributors.map((c) => `${c.layer} (${c.path})`).join(" + ")
        : `${entry.source} (${entry.path ?? "?"})`;
  return `# ${entry.key}: ${where}`;
}

/** `void settings effective`: pretty JSON + blank line + provenance comments. */
export function renderSettingsEffective(result: SettingsLoadResult): string[] {
  const lines = JSON.stringify(result.effective, null, 2).split("\n");
  if (result.provenance.length > 0) {
    lines.push("", "# provenance (user < workspace < env; permission rules merge workspace-first)");
    for (const entry of result.provenance) {
      lines.push(provenanceLine(entry));
    }
  }
  return lines;
}

/** Structured problem lines (stderr): `void: <path>: <key>: <message>`. */
export function formatSettingsProblems(problems: readonly SettingsProblem[]): string[] {
  return problems.map((problem) => `void: ${problem.path}: ${problem.key}: ${problem.message}`);
}
