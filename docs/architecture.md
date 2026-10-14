# Void — Architecture (v0, living document)

Status: living design document. Decisions of record: [ADR-0001](adr/0001-tech-stack-typescript-bun.md)
(TS/Bun), [ADR-0002](adr/0002-local-first-architecture.md) (local-first), [ADR-0003](adr/0003-mvp-headless-first.md)
(headless-first). **This doc changes; ADRs don't.**

## Design thesis

**The loop is local; nothing vendor-side exists.** Every component below runs in
one local process; the only egress is to the user-configured LLM provider. Where
comparable cloud-first agents move the agent loop, prompts, threads, and credentials
server-side, Void keeps all of it on the user's machine:

| Concern | Cloud-first agents (typical) | Void (designed) |
|---|---|---|
| Agent loop | Server-side | Local process (`core`) |
| System prompts | Server-rendered, opaque | Versioned files in-repo, user-overridable |
| Tool execution driven by | Remote executor protocol | In-process dispatch |
| OS sandboxing | Policy rules only, if any | `sandbox-exec`/`bwrap` by default + rules |
| Credentials | Often held server-side | Local only (env/file/keychain) |
| Threads | Vendor cloud | Local JSONL files |
| Telemetry | Commonly on by default | None |
| Model routing | Server-side router | Local provider adapters |

## Components (MVP)

```
                    ┌─────────────────────────────────────────────────┐
                    │ void (single Bun process)                       │
 stdin/args ──►     │ ┌─────────┐   ┌──────────┐   ┌───────────────┐  │
                    │ │interface│──►│   core   │──►│   providers   │──┼──► Anthropic API
 stdout: stream-JSON│ │ (CLI,   │   │ turn loop│   │ (anthropic,   │  │
                    │ │  headless)   │ assembly │   │  ollama)      │  │──► Ollama (local)
                    │ └─────────┘   │ dispatch │   └───────────────┘  │
                    │               └────┬─────┘                      │
                    │        ┌───────────┼────────────┐               │
                    │        ▼           ▼            ▼               │
                    │ ┌────────────┐ ┌────────┐ ┌───────────┐         │
                    │ │permissions │ │ tools  │ │  sandbox  │         │
                    │ │ (rules)    │ │ bash*  │ │ (exec/bwr │         │
                    │ └────────────┘ │ edit/  │ │  ap, opt- │         │
                    │                │ read/  │ │  in flag) │         │
                    │                │ grep)  │ └───────────┘         │
                    │                └────────┘                       │
                    │ ┌──────────────────────────┐  ┌─────────────┐   │
                    │ │ context (AGENTS.md,      │  │ store       │   │
                    │ │ prompts from repo files) │  │ (threads:   │   │
                    │ └──────────────────────────┘  │  local JSONL)│   │
                    └───────────────────────────────────────────────┘
```

### `core/` — turn engine

Per turn: assemble context (system prompt from repo files + AGENTS.md chain + tool specs +
history) → call provider with streaming → parse tool-use blocks → for each call: permission
check → (optional sandbox wrap) → execute → append tool result → repeat until the model
ends its turn or a budget/stop condition hits. Budget and stop conditions are local config.
(compaction policy is a post-MVP concern —
MVP bounds turns and fails loudly instead of silently summarizing.)

### `providers/` — LLM adapters

One interface: `stream(request): AsyncIterable<StreamEvent>` + tool-use support. MVP ships
**anthropic** (Messages API streaming) and **ollama** (local, OpenAI-compatible endpoint,
proves the offline property). A generic OpenAI-compatible adapter is the obvious third,
post-MVP. Model registry is a local file with per-model context/effort metadata.

### `tools/` — registry and builtins

Registry entries are `{name, description, inputSchema, source: "builtin", fn}` — simple and sufficient.
MVP builtins: `bash` (workdir-param, background support deferred), `edit_file`
(unique-match old/new, git-style diff result), `read_file`, `grep`/`glob` (shell out to
`rg`, vendored path or PATH). Tool results carry byte-capped output with explicit
truncation markers (limits are config, not magic).

### `permissions/` — ordered rules engine

Ordered entries `{tool, matches, action:
allow|reject|ask|delegate}`, matchers = glob / `/regex/` / literal / nested input paths,
first match wins. Headless `ask` = fail with remediation text (ADR-0003). Defaults ship
allow-listing read-only operations and rejecting destructive patterns; `void permissions
test` subcommand with stable exit codes (ask=1, reject=2) ships with MVP because it makes
the rules testable by users and CI alike.

### `sandbox/` — OS isolation

`bash` runs inside a generated `sandbox-exec` profile (macOS) or `bwrap` invocation
(Linux) allowing write access only to the workspace + temp; network on/off per rule.
Missing sandbox binaries = hard fail with install guidance (never silent fallback — the
exact failure mode of policy-only sandboxing).

### `interface/` — headless CLI

`void run "task…"` (one-shot) and `void resume <thread>`; emits Claude-Code-shaped
stream-JSON on stdout, logs to stderr (ADR-0003). Exit codes: 0 success, 1 `ask` blocked,
2 rejected/denied, 3 provider/stream error.

### `mcp/` — MCP stdio client (post-MVP, ADR-0011)

Hand-rolled P1 client (zero runtime deps): each `mcpServers` settings entry is
spawned as a child via `node:child_process` speaking newline-delimited JSON-RPC
2.0 over stdio — `initialize` (clientInfo `{name:"void"}`, protocolVersion
recorded) → `notifications/initialized` → `tools/list` (nextCursor pagination
with a LOUD cap; never a silent truncation) → `tools/call`. Tools register as
`mcp__<server>__<tool>` behind the SAME permission gate as the builtins; a
failed server degrades to a structured `mcp__<name>__unavailable` tool error so
the model can react. 30s per-call timeout + `notifications/cancelled` on
AbortSignal; 10s startup deadline; SIGTERM→grace→SIGKILL shutdown at every exit
path (incl. signal hooks). Server children run UNSANDBOXED by design — they are
user-configured infrastructure (the trust act is the settings entry); their
environment is CONSTRUCTED (PATH/HOME/TMPDIR + exactly what was configured;
`${VAR}` expansion refuses and the env strips Void's own credential variables —
never inlined into argv where `ps` could read them). `void mcp list|doctor`
inspect connections. P2: StreamableHTTP (reusing providers/sse's parseSSE),
restart-on-change; SDK adoption decided at P2 entry.

### `context/` — prompts and AGENTS.md

System prompts live in `prompts/` (in-repo, versioned); user overrides via config.
AGENTS.md discovery walks cwd→root, supports `.agents/` scope, YAML frontmatter with
`globs` conditional inclusion — MVP implements discovery
+ unconditional inclusion; conditional globs are fast-follow.

### `store/` — threads

One JSONL per thread under the platform data dir: immutable append-only events
(user/assistant/tool records + usage). Resume = replay. Export to markdown later. No DB at MVP (JSONL covers everything a local agent needs).

## Deliberately not in MVP

TUI (ADR-0003), MCP client, skills, plugins, subagents/Task, integrations, remote
runners, compaction, model routing/fallback. Each maps to a report section and is
sequenced in [mvp-scope.md](mvp-scope.md).

## Verification posture (how the ADR-0002 properties stay true)

CI runs the full suite with a **network firewall fixture** (only the mock provider port
reachable): any egress attempt fails the build. Sandbox tests run real `sandbox-exec` on
macOS runners. Prompt files are linted to ensure no remote-fetch constructs. These tests
*are* the marketing claims — treat them as product, not hygiene.
