# ADR-0005: TUI layer dependencies (Ink 6 + React 19) behind the stream boundary

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

ADR-0001 keeps `src/**` zero-runtime-dependency. The TUI (post-MVP roadmap workstream 1)
needs a component model; the alternatives were a hand-rolled renderer (big surface,
hard to test, expensive for LLM contributors to iterate on) or an existing TS framework.

## Decision

Allow **runtime dependencies for the TUI layer only**: `react` and `ink` (plus their
transitive trees) and `react-devtools-core` — ink's optional peer whose module graph
references it unconditionally; bun installs no optional peers and the compile
bundler cannot resolve it, so it is a deliberate DIRECT dependency (2026-10-14
amendment; enforced by the audit allowlist) — all confined to `src/tui/**`. The boundary rule:

1. `src/tui/**` is the ONLY module that may import `react`/`ink`.
2. `src/tui/**` may consume `src/contracts`, `src/app` (stream events), the frozen
   stream-JSON contract, and **read-only replay from `src/store`** (the `void ui
   [thread]` viewer renders recorded threads; a composition-root read like cli.ts's
   own store use — no store writes from tui) — nothing in
   `src/{core,providers,tools,permissions,sandbox,store,context,app}` may import
   from `src/tui`. [Amended 2026-10-14: replay access added — recorded threads live
   in the store and the original allowlist would have forced a boundary violation
   or a subprocess hack at review time.]
3. The headless CLI path must work with the TUI deps absent (the TUI is a rendering
   layer, per ADR-0003; the stream contract stays the product interface).
4. Implementation notes: the `void ui` dispatch MUST dynamically import the TUI
entry (`await import`) so the headless binary builds without react/ink present;
JSX/tsx tsconfig settings apply only to `src/tui/**`; `ink-testing-library` stays in
devDependencies.
5. Enforced by a dependency-audit test: parse `package.json` `dependencies` against an
   allowlist (`react`, `ink`) and assert no non-tui module imports them.

## Consequences

**Positive.** Ink is testable (`ink-testing-library`), familiar to LLM contributors, and
keeps us off a multi-month custom-renderer detour; the zero-dep guarantee survives where
it matters (everything the sandbox and providers touch).

**Negative.** First runtime deps in the product; bundle grows; React's scheduler in a TUI
is heavier than a bespoke renderer on pathological update storms. Revisit trigger:
measured render latency problems on fast streams, not aesthetics.
