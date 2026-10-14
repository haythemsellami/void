/**
 * CLI dispatch smoke for `void ui`: the parse table, the `--help` page (which
 * must NOT load the TUI), and the real dispatch path through the lazy
 * `await import` — exercised end-to-end here via the injected non-TTY guard
 * (runUiSession refuses to render without a terminal and exits 64), so the
 * test needs no TTY and skips nothing.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CliDeps, parseArgs, runCli } from "../cli";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-ui-cli-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeDeps(): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
      env: {},
      cwd: scratch,
      dataDir: join(scratch, "data"),
    },
    out,
    err,
  };
}

describe("parseArgs: ui", () => {
  it("accepts the flag forms and requires --thread or --task", () => {
    expect(parseArgs(["ui", "--task", "fix it"])).toEqual({
      kind: "ui",
      task: "fix it",
    });
    expect(parseArgs(["ui", "--thread", "thr_a"])).toEqual({
      kind: "ui",
      threadId: "thr_a",
    });
    expect(
      parseArgs(["ui", "--thread=thr_a", "--task=go", "--model", "ollama/q", "--workspace", "."]),
    ).toEqual({
      kind: "ui",
      threadId: "thr_a",
      task: "go",
      model: "ollama/q",
      workspace: ".",
    });
  });

  it("rejects bare ui, positionals, unknown flags, and missing values", () => {
    expect(parseArgs(["ui"])).toMatchObject({
      kind: "usageError",
      message: expect.stringContaining("--thread"),
    });
    expect(parseArgs(["ui", "thr_a"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["ui", "--bogus", "x"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["ui", "--task"])).toMatchObject({ kind: "usageError" });
  });
});

describe("runCli: ui dispatch", () => {
  it("void ui --help prints the subcommand usage and exits 0 (no TUI loaded)", async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(["ui", "--help"], deps)).resolves.toBe(0);
    const text = out.join("\n");
    expect(text).toContain("void ui [--thread <id>] [--task <text>]");
    expect(text).toContain("--task");
    expect(text).toContain("Usage:");
    expect(text).toContain("Examples:");
  });

  it("void ui is listed in the main help", async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(["--help"], deps)).resolves.toBe(0);
    expect(out.join("\n")).toContain("interactive session view (TUI)");
  });

  it("dispatching ui without a TTY exits 64 with a terminal hint (lazy import path)", async () => {
    const { deps, err } = makeDeps();
    // Test processes have no TTY stdout, so runUiSession takes its guard
    // path — proving the dynamic import resolved and the session entry ran.
    await expect(runCli(["ui", "--task", "hi"], deps)).resolves.toBe(64);
    expect(err.join("\n")).toContain("requires an interactive terminal");
  });

  it("malformed workspace settings fail loudly (exit 3) before any rendering (ADR-0006)", async () => {
    const dir = realpathSync(mkdtempSync(join(scratch, "ws-")));
    mkdirSync(join(dir, ".void"));
    writeFileSync(join(dir, ".void", "settings.json"), '{"defaultModel": ');
    const out: string[] = [];
    const err: string[] = [];
    await expect(
      runCli(["ui", "--task", "hi"], {
        stdout: (line) => {
          out.push(line);
        },
        stderr: (line) => {
          err.push(line);
        },
        env: {},
        cwd: dir,
      }),
    ).resolves.toBe(3);
    expect(err.join("\n")).toContain("invalid settings");
    expect(err.join("\n")).toContain(".void/settings.json");
    expect(err.join("\n")).toContain("(syntax)");
    expect(out).toEqual([]);
  });

  it("usage errors exit 64 through the dispatcher", async () => {
    const { deps, err } = makeDeps();
    await expect(runCli(["ui"], deps)).resolves.toBe(64);
    expect(err[0]).toContain("void:");
  });
});
