/**
 * `src/tui/entry` — `void ui` session composition (roadmap WS1 P1-P2).
 *
 * One `runUiSession` call assembles the whole session:
 *
 * - `--thread <id>` (no task): P1 read-only viewer — the thread log is
 *   replayed from the store and rendered statically;
 * - `--task "…"` (optionally with `--thread`): a live run through `runTask`
 *   (the same composition `void run` uses), subscribing to `onEngineEvent` /
 *   `onPermission` DIRECTLY — never by parsing stdout (ADR-0003: the TUI is
 *   just another consumer of the runner surface);
 * - P2 follow-ups: every prompt submit calls `runTask` again with the same
 *   thread id and the new events render live.
 *
 * This module is loaded LAZILY by the CLI dispatch (`await import`) so the
 * headless binary and every other subcommand never load react/ink
 * (ADR-0005 rules 1+3). Like `src/cli.ts`, it is a host boundary: the only
 * `src/tui` file that touches `process` (the TTY check) or the store —
 * the store access is READ-ONLY replay (`store.replay()` only; ADR-0005
 * rule 2 as amended 2026-10-14: tui may consume read-only replay from
 * `src/store`, never store writes — all persistence flows through runTask,
 * which owns its own store instance).
 *
 * P3 notes: permission dialogs will intercept the permission records before
 * they reach the feed; steering (queueing input mid-run) needs an engine
 * queued-input extension — until then submissions are refused while a run is
 * active, and quitting mid-run aborts the run with the process.
 */

import { render } from "ink";
import { createElement } from "react";
import { type AppFetchLike, runTask } from "../app/runner";
import { threadId as brandThreadId, type PermissionRule } from "../contracts";
import { JsonlThreadStore } from "../store/jsonl";
import { App } from "./App";
import {
  createEventQueue,
  engineEventToSession,
  permissionRecordToSession,
  threadEventsToSessionEvents,
} from "./events";
import type { SessionEvent } from "./view-model";

/** Everything the CLI hands the session (env policy stays in `src/cli.ts`). */
export interface UiSessionOptions {
  /** Existing thread to view (and continue). */
  readonly threadId?: string;
  /** Start a live run with this task (P1 live mode). */
  readonly task?: string;
  /** Explicit `--model` override. */
  readonly modelRef?: string;
  /** CLI-resolved default (--model > $VOID_MODEL > settings > builtin). */
  readonly defaultModelRef: string;
  readonly workspaceRoot: string;
  readonly dataDir?: string;
  readonly fetchImpl?: AppFetchLike;
  /** Curated tool environment (see cli.ts TOOL_ENV_ALLOWLIST). */
  readonly toolEnv: Readonly<Record<string, string>>;
  readonly apiKey?: string;
  readonly ollamaBaseUrl?: string;
  /** Provider endpoint overrides (ADR-0009), mapped from env by the CLI. */
  readonly anthropicBaseUrl?: string;
  readonly openaiBaseUrl?: string;
  readonly openaiApiKey?: string;
  /** Permission rules (ADR-0006: settings layers over DEFAULT_RULES tail). */
  readonly rules?: readonly PermissionRule[];
  /** Provider deadline from settings (ADR-0006). */
  readonly providerTimeoutMs?: number;
  readonly stderr: (line: string) => void;
  readonly version: string;
  /** TTY override (tests); default `process.stdout.isTTY`. */
  readonly isTTY?: boolean;
}

/**
 * Run one interactive UI session; resolves to the process exit code when the
 * user quits (the last run's exit code, or 0 for a pure viewer session).
 */
export async function runUiSession(options: UiSessionOptions): Promise<number> {
  // The TUI needs a terminal; everything else about Void works headless,
  // so refuse loudly instead of rendering garbage into a pipe.
  if ((options.isTTY ?? process.stdout.isTTY ?? false) === false) {
    options.stderr("void ui: requires an interactive terminal (stdout is not a TTY)");
    return 64;
  }

  const store = new JsonlThreadStore({
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
  });
  const feed = createEventQueue();

  // --- Replay phase: existing thread history → feed (before mount; the
  // queue's backlog delivers it to the App on subscribe).
  let replayedAnything = false;
  if (options.threadId !== undefined) {
    try {
      const log = await store.replay(brandThreadId(options.threadId));
      for (const event of threadEventsToSessionEvents(log)) {
        feed.push(event);
      }
      replayedAnything = true;
    } catch (cause) {
      options.stderr(
        `void ui: cannot open thread: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return 3;
    }
  }

  // Model precedence mirrors `void resume` (the CLI layer resolves
  // --model > $VOID_MODEL > settings > builtin; the thread's own model only
  // ever shows in the replayed header, it does not steer follow-up runs).
  const modelRef = options.modelRef ?? options.defaultModelRef;

  // Header for sessions whose history did not carry one (a live `--task` run
  // on a fresh thread; replay already pushed its own).
  if (!replayedAnything) {
    feed.push({
      type: "session_init",
      threadId: options.threadId ?? "(new thread)",
      model: modelRef,
      workspaceRoot: options.workspaceRoot,
    });
  }

  // --- Live-run machinery (initial --task run and P2 follow-ups).
  const generatedId = crypto.randomUUID();
  let activeThread: string | undefined = options.threadId;

  const startRun = async (task: string): Promise<void> => {
    feed.push({ type: "run_started", task });
    const startedAtMs = Date.now();
    try {
      const outcome = await runTask({
        task,
        workspaceRoot: options.workspaceRoot,
        modelRef,
        ...(activeThread !== undefined ? { threadId: activeThread } : { newId: () => generatedId }),
        ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.ollamaBaseUrl !== undefined ? { ollamaBaseUrl: options.ollamaBaseUrl } : {}),
        ...(options.anthropicBaseUrl !== undefined
          ? { anthropicBaseUrl: options.anthropicBaseUrl }
          : {}),
        ...(options.openaiBaseUrl !== undefined ? { openaiBaseUrl: options.openaiBaseUrl } : {}),
        ...(options.openaiApiKey !== undefined ? { openaiApiKey: options.openaiApiKey } : {}),
        ...(options.rules !== undefined ? { rules: options.rules } : {}),
        ...(options.providerTimeoutMs !== undefined
          ? { providerTimeoutMs: options.providerTimeoutMs }
          : {}),
        env: options.toolEnv,
        onEngineEvent: (event) => {
          feed.push(engineEventToSession(event));
        },
        onPermission: (record) => {
          const sessionEvent: SessionEvent | null = permissionRecordToSession(record);
          if (sessionEvent !== null) {
            feed.push(sessionEvent);
          }
        },
      });
      activeThread = outcome.threadId;
      feed.push({
        type: "run_finished",
        exitCode: outcome.exitCode,
        stopReason: outcome.result.stopReason,
        numTurns: outcome.result.rounds,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      feed.push({ type: "run_error", message });
      feed.push({
        type: "run_finished",
        exitCode: 3,
        stopReason: "run_error",
        numTurns: 0,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
    }
  };

  // --- Quit plumbing: onQuit resolves the exit promise; unmounting kills
  // the Ink tree (an in-flight run dies with the process — P3 abort).
  let resolveExit: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const instance = render(
    createElement(App, {
      feed,
      onSubmit: (text) => {
        void startRun(text);
      },
      onQuit: (code) => {
        resolveExit(code);
      },
      version: options.version,
    }),
  );

  if (options.task !== undefined) {
    void startRun(options.task);
  }

  const code = await exitCode;
  instance.unmount();
  return code;
}
