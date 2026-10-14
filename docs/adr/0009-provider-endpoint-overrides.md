# ADR-0009: Provider endpoint and key overrides (GLM via Anthropic-compatible endpoints)

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

Z.AI (and other vendors) expose Anthropic-messages-compatible endpoints. Void's
Anthropic adapter already speaks that wire and accepts a `baseURL` constructor option —
only the CLI/runner plumbing was missing. Model breadth without new adapters is the
goal; keys must stay local and out of tool-child environments.

## Decision

Add `VOID_ANTHROPIC_BASE_URL` (env) → `anthropicBaseUrl` (RunTaskOptions) → adapter
`baseURL`, mirroring the existing `VOID_OLLAMA_URL` pattern. Registry entries for
`anthropic/glm-4.6` and `anthropic/glm-4.7` document the Z.AI pairing
(`VOID_ANTHROPIC_BASE_URL=https://api.z.ai/anthropic` + a Z.AI key in
`VOID_ANTHROPIC_KEY`). Binding is **env-driven, not registry-driven**: registry entries
are metadata (context window, provider kind) only — a model never carries its endpoint
inside the registry, so registries stay shareable and endpoints stay user-owned.
`VOID_ANTHROPIC_BASE_URL` is deliberately NOT in `TOOL_ENV_ALLOWLIST`.

## Consequences

Any Anthropic-compatible endpoint works with zero code (GLM today). Risk: an
Anthropic-shaped API that drifts from the real protocol surfaces as provider errors —
acceptable; the adapter's error taxonomy already maps them. OpenAI-compatible
endpoints get the same treatment via ADR-0010.
