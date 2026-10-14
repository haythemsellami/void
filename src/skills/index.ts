/**
 * `src/skills` — SKILL.md discovery, validation, and rendering (ADR-0012,
 * roadmap WS2 P1). Public surface: the validator (pure text → skill |
 * problems), the root discovery walk (first-wins per name across workspace /
 * user / `skills.path` tiers), the bounded resource listing, output
 * renderers, and {@link loadSkillsContext} — the one-call loader the CLI
 * composes into runs.
 */

export type {
  DirEntry,
  DiscoveredSkill,
  DiscoverSkillsOptions,
  InvalidSkill,
  ShadowedSkill,
  SkillProblem,
  SkillSource,
  SkillsDiscoveryResult,
  SkillsFsSeams,
  SkillsRoot,
} from "./discover";
export {
  discoverSkills,
  expandTilde,
  listSkillResources,
  MAX_RESOURCE_ENTRIES,
} from "./discover";
export { formatSkillsProblems, renderSkillsList, skillsPromptSection } from "./render";
export type { ParsedSkill, SkillParseProblem, SkillParseResult } from "./validate";
export {
  MAX_SKILL_BYTES,
  parseSkillDocument,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
  SKILL_NAME_PATTERN,
  skillByteLength,
} from "./validate";

import type { DiscoverSkillsOptions, SkillsDiscoveryResult } from "./discover";
import { discoverSkills } from "./discover";

/**
 * The run-shaped bundle the CLI hands to `runTask`: the discovery OPTIONS
 * (the lazy `skill`/`reload_skills` tools rescan with them) plus the result
 * the run started from (prompt list + problems). One discovery pass feeds
 * the prompt section, the tool registration decision, and the loud-failure
 * check — nothing is discovered twice.
 */
export interface SkillsRunContext {
  readonly options: DiscoverSkillsOptions;
  readonly discovered: SkillsDiscoveryResult;
}

/** Discover once and wrap: the composition helper behind `runTask` wiring. */
export async function loadSkillsContext(options: DiscoverSkillsOptions): Promise<SkillsRunContext> {
  return { options, discovered: await discoverSkills(options) };
}
