# ADR-0003: Headless-first MVP (stream-JSON CLI before TUI)

- **Status:** Accepted (2026-10-12)
- **Deciders:** project owner, on agent recommendation

## Context

An agentic CLI has two faces: the interactive terminal UI and the programmatic interface.
A TUI is a large engineering surface that is nonetheless a *rendering* concern,
downstream of the agent loop, tools, and permissions. Building UI first delays the parts that differentiate Void
(ADR-0002 properties) and is hard to test in CI.

A machine interface enables remote runners, scripting, and ecosystem tooling — and
adopting a Claude-Code-compatible event shape makes existing tooling work with us on
day one.

## Decision

The MVP ships a **headless CLI with a stream-JSON interface only**; no interactive TUI in
MVP scope. The event stream adopts the **Claude Code `--stream-json` event shapes**
(init/message/result system events) as the compatibility target, documented in
`mvp-scope.md` once frozen.

## Consequences

**Positive.** The core (loop/tools/permissions/sandbox) is the entire MVP and is fully
testable in CI against mock providers. Agent developers (our main contributors) can
dogfood Void through the same interface users script with. TUI becomes a pure consumer of
a stable event stream — no rearchitecture when it arrives (post-MVP).

**Negative.** No interactive product until post-MVP; adoption among interactive-first
users waits. Approval-gated actions (`ask` permission results) degrade to
fail-with-guidance in headless mode (or `--dangerously-allow-all`-style explicit
overrides) until there is a UI to ask through.

**Revisit trigger:** MVP acceptance (see `mvp-scope.md`) — TUI is the first post-MVP
workstream, built on the frozen stream contract.
