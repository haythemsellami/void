/**
 * `src/skills/validate` — SKILL.md parsing and validation (ADR-0012).
 *
 * Format: a directory containing `SKILL.md` (or `skill.md`) whose body is
 * `---`-delimited YAML frontmatter followed by the instruction payload.
 * The frontmatter is parsed with hand-rolled YAML-lite — flat `key: value`
 * lines only, exactly the two keys ADR-0012 defines:
 *
 * - `name`        — REQUIRED, at most 64 characters, matching /^[a-z0-9-]+$/
 *                   (lowercase letters, digits, hyphens).
 * - `description` — REQUIRED, at most 300 characters.
 *
 * Anything else is rejected LOUDLY (same posture as `settings/schema`):
 * unknown keys, nested/indented values, malformed lines, duplicate keys,
 * missing fields, oversized values, and an empty body each produce a
 * structured problem naming the key. A malformed skill never silently
 * loads — callers turn any problem into a loud failure.
 *
 * The regex discipline for the `---` fences is shared with
 * `src/context/agents-md.ts` (BOM-tolerant, CRLF-tolerant, one leading
 * newline after the closing fence stripped). This module is pure: it never
 * touches the filesystem and does not know file paths — the discoverer
 * (`src/skills/discover.ts`) attaches the source path to problems.
 */
import { Buffer } from "node:buffer";

/** Maximum length of the frontmatter `name` (ADR-0012). */
export const SKILL_NAME_MAX_CHARS = 64;

/** Maximum length of the frontmatter `description` (ADR-0012). */
export const SKILL_DESCRIPTION_MAX_CHARS = 300;

/** The only charset a skill `name` may use (ADR-0012 slug). */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Hard cap on one SKILL.md file, in bytes — same order as settings'
 * `MAX_SETTINGS_BYTES`. A skill body is injected into the conversation via
 * the `skill` tool result, so pathological files fail loudly at discovery
 * instead of being lugged around.
 */
export const MAX_SKILL_BYTES = 256 * 1024;

/** The complete allowed frontmatter key set (additive only via ADR). */
const FRONTMATTER_KEYS: ReadonlySet<string> = new Set(["name", "description"]);

/** One validation problem, path-agnostic (the discoverer prefixes the path). */
export interface SkillParseProblem {
  /** Frontmatter key (`name`, `description`, the unknown key), `(frontmatter)`, or `(body)`. */
  readonly key: string;
  readonly message: string;
}

/** A validated SKILL.md: identity fields plus the instruction payload. */
export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** Result of {@link parseSkillDocument}: a full report, never first-error. */
export type SkillParseResult =
  | { readonly ok: true; readonly skill: ParsedSkill }
  | {
      readonly ok: false;
      readonly problems: readonly SkillParseProblem[];
      /**
       * Whatever identity fields still parsed (for failure REPORTING only —
       * e.g. the `skill` tool matching a by-now-invalid skill by name so its
       * error can name the file and key). Never a loadable skill.
       */
      readonly partial: { readonly name?: string; readonly description?: string };
    };

/** Byte length of `text` in UTF-8 (size cap for {@link MAX_SKILL_BYTES}). */
export function skillByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Opening `---` fence: BOM-tolerant, optional trailing spaces, CRLF-tolerant. */
const OPEN_FENCE = /^(?:\uFEFF)?---[ \t]*\r?\n/;

/** Closing `---` fence: own line, optional trailing spaces, or end of file. */
const CLOSE_FENCE = /^---[ \t]*(?:\r?\n|$)/m;

/** Strip ONE matching pair of surrounding single or double quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse and validate one SKILL.md document (frontmatter + body). Collects
 * every problem so one editing pass can fix them all (zod-style full report,
 * same as the settings validator).
 */
export function parseSkillDocument(text: string): SkillParseResult {
  const problems: SkillParseProblem[] = [];

  const open = OPEN_FENCE.exec(text);
  if (open === null) {
    return {
      ok: false,
      problems: [
        {
          key: "(frontmatter)",
          message:
            "SKILL.md must start with a YAML frontmatter block (a leading --- line, " +
            'a closing --- line) containing both "name" and "description" fields',
        },
      ],
      partial: {},
    };
  }
  const afterOpen = text.slice(open[0].length);
  const close = CLOSE_FENCE.exec(afterOpen);
  if (close === null) {
    return {
      ok: false,
      problems: [
        {
          key: "(frontmatter)",
          message: "frontmatter is not terminated — add a closing --- line on its own",
        },
      ],
      partial: {},
    };
  }
  const frontmatter = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length).replace(/^\r?\n/, "");

  // YAML-lite: flat `key: value` lines. Blank lines and `#` comments are
  // skipped; anything nested, keyless, or unknown is a loud problem.
  const values = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (/^[ \t]/.test(line)) {
      problems.push({
        key: "(frontmatter)",
        message:
          `nested frontmatter lines are not supported — only flat "key: value" lines ` +
          `(offending line: ${JSON.stringify(line.trim())})`,
      });
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      problems.push({
        key: "(frontmatter)",
        message: `invalid frontmatter line ${JSON.stringify(line)} — expected "key: value"`,
      });
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (key === "") {
      problems.push({
        key: "(frontmatter)",
        message: `invalid frontmatter line ${JSON.stringify(line)} — the key before ":" is empty`,
      });
      continue;
    }
    if (!FRONTMATTER_KEYS.has(key)) {
      problems.push({
        key,
        message: `unknown frontmatter key "${key}" — supported keys are "name" and "description"`,
      });
      continue;
    }
    if (values.has(key)) {
      problems.push({ key, message: `duplicate frontmatter key "${key}"` });
      continue;
    }
    values.set(key, unquote(line.slice(colon + 1).trim()));
  }

  const name = values.get("name");
  const description = values.get("description");
  if (!values.has("name")) {
    problems.push({ key: "name", message: 'frontmatter is missing the required "name" field' });
  }
  if (!values.has("description")) {
    problems.push({
      key: "description",
      message: 'frontmatter is missing the required "description" field',
    });
  }
  if (name !== undefined) {
    if (name.length === 0) {
      problems.push({ key: "name", message: '"name" must not be empty' });
    } else {
      if (name.length > SKILL_NAME_MAX_CHARS) {
        problems.push({
          key: "name",
          message: `"name" must be at most ${SKILL_NAME_MAX_CHARS} characters (got ${name.length})`,
        });
      }
      if (!SKILL_NAME_PATTERN.test(name)) {
        problems.push({
          key: "name",
          message:
            `"name" must match /^[a-z0-9-]+$/ (lowercase letters, digits, hyphens), ` +
            `got ${JSON.stringify(name)}`,
        });
      }
    }
  }
  if (description !== undefined) {
    if (description.length === 0) {
      problems.push({ key: "description", message: '"description" must not be empty' });
    } else if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
      problems.push({
        key: "description",
        message:
          `"description" must be at most ${SKILL_DESCRIPTION_MAX_CHARS} characters ` +
          `(got ${description.length})`,
      });
    }
  }
  if (body.trim().length === 0) {
    problems.push({
      key: "(body)",
      message: "SKILL.md body is empty after the frontmatter — a skill needs instruction content",
    });
  }

  if (problems.length > 0) {
    return {
      ok: false,
      problems,
      partial: {
        ...(name !== undefined && name.length > 0 ? { name } : {}),
        ...(description !== undefined && description.length > 0 ? { description } : {}),
      },
    };
  }
  return { ok: true, skill: { name: name ?? "", description: description ?? "", body } };
}
