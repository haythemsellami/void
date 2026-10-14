# ADR-0006: Settings format, precedence, and UX

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

Everything user-configurable is currently env/flags only. Roadmap workstream 0 needs a
settings substrate for user permission rules, `mcpServers`, `skills.path`, and defaults.
A design pass on configuration UX established the patterns worth adopting and the
enterprise layers worth skipping.

## Decision

**Files:** user scope `$XDG_CONFIG_HOME/void/settings.json` (default `~/.config/void/`);
workspace scope `.void/settings.json` **or** `.void/settings.jsonc` (JSONC supported
everywhere; JSON is found first and WINS if both exist — JSONC applies only when the JSON file is
absent; a malformed file in either syntax is a LOUD failure, never a silent fallback
to the other), discovered by walking cwd up to the git root, or to the filesystem
root when no git root exists (matching `src/context/agents-md.ts` semantics).

**Precedence:** built-in defaults < user < workspace < `VOID_*` env < CLI flags.
Permission-rule merge order (first-match-wins, so order IS semantics): workspace
rules first, then user rules, then `DEFAULT_RULES` (workspace outranks user). Env
stays as its own layer (scriptable, no file needed); no managed/policy/server layers
(ADR-0002: nothing vendor-side exists).

**Schema:** versioned via `settingsVersion: 1`; hand-rolled validator (zero runtime
deps, same style as `validateRules`) producing precise errors naming the offending key
("Unknown setting", "must be a …"); unknown keys are REJECTED, not ignored. MVP keys:
`permissions` (user rules merged before `DEFAULT_RULES`), `defaultModel`, `mcpServers`
(validated now, consumed when MCP lands), `skills.path`, `providerTimeoutMs`,
`compaction.thresholdPercent`, `compaction.keepTurns` (positive int, default 2),
`asyncShell.maxLifetimeMs` (positive int, default 1_800_000, capped at 4h).

**UX:** `void settings path` (prints both layers' paths +
which exist), `void settings effective` (merged-effective view — the transparency
pattern), `void settings edit [--workspace]` (creates a `0600` skeleton `{"settingsVersion":1}` when absent, then opens `$EDITOR`, stdio inherit, structured error
naming editor+path on failure). Missing files never fatal: absent → defaults, malformed
→ loud structured error that names file, key, and problem.

## Consequences

JSONC costs ~40 lines of comment-stripping and buys inline documentation — worth it.
Env shadows for settings-shaped keys are resolved at the CLI/runner layer BEFORE
adapter construction; adapters' own env reads are construction-time fallbacks only
and never participate in file precedence. Key names follow common conventions only where semantics genuinely match (`permissions`,
`mcpServers`). A future key addition is additive; removing/renaming a key requires a
settingsVersion bump + migration note.
