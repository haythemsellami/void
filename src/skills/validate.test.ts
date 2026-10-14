/**
 * Validator matrix for `src/skills/validate` (ADR-0012): every acceptance
 * and every rejection, as a full-report (all problems per document).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_BYTES,
  parseSkillDocument,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
  skillByteLength,
} from "./validate";

const valid = (frontmatter: string, body = "Do the thing."): string =>
  `---\n${frontmatter}\n---\n${body}\n`;

describe("parseSkillDocument: acceptance", () => {
  it("parses a minimal valid skill (name + description + body)", () => {
    const result = parseSkillDocument(
      valid("name: commit-style\ndescription: Enforce commit style"),
    );
    expect(result).toEqual({
      ok: true,
      skill: {
        name: "commit-style",
        description: "Enforce commit style",
        body: "Do the thing.\n",
      },
    });
  });

  it("accepts a name at exactly the 64-character cap and rejects 65", () => {
    const edge = "a".repeat(64);
    expect(parseSkillDocument(valid(`name: ${edge}\ndescription: d`)).ok).toBe(true);
    const over = "a".repeat(65);
    const result = parseSkillDocument(valid(`name: ${over}\ndescription: d`));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContainEqual({
        key: "name",
        message: `"name" must be at most ${SKILL_NAME_MAX_CHARS} characters (got 65)`,
      });
    }
  });

  it("accepts a description at exactly the 300-character cap and rejects 301", () => {
    const edge = "d".repeat(300);
    expect(parseSkillDocument(valid(`name: x\ndescription: ${edge}`)).ok).toBe(true);
    const over = "d".repeat(301);
    const result = parseSkillDocument(valid(`name: x\ndescription: ${over}`));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContainEqual({
        key: "description",
        message: `"description" must be at most ${SKILL_DESCRIPTION_MAX_CHARS} characters (got 301)`,
      });
    }
  });

  it("accepts every name-charset character (a-z, 0-9, hyphen) and useful bodies", () => {
    for (const name of ["a", "0", "a-b", "a1-b2", "release-notes-writer"]) {
      const result = parseSkillDocument(valid(`name: ${name}\ndescription: d`));
      expect(result.ok, name).toBe(true);
    }
    const multiline = parseSkillDocument(
      valid("name: multi\ndescription: d", "line one\n\nline two\n- bullet\n```lang\nfenced\n```"),
    );
    expect(multiline.ok).toBe(true);
    if (multiline.ok) {
      expect(multiline.skill.body).toContain("fenced");
    }
  });

  it("strips one matching pair of surrounding quotes from values", () => {
    const result = parseSkillDocument(valid(`name: "quoted-skill"\ndescription: 'single quoted'`));
    expect(result).toEqual({
      ok: true,
      skill: { name: "quoted-skill", description: "single quoted", body: "Do the thing.\n" },
    });
  });

  it("skips blank lines and # comments inside the frontmatter", () => {
    const result = parseSkillDocument(
      valid("# a comment\n\nname: commented\n\ndescription: has comments"),
    );
    expect(result.ok).toBe(true);
  });

  it("tolerates CRLF line endings and a leading BOM", () => {
    const crlf = `\uFEFF---\r\nname: crlf-skill\r\ndescription: windows edits\r\n---\r\nbody\r\n`;
    const result = parseSkillDocument(crlf);
    expect(result).toEqual({
      ok: true,
      skill: { name: "crlf-skill", description: "windows edits", body: "body\r\n" },
    });
  });

  it("reports the byte length used by the size cap", () => {
    expect(skillByteLength("abc")).toBe(3);
    expect(skillByteLength("é")).toBe(2);
    expect(MAX_SKILL_BYTES).toBe(256 * 1024);
  });
});

describe("parseSkillDocument: rejections (all loud, key-named)", () => {
  const keysOf = (text: string): { keys: string[]; messages: string[] } => {
    const result = parseSkillDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    return {
      keys: result.problems.map((problem) => problem.key),
      messages: result.problems.map((problem) => problem.message),
    };
  };

  it("rejects a document without frontmatter", () => {
    const { keys, messages } = keysOf("Just a body, no fences.");
    expect(keys).toEqual(["(frontmatter)"]);
    expect(messages[0]).toContain("must start with a YAML frontmatter block");
    expect(messages[0]).toContain('"name" and "description"');
  });

  it("rejects unterminated frontmatter (no closing fence)", () => {
    const { keys, messages } = keysOf("---\nname: x\ndescription: d\n");
    expect(keys).toEqual(["(frontmatter)"]);
    expect(messages[0]).toContain("not terminated");
  });

  it("rejects a missing name, a missing description, and both", () => {
    const missingName = keysOf(valid("description: only description"));
    expect(missingName.keys).toEqual(["name"]);
    expect(missingName.messages[0]).toContain('missing the required "name" field');

    const missingDescription = keysOf(valid("name: only-name"));
    expect(missingDescription.keys).toEqual(["description"]);
    expect(missingDescription.messages[0]).toContain('missing the required "description" field');

    const missingBoth = keysOf("---\n---\nbody\n");
    expect(missingBoth.keys).toEqual(["name", "description"]);
  });

  it("rejects an empty name and an empty description", () => {
    const { keys, messages } = keysOf(valid("name:\ndescription:"));
    expect(keys).toEqual(["name", "description"]);
    expect(messages[0]).toContain('"name" must not be empty');
    expect(messages[1]).toContain('"description" must not be empty');
  });

  it("rejects names outside /^[a-z0-9-]+$/ with the pattern in the message", () => {
    for (const bad of ["UpperCase", "under_score", "with space", "dot.name", "é"]) {
      const { keys, messages } = keysOf(valid(`name: ${bad}\ndescription: d`));
      expect(keys, bad).toEqual(["name"]);
      expect(messages[0], bad).toContain('"name" must match /^[a-z0-9-]+$/');
    }
  });

  it("rejects an unknown frontmatter key, naming the key", () => {
    const { keys, messages } = keysOf(valid("name: x\ndescription: d\nallowedTools: [bash]"));
    expect(keys).toContain("allowedTools");
    expect(messages.find((m) => m.includes("allowedTools"))).toContain(
      'unknown frontmatter key "allowedTools"',
    );
    expect(messages.find((m) => m.includes("allowedTools"))).toContain('"name" and "description"');
  });

  it("rejects a duplicate frontmatter key", () => {
    const { keys, messages } = keysOf(valid("name: x\nname: y\ndescription: d"));
    expect(keys).toContain("name");
    expect(messages.some((m) => m.includes('duplicate frontmatter key "name"'))).toBe(true);
  });

  it("rejects nested/indented frontmatter lines", () => {
    const { keys, messages } = keysOf("---\nname: x\ndescription: d\n  nested: value\n---\nbody\n");
    expect(keys).toEqual(["(frontmatter)"]);
    expect(messages[0]).toContain("nested frontmatter lines are not supported");
    expect(messages[0]).toContain('"nested: value"');
  });

  it("rejects a frontmatter line without a colon and one with an empty key", () => {
    const noColon = keysOf(valid("name: x\ndescription: d\nnamex description d"));
    expect(noColon.keys).toEqual(["(frontmatter)"]);
    expect(noColon.messages[0]).toContain('invalid frontmatter line "namex description d"');

    const emptyKey = keysOf(valid("name: x\ndescription: d\n: value"));
    expect(emptyKey.keys).toEqual(["(frontmatter)"]);
    expect(emptyKey.messages[0]).toContain('the key before ":" is empty');
  });

  it("rejects an empty body after the frontmatter", () => {
    const whitespace = keysOf("---\nname: x\ndescription: d\n---\n\n   \n");
    expect(whitespace.keys).toEqual(["(body)"]);
    expect(whitespace.messages[0]).toContain("body is empty");
  });

  it("collects MULTIPLE problems in one report (full report, not first-error)", () => {
    const { keys } = keysOf(
      "---\nname: Bad_Name\ndescription: d\nmystery: 1\n  nested: x\n---\n\n",
    );
    expect([...keys].sort()).toEqual(["(body)", "(frontmatter)", "mystery", "name"]);
  });
});
