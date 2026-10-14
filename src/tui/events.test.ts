/**
 * Event-mapping tests: engine events, permission records, and thread-log
 * replay all normalize into SessionEvents; the feed replays its backlog to
 * late subscribers (the pre-mount replay path).
 */
import { describe, expect, it } from "vitest";
import type { PermissionGateRecord } from "../app/runner";
import type { ThreadEvent, ThreadId } from "../contracts";
import type { EngineEvent } from "../core/engine";
import {
  createEventQueue,
  engineEventToSession,
  permissionRecordToSession,
  threadEventsToSessionEvents,
} from "./events";
import type { SessionEvent } from "./view-model";

const tid: ThreadId = "thr_test" as ThreadId;

describe("engineEventToSession", () => {
  it("maps every engine event kind", () => {
    const cases: readonly [EngineEvent, SessionEvent][] = [
      [
        { type: "assistant_text_delta", text: "hi" },
        { type: "assistant_text_delta", text: "hi" },
      ],
      [
        { type: "tool_call_started", toolUseId: "t1", name: "bash", input: { command: "ls" } },
        { type: "tool_call", toolUseId: "t1", name: "bash", input: { command: "ls" } },
      ],
      [
        {
          type: "tool_call_finished",
          toolUseId: "t1",
          name: "bash",
          resultSummary: "ok",
          isError: false,
        },
        { type: "tool_result", toolUseId: "t1", summary: "ok", isError: false },
      ],
      [
        {
          type: "turn_finished",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 2 },
        },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      ],
      [
        {
          type: "compaction",
          trigger: "threshold",
          summary: "prefix summary",
          summarizedTurns: 4,
          keptTurns: 2,
          usage: { inputTokens: 30, outputTokens: 10 },
          assumedContextWindow: true,
        },
        {
          type: "compacted",
          trigger: "threshold",
          summarizedTurns: 4,
          keptTurns: 2,
          usage: { inputTokens: 30, outputTokens: 10 },
        },
      ],
      [
        { type: "engine_stopped", reason: "provider_error", message: "boom" },
        { type: "engine_stopped", reason: "provider_error", message: "boom" },
      ],
    ];
    for (const [engine, session] of cases) {
      expect(engineEventToSession(engine)).toEqual(session);
    }
  });
});

describe("permissionRecordToSession", () => {
  const base: PermissionGateRecord = {
    tool: "bash",
    input: { command: "rm -rf /" },
    action: "ask",
    headlessDenied: true,
    reason: "rule: destructive command",
    message: "denied headless",
  };

  it("denials become permission entries carrying decision and remediation", () => {
    expect(permissionRecordToSession(base)).toEqual({
      type: "permission_denied",
      tool: "bash",
      decision: "ask",
      reason: "rule: destructive command",
      message: "denied headless",
    });
  });

  it("allowed calls are not rendered (null)", () => {
    const allowed: PermissionGateRecord = {
      tool: "bash",
      input: { command: "echo hi" },
      action: "allow",
      headlessDenied: false,
      reason: "rule: read-only",
    };
    expect(permissionRecordToSession(allowed)).toBeNull();
  });
});

describe("threadEventsToSessionEvents", () => {
  it("maps a full stored conversation, skipping derived tool_call events", () => {
    const log: readonly ThreadEvent[] = [
      {
        type: "thread_metadata",
        threadId: tid,
        title: "demo",
        model: "anthropic/x",
        createdAt: "2026-01-01T00:00:00Z",
        at: "2026-01-01T00:00:00Z",
      },
      {
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
        at: "2026-01-01T00:00:01Z",
      },
      {
        type: "assistant_message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "u1", name: "glob", input: { pattern: "*.ts" } },
          ],
        },
        at: "2026-01-01T00:00:02Z",
      },
      {
        type: "tool_call",
        toolUseId: "u1",
        name: "glob",
        input: { pattern: "*.ts" },
        at: "2026-01-01T00:00:02Z",
      },
      {
        type: "tool_result",
        toolUseId: "u1",
        result: { content: [{ type: "text", text: "3 matches" }], isError: false },
        at: "2026-01-01T00:00:03Z",
      },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 6 }, at: "2026-01-01T00:00:03Z" },
      {
        // ADR-0008: compaction is a view, not a rewrite — the log keeps the
        // summarized events; the notice renders where the event sits.
        type: "compaction",
        summary: "prefix summary",
        summarizedTurns: 2,
        keptTurns: 1,
        trigger: "threshold",
        at: "2026-01-01T00:00:04Z",
      },
      { type: "usage", usage: { inputTokens: 30, outputTokens: 10 }, at: "2026-01-01T00:00:04Z" },
    ];
    expect(threadEventsToSessionEvents(log)).toEqual([
      { type: "session_init", threadId: tid, model: "anthropic/x", workspaceRoot: "" },
      { type: "user_message", text: "go" },
      { type: "assistant_text_complete", text: "checking" },
      { type: "tool_call", toolUseId: "u1", name: "glob", input: { pattern: "*.ts" } },
      { type: "tool_result", toolUseId: "u1", summary: "3 matches", isError: false },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 6 } },
      { type: "compacted", trigger: "threshold", summarizedTurns: 2, keptTurns: 1 },
      { type: "usage", usage: { inputTokens: 30, outputTokens: 10 } },
    ]);
  });

  it("falls back to an unknown-model header and skips empty text", () => {
    const events = threadEventsToSessionEvents([
      {
        type: "thread_metadata",
        threadId: tid,
        createdAt: "2026-01-01T00:00:00Z",
        at: "2026-01-01T00:00:00Z",
      },
      {
        type: "assistant_message",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
        at: "2026-01-01T00:00:01Z",
      },
    ]);
    expect(events).toEqual([
      { type: "session_init", threadId: tid, model: "unknown", workspaceRoot: "" },
    ]);
  });
});

describe("createEventQueue", () => {
  it("delivers pushes to subscribers in order", () => {
    const queue = createEventQueue();
    const seen: SessionEvent[] = [];
    queue.subscribe((event) => {
      seen.push(event);
    });
    queue.push({ type: "user_message", text: "a" });
    queue.push({ type: "user_message", text: "b" });
    expect(seen.map((event) => (event.type === "user_message" ? event.text : ""))).toEqual([
      "a",
      "b",
    ]);
  });

  it("replays the backlog to late subscribers, then stops after unsubscribe", () => {
    const queue = createEventQueue();
    queue.push({ type: "user_message", text: "early" });

    const late: SessionEvent[] = [];
    const unsubscribe = queue.subscribe((event) => {
      late.push(event);
    });
    expect(late).toHaveLength(1);

    queue.push({ type: "user_message", text: "live" });
    expect(late).toHaveLength(2);

    unsubscribe();
    queue.push({ type: "user_message", text: "after" });
    expect(late).toHaveLength(2);
  });
});
