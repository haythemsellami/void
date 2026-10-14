# Void — Post-MVP roadmap (living document)

Expansion of the `docs/mvp-scope.md` backlog into implementable workstreams. Each item
carries: goal, technical choices ("what to use"), phased plan (phases are sized to be
one agent workstream each, on the established pattern: worktree → branch →
both-runner-green → serial merge), and open questions. **Every item still needs
its ADR before build starts** (AGENTS.md rule); this doc feeds those ADRs.

## Recommended order & dependencies

| # | Workstream | Depends on | Parallelizable with |
|---|---|---|---|
| 0 | Settings/config loader | — (prerequisite for 2, 3) | 1, 4, 5 |
| 1 | TUI on the stream contract | nothing (contract is frozen) | everything |
| 2 | Skills + AGENTS.md `globs` | 0 (skills.path config) | 3, 4, 5 |
| 3 | MCP client | 0 (mcpServers config) | 2, 4, 5 |
| 4 | Context compaction | contract ADR (additive events) | all |
| 5 | OpenAI-generic adapter + delegate + keychain | nothing | all |
| 6 | Task/subagents + remote-runner | 4 (long subagent runs need compaction) | — |

TUI first, per the backlog: it is the largest user-facing gap and dogfoods the frozen
stream-JSON contract against a real consumer, which hardens the contract before more
consumers (MCP, remote-runner) build on it.

---

## 0. Settings / config loader (prerequisite mini-workstream)

**Goal:** a layered settings file so users can configure permission rules beyond
`DEFAULT_RULES`, `mcpServers`, `skills.path`, default model — everything currently
env/flags only.

**Reference posture:** Our scope:
defaults < user (XDG config) < workspace (`.void/settings.json`) < flags — no managed/
server layers exist locally.

**Config UX patterns (design pass, 2026-10-14):** file-first design — commands
navigate/validate, files are the truth.
Adopt: `config edit` creates a missing file as a `0600` skeleton then opens `$EDITOR` (stdio inherit; structured error naming editor+path on failure; `--workspace`
targets the other layer) (@2389330); JSONC fallback with an info log, and missing config
warns + uses empty settings rather than failing (@872507); secrets entered via stdin
(value `-`) or file path only, 1 MiB cap, never argv — keeps keys out of shell history
(@2405700); precise validation errors ("Unknown setting", keys-must-start-with rule)
(ascii-4 @197922); effective-value transparency (`config keymap` lists merged-effective
entries) (@2390041); docs-linked setup guides that honestly list "Not supported, and not
planned" auth methods with reasons (@2405700). Skip: managed/policy and server-managed
layers (enterprise/cloud machinery, contra ADR-0002).

**What to use:** plain JSON + JSONC fallback (decided: support both)
+ zod-style manual validation (zero runtime deps — hand-rolled validator like
`validateRules`), schema versioned with a `settingsVersion` field.

**Phases:** P1 loader + merge precedence + `void settings path/effective` command +
user-rules wiring into the permission gate. Acceptance: a user rule from each layer
overrides defaults in deterministic order; malformed file = loud structured error.

**Open questions:** JSON only, or JSONC? (JSONC costs ~40 lines of comment-stripping —
worth it.) Key names: follow common conventions (`mcpServers`, `permissions`) where semantics match.

---

## 1. TUI on the frozen stream contract

**Goal:** interactive terminal UI; headless stream-JSON remains the substrate, the TUI is
"just another consumer" (ADR-0003 revisit).

**TUI prior art:** kitty keyboard protocol, command registry with user keymap +
chord hints, synchronized output — good targets; a fully hand-rolled widget framework
is a large surface we deliberately do not copy.

**What to use:** **Ink 6 + React 19** for the UI layer. Rationale: TS-native,
`ink-testing-library` makes it agent-testable, and LLM agents iterate on React far better
than on a bespoke renderer. ADR-0005 must carve the dependency exception: UI-layer deps
allowed *behind* the stream boundary; `src/{core,providers,tools,permissions,sandbox,
store,app}` stay zero-runtime-dep. Alternative rejected: custom renderer —
revisit only if Ink's rendering cost demonstrably hurts.

**Phases:**
- P1 read-only session view: `void ui [thread]` rendering live/recorded stream events
  (assistant text, tool calls + collapsed results, permission denials, usage), scroll,
  quit. Acceptance: drives a scripted conversation to completion; snapshot tests.
- P2 interactive input: prompt entry + submit; **steering** (queue a message mid-run)
  needs an engine extension (queued-input API + additive stream event) — small contract
  ADR (additive only).
- P3 permission interaction: `ask` outcomes become TUI dialogs answering the permission
  event (headless mode keeps deny-with-remediation, ADR-0003 unchanged).
- P4 polish: kitty keyboard + chords, mouse scroll, themes, `--text` parity.

**Open questions:** steer-before-finish semantics (queued input injected at turn
boundaries).

---

## 2. Skills + AGENTS.md `globs`

**Goal:** SKILL.md-format skills with lazy injection (small default context), plus
conditional AGENTS.md application.

**Format notes:**
- Frontmatter: `name` + `description` both **required**, with a name length cap. Body
  after frontmatter is the instruction payload.
- Discovery: directory containing `SKILL.md` **or** `skill.md`; skills roots scan
  subdirectories; lookup also checks `skills/<name>` and `.agents/skills/<name>`; plus
  `~/.claude/skills` + `skills.path` colon list (server-synced repos are out for us —
  local-first).
- Injection: the `skill` tool loads a skill's instructions on demand; skills may unlock
  additional tools.
- Claude-compat `allowedTools` auto-approve semantics: treat as *optional* later
  compat; our permission engine already has the better primitive (rules + `delegate`).

**What to use:** our own loader (frontmatter regex we already ship in agents-md.ts;
hand-rolled YAML-lite for flat `key: value` fields — name/description/globs only, reject
anything nested with a loud error). Skill tool = builtin whose execute reads+validates,
returns body as tool result (the model then follows it); unlocked-tools support maps onto
the tool registry + permission rules by name pattern.

**Phases:** P1 loader + validation (same required fields, name cap 64) + discovery dirs
(`.agents/skills`, workspace `skills/`, user XDG, `skills.path`) + `skill` tool +
`void skills list`. P2 AGENTS.md `globs:` frontmatter — file-attachment-conditioned
loading (wire into the read/grep tools' discovered-guidance surface, surfaced to the model
through tool results). P3 `void skills add <git-url|path>`
(local-only install; no registry/notarization — vendor-cloud machinery).

**Open questions:** resource files inside a skill dir:
P2 scope = relative file reads resolved inside the skill dir, sandboxed to it.

---

## 3. MCP client

**Goal:** use MCP servers' tools from Void; permission-gated, context-economical.

**MCP notes:** stdio + StreamableHTTP + SSE transports; OAuth incl. dynamic client
registration; `${VAR}` env expansion in URLs; credentials stripped from child env;
permission gating per tool name. Context economy via deferred tool loading so big
catalogs don't stuff the prompt.

**What to use:** P1 hand-rolled **stdio** client (~200 lines: spawn, JSON-RPC 2.0
framing, `initialize` → `tools/list` → `tools/call`, `notifications/initialized`), keeping
zero runtime deps — the protocol subset is small and stable. Our `parseSSE` (providers/sse.ts)
is reusable for P2 **StreamableHTTP**. P3: adopt `@modelcontextprotocol/sdk` (MIT) via an
ADR-0001 exception *only if* hand-rolling OAuth + dynamic registration proves larger than
the exception is worth — decide at P3 entry, not now.

**Integration:** tools enter the existing registry as `mcp__<server>__<tool>` (naming
already assumed by permission defaults); permissions via existing rules engine
(`mcp__server__*` patterns); config from settings (workstream 0); `${VAR}` expansion +
env scrubbing as hardening. `void mcp list/doctor`.

**Phases:** P1 stdio + registry/permissions wiring + lifecycle (restart on config
change). P2 StreamableHTTP (+SSE fallback) reusing parseSSE. P3 OAuth + dynamic client
registration + `mcp oauth login`-equivalent. P4 deferred-tools pattern (`tool_search`).

**Open questions:** whether P4 changes the stream contract (additive tool-listing
events) — likely yes, additive ADR.

---

## 4. Context compaction

**Goal:** unbounded-feeling threads without silent quality loss; local, transparent.

**Policy surface:** a global threshold percent (0–100, default ≈90 of context) and a
per-agent token override; compaction lifecycle events; a hard-stop guard when
compaction cannot shrink further. Implementation is ours.

**Design:** trigger when estimated context ≥ threshold % of the registry's
`contextWindow` (estimate = last provider usage + chars/4 for additions). Action: replace
the conversation prefix with a summary produced by the *same provider* using a versioned
`prompts/compaction.md`; keep the newest N turns verbatim. Persist as new ThreadEvent
kinds → **frozen-contract change: additive `compaction` events need the contract ADR**
(and additive stream events, v1.1). Fail-loud: summarization failure stops the run with
remediation; never silently truncate (the same hard-stop guard).

**Phases:** P1 contract ADR + thread events + manual `--compact` flag on resume. P2
automatic threshold with usage-based estimation. P3 quality: prune stale tool results
before messages; segment-aware summarization.

**Open questions:** summary stored as a synthetic assistant message vs a dedicated event
(dedicated event preferred — replay must distinguish).

---

## 5. OpenAI-generic adapter + delegate UX + keychain

**Goal:** any OpenAI-compatible endpoint as a provider; delegate action fully usable;
secrets beyond env vars.

No new references needed — our Ollama adapter already speaks the OpenAI wire
(`src/providers/ollama.ts`). Keyring via `@napi-rs/keyring` native bindings was
considered and rejected (native addons contra ADR-0001).

**What to use:**
- Adapter: extract the OpenAI-wire core from ollama.ts into a shared `openai-compat`
  module; new provider prefix `openai/` (+`/v1`-style baseUrl, Bearer key) covers OpenAI,
  Groq, OpenRouter, LM Studio, vLLM. Registry entries minimal; `custom` fallback exists.
- Keychain: macOS `security` CLI via child process (service `void.cli.*`), Linux
  `secret-tool` with 0600-file fallback; behind a `SecretStore` interface the CLI already
  borders on having (env reads). No native modules.
- Delegate: `runDelegate` is already implemented + tested (src/permissions/delegate.ts);
  remaining is CLI surface (timeout flag), docs, and an examples/ script.

**Phases:** P1 adapter extraction + registry + tests (fake fetch as usual). P2 SecretStore
+ `void auth login/store/list` (interactive minimal; headless = env unchanged). P3
delegate docs/examples + `permissions test --delegate`.

---

## 6. Task/subagents + remote-runner

**Goal:** scoped subagents for parallel exploration; drive Void on another machine
without any vendor cloud.

**Design inputs:** Task input is `{description, prompt, mode}`. Coordination tools:
`get_thread_status`, `send_thread_message`, `wait_for_threads`; persistent children
via `create_thread` with `agent_mode` + `parentThreadID`. Our MVP already has the
seam: permission rules carry a `context: subagent` field.

**Design:** a `task` builtin spawning a child `runConversation` — same provider,
isolated messages, tool subset, no persistence by default; mode presets are prompt files
(`prompts/modes/explorer.md`, `planner.md`…). Concurrency
cap (default 3). Child progress as additive stream events. Remote runner:
`void serve` = the existing CLI loop exposed over stdio/SSH/unix socket speaking
stream-JSON v1; auth is the operator's transport (SSH keys), not a platform — explicitly
no tunnel to anyone's cloud (ADR-0002 property 1).

**Phases:** P1 sequential `task` tool + mode presets + subagent-context permission
inheritance. P2 parallel children + budget isolation + coordination tools. P3
`void serve` transport + remote `--runner` flag + docs.

**Open questions:** whether child threads persist by default (no for task, yes for
create_thread — the current split).
