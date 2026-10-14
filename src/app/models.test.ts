/** Tests for the local model registry (src/app/models). */
import { describe, expect, it } from "vitest";
import {
  CUSTOM_FALLBACK_CONTEXT_WINDOW,
  DEFAULT_MODEL_REF,
  knownModels,
  resolveDefaultModelRef,
  resolveModel,
} from "./models";

describe("resolveModel", () => {
  it("resolves the default Anthropic entry with its context window", () => {
    expect(resolveModel(DEFAULT_MODEL_REF)).toEqual({
      providerKind: "anthropic",
      modelId: "claude-sonnet-4-5",
      contextWindow: 200_000,
    });
  });

  it("resolves every known registry entry", () => {
    for (const entry of knownModels()) {
      const ref = `${entry.providerKind}/${entry.modelId}`;
      expect(resolveModel(ref)).toEqual(entry);
    }
    expect(knownModels().length).toBeGreaterThanOrEqual(3);
  });

  it("resolves the GLM entries (Z.AI's Anthropic-compatible endpoint; needs VOID_ANTHROPIC_BASE_URL)", () => {
    expect(resolveModel("anthropic/glm-4.6")).toEqual({
      providerKind: "anthropic",
      modelId: "glm-4.6",
      contextWindow: 200_000,
    });
    expect(resolveModel("anthropic/glm-4.7")).toEqual({
      providerKind: "anthropic",
      modelId: "glm-4.7",
      contextWindow: 200_000,
    });
  });

  it("falls back for unlisted anthropic model ids", () => {
    expect(resolveModel("anthropic/claude-sonnet-9-20990101")).toEqual({
      providerKind: "anthropic",
      modelId: "claude-sonnet-9-20990101",
      contextWindow: CUSTOM_FALLBACK_CONTEXT_WINDOW,
    });
  });

  it("passes ollama refs through with no fixed context window", () => {
    expect(resolveModel("ollama/qwen3:14b")).toEqual({
      providerKind: "ollama",
      modelId: "qwen3:14b",
    });
  });

  it("passes openai refs through (ADR-0010: the backing service sets the window)", () => {
    expect(resolveModel("openai/gpt-5")).toEqual({
      providerKind: "openai",
      modelId: "gpt-5",
    });
  });

  it("marks unknown prefixes as custom (provider construction rejects them)", () => {
    expect(resolveModel("mystery/gpt-5")).toEqual({
      providerKind: "custom",
      modelId: "gpt-5",
      contextWindow: CUSTOM_FALLBACK_CONTEXT_WINDOW,
    });
  });

  it("marks bare refs (no slash) as custom", () => {
    expect(resolveModel("some-model")).toEqual({
      providerKind: "custom",
      modelId: "some-model",
      contextWindow: CUSTOM_FALLBACK_CONTEXT_WINDOW,
    });
  });
});

describe("resolveDefaultModelRef", () => {
  it("uses VOID_MODEL when set", () => {
    expect(resolveDefaultModelRef({ VOID_MODEL: "ollama/llama3.3" })).toBe("ollama/llama3.3");
  });

  it("ignores empty or whitespace VOID_MODEL", () => {
    expect(resolveDefaultModelRef({ VOID_MODEL: "" })).toBe(DEFAULT_MODEL_REF);
    expect(resolveDefaultModelRef({ VOID_MODEL: "   " })).toBe(DEFAULT_MODEL_REF);
    expect(resolveDefaultModelRef({})).toBe(DEFAULT_MODEL_REF);
  });

  it("default is the documented placeholder", () => {
    expect(DEFAULT_MODEL_REF).toBe("anthropic/claude-sonnet-4-5");
    expect(CUSTOM_FALLBACK_CONTEXT_WINDOW).toBe(200_000);
  });
});
