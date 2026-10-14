# Contracts gap register

Wave-1 workstreams implemented against frozen `src/contracts/**` and reported
every gap they hit. Adjudication happened in the single orchestrated wave-2
contracts commit (AGENTS.md frozen-contract rule: contracts change only
through an orchestrated commit, never inside a workstream). Every wave-1 gap
is resolved below; nothing is open.

## Resolved (wave-2 adjudication)

1. **`complete()` error channel** — resolved: documented on the `Provider`
   interface that `stream()` reports errors as a final `error` event while
   `complete()` throws; added structural `ProviderCallError`
   (`Error` + `providerError: ProviderError`) to `contracts/provider.ts`.
   `AnthropicCallError` and `OllamaProviderError` both implement it (ollama
   gained a `providerError` field; `retryable`/`code` kept for compat).
2. **Structured error/data on tool results** — resolved:
   `ToolResultBlock.error?: ToolError` (the engine populates it when
   converting ToolResults) and `ToolError.details?: JsonObject`. Exemplar
   adoption: bash puts `{exitCode?, timedOut?}` (only when set) on its timeout
   error; edit_file puts `{matchCount}` / `{matchCount, lineNumbers}` on the
   zero-/multi-match errors. Other tools adopt `details` opportunistically
   later.
3. **`ToolUseEndEvent.name`** — resolved: optional `name?: string`; both
   providers emit it at block completion; the engine uses it to recover
   orphan end events (ends with no matching start) and still drops
   name-less orphans.
4. **`ThreadStore` error + warnings types** — resolved: promoted
   `ThreadStoreErrorCode` (six codes), structural `ThreadStoreErrorShape`,
   and `ThreadListWarning` + optional `onListWarning` into
   `contracts/thread.ts`; documented that `list()` never throws for one bad
   file and that the CALLER stamps `at` (events persist verbatim).
   `ThreadId` is branded (`string & { __brand: "ThreadId" }`) with the
   validating `threadId()` helper; the store's local error class now
   implements the contract shape (class kept, codes re-exported from the
   contract).
5. **`OutputLimits` units + knobs** — resolved: contract documents the caps
   as BYTES (field names kept for compatibility; markers may exceed the
   cap) and adds optional `maxLines?`; read_file reads `maxLines` from the
   context, falling back to its 500 default (per-call `limit` still wins).
6. **`ToolContext` cancellation + capability declaration** — resolved:
   `ToolContext.signal?: AbortSignal` (grep kills its rg child on abort;
   an already-aborted signal fails fast) and declaration-only
   `ToolSpec.network?: boolean` (bash keeps sandbox deny-by-default; no
   behavior change anywhere).
7. **`StopReason` extensibility** — resolved: widened to the known literals
   plus `(string & {})` — unknown vendor reasons pass through verbatim
   (anthropic no longer degrades them to `end_turn`; e.g. `"refusal"`), and
   the engine treats unknown reasons as a terminal natural end.
8. **Cross-provider conventions** — resolved: doc comments on the contract:
   `tool_result.isError` has no OpenAI-wire representation (ollama flattens
   error results to text), `stop_sequence` is unreachable from ollama, and
   `topP`/`reasoningEffort` are per-provider best-effort. No code change.

## Contract ambiguities resolved by reading (documented, no change needed)

- `InputMatchSpec` semantics: record keys AND (the permissions mission said OR across
  entries; the contract text wins — OR lives in `ValueMatcher` arrays).
- `TextResultBlock.truncated`: omitted when not clipped (not `false`).
- `OutputLimits` markers may exceed the cap (they are metadata, not content).

## Fixed during integration

- `src/providers/ollama.test.ts` used vitest-only `vi.stubEnv`/`vi.unstubAllEnvs`, which
  `bun:test` does not implement — replaced with manual save/restore so the suite is green
  under both runners (policy: all suites must pass under `bun test` AND `vitest run`).

## Post-MVP adjudications (additive, recorded per workstream)

9. **`ToolSource` widened to `"builtin" | "mcp"`** — ADR-0011 (MCP stdio client,
   roadmap WS3 P1). Tools discovered from configured MCP servers register with
   `source: "mcp"` under the `mcp__<server>__<tool>` naming the permission
   defaults already assumed. Strictly additive: the field stays
   declaration-only (no runtime consumer reads it — providers serialize
   name/description/inputSchema only), every existing literal keeps its
   meaning, and no stored shape carries it (threads persist ToolResult
   content, not ToolSpecs). Recorded here rather than deferred because the
   alternative — labeling user-configured server tools `"builtin"` — would be
   an auditable lie in the one field whose job is provenance.

## 9. ToolSource widened for MCP (ADR-0011) — 2026-10-14

`ToolSpec.source` widened from `"builtin"` to `"builtin" | "mcp"` so MCP-registered
tools are distinguishable at the type level. Declaration-only: providers serialize
name/description/inputSchema and never read `source` (verified — `registryToolSpecs`
untouched). Landed in its own commit (6d76386 on feat/mcp) before any consumer,
per the orchestrated-additive pattern. Future sources (e.g. `"plugin"`) follow the
same route: ADR + own commit + register entry here.
