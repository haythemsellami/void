/**
 * `src/tui/components` — the Ink presentation layer (roadmap WS1, ADR-0005).
 *
 * Dumb components: they render the pure `SessionState`/`ViewState` produced
 * by `view-model.ts` and own no logic. Written with `createElement` in plain
 * `.ts` (no JSX): the root tsconfig therefore needs no `jsx` setting and the
 * strict flags apply here exactly as everywhere else (ADR-0005 note 4).
 */

import { Box, Text } from "ink";
import { createElement, type ReactElement } from "react";
import type { PromptState } from "./prompt";
import {
  formatDuration,
  formatUsage,
  type SessionEntry,
  type SessionHeader,
  type SessionState,
  type ToolEntryStatus,
  type VisibleWindow,
} from "./view-model";

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface HeaderProps {
  readonly header: SessionHeader | null;
  readonly version: string;
}

/** One-line session header: version · thread · model · workspace. */
export function HeaderLine({ header, version }: HeaderProps): ReactElement {
  if (header === null) {
    return createElement(Text, { dimColor: true }, `void ${version} · no session`);
  }
  return createElement(
    Text,
    null,
    createElement(Text, { bold: true }, `void ${version}`),
    createElement(Text, { dimColor: true }, " · "),
    createElement(Text, { color: "cyan" }, header.threadId),
    createElement(Text, { dimColor: true }, " · "),
    createElement(Text, { color: "magenta" }, header.model),
    createElement(Text, { dimColor: true }, " · "),
    createElement(
      Text,
      { dimColor: true },
      header.workspaceRoot.length > 0 ? header.workspaceRoot : "—",
    ),
  );
}

// ---------------------------------------------------------------------------
// Transcript rows
// ---------------------------------------------------------------------------

export interface RowProps {
  readonly entry: SessionEntry;
  readonly isCursor: boolean;
  readonly expanded: boolean;
}

/** Tool status marker + color per lifecycle. */
function toolMarker(status: ToolEntryStatus): {
  readonly label: string;
  readonly color: "yellow" | "green" | "red";
} {
  if (status === "ok") {
    return { label: "✓", color: "green" };
  }
  return status === "error" ? { label: "✗", color: "red" } : { label: "…", color: "yellow" };
}

/** One transcript row (cursor marker, wrapped content, expansion details). */
export function TranscriptRow({ entry, isCursor, expanded }: RowProps): ReactElement {
  const marker = isCursor
    ? createElement(Text, { bold: true, color: "cyan" }, "❯ ")
    : createElement(Text, null, "  ");
  switch (entry.kind) {
    case "user":
      return createElement(
        Box,
        null,
        marker,
        createElement(
          Text,
          null,
          createElement(Text, { color: "cyan", bold: true }, "you ▸ "),
          createElement(Text, null, entry.text),
        ),
      );
    case "assistant":
      return createElement(Box, null, marker, createElement(Text, null, entry.text));
    case "tool": {
      const mark = toolMarker(entry.status);
      return createElement(
        Box,
        { flexDirection: "column" },
        createElement(
          Box,
          null,
          marker,
          createElement(Text, { color: mark.color }, `${mark.label} `),
          createElement(Text, { bold: true }, entry.name),
          createElement(Text, { dimColor: true }, ` ${entry.inputSummary}`),
          // Completed calls carry their one-line result status ("→ summary");
          // the full detail lives in the expanded view below.
          entry.status === "running"
            ? createElement(Text, { color: "yellow" }, " …")
            : entry.resultSummary !== undefined
              ? createElement(
                  Text,
                  { color: entry.status === "error" ? "red" : "green" },
                  ` → ${entry.resultSummary}`,
                )
              : null,
        ),
        expanded
          ? createElement(
              Box,
              { flexDirection: "column", paddingLeft: 2 },
              createElement(Text, { dimColor: true }, `input  ${entry.inputJson}`),
              entry.resultSummary !== undefined
                ? createElement(
                    Text,
                    { color: entry.status === "error" ? "red" : "green", dimColor: true },
                    `result ${entry.resultSummary}`,
                  )
                : createElement(Text, { dimColor: true }, "result (pending)"),
            )
          : null,
      );
    }
    case "permission":
      return createElement(
        Box,
        { flexDirection: "column" },
        createElement(
          Box,
          null,
          marker,
          createElement(
            Text,
            { color: "red", bold: true },
            `permission denied (${entry.decision}): ${entry.tool}`,
          ),
          createElement(Text, { dimColor: true }, ` — ${entry.reason}`),
        ),
        entry.message !== undefined
          ? createElement(
              Box,
              null,
              createElement(Text, null, "    "),
              createElement(Text, { color: "red", dimColor: true }, entry.message),
            )
          : null,
      );
    case "error":
      return createElement(
        Box,
        null,
        marker,
        createElement(Text, { color: "red" }, `error: ${entry.text}`),
      );
    case "notice":
      return createElement(
        Box,
        null,
        marker,
        createElement(Text, { dimColor: true }, `· ${entry.text}`),
      );
  }
}

export interface TranscriptProps {
  readonly entries: readonly SessionEntry[];
  readonly window: VisibleWindow;
  readonly expanded: readonly string[];
  /** In-flight streamed assistant text, shown pinned at the bottom row. */
  readonly streaming: string;
}

/** The scrollable transcript window (caller slices via `window`). */
export function Transcript({
  entries,
  window,
  expanded,
  streaming,
}: TranscriptProps): ReactElement {
  const rows: ReactElement[] = entries.slice(window.start, window.end).map((entry, index) => {
    const absoluteIndex = window.start + index;
    return createElement(TranscriptRow, {
      key: absoluteIndex,
      entry,
      isCursor: absoluteIndex === window.cursor,
      expanded: entry.kind === "tool" && expanded.includes(entry.toolUseId),
    });
  });
  if (streaming.length > 0) {
    rows.push(
      createElement(
        Box,
        { key: "__streaming__" },
        createElement(Text, null, "  "),
        createElement(Text, { dimColor: true }, `${streaming}▌`),
      ),
    );
  }
  return createElement(
    Box,
    { flexDirection: "column" },
    rows.length > 0 ? rows : createElement(Text, { dimColor: true }, "  (empty transcript)"),
  );
}

// ---------------------------------------------------------------------------
// Prompt + footer + hints
// ---------------------------------------------------------------------------

export interface PromptLineProps {
  readonly state: PromptState;
  readonly focused: boolean;
}

/** The input line: `> text` with a block cursor; dim when unfocused. */
export function PromptLine({ state, focused }: PromptLineProps): ReactElement {
  return createElement(
    Box,
    null,
    createElement(Text, { bold: true, color: focused ? "cyan" : "gray" }, "> "),
    createElement(
      Text,
      focused ? {} : { color: "gray" },
      state.text,
      focused ? createElement(Text, { inverse: true }, " ") : null,
    ),
  );
}

export interface FooterProps {
  readonly state: SessionState;
}

/** Status line: run state, usage totals, last result footer. */
export function FooterLine({ state }: FooterProps): ReactElement {
  const parts: ReactElement[] = [];
  parts.push(
    state.running
      ? createElement(Text, { color: "yellow" }, "● running")
      : createElement(Text, { color: "green" }, "○ idle"),
  );
  parts.push(createElement(Text, { dimColor: true }, `  ${formatUsage(state.totals)}`));
  if (state.footer !== null) {
    parts.push(
      createElement(
        Text,
        {
          color: state.footer.exitCode === 0 ? "green" : "red",
          dimColor: true,
        },
        `  exit ${state.footer.exitCode} · ${state.footer.stopReason} · ${formatDuration(state.footer.durationMs)}`,
      ),
    );
  }
  return createElement(Box, null, ...parts);
}

export interface HintsProps {
  readonly mode: "transcript" | "prompt";
  readonly running: boolean;
  readonly interrupted: boolean;
}

/** Key hints line (and the one-shot ctrl+c interrupt hint). */
export function HintsLine({ mode, running, interrupted }: HintsProps): ReactElement {
  if (interrupted) {
    return createElement(Text, { dimColor: true }, "prompt cleared — ctrl+c again to quit");
  }
  if (running) {
    return createElement(
      Text,
      { dimColor: true },
      "j/k scroll · pgup/pgdn page · ctrl+c quits (aborts the run)",
    );
  }
  return createElement(
    Text,
    { dimColor: true },
    mode === "prompt"
      ? "enter send · ctrl+c clear · esc scroll mode"
      : "i input · j/k scroll · pgup/pgdn page · ⏎ expand · q quit",
  );
}
