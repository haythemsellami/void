/**
 * `src/app/models` — the minimal local model registry
 * (docs/architecture.md §providers: "model registry is a local file").
 *
 * A ModelRef is `<providerKind>/<modelId>` (e.g. "anthropic/claude-sonnet-4-5",
 * "ollama/qwen3:14b"). Resolution is total — it never throws:
 *
 * - known registry entries return their metadata (context window included);
 * - `anthropic/<unlisted-id>` resolves with the custom-fallback context
 *   window (new Anthropic model ids keep working before the registry learns
 *   them);
 * - `ollama/<id>` is a pure passthrough (local models have no fixed window);
 * - `openai/<id>` is likewise a passthrough: it routes to the generic
 *   OpenAI-compatible adapter, whose endpoint `VOID_OPENAI_BASE_URL` selects
 *   — OpenAI (default), Kimi/Moonshot, Groq, OpenRouter, LM Studio, vLLM.
 *   Examples: `openai/gpt-5.5`; `openai/moonshot-v1-auto` with
 *   `VOID_OPENAI_BASE_URL=https://api.moonshot.ai/v1`;
 *   `openai/llama-3.3-70b-versatile` with
 *   `VOID_OPENAI_BASE_URL=https://api.groq.com/openai/v1`;
 *   `openai/qwen3-32b` with `VOID_OPENAI_BASE_URL=http://localhost:1234/v1`
 *   (LM Studio). No fixed window: the backing service decides.
 * - anything else (unknown prefix or bare id) resolves to a `custom` entry —
 *   informational only; provider construction rejects it with guidance.
 *
 * GLM entries (`anthropic/glm-4.6`, `anthropic/glm-4.7`) run on Z.AI's
 * Anthropic-compatible endpoint, not Anthropic's own: they require
 * `VOID_ANTHROPIC_BASE_URL=https://api.z.ai/anthropic` plus a Z.AI key in
 * `VOID_ANTHROPIC_KEY` (see README §Environment variables).
 *
 * Default model resolution: `--model` flag > `$VOID_MODEL` > the settings
 * `defaultModel` layers (ADR-0006, incl. the `$VOID_DEFAULT_MODEL` shadow) >
 * {@link DEFAULT_MODEL_REF}. The default is an explicit, documented
 * placeholder the user is expected to override (env or flag); it carries no
 * vendor coupling beyond "sensible current default".
 */

/** Kind of the adapter a ModelRef routes to. `custom` = unrecognized prefix. */
export type ProviderKind = "anthropic" | "ollama" | "custom" | (string & {});

/** One resolved model: which adapter runs it and what we know about it. */
export interface ModelEntry {
  readonly providerKind: ProviderKind;
  readonly modelId: string;
  /** Context window in tokens, when known; unknown models fall back to 200k. */
  readonly contextWindow?: number;
}

/**
 * The fallback context window for refs the registry does not know
 * (deliberately conservative-ish so local guards have something to work with).
 */
export const CUSTOM_FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * Default model when neither `--model` nor `$VOID_MODEL` says otherwise.
 * PLACEHOLDER, user-overridable: a sensible current Claude Sonnet id. Void
 * ships no vendor coupling to it — set VOID_MODEL or pass --model.
 */
export const DEFAULT_MODEL_REF = "anthropic/claude-sonnet-4-5";

const ANTHROPIC_WINDOW = 200_000;

/** The known registry. Keep tiny and current; unknown ids fall back cleanly. */
const REGISTRY: ReadonlyMap<string, ModelEntry> = new Map([
  [
    "anthropic/claude-sonnet-4-5",
    { providerKind: "anthropic", modelId: "claude-sonnet-4-5", contextWindow: ANTHROPIC_WINDOW },
  ],
  [
    "anthropic/claude-opus-4-5",
    { providerKind: "anthropic", modelId: "claude-opus-4-5", contextWindow: ANTHROPIC_WINDOW },
  ],
  [
    "anthropic/claude-haiku-4-5",
    { providerKind: "anthropic", modelId: "claude-haiku-4-5", contextWindow: ANTHROPIC_WINDOW },
  ],
  // GLM via Z.AI's Anthropic-compatible endpoint — needs the base-URL env
  // override documented in the module doc above.
  [
    "anthropic/glm-4.6",
    { providerKind: "anthropic", modelId: "glm-4.6", contextWindow: ANTHROPIC_WINDOW },
  ],
  [
    "anthropic/glm-4.7",
    { providerKind: "anthropic", modelId: "glm-4.7", contextWindow: ANTHROPIC_WINDOW },
  ],
]);

/** Registry snapshot for tools like `void models` (display-only at MVP). */
export function knownModels(): readonly ModelEntry[] {
  return [...REGISTRY.values()];
}

/**
 * Resolve a ModelRef to its {@link ModelEntry}. Total function: unknown refs
 * produce a custom-fallback entry instead of throwing (see module doc).
 */
export function resolveModel(ref: string): ModelEntry {
  const known = REGISTRY.get(ref);
  if (known !== undefined) {
    return known;
  }
  const slash = ref.indexOf("/");
  if (slash <= 0) {
    return { providerKind: "custom", modelId: ref, contextWindow: CUSTOM_FALLBACK_CONTEXT_WINDOW };
  }
  const prefix = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  if (prefix === "anthropic") {
    return {
      providerKind: "anthropic",
      modelId,
      contextWindow: CUSTOM_FALLBACK_CONTEXT_WINDOW,
    };
  }
  if (prefix === "ollama") {
    return { providerKind: "ollama", modelId }; // passthrough: no fixed window
  }
  if (prefix === "openai") {
    return { providerKind: "openai", modelId }; // passthrough: window depends on the backing service
  }
  return { providerKind: "custom", modelId, contextWindow: CUSTOM_FALLBACK_CONTEXT_WINDOW };
}

/**
 * Default-model precedence: explicit flag (checked by the caller) is applied
 * before this; here it is `$VOID_MODEL` > {@link DEFAULT_MODEL_REF}. Empty or
 * whitespace env values are ignored.
 */
export function resolveDefaultModelRef(env: { readonly VOID_MODEL?: string | undefined }): string {
  const value = env.VOID_MODEL?.trim();
  return value !== undefined && value !== "" ? value : DEFAULT_MODEL_REF;
}
