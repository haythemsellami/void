# ADR-0010: OpenAI-compatible adapter core (openai/* provider prefix)

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

The Ollama adapter (roadmap WS5a origin) already implements the OpenAI wire protocol
(chat-completions SSE, fragmented tool-call accumulation, loud-EOF/error-frame
semantics from the review fixes). Moonshot/Kimi, Groq, OpenRouter, LM Studio, and vLLM
all speak the same wire with different base URLs and auth.

## Decision

Extract the OpenAI-wire logic from `src/providers/ollama.ts` into a shared
`src/providers/openai-compat.ts` core (request mapping, SSE parsing, tool-call
accumulation, usage/stop/error mapping). `ollama.ts` becomes a thin wrapper (public
API, env, /v1 normalization, model_not_found semantics unchanged — its test suite must
stay green UNMODIFIED as the regression proof). New `src/providers/openai.ts`
implements the contracts Provider via the shared core: options `{baseUrl (default
https://api.openai.com/v1), apiKey (Bearer), timeoutMs, fetchImpl}`, env
`VOID_OPENAI_BASE_URL` / `VOID_OPENAI_KEY` (opts win). ModelRef prefix `openai/`
resolves through `src/app/models.ts` as a passthrough (like ollama). Endpoint binding
is env/option-driven per ADR-0009.

## Consequences

One wire implementation, many providers; Kimi hosted becomes usable via
`VOID_OPENAI_BASE_URL=https://api.moonshot.ai/v1`. Risk: the extraction is the
highest-regression refactor of this push — mitigated by the unmodified-ollama-tests
gate plus a mirrored openai test suite. Future OpenAI-wire extensions (reasoning
fields, vendor quirks) land in one place.
