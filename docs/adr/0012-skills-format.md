# ADR-0012: Skills — SKILL.md format, lazy injection, local-only

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

Roadmap workstream 2. Format requirements:
SKILL.md with REQUIRED frontmatter `name` + `description` (literal validation
errors), discovery over `SKILL.md|skill.md` in skills-root subdirectories, plus
`.agents/skills`/`.claude/skills`-style user dirs and a `skills.path` list; lazy
injection via a `skill` tool so default context stays small. Server-synced skill
repos are vendor-cloud machinery — out (ADR-0002).

## Decision

**Format:** directory containing `SKILL.md` (or `skill.md`); YAML frontmatter with
`name` (required, ≤64 chars, `[a-z0-9-]` slug) + `description` (required, ≤300
chars); body = instruction payload. Unknown frontmatter keys are LOUDLY rejected
(same posture as settings). Optional sibling resources readable by path inside the
skill dir only.

**Discovery (in order, first wins per name):** workspace `.agents/skills/` and
`skills/` (walked to the git root), then user `~/.config/void/skills/`, then
`skills.path` (colon-separated, from settings). `.claude/skills` compat is a
follow-up decision, NOT P1 (avoid implying Claude-specific semantics we don't
implement).

**Injection:** a `skill` builtin tool — input `{name}`; execute loads, validates,
and returns the body as the tool result (the model then follows it); `reload_skills`
rescans. The system prompt gains only the name+description list (lazy by design).

**CLI:** `void skills list` (discovered skills + source paths). **No** install
command at P1 (users manage directories; `void skills add` is P2 with git-clone
semantics).

**P2 (same workstream):** AGENTS.md `globs:` frontmatter — conditional loading
wired into the tools' discovered-guidance surface.

## Consequences

Ecosystem-compatible shape (same frontmatter contract) without inheriting another
project's semantics; validation is strict so malformed skills fail loud, never
silently load. Skills can carry arbitrary instructions — same trust level as
AGENTS.md files already in the workspace (user-curated), noted in the README.
