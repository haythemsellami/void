# ADR-0002: Local-first architecture

- **Status:** Accepted (2026-10-12)
- **Deciders:** project owner, on agent recommendation

## Context

Cloud-first agent CLIs typically run as thin clients for a vendor-hosted platform: the
agent loop, system prompts, threads, and even user-supplied keys live server-side, and
local command execution is often unsandboxed behind policy-only gating.

That model is the incumbents' moat **and** its vulnerability list from a user-trust perspective:
core use requires an account and vendor cloud; prompts are opaque; local execution has no
OS-level isolation; telemetry is on by default. Report §14 identifies local-first as the
primary open-source wedge.

## Decision

Void inverts the model: **the agent loop is a local process, and the only required
network egress is to the LLM provider the user configures.**

Hard properties, enforced by design and tested:

1. **Local agent core** — turn engine, tool dispatch, and thread state run in-process;
   no vendor endpoint is required for any core function.
2. **Transparent prompts** — every system prompt is a versioned file in this repo
   (overridable by user config); nothing prompt-shaped is fetched remotely.
3. **OS sandbox by default** — shell tools execute inside OS-level sandboxing
   (`sandbox-exec` profile on macOS, `bubblewrap` on Linux) with an explicit,
   logged opt-out; permission rules layer on top, never substitute.
4. **Keys stay local** — provider credentials read from env/config file/OS keychain by
   the local process only; no credential ever leaves the machine except to its provider.
5. **Zero telemetry** — no analytics, crash reporting, or update pinging; version checks
   are manual (compare against git tags / releases; no update pinging) and off the hot path. [Amended 2026-10-12: the original text referenced a `void update check` subcommand that does not exist.]
6. **Threads are local files** (JSONL) — inspectable, exportable, deletable; sync/sharing,
   if ever added, is an optional layer that defaults off.

## Consequences

**Positive.** Every property above is directly demonstrable and testable (network
assertions in tests: no egress besides configured providers), which is the marketing.
Offline/local models (Ollama) work as first-class citizens. Trust story is auditable by
anyone — the differentiator.

**Negative/accepted costs.** No server-side capabilities: hosted integrations,
multiplayer, cloud sandboxes, and server-rendered prompt iteration are out of scope by
construction. Cross-device threads and hosted subagents have no local equivalent — we
ship none of them rather than compromise the properties above. Context compaction and
model routing must be done well locally.

**Extension rule:** any future feature that requires vendor-cloud coupling must be an
optional plugin behind a disabled-by-default flag, never a core dependency.
