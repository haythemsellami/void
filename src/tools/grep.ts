/**
 * `grep` builtin (docs/architecture.md §tools): content search by shelling
 * out to ripgrep (`rg --json --no-heading`) via Bun.spawn and parsing its
 * JSON event stream (type "match" -> {path, line_number, lines.text}).
 *
 * No silent fallback: when rg is not on the tool context's PATH the tool
 * fails with a structured execution_failed error and install guidance
 * (architecture.md's never-silently-fallback rule; wave-2 note: vendor an
 * rg binary path instead of relying on PATH).
 *
 * Output handling (review minor): rg's stdout is stream-parsed as it
 * arrives — the tool never buffers the full output of a huge search. Once
 * maxResults matches are collected the rg child is killed immediately
 * (the same kill the cancellation path uses), so enormous result sets
 * cost one pipe window, not one full scan. `--sort` is deliberately not
 * passed: it forces rg to buffer its entire output before printing
 * anything, defeating the early stop. Output order is therefore rg's
 * natural (parallel walk) order.
 *
 * Cancellation: honors `ctx.signal` (contracts gap #6) — an already-aborted
 * signal fails fast without spawning, and an abort mid-run kills the rg
 * child so huge searches stop promptly; both return a structured
 * execution_failed result.
 *
 * Note: this module only touches the Bun global inside execute(), so it
 * stays importable under non-Bun runners (vitest under node skips these
 * tests; `bun test` runs everything).
 */

import type { Stats } from "node:fs";
import { statSync } from "node:fs";
import type { ToolContext, ToolInput, ToolResult, ToolSpec } from "../contracts/tools";
import {
  clipToOutputLimit,
  errnoCode,
  optionalPositiveInt,
  resolveInputPath,
  textResult,
  toDisplayPath,
  toolError,
} from "./paths";

/** Default cap on returned matches (config per call via maxResults). */
export const DEFAULT_GREP_MAX_RESULTS = 200;

/** rg exit codes: 0 = matches, 1 = no matches, >=2 = real failure. */
const RG_EXIT_ERROR = 2;

/** One parsed rg "match" event. */
interface RgMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Minimal typed view of rg's --json output events
 * (https://docs.rs/ripgrep/rg--json). Unknown shapes are ignored.
 */
interface RgEvent {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly line_number?: number;
    readonly lines?: { readonly text?: string };
    readonly stats?: { readonly matches?: number };
  };
}

/** Locate rg on the given PATH exactly (no implicit process.env fallback). */
function findRg(pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  return Bun.which("rg", { PATH: pathEnv });
}

/**
 * Build rg's argument vector. No `--sort`: it makes rg buffer its whole
 * output before printing, defeating the incremental early stop. Exported
 * for the argv assertions in tests.
 */
export function buildRgArgs(
  pattern: string,
  path: string,
  glob: string | undefined,
  caseSensitive: boolean,
  literal: boolean,
): string[] {
  const args = ["--json", "--no-heading"];
  if (literal) args.push("--fixed-strings");
  if (!caseSensitive) args.push("--ignore-case");
  if (glob !== undefined) args.push("--glob", glob);
  args.push("-e", pattern, path);
  return args;
}

/** The grep ToolSpec the engine registers (`tools/` registry, M3). */
export const grepTool: ToolSpec = {
  name: "grep",
  description:
    "Search file contents with ripgrep and return matches as path:line:text " +
    "lines, capped at maxResults (default 200; a marker notes further " +
    "matches). pattern is a regular-expression source by default; pass " +
    "literal: true for a fixed string, and caseSensitive: false to match " +
    "case-insensitively (the default is case-sensitive). Narrow the scope " +
    "with path (a file or directory, default the workspace root) and glob " +
    '(e.g. "*.ts"). Requires the rg binary on PATH; there is deliberately ' +
    "no fallback searcher. Use glob to find files by name instead.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex source (or literal with literal: true)." },
      path: {
        type: "string",
        description: "File or directory to search (default: workspace root).",
      },
      glob: { type: "string", description: 'ripgrep file filter, e.g. "*.ts".' },
      caseSensitive: { type: "boolean", description: "Match case-sensitively (default true)." },
      literal: { type: "boolean", description: "Treat pattern as a fixed string (default false)." },
      maxResults: {
        type: "integer",
        description: `Max matches to return (default ${DEFAULT_GREP_MAX_RESULTS}).`,
      },
    },
    required: ["pattern"],
  },
  source: "builtin",
  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      return toolError("invalid_input", "pattern must be a non-empty string");
    }
    if (pattern.includes("\0")) {
      return toolError("invalid_input", "pattern must not contain NUL bytes");
    }
    const globInput = input.glob;
    if (globInput !== undefined && (typeof globInput !== "string" || globInput.length === 0)) {
      return toolError("invalid_input", "glob must be a non-empty string when given");
    }
    const caseInput = input.caseSensitive;
    if (caseInput !== undefined && typeof caseInput !== "boolean") {
      return toolError("invalid_input", "caseSensitive must be a boolean");
    }
    const literalInput = input.literal;
    if (literalInput !== undefined && typeof literalInput !== "boolean") {
      return toolError("invalid_input", "literal must be a boolean");
    }
    const maxResultsInput = optionalPositiveInt(input.maxResults, "maxResults");
    if (!maxResultsInput.ok) return toolError("invalid_input", maxResultsInput.reason);

    const caseSensitive = caseInput !== false; // default true
    const literal = literalInput === true; // default false
    const maxResults = maxResultsInput.value ?? DEFAULT_GREP_MAX_RESULTS;

    // Pre-validate the regex in JS so typo'd patterns fail fast with a
    // clear code (JS and Rust regex dialects mostly agree on validity).
    if (!literal) {
      try {
        new RegExp(pattern);
      } catch (err) {
        return toolError(
          "invalid_input",
          `invalid regular expression: ${String(err)} (pass literal: true to search for the text as-is)`,
        );
      }
    }

    const pathInput = input.path;
    let root: string;
    if (pathInput === undefined) {
      root = ctx.workspaceRoot;
    } else if (typeof pathInput === "string" && pathInput.length > 0) {
      root = resolveInputPath(pathInput, ctx.workspaceRoot);
    } else {
      return toolError("invalid_input", "path must be a non-empty string when given");
    }
    const display = toDisplayPath(root, ctx.workspaceRoot);

    let st: Stats;
    try {
      st = statSync(root);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        return toolError("not_found", `search path not found: ${display}`);
      }
      if (errnoCode(err) === "EACCES" || errnoCode(err) === "EPERM") {
        return toolError("permission_denied", `cannot access ${display}: permission denied`);
      }
      return toolError("execution_failed", `cannot stat ${display}: ${String(err)}`, true);
    }
    if (!st.isFile() && !st.isDirectory()) {
      return toolError("invalid_input", `search path is not a file or directory: ${display}`);
    }

    const rgPath = findRg(ctx.env.PATH);
    if (rgPath === null) {
      return toolError(
        "execution_failed",
        "ripgrep (rg) not found on PATH; grep shells out to rg and has no fallback " +
          "searcher. Install ripgrep (https://github.com/BurntSushi/ripgrep#installation, " +
          "e.g. brew install ripgrep) and re-run.",
        false,
      );
    }

    const args = buildRgArgs(pattern, root, globInput, caseSensitive, literal);
    const signal = ctx.signal;
    if (signal?.aborted) {
      return toolError(
        "execution_failed",
        "search aborted: the tool context's cancellation signal was already fired",
        false,
      );
    }
    const proc = Bun.spawn({
      cmd: [rgPath, ...args],
      cwd: ctx.workingDir,
      env: { ...ctx.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      proc.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const matches: RgMatch[] = [];
    let reportedTotal: number | undefined;
    let stoppedEarly = false;
    let exitCode: number;
    let stderrText: string;
    try {
      // Re-check after subscribing: an abort that fired between the check
      // above and the listener would otherwise be missed.
      if (signal?.aborted) {
        onAbort();
      }
      // stderr is drained concurrently (rg keeps it small in practice) so a
      // chatty stderr can never deadlock the stdout pump.
      const stderrPromise = new Response(proc.stderr).text().catch(() => "");
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      const consumeLine = (line: string): void => {
        if (line.trim() === "") return;
        let event: RgEvent;
        try {
          event = JSON.parse(line) as RgEvent;
        } catch {
          return; // tolerate stray non-JSON noise on stdout
        }
        if (event.type === "match" && event.data) {
          const p = event.data.path?.text;
          const n = event.data.line_number;
          const t = event.data.lines?.text;
          if (typeof p === "string" && typeof n === "number" && typeof t === "string") {
            matches.push({ path: p, line: n, text: t.replace(/\r?\n$/, "") });
          }
        } else if (event.type === "summary" && event.data?.stats?.matches !== undefined) {
          reportedTotal = event.data.stats.matches;
        }
      };

      // Stream-parse stdout as it arrives; stop the moment maxResults
      // matches are collected (review minor: the old flow buffered ALL of
      // rg's output before capping).
      let pending = "";
      readLoop: for (;;) {
        const { done, value } = await reader.read();
        if (value !== undefined && value.length > 0) {
          pending += decoder.decode(value, { stream: true });
          let nl = pending.indexOf("\n");
          while (nl !== -1) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            consumeLine(line);
            if (matches.length >= maxResults) {
              stoppedEarly = true;
              break readLoop;
            }
            nl = pending.indexOf("\n");
          }
        }
        if (done) break;
      }

      if (stoppedEarly) {
        // Quota filled: kill rg NOW so a huge search stops producing output
        // and releases the pipes. Before closing, salvage a summary total
        // from the complete lines already buffered — when the whole result
        // set happened to arrive in the same chunk, the footer can still be
        // exact instead of "more may exist".
        proc.kill();
        for (const line of pending.split("\n")) {
          if (line.trim() === "") continue;
          try {
            const event = JSON.parse(line) as RgEvent;
            if (event.type === "summary" && event.data?.stats?.matches !== undefined) {
              reportedTotal = event.data.stats.matches;
            }
          } catch {
            // ignore non-JSON noise in the salvage scan
          }
        }
        try {
          await reader.cancel();
        } catch {
          // stream already closed by the kill
        }
      } else if (pending.trim() !== "") {
        consumeLine(pending); // final line without a trailing newline
      }

      [exitCode, stderrText] = await Promise.all([proc.exited, stderrPromise]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (aborted) {
      return toolError(
        "execution_failed",
        "search aborted: the tool context's cancellation signal fired mid-run " +
          "(the rg child was killed)",
        false,
      );
    }

    // A kill WE initiated (quota reached) is not an rg failure; every other
    // exit >= 2 is.
    if (!stoppedEarly && exitCode >= RG_EXIT_ERROR) {
      return toolError(
        "execution_failed",
        `rg exited with code ${exitCode}: ${stderrText.trim().slice(0, 500)}`,
        true,
      );
    }

    if (matches.length === 0) {
      return textResult(
        `No matches for ${literal ? "literal" : "pattern"} ${JSON.stringify(pattern)} in ${display}`,
        false,
      );
    }

    const shown = matches.slice(0, maxResults);
    const out: string[] = [];
    for (const m of shown) {
      out.push(`${toDisplayPath(m.path, ctx.workspaceRoot)}:${m.line}:${m.text}`);
    }
    let truncated = false;
    if (reportedTotal !== undefined) {
      if (shown.length < reportedTotal) {
        out.push(`… ${shown.length} of ${reportedTotal} matches shown (maxResults: ${maxResults})`);
        truncated = true;
      }
    } else {
      // Early stop without a summary event: the total is unknown — never
      // imply the shown matches are all of them.
      out.push(
        `… ${shown.length} matches shown; search stopped early after reaching ` +
          `maxResults: ${maxResults} (further matches may exist)`,
      );
      truncated = true;
    }
    const clipped = clipToOutputLimit(out.join("\n"), ctx.outputLimits);
    return textResult(clipped.text, truncated || clipped.truncated);
  },
};
