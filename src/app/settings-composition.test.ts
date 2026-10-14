/**
 * Settings composition tests — the AGENTS.md working agreement applied to
 * this workstream: changes to `src/cli.ts` composition need tests driving the
 * REAL path (runCli → runTask → engine → gate → real builtin tools), not
 * injected component seams. Everything here proves ADR-0006 end-to-end:
 *
 * - a user-scope settings file with a permission rule changes a real run's
 *   outcome (`date` is ask-by-default headless-denied; a user allow rule lets
 *   it through) — through the REAL CLI path with temp XDG injection;
 * - the amended merge order is load-bearing: a workspace REJECT beats a user
 *   ALLOW for the same command (workspace rules are consulted first);
 * - settings `defaultModel` reaches the real init event under the documented
 *   precedence (--model > VOID_MODEL > files > builtin).
 *
 * The provider is the REAL anthropic adapter over an injected scripted SSE
 * fetch (same pattern as cli-composition.test.ts); the bash tool executes
 * for real where the OS sandbox allows it — assertions are written to hold
 * on sandbox-less hosts too (a permission `allow` is what flips the exit
 * code; a sandbox refusal is a tool error, not a denial).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CliDeps, runCli } from "../cli";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-set-comp-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted anthropic SSE (the real adapter parses these) — same shapes as
// cli-composition.test.ts.
// ---------------------------------------------------------------------------

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A tool_use round whose reported usage blows past a threshold (R1
 * fixture): input_tokens ~1.79M against the anthropic 200k window at 90%.
 * The round ends with tool_use so the engine continues to another round —
 * an end_turn here would finish the conversation before the pre-round
 * threshold check could ever fire. */
function bigToolRoundSse(id: string, text: string): string {
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        role: "assistant",
        usage: { input_tokens: 1_790_000, output_tokens: 10 },
      },
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
    frame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id, name: "bash" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: `{"command":"echo ${id}"}` },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 1 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 1_790_000, output_tokens: 10 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
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
// Harness: temp XDG config home + temp workspace, injected env + fetch.
// ---------------------------------------------------------------------------

interface Harness {
  readonly deps: CliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly requests: string[];
  readonly xdg: string;
  readonly ws: string;
}

function makeHarness(rounds: readonly string[]): Harness {
  const xdg = mkdtempSync(join(scratch, "xdg-"));
  const ws = mkdtempSync(join(scratch, "ws-"));
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const queue = [...rounds];
  const deps: CliDeps = {
    stdout: (line) => {
      out.push(line);
    },
    stderr: (line) => {
      err.push(line);
    },
    // XDG_CONFIG_HOME is the ONLY settings-related env injected — exactly how
    // a real user's environment would point Void at their config directory.
    env: { XDG_CONFIG_HOME: xdg, VOID_ANTHROPIC_KEY: "test-key" },
    cwd: ws,
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
  return { deps, out, err, requests, xdg, ws };
}

/** Write a user-scope settings file under the harness's XDG config home. */
function writeUserSettings(harness: Harness, body: string): string {
  const dir = join(harness.xdg, "void");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(path, body);
  return path;
}

/** Write a workspace-scope settings file at the harness workspace root. */
function writeWorkspaceSettings(harness: Harness, body: string): string {
  const dir = join(harness.ws, ".void");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(path, body);
  return path;
}

interface StreamEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

function events(out: readonly string[]): StreamEvent[] {
  return out.map((line) => JSON.parse(line) as StreamEvent);
}

function permissionEvents(out: readonly string[]): StreamEvent[] {
  return events(out).filter((event) => event.type === "permission");
}

/** The FULL tool-result body the provider received for one tool_use id. */
function toolResultText(requests: readonly string[], toolUseId: string): string {
  for (const body of requests) {
    const parsed = JSON.parse(body) as {
      messages?: readonly {
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

/** `date`: single plain command — not on the default read-only allow list,
 * not catastrophic: no default rule matches, so the no-match policy asks. */
const DATE_TOOL_ROUND = toolRoundSse("call-date", "bash", { command: "date" });

// ---------------------------------------------------------------------------

describe("settings composition (real CLI path, temp XDG injection)", () => {
  it("defaults deny-by-asking: unmatched bash command exits 1 with a permission denial", async () => {
    const h = makeHarness([DATE_TOOL_ROUND, textRoundSse("done")]);
    const code = await runCli(["run", "--workspace", h.ws, "what time is it"], h.deps);
    expect(code).toBe(1); // ask hit headless → exit 1
    const [permission] = permissionEvents(h.out);
    expect(permission?.decision).toBe("ask");
    expect(toolResultText(h.requests, "call-date")).toContain("Permission denied");
  });

  it("A USER SETTINGS FILE CHANGES THE OUTCOME: allow rule → same command runs, exit 0", async () => {
    const h = makeHarness([DATE_TOOL_ROUND, textRoundSse("done")]);
    writeUserSettings(
      h,
      JSON.stringify({
        settingsVersion: 1,
        permissions: [{ tool: "bash", matches: { command: "/^date$/" }, action: "allow" }],
      }),
    );
    const code = await runCli(["run", "--workspace", h.ws, "what time is it"], h.deps);
    expect(code).toBe(0); // allowed: neither ask nor reject occurred
    const [permission] = permissionEvents(h.out);
    expect(permission?.decision).toBe("allow");
    // The tool actually executed (or failed on a sandbox-less host with a
    // TOOL error) — either way the result is NOT a permission denial.
    const result = toolResultText(h.requests, "call-date");
    expect(result).not.toContain("Permission denied");
    // On a host with a working OS sandbox the command really ran and printed
    // a calendar date; assert that only when the output says it did.
    if (!result.includes("sandbox")) {
      expect(result).toMatch(/\d{4}/);
    }
  });

  it("AMENDED ORDER through the real path: workspace reject outranks user allow (exit 2)", async () => {
    const h = makeHarness([DATE_TOOL_ROUND, textRoundSse("done")]);
    writeUserSettings(
      h,
      JSON.stringify({
        settingsVersion: 1,
        permissions: [{ tool: "bash", matches: { command: "/^date$/" }, action: "allow" }],
      }),
    );
    writeWorkspaceSettings(
      h,
      JSON.stringify({
        settingsVersion: 1,
        permissions: [{ tool: "bash", matches: { command: "/^date$/" }, action: "reject" }],
      }),
    );
    const code = await runCli(["run", "--workspace", h.ws, "what time is it"], h.deps);
    expect(code).toBe(2); // rejected: the workspace rule was consulted FIRST
    const [permission] = permissionEvents(h.out);
    expect(permission?.decision).toBe("reject");
    expect(toolResultText(h.requests, "call-date")).toContain("Permission denied");
  });

  it("settings defaultModel reaches the real init event; VOID_MODEL still outranks it", async () => {
    const fileOnly = makeHarness([textRoundSse("ok")]);
    writeUserSettings(fileOnly, '{"settingsVersion":1,"defaultModel":"anthropic/from-settings"}');
    await runCli(["run", "--workspace", fileOnly.ws, "hi"], fileOnly.deps);
    expect(events(fileOnly.out)[0]).toMatchObject({
      type: "system",
      model: "anthropic/from-settings",
    });

    const envWins = makeHarness([textRoundSse("ok")]);
    writeUserSettings(envWins, '{"settingsVersion":1,"defaultModel":"anthropic/from-settings"}');
    const envDeps: CliDeps = {
      ...envWins.deps,
      env: { ...envWins.deps.env, VOID_MODEL: "anthropic/from-void-model" },
    };
    await runCli(["run", "--workspace", envWins.ws, "hi"], envDeps);
    expect(events(envWins.out)[0]).toMatchObject({
      type: "system",
      model: "anthropic/from-void-model",
    });
  });

  it("a malformed user settings file fails the run loudly: exit 3, problems on stderr, no provider round", async () => {
    const h = makeHarness([textRoundSse("never used")]);
    const path = writeUserSettings(h, '{"settingsVersion":1,"defaultModell":"typo"}');
    const code = await runCli(["run", "--workspace", h.ws, "hi"], h.deps);
    expect(code).toBe(3);
    expect(h.err.join("\n")).toContain(path);
    expect(h.err.join("\n")).toContain("defaultModell");
    expect(h.err.join("\n")).toContain("Unknown setting");
    const last = events(h.out).at(-1);
    expect(last).toMatchObject({ type: "result", subtype: "error_run", exit_code: 3 });
    expect(h.requests).toHaveLength(0); // failed before any provider traffic
  });

  // ---------------------------------------------------------------------------
  // Review N1: asyncShell.maxLifetimeMs must actually reach the async tool's
  // env (settings effective view must not display inert keys).
  // ---------------------------------------------------------------------------
  describe("settings -> tool env wiring (asyncShell.maxLifetimeMs, review N1)", () => {
    // Bash children deliberately see ONLY the allowlisted env (PATH/HOME/TMPDIR
    // — secrets and knobs stay out), so the knob is observed at its consumer
    // layer: the async tool reads ctx.env, which runTaskCommand now builds via
    // toolEnvWithSettings. This real-path test proves the end-to-end async
    // round works with a settings lifetime present; the precedence table
    // (settings flows when env lacks it, real env wins, empty env loses) is
    // pinned by the toolEnvWithSettings unit tests in cli-composition.test.ts.
    // Bun-gated like the async tool's own real-spawn suites: its spawner is
    // Bun-only by design (fd capture + unref), so Node-vitest skips real spawns.
    (typeof Bun === "undefined" ? it.skip : it)(
      "async_shell_command runs end-to-end through the CLI with a settings lifetime",
      async () => {
        const asyncRound = toolRoundSse("call-async", "async_shell_command", {
          command: "echo lifetime-ok",
        });
        const h = makeHarness([asyncRound, textRoundSse("done")]);
        writeUserSettings(
          h,
          JSON.stringify({
            settingsVersion: 1,
            asyncShell: { maxLifetimeMs: 123456 },
          }),
        );
        const code = await runCli(["run", "--workspace", h.ws, "start something"], h.deps);
        expect(code).toBe(0);
        const result = toolResultText(h.requests, "call-async");
        // The handle came back (spawn worked under the real sandbox); on hosts
        // without a sandbox binary the tool fails closed instead.
        if (!result.includes("sandbox")) {
          expect(result).toContain("as_");
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Reviewer R1: compaction settings must drive real compaction through the CLI
// (effective view must not display inert keys). keepTurns=1 with two big
// rounds: the third round's request carries the summary + one kept round.
// ---------------------------------------------------------------------------
describe("settings -> compaction wiring (reviewer R1)", () => {
  (typeof Bun === "undefined" ? it.skip : it)(
    "compaction.thresholdPercent/keepTurns from settings drive real compaction",
    async () => {
      const h = makeHarness([
        bigToolRoundSse("call-big-1", "first big turn"),
        bigToolRoundSse("call-big-2", "second big turn"),
        textRoundSse("condensed working state"),
        textRoundSse("all done after compaction"),
      ]);
      writeUserSettings(
        h,
        JSON.stringify({
          settingsVersion: 1,
          compaction: { thresholdPercent: 90, keepTurns: 1 },
        }),
      );
      const code = await runCli(["run", "--workspace", h.ws, "big work"], h.deps);
      expect(code).toBe(0);
      const bodies = h.requests.map((r) => JSON.parse(r) as { messages?: unknown[] });
      const last = bodies.at(-1);
      const transcript = JSON.stringify(last?.messages ?? []);
      expect(transcript).toContain("[compaction summary]");
      expect(transcript).toContain("condensed working state");
      // Exactly one round is kept (keepTurns=1): the second big turn survives.
      expect(transcript).toContain("second big turn");
      expect(transcript).not.toContain("first big turn");
      // The compaction event reached the stream too.
      expect(h.out.join("\n")).toContain('"type":"compaction"');
    },
  );
});
