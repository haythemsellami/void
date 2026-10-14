# AGENTS.md — Void

Operating manual for the LLM agents developing this project. **Read this file fully before doing anything else.** This repo is developed mainly by LLM agents with light human oversight, so this file is the source of truth for goals, rules, and conventions — keep it updated as decisions crystallize.

## Project goal

Build **Void** — an open-source, local-first, OS-sandboxed agentic coding CLI. Design north star: differentiate where proprietary cloud-first agents are weak — local-first operation, sandboxing by default, transparent prompts, offline models, no telemetry.

- **v0.1.x (complete):** local-first headless CLI (turn engine, sandboxed tools, permission rules, thread store, Anthropic+Ollama providers, frozen stream-JSON v1). License AGPL-3.0-only (ADR-0004).
- **v1.0 (complete):** the full production push — TUI, settings, model breadth, MCP, skills, compaction, subagents, async shell, distribution. Fourteen ADRs.
- **Next:** whatever dogfooding demands; the backlog lives in `docs/post-mvp-roadmap.md`.
- **Design north star:** **local-first** (no account/cloud required for core use), **OS-sandboxed by default** (not policy-gated only), **transparent prompts** (all prompt text in-repo, never hidden server-side), **offline/local models** as first-class citizens, **no telemetry by design**.

## Non-negotiable rules

1. **Commit early and often.** Make small, self-contained commits as soon as a unit of work is verifiably done — never bank multiple features in one commit, and never end a task with uncommitted changes. Use conventional commit messages (the `/commit` skill). Push when a coherent piece is complete.
2. **Evidence discipline:** separate observations, inferences, and unknowns explicitly in any analysis or design doc; design claims should be verifiable against the code or tests.
3. **Be conservative by default**: no force-pushes, no history rewrites, no deletions of others' work, ask before anything destructive or outward-facing. Keep every doc self-contained enough that a fresh agent session can resume from it.

## Repository layout

| Path | What it is |
|---|---|
| `AGENTS.md` | This file — agent operating manual |
| `docs/` | Design docs: `architecture.md`, `mvp-scope.md`, `post-mvp-roadmap.md`, `stream-json.md` (**frozen v1.1 event contract** — breaking changes need an ADR), `security-posture.md` (the threat model + R1–R10 residual register), `user-guide.md`, `contracts-gaps.md` (contracts decisions log), `adr/` (decision records 0001–0014). Read `docs/README.md` for the guided order |
| `src/contracts/` | The frozen shared contracts (provider/tools/permissions/thread types). Changes only through an orchestrated commit — see `docs/contracts-gaps.md` |
| `src/` (components) | `core/` turn engine + compaction · `store/` JSONL threads · `providers/` anthropic + ollama + openai-compat core (ADR-0010) · `tools/` bash/edit/read/glob/grep + async-shell family (ADR-0007) + `task` subagents (ADR-0013) + `skill` pair (ADR-0012) · `permissions/` rules engine (incl. subagent context, ADR-0013) · `sandbox/` OS isolation · `settings/` layered loader (ADR-0006) · `skills/` SKILL.md discovery + validation (ADR-0012) · `mcp/` stdio client (ADR-0011) · `app/` composition root + stream-JSON emitter + model registry · `context/` system prompt + AGENTS.md discovery + mode presets · `tui/` Ink session UI (react/ink live ONLY here, ADR-0005; audit test enforces) — per `docs/architecture.md` |
| `prompts/` | Versioned prompt text — ADR-0002 property 2: prompt text lives in-repo, never fetched remotely. `default.md` (system prompt), `compaction.md` (ADR-0008), `modes/` task-tool presets explorer+planner (ADR-0013). After editing any of them, run `bun run sync-prompt` (the build chains it; a drift test enforces equality with the embedded copy) |
| `scripts/` | Repo maintenance scripts (prompt embedding sync; release-artifact assertions shared by the release workflow and its dry-runs) |
| `tests/` | Cross-cutting test support (the offline MCP fixture server) + the repo-hygiene guard (committed conflict markers) |
| `examples/` | Tested runnable examples: the stream-JSON consumer, an MCP server config, layered permission walkthroughs — see `examples/examples.test.ts` |
| `install.sh` | The curl-able installer (ADR-0014 channel 2) — platform detection, checksum-verified GitHub Releases download; test seams `VOID_RELEASE_URL`/`VOID_VERSION`/`VOID_REPO` documented in its header |
| `npm/` | The npm launcher-stub surface (ADR-0014 channel 3, pre-publish: bin/postinstall wiring deliberately NOT switched on; package stays `private`) |
| `NOTICE` | Third-party attribution for the compiled binary (react/ink/react-devtools-core, MIT) — ships in every Release's notes |
| `.github/` | CI (`workflows/ci.yml` incl. the offline job + release dry-run), the tag-gated `release.yml`, dispatch `release-dry-run.yml`, and the release-notes template |
| `.worktrees/` | Git worktrees for parallel agent workstreams (git-ignored); merge serially into main in the order defined by the build plan |
When new top-level structure appears (source tree, docs, tests), document it here.

## Working agreements

- Before implementing anything non-trivial, check `docs/` for prior decisions about the feature area; link the relevant ADR in your PR/commit description.
- Design docs and decisions go in versioned files under `docs/` once created — recorded decisions beat chat-history memory.
- Prefer boring, well-tested code.
- **Test the composition, not just the components.** Component tests with injected seams do not catch wiring bugs at the CLI boundary (the v0.1.0 review found two shipped blockers this way: flags parsed but never read, env available but never forwarded). Any change to `src/cli.ts` or `src/app/runner.ts` composition needs at least one test driving the real composition path end-to-end.
- If something in this file is wrong or stale, fixing it is part of whatever task notices it.
