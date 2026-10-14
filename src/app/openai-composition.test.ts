/**
 * OpenAI-provider composition tests (roadmap workstream 5 / ADR-0010) — the
 * AGENTS.md working agreement made binding by the v0.1.0 review: changes to
 * `src/cli.ts` or `src/app/runner.ts` composition need at least one test
 * driving the REAL composition path, not injected seams.
 *
 * Everything here goes through `runCli` → `runTask` → `resolveProvider` →
 * the REAL OpenAIProvider (over the shared openai-compat core), with only the
 * documented injection seams (`deps.env`, `deps.fetchImpl`, `deps.dataDir`).
 * It pins the wiring the CLI review blockers were made of: the
 * VOID_OPENAI_BASE_URL / VOID_OPENAI_KEY env vars must actually reach the
 * adapter (endpoint + Bearer header), and the `openai/` ModelRef prefix must
 * resolve and be stripped end-to-end.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliDeps } from "../cli";
import { runCli } from "../cli";
import { resolveModel } from "./models";
import { resolveProvider } from "./runner";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-openai-comp-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted OpenAI-wire SSE (the real adapter parses these)
// ---------------------------------------------------------------------------

function openAiTextRound(text: string): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

interface Captured {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

// ---------------------------------------------------------------------------
// Registry + provider construction units (kept here, not in models/runner
// test files, to leave those shared files untouched for parallel workstreams)
// ---------------------------------------------------------------------------

describe("openai composition units", () => {
  it("resolveModel passes openai/<id> through as providerKind openai", () => {
    expect(resolveModel("openai/moonshot-v1-auto")).toEqual({
      providerKind: "openai",
      modelId: "moonshot-v1-auto",
    });
  });

  it("resolveProvider builds the openai adapter from its options", () => {
    const provider = resolveProvider("openai/some-model", {
      openaiBaseUrl: "http://vllm.local:8000/v1",
      openaiApiKey: "sk-x",
    });
    expect(provider.id).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// The real CLI path (both runners): env → runner options → adapter wire
// ---------------------------------------------------------------------------

describe("CLI composition: openai provider env wiring (real path)", () => {
  it("VOID_OPENAI_BASE_URL/VOID_OPENAI_KEY reach the adapter: endpoint, Bearer header, stripped model", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-"));
    const dataDir = mkdtempSync(join(scratch, "data-"));
    const captured: Captured[] = [];
    const deps: CliDeps = {
      stdout: () => {},
      stderr: () => {},
      env: {
        VOID_MODEL: "openai/comp-model",
        VOID_OPENAI_BASE_URL: "https://api.moonshot.test/v1",
        VOID_OPENAI_KEY: "sk-comp-secret",
      },
      cwd: workspace,
      dataDir,
      fetchImpl: (url, init) => {
        const headers =
          init?.headers !== undefined && typeof init.headers === "object"
            ? (init.headers as Record<string, string>)
            : {};
        const raw = typeof init?.body === "string" ? init.body : "";
        let body: unknown = raw;
        try {
          body = raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        captured.push({ url, authorization: headers.authorization, body });
        return Promise.resolve(
          new Response(openAiTextRound("done"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    };

    const code = await runCli(["run", "--workspace", workspace, "compose me a haiku"], deps);

    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    // Env-driven endpoint binding (ADR-0009): the env base URL — not the
    // api.openai.com default — is where the request went, /v1 not doubled.
    expect(captured[0]?.url).toBe("https://api.moonshot.test/v1/chat/completions");
    // The env key traveled as the Bearer credential.
    expect(captured[0]?.authorization).toBe("Bearer sk-comp-secret");
    // The openai/ prefix never reaches the wire.
    const body = captured[0]?.body as Record<string, unknown> | undefined;
    expect(body?.model).toBe("comp-model");
    expect(body?.stream).toBe(true);
  });
});
