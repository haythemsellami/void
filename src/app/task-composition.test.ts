/**
 * Task-tool composition tests (ADR-0013) — AGENTS.md working agreement: the
 * REAL composition path (runCli → runTask → engine → gated builtins → the
 * task tool's own child runConversation) with only the documented injection
 * seams (deps.fetchImpl scripted SSE, deps.dataDir). The provider fixture is
 * ONE queue serving both conversations: parent and child requests are told
 * apart by their system prompts (parent = the default system prompt's "You
 * are Void" opener; child = the explorer preset's "explorer subagent"
 * opener). The child's read_file runs for real against a fixture file, so
 * these tests are node-based only and run under both runners.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CliDeps, runCli } from "../cli";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-task-comp-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted anthropic SSE (the real adapter parses these) — same shapes as
// cli-composition.test.ts, kept local so both files stay self-contained.
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

interface ParsedRequest {
  readonly system: string | undefined;
  readonly tools: readonly { name: string }[];
  readonly messages: readonly { role: string }[];
  readonly raw: string;
}

interface Harness {
  readonly deps: CliDeps;
  readonly out: string[];
  readonly requests: ParsedRequest[];
}

function makeHarness(options: {
  readonly cwd: string;
  readonly rounds: readonly string[];
}): Harness {
  const out: string[] = [];
  const requests: ParsedRequest[] = [];
  const queue = [...options.rounds];
  const deps: CliDeps = {
    stdout: (line) => {
      out.push(line);
    },
    stderr: () => {},
    env: { VOID_ANTHROPIC_KEY: "test-key" },
    cwd: options.cwd,
    dataDir: mkdtempSync(join(scratch, "data-")),
    fetchImpl: (url: string, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(raw) as {
        system?: string;
        tools?: { name: string }[];
        messages?: { role: string }[];
      };
      requests.push({
        system: parsed.system,
        tools: parsed.tools ?? [],
        messages: parsed.messages ?? [],
        raw,
      });
      void url;
      return Promise.resolve(
        new Response(queue.shift() ?? textRoundSse("unexpected extra round"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  };
  return { deps, out, requests };
}

/** The task tool_result text the parent's round-2 request carried back. */
function parentTaskResult(requests: readonly ParsedRequest[], toolUseId: string): string {
  for (const request of requests) {
    const parsed = JSON.parse(request.raw) as {
      messages?: readonly {
        role?: string;
        content?: readonly {
          type?: string;
          tool_use_id?: string;
          content?: readonly { text?: string }[] | string;
        }[];
      }[];
    };
    for (const message of parsed.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
          return typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((part) => part.text ?? "").join("\n");
        }
      }
    }
  }
  throw new Error(`no tool_result for ${toolUseId} in any provider request`);
}

describe("CLI composition: task tool (real dispatch path, ADR-0013)", () => {
  it("parent round calls task → child investigates read-only → findings return as the tool_result", async () => {
    const workspace = mkdtempSync(join(scratch, "task-ws-"));
    writeFileSync(join(workspace, "facts.txt"), "task-composition-marker-42\nsecond line\n");

    const childRead = toolRoundSse("child-read-1", "read_file", {
      path: join(workspace, "facts.txt"),
    });
    const taskCall = toolRoundSse("call-task-1", "task", {
      description: "find the marker",
      prompt: "Read facts.txt and report the marker value.",
    });
    const harness = makeHarness({
      cwd: workspace,
      // ONE queue, TWO conversations in real time order:
      // parent round 1 (task call) → child round 1 (read_file) → child final
      // text → parent final text.
      rounds: [
        taskCall,
        childRead,
        textRoundSse("FINDINGS: marker is task-composition-marker-42"),
        textRoundSse("all done"),
      ],
    });

    const code = await runCli(
      ["run", "--workspace", workspace, "please investigate the fixture"],
      harness.deps,
    );
    expect(code).toBe(0);
    expect(harness.requests).toHaveLength(4);

    // init event advertises task alongside the other builtins.
    const init = JSON.parse(harness.out[0] ?? "{}") as { type?: string; tools?: string[] };
    expect(init.type).toBe("system");
    expect(init.tools).toContain("task");

    // Request 1: the PARENT round (default system prompt) asking for `task`.
    expect(harness.requests[0]?.system).toContain("You are Void");
    expect(harness.requests[0]?.tools.map((tool) => tool.name)).toContain("task");

    // Request 2: the CHILD conversation — explorer preset + assignment
    // framing as its system prompt, and ONLY the read-only tool subset.
    const child = harness.requests[1];
    expect(child?.system).toContain("explorer subagent");
    expect(child?.system).toContain("find the marker");
    expect(child?.system).toContain("Read facts.txt and report the marker value.");
    const childTools = child?.tools.map((tool) => tool.name) ?? [];
    expect(childTools).toEqual([
      "async_shell_command_kill",
      "async_shell_command_status",
      "glob",
      "grep",
      "read_file",
    ]);
    // Message isolation: the child starts from the kickoff only — the
    // parent's task text never enters the child transcript.
    expect(child?.messages[0]?.role).toBe("user");
    expect(child?.raw).toContain("Begin the task now.");
    expect(child?.raw).not.toContain("please investigate the fixture");

    // The real read_file ran inside the child: round 3 (child final) carries
    // the actual fixture content in its history.
    expect(harness.requests[2]?.raw).toContain("task-composition-marker-42");

    // The findings + accounting line return to the parent as the tool_result.
    const taskResult = parentTaskResult(harness.requests, "call-task-1");
    expect(taskResult).toContain("FINDINGS: marker is task-composition-marker-42");
    expect(taskResult).toMatch(
      /\[task mode=explorer stop=end_turn rounds=2 tokens_in=\d+ tokens_out=\d+\]/,
    );

    // The parent finished on its own next round with the findings in context.
    expect(harness.requests[3]?.system).toContain("You are Void");
    expect(harness.requests[3]?.raw).toContain("FINDINGS: marker is task-composition-marker-42");

    // The thread log records ONLY the parent's two assistant rounds: the
    // child is not persisted (ADR-0013 — no child threads at P1).
    const initEvent = JSON.parse(harness.out[0] ?? "{}") as { thread_id?: string };
    const logPath = join(harness.deps.dataDir ?? "", "threads", `${initEvent.thread_id}.jsonl`);
    const log = readFileSync(logPath, "utf8");
    const types = log
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types.filter((type) => type === "assistant_message")).toHaveLength(2);
    expect(types.filter((type) => type === "tool_call")).toHaveLength(1);
    expect(log).not.toContain("Begin the task now.");
    expect(log).toContain('"name":"task"');
  });

  it('child runs under caller "subagent": a subagent-scoped rule restricts the child, not the parent', async () => {
    const workspace = mkdtempSync(join(scratch, "task-sub-ws-"));
    writeFileSync(join(workspace, "facts.txt"), "never-read-in-child\n");
    // Workspace settings (ADR-0006): rules merge BEFORE the defaults, so this
    // subagent-scoped reject is consulted first — only inside children (the
    // ADR-0013 seam exercised through the real settings path).
    const settingsDir = join(workspace, ".void");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        settingsVersion: 1,
        permissions: [
          {
            tool: "read_file",
            matches: "*",
            context: "subagent",
            action: "reject",
            message: "reads are banned in subagents (composition fixture)",
          },
        ],
      }),
    );

    const taskCall = toolRoundSse("call-task-2", "task", {
      description: "try to read",
      prompt: "Read facts.txt.",
    });
    const childRead = toolRoundSse("child-read-2", "read_file", {
      path: join(workspace, "facts.txt"),
    });
    const harness = makeHarness({
      cwd: workspace,
      rounds: [taskCall, childRead, textRoundSse("denied, reporting"), textRoundSse("understood")],
    });

    const code = await runCli(["run", "--workspace", workspace, "investigate"], harness.deps);
    expect(code).toBe(0); // the denial is the child's tool result, not the run's

    // The child's round-2 request carries the subagent-scoped rejection…
    expect(harness.requests[2]?.raw).toContain("Permission denied for read_file");
    expect(harness.requests[2]?.raw).toContain("reads are banned in subagents");
    expect(harness.requests[2]?.raw).not.toContain("never-read-in-child"); // never executed

    // …while the parent's own `task` call (and any parent read_file) is
    // untouched by the rule, and the child still completes and reports back.
    const taskResult = parentTaskResult(harness.requests, "call-task-2");
    expect(taskResult).toContain("denied, reporting");
    expect(taskResult).toMatch(/\[task mode=explorer stop=end_turn rounds=2/);
  });
});
