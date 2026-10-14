/**
 * `src/core` — the local turn engine (docs/architecture.md §core): request
 * assembly plus the conversation loop (provider streaming, tool dispatch,
 * usage aggregation, local stop conditions) and context compaction
 * (ADR-0008). Pure orchestration — every dependency is injected; observation
 * happens through EngineEvent callbacks.
 */
export * from "./assemble";
export * from "./compaction";
export * from "./engine";
