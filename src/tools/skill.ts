/**
 * `skill` and `reload_skills` builtins (ADR-0012 lazy injection): the model
 * sees ONLY the name+description list in the system prompt; bodies load on
 * demand through these tools.
 *
 * - `skill` `{name}`: fresh discovery over the SAME root options the run
 *   started with (so a `reload_skills` from an earlier round makes newly
 *   added skills loadable), pick the first valid skill with that name,
 *   return its body plus its bundled resource listing as the tool result.
 *   The model then follows the returned instructions.
 * - `reload_skills` `{}`: fresh discovery, return the current list
 *   (names + descriptions + source paths) and any validation problems.
 *
 * Both are read-only local context operations: no sandbox, no network, no
 * writes — the permission defaults allow them outright (like read_file /
 * grep / glob). Expected failures return structured ToolResults (never
 * throw); results are clipped through the standard OutputLimits.
 *
 * Error results carry the message as TEXT content as well as the structured
 * error: the provider wire format forwards only content blocks (the
 * structured error stays local), and a model that asked for a skill it
 * cannot load must be able to READ why — otherwise the lazy-injection
 * contract breaks on its error path.
 */

import { dirname } from "node:path";
import type {
  ToolContext,
  ToolErrorCode,
  ToolInput,
  ToolResult,
  ToolSpec,
} from "../contracts/tools";
import type { DiscoveredSkill, DiscoverSkillsOptions } from "../skills";
import { discoverSkills, listSkillResources } from "../skills";
import { formatSkillsProblems } from "../skills/render";
import { clipToOutputLimit, textResult } from "./paths";

/** The two specs, built over one discovery-options object. */
export interface SkillTools {
  readonly skill: ToolSpec;
  readonly reloadSkills: ToolSpec;
}

/** Structured error WITH provider-visible text content (see module note). */
function loudToolError(code: ToolErrorCode, message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, retryable: false },
  };
}

/** Render the `skill` tool result: header, resources, then the body verbatim. */
function renderSkillResult(skill: DiscoveredSkill, resources: readonly string[]): string {
  const lines: string[] = [`# Skill: ${skill.name}`, `Source: ${skill.path}`, ""];
  if (resources.length > 0) {
    lines.push(
      `Resources live under ${dirname(skill.path)} — read_file resolves relative paths against the WORKSPACE root, so join with the Source directory above:`,
      ...resources.map((file) => `- ${file}`),
      "",
    );
  }
  lines.push(skill.body.trimEnd());
  return lines.join("\n");
}

/** Render the `reload_skills` result: the fresh discovery state. */
function renderReloadResult(
  skills: readonly DiscoveredSkill[],
  problems: readonly string[],
  shadowed: readonly string[],
  roots: readonly string[],
): string {
  const lines: string[] = [];
  if (skills.length === 0) {
    lines.push("No skills discovered. Roots scanned (first-wins order):");
  } else {
    lines.push(`${skills.length} skill(s) discovered:`);
  }
  for (const skill of skills) {
    lines.push(`- ${skill.name} — ${skill.description} (${skill.path})`);
  }
  if (problems.length > 0) {
    lines.push("", "Validation problems (these skills are NOT loadable):");
    lines.push(...problems);
  }
  if (shadowed.length > 0) {
    lines.push("", "Shadowed by an earlier same-name skill (ignored):");
    lines.push(...shadowed);
  }
  if (skills.length === 0) {
    lines.push(...roots.map((root) => `- ${root}`));
  }
  return lines.join("\n");
}

/**
 * Build the lazy-injection pair over one {@link DiscoverSkillsOptions}.
 * Every execute re-scans with those options — cheap (a handful of small
 * directories) and always consistent with what `reload_skills` reports.
 */
export function createSkillTools(options: DiscoverSkillsOptions): SkillTools {
  const skill: ToolSpec = {
    name: "skill",
    description:
      "Load one skill's full instructions by name. The system prompt lists the " +
      "installed skills (name — description) but not their bodies; calling this " +
      "tool with the exact name returns the skill's instructions plus its " +
      "bundled resource files, which you then follow for the task at hand.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'The skill name exactly as listed (e.g. "commit-style").',
        },
      },
      required: ["name"],
    },
    source: "builtin",
    async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
      const name = input.name;
      if (typeof name !== "string" || name.length === 0) {
        return loudToolError("invalid_input", "name must be a non-empty string");
      }
      const discovery = await discoverSkills(options);
      const match = discovery.skills.find((skill) => skill.name === name);
      if (match === undefined) {
        // Loud over silent: a candidate that EXISTS under this name but is
        // invalid fails with file + key + problem (never a bare not-found,
        // which would read as "wrong name" instead of "broken skill").
        const broken = discovery.invalid.find((entry) => entry.name === name);
        if (broken !== undefined) {
          const detail = broken.problems
            .map((problem) => `${problem.key}: ${problem.message}`)
            .join("; ");
          return loudToolError(
            "invalid_input",
            `skill ${JSON.stringify(name)} at ${broken.path} failed validation — ${detail}`,
          );
        }
        const known =
          discovery.skills.length === 0
            ? "no skills are currently discovered (try reload_skills)"
            : `discovered skills: ${discovery.skills.map((s) => s.name).join(", ")}`;
        return loudToolError("not_found", `no skill named ${JSON.stringify(name)} — ${known}`);
      }
      const resources = await listSkillResources(match.dir, options.fs);
      const resourceList = resources.truncated
        ? [...resources.files, `… more than ${resources.files.length} resource entries omitted`]
        : resources.files;
      const text = renderSkillResult(match, resourceList);
      const clipped = clipToOutputLimit(text, ctx.outputLimits);
      return textResult(clipped.text, clipped.truncated);
    },
  };

  const reloadSkills: ToolSpec = {
    name: "reload_skills",
    description:
      "Rescan all configured skill roots and return the fresh skill list " +
      "(names, descriptions, source paths) plus any validation problems. Use " +
      "this when skills may have been added, removed, or edited since the run " +
      "started; newly listed skills are then loadable via the skill tool.",
    inputSchema: { type: "object", properties: {} },
    source: "builtin",
    async execute(_input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
      const discovery = await discoverSkills(options);
      const text = renderReloadResult(
        discovery.skills,
        formatSkillsProblems(discovery.problems),
        discovery.shadowed.map((entry) => `- ${entry.name} (${entry.path})`),
        discovery.roots.filter((root) => root.found).map((root) => root.path),
      );
      const clipped = clipToOutputLimit(text, ctx.outputLimits);
      return textResult(clipped.text, clipped.truncated);
    },
  };

  return { skill, reloadSkills };
}
