/**
 * Default permission rules — Void's out-of-the-box posture
 * (docs/architecture.md §permissions: "defaults ship allow-listing read-only
 * operations and rejecting destructive patterns").
 *
 * Authored from scratch for Void. The ordered-rules *pattern* is a design
 * decision recorded in the architecture doc; every rule, regex, and message
 * below is fresh wording with its rationale inline.
 *
 * Posture, in priority order (rules are evaluated first-match-wins):
 *
 * 1. REJECT unambiguous catastrophes (filesystem-destroying commands).
 * 2. ASK for operations that change shared state (git history, dependency
 *    trees) — a human or the user's own config should confirm.
 * 3. ALLOW operations that only read.
 * 4. Everything else matches no rule and falls to the default no-match
 *    policy: ASK. Unknown is not allowed.
 *
 * Async shell family (ADR-0007): `async_shell_command` gets its own rules
 * mirroring bash's classification (rules are keyed by tool name, so bash's
 * cannot match the async name); `async_shell_command_status` and
 * `async_shell_command_kill` are allowed — status only reads output of an
 * already-classified spawn, kill only stops one. This keeps headless runs
 * usable; no async tool falls to the default ask.
 *
 * These are heuristics on command text, not a security boundary — the OS
 * sandbox (docs/architecture.md §sandbox) is the boundary. Users replace or
 * extend this list in their own config; keeping it short keeps it auditable.
 */
import type { PermissionRule } from "../contracts/permissions";

/**
 * Bash commands matching one of these shapes can brick a machine or an entire
 * home directory in one hit. Each array entry is an OR-alternative:
 *
 * - `rm` with combined recursive+force flags (`-rf`/`-fr`, case-insensitive)
 *   aimed at `~`, `$HOME`, or a bare `/`. Targets like `rm -rf ./build` are
 *   NOT rejected here — they fall through to ask (destructive but scoped).
 * - fork-bomb shape `name(){ name|name& };…` (function that pipes into
 *   itself in the background). Also catches rare legitimate background
 *   piped functions — rejecting those is the right default; users who need
 *   them can write a rule.
 * - `dd` writing to a raw disk device (`of=/dev/sd*`, `/dev/hd*`,
 *   `/dev/nvme*n*`, `/dev/disk*` — Linux and macOS device names).
 * - recursive `chmod 777` applied to `/` (world-writable root).
 */
const CATASTROPHIC_BASH: readonly string[] = [
  String.raw`/\brm\b[^|;&]*\s-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*\b[^|;&]*\s(?:~(?:\/|\s|$)|\$HOME(?:\/|\s|$)|\/(?:\s|$))/i`,
  String.raw`/\(\)\s*\{[^}]*\|[^}]*&[^}]*\}/`,
  String.raw`/\bdd\b[^|;&]*\bof=\/dev\/(?:sd[a-z]+|hd[a-z]+|nvme\d+n\d+(?:p\d+)?|disk\d*)\b/`,
  String.raw`/\bchmod\b[^|;&]*\s-[a-z]*R[a-z]*\b[^|;&]*\s777\b[^|;&]*\s\/(?:\s|$)/`,
];

/**
 * Plain read-only invocations we allow outright. One command, no chaining
 * (`;`, `&&`, `|`), no redirection (`>`, `<`), no substitution (`$`, backtick),
 * no newlines — anything richer asks, so `cat f | sh` or `cat <(cmd)` can
 * never ride in behind a read-only verb. `git` is limited to its read-only
 * subcommands; version checks (`node --version`, `python3 -V`) prove the
 * "query the environment" case without allowing arbitrary execution.
 *
 * `find` is deliberately NOT on this list: its action flags (`-delete`,
 * `-exec rm {} \;`, `-fprint /path`, …) make the whole command mutable
 * while every character of it still matches a "bare find" shape, and the
 * no-compound-command guard above cannot see inside find's argument list.
 * Classifying it read-only is unsound, so `find` asks like every other
 * unclassified command (review major 7).
 */
const READ_ONLY_BASH = String.raw`/^\s*(?:ls|cat|head|tail|wc|pwd|echo|rg|git\s+(?:status|diff|log|show)|node\s+(?:--version|-v\b)|python3?\s+(?:--version|-V\b))\b[^|;&$><\x60\n\r]*$/`;

/**
 * Paths whose edits should never happen silently: anything inside a `.git`
 * directory (history/refstore integrity — `.git` itself, `.git/config`, …),
 * and dotfiles (`.env`, `.npmrc`, `.gitignore`, …) which carry credentials or
 * repo-level policy. The dotfile pattern matches any dot-named final segment,
 * so `config/.env` asks too — over-asking on dotfiles is the safe direction.
 * Both keys (`path` and nested `file.path`) are covered until the edit_file
 * input schema is frozen by the tools wave.
 */
const SENSITIVE_EDIT_PATHS: readonly string[] = [
  String.raw`/(^|\/)\.git(\/|$)/`,
  String.raw`/(^|\/)\.[^\/]+$/`,
];

/**
 * The default rule list. Exported as a constant (callers compose it with
 * user/project rules: user rules first, then these as the fallback tail).
 */
export const DEFAULT_RULES: readonly PermissionRule[] = [
  {
    tool: "bash",
    matches: { command: CATASTROPHIC_BASH },
    action: "reject",
    message:
      "Blocked by Void's default catastrophic-command rule (recursive force delete " +
      "of home/root, fork bombs, raw-device writes, chmod 777 on /). Override it in " +
      "your permission rules only if you accept the risk.",
  },
  {
    tool: "bash",
    matches: { command: String.raw`/\bgit\s+(?:commit|push)\b/` },
    action: "ask",
    message:
      "git commit/push changes shared history — Void asks by default. Add a rule " +
      "to allow them in this project if commits should be silent.",
  },
  {
    tool: "bash",
    matches: {
      command: String.raw`/\b(?:npm|pnpm|bun|yarn)\s+(?:install|ci|add|remove|uninstall|update)\b/`,
    },
    action: "ask",
    message:
      "package installs mutate node_modules and lockfiles (and run install " +
      "scripts) — Void asks by default.",
  },
  {
    tool: "bash",
    matches: { command: READ_ONLY_BASH },
    action: "allow",
  },
  // Async shell family (ADR-0007): the async names get their OWN rules —
  // name-keyed bash rules cannot match them — mirroring bash's classification
  // for the command input: catastrophes reject, shared-state mutations ask,
  // read-only prefixes allow, everything else falls to the default ask.
  {
    tool: "async_shell_command",
    matches: { command: CATASTROPHIC_BASH },
    action: "reject",
    message:
      "Blocked by Void's default catastrophic-command rule for background commands " +
      "(recursive force delete of home/root, fork bombs, raw-device writes, " +
      "chmod 777 on /). Override it in your permission rules only if you accept the risk.",
  },
  {
    tool: "async_shell_command",
    matches: { command: String.raw`/\bgit\s+(?:commit|push)\b/` },
    action: "ask",
    message:
      "git commit/push changes shared history — Void asks by default, in the " +
      "background family too. Add a rule to allow them if commits should be silent.",
  },
  {
    tool: "async_shell_command",
    matches: {
      command: String.raw`/\b(?:npm|pnpm|bun|yarn)\s+(?:install|ci|add|remove|uninstall|update)\b/`,
    },
    action: "ask",
    message:
      "package installs mutate node_modules and lockfiles (and run install " +
      "scripts) — Void asks by default, also when they run in the background.",
  },
  {
    tool: "async_shell_command",
    matches: { command: READ_ONLY_BASH },
    action: "allow",
  },
  // Status and kill carry no `command` input to classify — they act only on
  // handles this session created via an already-classified spawn call.
  // ADR-0007: status is read-only output retrieval (allow); kill is
  // risk-REDUCING — it stops a process Void itself started (allow). No
  // default ask-classification exists in the async family so headless runs
  // stay usable; users override with their own rules.
  { tool: "async_shell_command_status", matches: "*", action: "allow" },
  { tool: "async_shell_command_kill", matches: "*", action: "allow" },
  // Reading is non-destructive: read_file/grep/glob are allowed outright,
  // including paths outside the workspace (reading /etc or a sibling project
  // is normal agent work; the sandbox decides filesystem *visibility*).
  { tool: "read_file", matches: "*", action: "allow" },
  { tool: "grep", matches: "*", action: "allow" },
  { tool: "glob", matches: "*", action: "allow" },
  // Task tool (ADR-0013): spawning a child subagent is allowed by default.
  // The child conversation runs with its OWN permission gate (every call
  // evaluated under caller "subagent" against these same rules) and a
  // read-only tool subset — no bash, no edit_file, no task — so allowing the
  // spawn cannot allow any mutation. Users can still scope or reject `task`
  // (or any tool inside children, via `context: "subagent"` rules) in their
  // own config; a rule placed before these defaults wins.
  { tool: "task", matches: "*", action: "allow" },
  // MCP server tools (ADR-0011): `mcp__<server>__<tool>` calls are allowed
  // by default. The trust act is the user's CONFIGURATION, not a protocol
  // property — an mcpServers entry in settings is an explicit local trust
  // decision in that server (same posture as user-curated AGENTS.md/skills
  // content; MCP tools are NOT read-only by nature). The gate still
  // evaluates every call, and a user rule placed before the defaults
  // (settings rules merge in front) can restrict any server with
  // `mcp__<server>__*`.
  { tool: "mcp__*", matches: "*", action: "allow" },
  {
    tool: "edit_file",
    matches: { path: SENSITIVE_EDIT_PATHS },
    action: "ask",
    message:
      "This edit touches git internals or a dotfile (credentials/config live " +
      "there) — Void asks before writing.",
  },
  {
    tool: "edit_file",
    matches: { "file.path": SENSITIVE_EDIT_PATHS },
    action: "ask",
    message:
      "This edit touches git internals or a dotfile (credentials/config live " +
      "there) — Void asks before writing.",
  },
  {
    tool: "edit_file",
    matches: "*",
    context: "**",
    action: "allow",
    // Write confinement *inside* the workspace is enforced by the tool +
    // sandbox; permissions add the ask-on-sensitive-files layer above. The
    // `context` glob means: any referenced path within the workspace root.
  },
  // Skills (ADR-0012): `skill` reads+validates one local SKILL.md and returns
  // its body; `reload_skills` rescans the roots. Read-only context
  // operations over user-curated files — allowed outright, same posture as
  // read_file/grep/glob.
  { tool: "skill", matches: "*", action: "allow" },
  { tool: "reload_skills", matches: "*", action: "allow" },
];
