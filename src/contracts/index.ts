/**
 * `src/contracts` — the shared contracts every Void component codes against:
 * providers (streaming chat), tools (registry + execution), permissions
 * (ordered rules), and threads (append-only event logs). See
 * docs/architecture.md for the component design these serve.
 *
 * This module is pure: types and trivial helpers only, zero imports beyond
 * TypeScript itself. Components must not fork these shapes — extend here.
 */
export * from "./permissions";
export * from "./provider";
export * from "./thread";
export * from "./tools";
