/**
 * CLI composition tests for skills (ADR-0012) — AGENTS.md working agreement:
 * changes to `src/cli.ts` / the runner wiring under it need tests driving the
 * REAL composition path. Everything here goes through `runCli` → `runTask` →
 * engine → the real permission gate + real builtin registry (skill /
 * reload_skills included) with only the documented injection seams
 * (`deps.env`, `deps.fetchImpl`, `deps.dataDir`), against real temp-dir
 * workspaces. The provider is the REAL anthropic adapter parsing scripted
 * SSE, so these run under both test runners.
 *
 * Covers the four load-bearing wiring facts:
 *  1. a workspace skill is listed in the system prompt (name + description
 *     ONLY — the body must NOT leak into the prompt) and the init event
 *     advertises the skill tools;
 *  2. a scripted model round calling the `skill` tool by name gets the body
 *     (+ bundled resources) back as the tool result that reaches the next
 *     provider request;
 *  3. `settings effective`'s `skills.path` key actually DOES something — a
 *     skills.path root's skill reaches the prompt and is loadable (never an
 *     inert key);
 *  4. an invalid skill fails the run LOUDLY (exit 3, stderr file+key) before
 *     any provider round.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CliDeps, runCli } from "../cli";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-skills-comp-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted anthropic SSE (the real adapter parses these)
// ---------------------------------------------------------------------------

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textRoundSse(text: string): string {
  return [
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_1", role: "assistant", usage: { input_tokens: 25, output_tokens: 1 } },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 7 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

function toolRoundSse(id: string, name: string, input: Record<string, string>): string {
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        role: "assistant",
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

// ---------------------------------------------------------------------------
// runCli harness (injected deps + scripted provider fetch, real everything else)
// ---------------------------------------------------------------------------

interface Harness {
  readonly deps: CliDeps;
  readonly out: string[];
  readonly err: string[];
  /** Every provider request body, in order. */
  readonly requests: string[];
}

function makeHarness(options: {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly rounds: readonly string[];
}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const queue = [...options.rounds];
  const deps: CliDeps = {
    stdout: (line) => {
      out.push(line);
    },
    stderr: (line) => {
      err.push(line);
    },
    env: options.env,
    cwd: options.cwd,
    dataDir: mkdtempSync(join(scratch, "data-")),
    fetchImpl: (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push(body);
      return Promise.resolve(
        new Response(queue.shift() ?? textRoundSse("unexpected extra round"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  };
  return { deps, out, err, requests };
}

function events(out: readonly string[]): Record<string, unknown>[] {
  return out.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function initEvent(out: readonly string[]): Record<string, unknown> {
  const first = events(out)[0];
  expect(first?.type).toBe("system");
  return first as Record<string, unknown>;
}

function resultEvent(out: readonly string[]): Record<string, unknown> {
  const last = events(out).at(-1);
  expect(last?.type).toBe("result");
  return last as Record<string, unknown>;
}

/** The system prompt of the Nth provider request (1-based). */
function systemPromptOf(requests: readonly string[], round: number): string {
  const body = requests[round - 1];
  expect(body).toBeDefined();
  const parsed = JSON.parse(body as string) as { system?: unknown };
  return typeof parsed.system === "string" ? parsed.system : JSON.stringify(parsed.system);
}

/** The FULL tool-result text sent back to the provider (uncapped). */
function fullToolResult(
  requests: readonly string[],
  toolUseId: string,
): { readonly text: string; readonly isError: boolean } {
  for (const body of requests) {
    const parsed = JSON.parse(body) as {
      messages?: readonly {
        role?: string;
        content?: readonly {
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: readonly { text?: string }[] | string;
        }[];
      }[];
    };
    for (const message of parsed.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
          const text =
            typeof block.content === "string"
              ? block.content
              : (block.content ?? []).map((part) => part.text ?? "").join("\n");
          return { text, isError: block.is_error === true };
        }
      }
    }
  }
  throw new Error(`no tool_result for ${toolUseId} in any provider request`);
}

function writeSkill(
  dir: string,
  name: string,
  options: { readonly description?: string; readonly body?: string; readonly text?: string } = {},
): { readonly file: string; readonly dir: string } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    options.text ??
      `---\nname: ${name}\ndescription: ${options.description ?? `${name} description`}\n---\n${options.body ?? `${name} BODY-MARKER`}\n`,
  );
  return { file, dir };
}

// ---------------------------------------------------------------------------
// 1+2: valid workspace skill — prompt list without body; skill tool round
// ---------------------------------------------------------------------------

describe("CLI composition: skills (valid workspace skill, real dispatch path)", () => {
  it("prompt lists name+description but never the body; init advertises the skill tools", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-"));
    writeSkill(join(workspace, ".agents", "skills", "release-helper"), "release-helper", {
      description: "Draft release notes from git history",
      body: "SECRET-BODY-INSTRUCTIONS release-helper BODY-MARKER",
    });
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key", HOME: mkdtempSync(join(scratch, "home-")) },
      cwd: workspace,
      rounds: [textRoundSse("ok")],
    });

    const code = await runCli(["run", "--workspace", workspace, "do the thing"], harness.deps);
    expect(code).toBe(0);

    const init = initEvent(harness.out);
    expect(init.tools).toContain("skill");
    expect(init.tools).toContain("reload_skills");

    const system = systemPromptOf(harness.requests, 1);
    expect(system).toContain("# Skills");
    expect(system).toContain("- release-helper — Draft release notes from git history");
    expect(system).toContain("`skill` tool");
    // Lazy injection: the body must NOT ride along in the prompt.
    expect(system).not.toContain("SECRET-BODY-INSTRUCTIONS");
    expect(system).not.toContain("BODY-MARKER");
  });

  it("a skill tool round returns the body + resources and they reach the next provider request", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-tool-"));
    const skillDir = join(workspace, ".agents", "skills", "commit-helper");
    writeSkill(skillDir, "commit-helper", {
      description: "Write conventional commits",
      body: "COMMIT-SKILL-BODY Follow the conventional commit types.\nSecond line.",
    });
    mkdirSync(join(skillDir, "references"));
    writeFileSync(join(skillDir, "references", "types.md"), "feat fix chore\n");

    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key", HOME: mkdtempSync(join(scratch, "home-tool-")) },
      cwd: workspace,
      rounds: [
        toolRoundSse("call-skill-1", "skill", { name: "commit-helper" }),
        textRoundSse("done"),
      ],
    });

    const code = await runCli(["run", "--workspace", workspace, "commit this"], harness.deps);
    expect(code).toBe(0);

    const result = fullToolResult(harness.requests, "call-skill-1");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("# Skill: commit-helper");
    expect(result.text).toContain("COMMIT-SKILL-BODY Follow the conventional commit types.");
    expect(result.text).toContain("- references/types.md");

    // The tool result is folded into the SECOND provider request verbatim.
    expect(harness.requests[1]).toContain("COMMIT-SKILL-BODY");
    expect(harness.requests[1]).toContain("references/types.md");
  });

  it("unknown skill name returns a structured not_found the model can recover from", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-unknown-"));
    writeSkill(join(workspace, ".agents", "skills", "known"), "known-skill");
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key", HOME: mkdtempSync(join(scratch, "home-unk-")) },
      cwd: workspace,
      rounds: [
        toolRoundSse("call-skill-2", "skill", { name: "missing-skill" }),
        textRoundSse("recovered"),
      ],
    });
    const code = await runCli(["run", "--workspace", workspace, "try it"], harness.deps);
    expect(code).toBe(0);
    const result = fullToolResult(harness.requests, "call-skill-2");
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"missing-skill"');
    expect(result.text).toContain("known-skill");
  });

  it("a workspace WITHOUT skills stays on the baseline: no skill tools, no Skills section", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-none-"));
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key", HOME: mkdtempSync(join(scratch, "home-none-")) },
      cwd: workspace,
      rounds: [textRoundSse("ok")],
    });
    const code = await runCli(["run", "--workspace", workspace, "plain"], harness.deps);
    expect(code).toBe(0);
    const init = initEvent(harness.out);
    expect(init.tools).not.toContain("skill");
    expect(init.tools).not.toContain("reload_skills");
    expect(systemPromptOf(harness.requests, 1)).not.toContain("# Skills");
  });
});

// ---------------------------------------------------------------------------
// 3: settings `skills.path` is CONSUMED here (binding: never an inert key)
// ---------------------------------------------------------------------------

describe("CLI composition: settings skills.path consumption (real dispatch path)", () => {
  it("a skills.path root's skill reaches the prompt and is loadable through the skill tool", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-settings-"));
    const extraRoot = mkdtempSync(join(scratch, "extra-root-"));
    writeSkill(join(extraRoot, "deploy-helper"), "deploy-helper", {
      description: "Ship to production safely",
      body: "DEPLOY-SKILL-BODY run the deploy script",
    });
    mkdirSync(join(workspace, ".void"));
    writeFileSync(
      join(workspace, ".void", "settings.json"),
      JSON.stringify({ settingsVersion: 1, skills: { path: extraRoot } }),
    );

    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key", HOME: mkdtempSync(join(scratch, "home-set-")) },
      cwd: workspace,
      rounds: [
        toolRoundSse("call-skill-3", "skill", { name: "deploy-helper" }),
        textRoundSse("deployed"),
      ],
    });
    const code = await runCli(["run", "--workspace", workspace, "deploy"], harness.deps);
    expect(code).toBe(0);

    expect(systemPromptOf(harness.requests, 1)).toContain(
      "- deploy-helper — Ship to production safely",
    );
    const result = fullToolResult(harness.requests, "call-skill-3");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("DEPLOY-SKILL-BODY");
  });
});

// ---------------------------------------------------------------------------
// 4: invalid skill — loud failure before any provider round
// ---------------------------------------------------------------------------

describe("CLI composition: invalid skill fails loud (real dispatch path)", () => {
  it("exit 3, stderr names file + key, error_run result, zero provider rounds", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-invalid-"));
    const { file } = writeSkill(join(workspace, ".agents", "skills", "broken"), "broken-skill", {
      text: "---\nname: broken-skill\ndescription: d\nallowedTools: bash\n---\nbody\n",
    });
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key", HOME: mkdtempSync(join(scratch, "home-bad-")) },
      cwd: workspace,
      rounds: [textRoundSse("never reached")],
    });

    const code = await runCli(["run", "--workspace", workspace, "anything"], harness.deps);
    expect(code).toBe(3);

    const stderr = harness.err.join("\n");
    expect(stderr).toContain(file);
    expect(stderr).toContain("allowedTools");
    expect(stderr).toContain("unknown frontmatter key");

    const result = resultEvent(harness.out);
    expect(result.subtype).toBe("error_run");
    expect(String(result.error)).toContain("invalid skills");
    // Fail closed BEFORE spending a provider round on a broken skills set.
    expect(harness.requests).toHaveLength(0);
  });
});
