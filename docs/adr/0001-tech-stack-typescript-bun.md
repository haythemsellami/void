# ADR-0001: TypeScript on Bun as the implementation stack

- **Status:** Accepted (2026-10-12)
- **Deciders:** project owner, on agent recommendation

## Context

Void will be developed mainly by LLM agents with light human oversight (AGENTS.md). The
stack must maximize (a) agent productivity — how well coding agents can iterate on the
codebase autonomously, (b) ecosystem fit for agent tooling (MCP, LLM provider SDKs), and
(c) distribution ergonomics for a CLI product. Candidates considered: TypeScript/Bun,
Rust, Go.

TypeScript compiled to a single Bun executable is a proven stack for production agent
CLIs at scale, including native bindings and per-platform binaries.

## Decision

Implement Void in **TypeScript, running on and distributed via Bun**:

- Runtime/package manager: **Bun**; distribution target: `bun build --compile` single-file
  binaries per platform.
- Tests: **Vitest**. Lint/format: **Biome**. Both are fast, zero-config, agent-friendly.
- Strict TypeScript (`strict: true`); no `any` in `src/` except at documented boundaries
  (e.g. vendor schema escapes).

## Consequences

**Positive.** The MCP TypeScript SDK and Anthropic SDK are the reference implementations —
we sit on the reference implementations, so upstream fixes reach us first.
Agent developers (the primary contributors) are measurably more productive in TS than in
Rust. Bun gives native APIs (sqlite, keyring-adjacent, child processes) without build
steps, and single-binary distribution without bundler gymnastics.

**Negative.** Binaries land in the ~100MB class unless we keep the
dependency tree lean; Bun's LTS story is younger than Node's; native modules must be
pre-built per platform. Mitigations: keep vendor deps minimal, prefer Bun-native APIs over
node_modules, and avoid native addons unless unavoidable (delegate to spawned binaries
like `rg` instead).

**Revisit trigger:** if startup latency or binary size becomes a demonstrated user
complaint, re-evaluate a Rust (or Zig) core with the same architecture — the architecture
(ADR-0002) is deliberately language-agnostic.
