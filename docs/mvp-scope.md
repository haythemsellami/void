# Void — MVP Scope (living document)

Grounding: [architecture.md](architecture.md), ADRs [0002](adr/0002-local-first-architecture.md)
and [0003](adr/0003-mvp-headless-first.md). This file defines **what ships when** and the
acceptance criteria that gate each milestone. Update it as scope crystallizes; ADRs stay
fixed.

## MVP definition (the walking skeleton)

A local, headless coding agent that completes a real task end-to-end with zero vendor
cloud, OS-sandboxed shell access, permission-gated writes, and a machine-readable event
stream. Concretely: *in an empty git repo, `void run "create a hello-world TypeScript
project with a passing test"` produces files, runs the test inside a sandbox, asks-or-blocks
per permission rules, and streams every step as JSON.*

## Milestones

### M0 — scaffolding
Repo skeleton per ADR-0001: Bun + strict TS, Vitest, Biome, CI (lint+test on macOS and
Linux), `docs/` as committed here, README/LICENSE (pending owner decision on license).
**Done when:** CI green on a hello-world test in both OS runners.
**Status: complete.**

### M1 — core loop against mock provider
`core/` turn engine + `providers/` interface with an **in-repo mock provider** (scripted
streaming + tool-use responses). No network anywhere. Includes: message assembly, stream
parsing, tool-call dispatch to a stub tool, loop termination, thread JSONL persistence and
resume-by-replay.
**Done when:** a scripted two-tool-call conversation replays deterministically from the
JSONL and the firewall fixture proves zero egress.
**Status: complete** (wave 1; the wave-2 integration suite re-proves replay determinism
through `runTask`; wave 3 ships the promised firewall fixture — see the hardening
section below).

### M2 — real providers
`anthropic` and `ollama` adapters behind the same interface; keys from
`VOID_ANTHROPIC_KEY`/Ollama base URL env only (keychain later); model registry file with
context/effort metadata; usage accounting (input/output/cache tokens) recorded per turn.
**Done when:** the M1 scripted conversation runs for real against a local Ollama model,
and against Anthropic behind an integration flag (no live key in CI).
**Status: complete** (wave 1 adapters + wave-2 model registry; live-key verification
remains behind an integration flag per the acceptance note).

### M3 — tools + sandbox + permissions
`bash` (sandbox-exec/bwrap enforced, workspace+writable-temp only), `edit_file`,
`read_file`, `grep`/`glob` via `rg`; permissions engine with ordered rules, defaults
(read-only allowlist, destructive reject), `void permissions test` (exit 1=ask, 2=reject).
**Done when:** the MVP definition scenario above passes on macOS and Linux; a
write-outside-workspace attempt is blocked by sandbox *and* surfaced by permissions;
unsandboxed fallback is impossible without an explicit logged flag.
**Status: complete** (wave 1; wave 2 wires `permissions test` into the CLI and exercises
a real sandbox-exec round inside `runTask`).

### M4 — headless interface freeze
`void run` / `void resume` stream-JSON contract (Claude-Code-shaped system/message/result
events) documented with JSON schema + examples; exit codes stable; `--json-schema` flag
emits the contract. **Done when:** contract docs + schema land and a consumer example
script drives Void end-to-end. → **MVP shipped.**
**Status: complete upon merge of feat/integration** — the contract lives in
[stream-json.md](stream-json.md) with the schema embedded (also `void schema`); the
consumer example script and the end-to-end driver tests are in the wave-2 suite.

## Wave 3 — hardening (ADR-0002 properties made falsifiable in CI)

**Status: complete on `feat/wave3-hardening`** — the release tag remains **blocked on
the LICENSE decision (owner)**.

- **Egress fixture** (`src/app/egress.test.ts` + `tests/support/egress-monitor.ts`):
  full offline `runTask` conversations (all five builtin tools, including a real
  sandboxed bash round) and the no-fetch CLI paths run under a recording, always-failing
  `globalThis.fetch` stub, with a control test proving the fixture fires. Works under
  both `bun test` and vitest.
- **Network-blocked CI job** (`offline` in `.github/workflows/ci.yml`): the suite runs
  with OS-level network denied — macOS `sandbox-exec -p '(version 1)(allow default)
  (deny network*)'`, Linux `unshare -Urn`. Honest boundary, verified locally: the Bun
  real-sandbox suites cannot run nested inside a deny-bearing sandbox-exec profile
  (a second `sandbox_apply` fails with EPERM), so the wrapped macOS run is the full
  vitest suite (those suites skip cleanly there) plus the CLI process-spawn smoke;
  the egress test probes the same capability and skips only its sandboxed-bash
  variant. On Linux every suite runs inside the netns.
- **Real bwrap coverage**: the Linux `ci` job apt-installs bubblewrap (unprivileged,
  non-setuid) so the capability-guarded bwrap integration suites execute for real;
  `src/sandbox/linux.ts` documents why no `--unshare-user`/`--uid`/`--gid` is needed
  (bwrap creates the userns it needs itself when not setuid) with argv assertions
  pinning that shape. First CI round caught an ordering bug, now fixed and pinned:
  the writable workspace/tempDir binds must come AFTER `--tmpfs /tmp` (bwrap applies
  argv in order, so the tmpfs overmount shadows mkdtemp'd workspaces bound earlier).
  CI is the verifier — bwrap cannot run on the dev macOS machine.
- **Subcommand help**: `void <sub> --help` renders per-subcommand usage (flags table +
  examples) from one hand-rolled table; bare `void --help` lists subcommands.
- **README/build**: "Trust properties & how they're verified" section maps the six
  ADR-0002 properties to their enforcing tests/jobs; `bun run build` compiles
  `dist/void` (verified locally: all subcommands work standalone, and `run`/`resume`
  use the embedded system prompt — `bun run sync-prompt` regenerates
  `src/context/default-prompt.ts` from `prompts/default.md` at build time, with a
  drift test failing the build if the copies diverge; the loader prefers the live
  repo file so source checkouts read prompt edits immediately).

## Post-MVP backlog (order tentative, each needs an ADR before build)

**Expanded with implementation phases and library choices in
[post-mvp-roadmap.md](post-mvp-roadmap.md) — that doc is the working plan; this list is
the index.** The roadmap adds a prerequisite workstream 0 (settings/config loader) ahead
of skills and MCP.

1. TUI on the frozen stream contract (ADR-0003 revisit)
2. AGENTS.md conditional `globs` + skills (`SKILL.md` format, compatible with
   `.agents/skills` and `.claude/skills` discovery — ecosystem compatibility)
3. MCP client (stdio first)
4. Context compaction (local; ~90% threshold default)
5. OpenAI-compatible generic adapter; permission `delegate` action; keychain storage
6. Subagents/Task tool; remote-runner mode over the stream contract

## Explicitly out of scope (per ADR-0002)

Anything requiring vendor cloud: hosted threads, sync, multiplayer, hosted integrations,
telemetry of any kind, auto-update pinging. Optional cloud-coupled features may only
exist as disabled-by-default plugins.

## Open items for the owner

- ~~LICENSE choice~~ — **resolved 2026-10-12: AGPL-3.0-only** ([ADR-0004](adr/0004-license-agpl3.md)).
- Repo public timing.
- Product naming check: "void" collides with an existing AI code editor (Void
  editor); owner chose to keep the name. The stream-JSON contract froze with the
  `void` binary name — a later rename must alias the contract.
