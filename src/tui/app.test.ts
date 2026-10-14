/**
 * Ink render tests: drive the real App component through
 * `ink-testing-library` (mock stdin/stdout — no TTY needed, so these run
 * everywhere). Feed events exercise the same reducer the session entry uses;
 * stdin writes exercise the real key routing.
 */

import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createEventQueue } from "./events";
import type { SessionEvent } from "./view-model";

/** ink-testing-library keeps its Instance type private; derive it. */
type TestInstance = ReturnType<typeof render>;

/** CSI escape matcher built from a string to keep the source ASCII-safe. */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Strip ANSI escapes so assertions read plain text. */
function plain(frame: string | undefined): string {
  return (frame ?? "").replace(ANSI_ESCAPE, "");
}

/** Wait (bounded) until a rendered frame satisfies the predicate.
 * 10s default: loaded CI runners (the offline netns job) can starve ink's
 * render cycle far past 2s; the loop resolves on the predicate, so the
 * ceiling only matters on machines that would otherwise flake. */
async function waitForFrame(
  instance: TestInstance,
  predicate: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const text = plain(instance.lastFrame());
    if (predicate(text)) {
      return text;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`frame never satisfied predicate; last frame:\n${text}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/** Let queued keypresses/re-renders settle (for assertions with no visual change). */
async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface Mounted {
  readonly instance: TestInstance;
  readonly feed: ReturnType<typeof createEventQueue>;
  readonly submitted: string[];
  quitCodes: number[];
}

function mountApp(): Mounted {
  const feed = createEventQueue();
  const submitted: string[] = [];
  const quitCodes: number[] = [];
  const instance = render(
    createElement(App, {
      feed,
      onSubmit: (text) => {
        submitted.push(text);
      },
      onQuit: (code) => {
        quitCodes.push(code);
      },
      version: "0.1.0-test",
      viewportRows: 10,
    }),
  );
  return { instance, feed, submitted, quitCodes };
}

const REPLAYED_SESSION: readonly SessionEvent[] = [
  { type: "session_init", threadId: "thr_demo", model: "anthropic/x", workspaceRoot: "/w" },
  { type: "user_message", text: "list files" },
  { type: "assistant_text_complete", text: "Looking." },
  { type: "tool_call", toolUseId: "t1", name: "bash", input: { command: "ls -la" } },
  { type: "tool_result", toolUseId: "t1", summary: "12 entries", isError: false },
];

afterEach(cleanup);

/**
 * Ink's render loop does not advance under bun inside a network-denied
 * namespace (the offline CI jobs: `unshare -Urn` with lo down) — frames never
 * satisfy predicates regardless of ceilings. Rendering has nothing to do with
 * the egress property those jobs verify, so the render suite is gated on a
 * loopback round-trip probe (the same pattern as the unsandboxed-marker test).
 */
const renderSupported: boolean = await (async () => {
  // The offline CI jobs set VOID_OFFLINE_CI=1: their purpose is egress
  // verification, not rendering — and one render test starves
  // non-deterministically in the namespace no matter the ceiling.
  if (process.env.VOID_OFFLINE_CI === "1") return false;
  if (typeof Bun === "undefined") return true; // Node/vitest renders fine
  try {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const ok = await fetch(`http://127.0.0.1:${probe.port}/`).then((r) => r.text());
    probe.stop(true);
    return ok === "ok";
  } catch {
    return false;
  }
})();

(renderSupported ? describe : describe.skip)("App rendering (ink-testing-library)", () => {
  it("renders a replayed session: header, user, assistant, collapsed tool row", async () => {
    const { instance, feed } = mountApp();
    for (const event of REPLAYED_SESSION) {
      feed.push(event);
    }
    const text = await waitForFrame(instance, (frame) => frame.includes("12 entries"));
    expect(text).toContain("void 0.1.0-test");
    expect(text).toContain("thr_demo");
    expect(text).toContain("anthropic/x");
    expect(text).toContain("you ▸ list files");
    expect(text).toContain("Looking.");
    expect(text).toContain("bash");
    expect(text).toContain("ls -la");
  });

  it("renders the live init→delta→tool→result→finished sequence with footer", async () => {
    const { instance, feed } = mountApp();
    feed.push({
      type: "session_init",
      threadId: "thr_live",
      model: "ollama/q",
      workspaceRoot: "/w",
    });
    feed.push({ type: "run_started", task: "fix the bug" });
    feed.push({ type: "assistant_text_delta", text: "thinking…" });
    const streaming = await waitForFrame(instance, (frame) => frame.includes("thinking"));
    expect(streaming).toContain("● running");

    feed.push({ type: "tool_call", toolUseId: "t2", name: "read_file", input: { path: "/a" } });
    feed.push({ type: "tool_result", toolUseId: "t2", summary: "read 3 lines", isError: false });
    feed.push({ type: "usage", usage: { inputTokens: 1200, outputTokens: 30 } });
    feed.push({
      type: "run_finished",
      exitCode: 0,
      stopReason: "end_turn",
      numTurns: 1,
      durationMs: 1500,
    });
    const done = await waitForFrame(instance, (frame) => frame.includes("exit 0"));
    expect(done).toContain("✓ read_file");
    expect(done).toContain("in 1.2k · out 30 · 1 turn");
    expect(done).toContain("end_turn");
    expect(done).toContain("1.5s");
    expect(done).toContain("you ▸ fix the bug");
    // streaming text was flushed into an entry by the tool boundary
    expect(done).toContain("thinking…");
    expect(done).toContain("○ idle");
  });

  it("renders permission denials prominently", async () => {
    const { instance, feed } = mountApp();
    feed.push({
      type: "permission_denied",
      tool: "bash",
      decision: "ask",
      reason: "needs approval",
      message: "adjust the rules",
    });
    const text = await waitForFrame(instance, (frame) => frame.includes("permission denied"));
    expect(text).toContain("permission denied (ask): bash");
    expect(text).toContain("adjust the rules");
  });

  it("submit path: i focuses the prompt, enter submits non-empty input once", async () => {
    const { instance, feed, submitted } = mountApp();
    for (const event of REPLAYED_SESSION) {
      feed.push(event);
    }
    await waitForFrame(instance, (frame) => frame.includes("list files"));

    instance.stdin.write("i");
    const focused = await waitForFrame(instance, (frame) => frame.includes("enter send"));
    expect(focused).toContain(">");

    instance.stdin.write("hello");
    await waitForFrame(instance, (frame) => frame.includes("hello"));

    instance.stdin.write("\r");
    await waitForFrame(instance, (frame) => !frame.includes("hello"));
    expect(submitted).toEqual(["hello"]);

    // blank enter is a no-op (mode stays on the emptied prompt). Wait for the
    // CLEARED prompt frame first: on slow runners the "!hello" predicate can
    // pass while the input state still holds the text, and the blank enter
    // would then legitimately submit it again (product behavior, test race).
    await waitForFrame(instance, (frame) => frame.includes("enter send"));
    instance.stdin.write("\r");
    await settle();
    expect(submitted).toEqual(["hello"]);
  });

  it("ctrl+c clears a focused prompt first; a second ctrl+c quits with the last exit code", {
    timeout: 30_000,
  }, async () => {
    const { instance, feed, quitCodes } = mountApp();
    for (const event of REPLAYED_SESSION) {
      feed.push(event);
    }
    feed.push({
      type: "run_finished",
      exitCode: 0,
      stopReason: "end_turn",
      numTurns: 1,
      durationMs: 5,
    });
    await waitForFrame(instance, (frame) => frame.includes("idle"));

    instance.stdin.write("i");
    await waitForFrame(instance, (frame) => frame.includes("enter send"));
    instance.stdin.write("draft");
    await waitForFrame(instance, (frame) => frame.includes("draft"));

    // first ctrl+c interrupts the prompt, not the app
    instance.stdin.write("");
    await waitForFrame(instance, (frame) => frame.includes("prompt cleared"));
    expect(quitCodes).toEqual([]);

    // second ctrl+c (now in transcript mode) quits with the last exit code
    instance.stdin.write("");
    await settle();
    expect(quitCodes).toEqual([0]);
  });

  it("enter on a tool row toggles the expanded input JSON and result detail", async () => {
    const { instance, feed } = mountApp();
    for (const event of REPLAYED_SESSION) {
      feed.push(event);
    }
    await waitForFrame(instance, (frame) => frame.includes("ls -la"));

    instance.stdin.write("\r");
    const expanded = await waitForFrame(instance, (frame) => frame.includes('input  {"command"'));
    expect(expanded).toContain("result 12 entries");

    instance.stdin.write("\r");
    await waitForFrame(instance, (frame) => !frame.includes('input  {"command"'));
  });

  it("q in transcript mode quits (viewer exit code 0 when no run finished)", async () => {
    const { instance, quitCodes } = mountApp();
    await waitForFrame(instance, (frame) => frame.includes("empty transcript"));
    instance.stdin.write("q");
    await settle();
    expect(quitCodes).toEqual([0]);
  });

  it("scrollback: k unsticks (cursor marker moves up) and j returns to the tail", async () => {
    const { instance, feed } = mountApp();
    for (const event of REPLAYED_SESSION) {
      feed.push(event);
    }
    await waitForFrame(instance, (frame) => frame.includes("12 entries"));
    // stuck at the tail: the cursor marks the newest row
    expect(plain(instance.lastFrame())).toContain("❯ ✓ bash");

    instance.stdin.write("k");
    await waitForFrame(instance, (frame) => frame.includes("❯ Looking."));

    instance.stdin.write("j");
    await waitForFrame(instance, (frame) => frame.includes("❯ ✓ bash"));
  });
});
