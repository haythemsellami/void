/**
 * `src/skills/render` — pure output formatting for the skills surfaces
 * (ADR-0012), in the exact pattern of `settings/render.ts`: returns LINES;
 * the CLI owns the stdout/stderr sinks. No filesystem, no env.
 *
 * - {@link skillsPromptSection}: the system-prompt section — names and
 *   descriptions ONLY (lazy injection by design; bodies load through the
 *   `skill` tool).
 * - {@link renderSkillsList}: `void skills list` (roots, valid skills,
 *   problems, shadowed).
 * - {@link formatSkillsProblems}: structured stderr lines, the same
 *   `void: <path>: <key>: <message>` shape as settings problems.
 */
import type { DiscoveredSkill, SkillProblem, SkillsDiscoveryResult } from "./discover";

/**
 * The skills section appended to the assembled system prompt. Deliberately
 * contains ONLY name + description per skill (ADR-0012: default context
 * stays small; the `skill` tool loads bodies on demand).
 */
export function skillsPromptSection(skills: readonly DiscoveredSkill[]): string {
  const lines: string[] = [
    "# Skills",
    "",
    "Installed skills, listed as `name` — description. Skill bodies are NOT included here:",
    "to use a skill, call the `skill` tool with its exact `name`; the tool returns the skill's",
    "full instructions (plus its bundled resource files), which you then follow. Call",
    "`reload_skills` to rescan the roots when skills may have changed.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name} — ${skill.description}`);
  }
  return lines.join("\n");
}

/** Structured problem lines (stderr): `void: <path>: <key>: <message>`. */
export function formatSkillsProblems(problems: readonly SkillProblem[]): string[] {
  return problems.map((problem) => `void: ${problem.path}: ${problem.key}: ${problem.message}`);
}

/** `void skills list`: the full discovery map, always complete (never throws). */
export function renderSkillsList(result: SkillsDiscoveryResult): string[] {
  const lines: string[] = ["Skills roots (in first-wins order):"];
  if (result.roots.length === 0) {
    lines.push("  (none)");
  }
  for (const root of result.roots) {
    lines.push(`  ${root.label.padEnd(16)}${root.path}${root.found ? "" : " (missing)"}`);
  }

  lines.push("", `Skills (${result.skills.length} valid):`);
  if (result.skills.length === 0) {
    lines.push("  (none)");
  }
  const nameWidth = Math.max(...result.skills.map((skill) => skill.name.length), 4);
  for (const skill of result.skills) {
    lines.push(`  ${skill.name.padEnd(nameWidth)}  ${skill.source.padEnd(13)}  ${skill.path}`);
  }

  if (result.problems.length > 0) {
    lines.push("", "Invalid (loud — runs fail until fixed):");
    for (const line of formatSkillsProblems(result.problems)) {
      lines.push(`  ${line.replace(/^void: /, "")}`);
    }
  }
  if (result.shadowed.length > 0) {
    lines.push("", "Shadowed (later same-name duplicates, ignored):");
    for (const entry of result.shadowed) {
      lines.push(`  ${entry.name}  ${entry.path}`);
    }
  }
  return lines;
}
