/**
 * CLI tests: pure parseArgs table, runCli dispatch with injected I/O
 * (permissions test exit codes, schema, threads list, usage errors), one
 * offline end-to-end `run` through the REAL anthropic adapter with a scripted
 * SSE fetch, and a process-level `bun src/cli.ts --version` spawn smoke
 * (Bun-runtime only; plain-Node vitest skips it).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type CliDeps, parseArgs, runCli, VERSION } from "./cli";
import { threadId } from "./contracts";
import { JsonlThreadStore } from "./store/jsonl";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-cli-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<CliDeps> = {}): {
  deps: CliDeps;
  out: string[];
  err: string[];
} {
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
      dataDir: mkdtempSync(join(scratch, "data-")),
      ...overrides,
    },
    out,
    err,
  };
}

// ---------------------------------------------------------------------------
// parseArgs table
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("table of accepted forms", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseArgs(["schema"])).toEqual({ kind: "schema" });
    expect(parseArgs(["threads", "list"])).toEqual({ kind: "threadsList" });
    expect(parseArgs(["permissions", "test", "bash", '{"command":"ls"}'])).toEqual({
      kind: "permissionsTest",
      tool: "bash",
      inputJson: '{"command":"ls"}',
    });

    // Settings subcommands (ADR-0006).
    expect(parseArgs(["settings", "path"])).toEqual({ kind: "settingsPath" });
    expect(parseArgs(["settings", "effective"])).toEqual({ kind: "settingsEffective" });
    expect(parseArgs(["settings", "edit"])).toEqual({ kind: "settingsEdit", workspace: false });
    expect(parseArgs(["settings", "edit", "--workspace"])).toEqual({
      kind: "settingsEdit",
      workspace: true,
    });
    expect(parseArgs(["settings", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "settings",
    });
    expect(parseArgs(["settings", "edit", "-h"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "settings",
    });

    expect(parseArgs(["run", "do", "the", "thing"])).toEqual({
      kind: "run",
      task: "do the thing",
      text: false,
    });
    expect(parseArgs(["run", "--model", "ollama/llama3", "task"])).toEqual({
      kind: "run",
      task: "task",
      model: "ollama/llama3",
      text: false,
    });
    expect(parseArgs(["run", "--model=ollama/x", "--workspace", "/ws", "t"])).toEqual({
      kind: "run",
      task: "t",
      model: "ollama/x",
      workspace: "/ws",
      text: false,
    });
    expect(parseArgs(["run", "--thread", "abc_123", "--text", "t"])).toEqual({
      kind: "run",
      task: "t",
      threadId: "abc_123",
      text: true,
    });
    expect(parseArgs(["run", "--thread=abc_123", "t"])).toEqual({
      kind: "run",
      task: "t",
      threadId: "abc_123",
      text: false,
    });
    expect(parseArgs(["resume", "abc_123", "continue", "it"])).toEqual({
      kind: "resume",
      threadId: "abc_123",
      task: "continue it",
      text: false,
      compact: false,
    });
    expect(parseArgs(["resume", "t-1", "--model", "m", "go"])).toEqual({
      kind: "resume",
      threadId: "t-1",
      task: "go",
      model: "m",
      text: false,
      compact: false,
    });
    expect(parseArgs(["resume", "abc_123", "--compact", "go"])).toEqual({
      kind: "resume",
      threadId: "abc_123",
      task: "go",
      text: false,
      compact: true,
    });

    // Subcommand help: a bare --help/-h anywhere in a known subcommand's
    // tail selects that subcommand's help page (before flag validation).
    expect(parseArgs(["run", "--help"])).toEqual({ kind: "subcommandHelp", subcommand: "run" });
    expect(parseArgs(["run", "-h"])).toEqual({ kind: "subcommandHelp", subcommand: "run" });
    expect(parseArgs(["run", "--text", "do", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "run",
    });
    expect(parseArgs(["resume", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "resume",
    });
    expect(parseArgs(["threads", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "threads",
    });
    expect(parseArgs(["threads", "list", "-h"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "threads",
    });
    expect(parseArgs(["permissions", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "permissions",
    });
    expect(parseArgs(["permissions", "test", "bash", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "permissions",
    });
    expect(parseArgs(["schema", "--help"])).toEqual({
      kind: "subcommandHelp",
      subcommand: "schema",
    });
  });

  it("table of usage errors", () => {
    expect(parseArgs(["frobnicate"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["run"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["resume"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["resume", "id"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["run", "--bogus", "t"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["run", "--model"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["threads", "burn"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["permissions"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["permissions", "test", "bash"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["schema", "extra"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["settings"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["settings", "frobnicate"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["settings", "path", "--workspace"])).toMatchObject({ kind: "usageError" });
    expect(parseArgs(["settings", "edit", "--workspace", "extra"])).toMatchObject({
      kind: "usageError",
    });
    expect(parseArgs(["settings", "edit", "--bogus"])).toMatchObject({ kind: "usageError" });
  });
});

// ---------------------------------------------------------------------------
// runCli dispatch (injected I/O)
// ---------------------------------------------------------------------------

describe("runCli", () => {
  it("prints the version", async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(["--version"], deps)).resolves.toBe(0);
    expect(out).toEqual([`void ${VERSION}`]);
  });

  it("prints usage for help", async () => {
    const { deps, out } = makeDeps();
    await expect(runCli([], deps)).resolves.toBe(0);
    expect(out[0]).toContain("local-first agentic coding CLI");
    // The bare help lists every subcommand with a one-liner plus the usage line.
    const text = out.join("\n");
    expect(text).toContain("Usage:");
    for (const name of ["run", "resume", "threads", "permissions", "settings", "schema"]) {
      expect(text).toContain(name);
    }
  });

  it("prints per-subcommand usage for <sub> --help and exits 0", async () => {
    const cases: readonly [string[], string, string][] = [
      [["run", "--help"], "void run <task...> — run a task", "--workspace <dir>"],
      [["resume", "-h"], "void resume <threadId> <task...>", "Examples:"],
      [["threads", "--help"], "void threads list — list thread summaries", "void threads list"],
      [
        ["permissions", "--help"],
        "void permissions test <tool> <input-json>",
        "exit 0 allow / 1 ask / 2 reject",
      ],
      [
        ["settings", "--help"],
        "void settings <path|effective|edit> — inspect and edit layered settings files",
        "exit 3, stderr names file+key+problem",
      ],
      [["schema", "--help"], "void schema — print the stream-JSON contract schema", "void schema"],
    ];
    for (const [argv, header, mustContain] of cases) {
      const { deps, out } = makeDeps();
      await expect(runCli([...argv], deps)).resolves.toBe(0);
      expect(out[0]?.startsWith(header.split(" — ")[0] ?? "")).toBe(true);
      expect(out.join("\n")).toContain(header);
      expect(out.join("\n")).toContain(mustContain);
      expect(out.join("\n")).toContain("Usage:");
    }
  });

  it("prints a valid JSON schema document", async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(["schema"], deps)).resolves.toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { items?: { oneOf?: unknown[] } };
    // v1.1 (ADR-0008): the five frozen v1 variants + compaction.
    expect(parsed.items?.oneOf?.length).toBe(6);
  });

  it("rejects --compact outside resume (resume-only flag, exit 64)", async () => {
    const { deps, err } = makeDeps();
    await expect(runCli(["run", "--compact", "do things"], deps)).resolves.toBe(64);
    expect(err.join("\n")).toContain("--compact is only valid with resume");
  });

  it("usage errors go to stderr with exit 64", async () => {
    const { deps, out, err } = makeDeps();
    await expect(runCli(["nope"], deps)).resolves.toBe(64);
    expect(out).toEqual([]);
    expect(err[0]).toContain("unknown command");
    expect(err[1]).toContain("void --help");
  });

  it("permissions test exit codes: allow 0, ask 1, reject 2", async () => {
    const allow = makeDeps();
    await expect(
      runCli(["permissions", "test", "bash", '{"command":"ls -la"}'], allow.deps),
    ).resolves.toBe(0);
    expect(allow.out[0]).toContain("allow");

    const ask = makeDeps();
    await expect(
      runCli(["permissions", "test", "bash", '{"command":"git push"}'], ask.deps),
    ).resolves.toBe(1);
    expect(ask.out[0]).toContain("ask");

    const reject = makeDeps();
    await expect(
      runCli(["permissions", "test", "bash", '{"command":"rm -rf ~"}'], reject.deps),
    ).resolves.toBe(2);
    expect(reject.out[0]).toContain("reject");
  });

  it("permissions test rejects malformed input with exit 64", async () => {
    const bad = makeDeps();
    await expect(runCli(["permissions", "test", "bash", "{not json"], bad.deps)).resolves.toBe(64);
    expect(bad.err[0]).toContain("not valid JSON");

    const nonObject = makeDeps();
    await expect(runCli(["permissions", "test", "bash", "[1,2]"], nonObject.deps)).resolves.toBe(
      64,
    );
    expect(nonObject.err[0]).toContain("JSON object");
  });

  it("threads list prints seeded threads as JSONL", async () => {
    const { deps, out } = makeDeps();
    const store = new JsonlThreadStore({ dataDir: deps.dataDir as string });
    const at = "2026-10-10T00:00:00.000Z";
    await store.append(threadId("list-thread-1"), {
      type: "thread_metadata",
      threadId: threadId("list-thread-1"),
      title: "my task",
      createdAt: at,
      at,
    });
    await expect(runCli(["threads", "list"], deps)).resolves.toBe(0);
    const parsed = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toEqual([{ id: "list-thread-1", title: "my task", createdAt: at }]);
  });

  it("threads list with no threads prints nothing and exits 0", async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(["threads", "list"], deps)).resolves.toBe(0);
    expect(out).toEqual([]);
  });

  it("run with an unknown provider prefix exits 3 with a result event", async () => {
    const { deps, out, err } = makeDeps();
    await expect(runCli(["run", "--model", "mystery/gpt-5", "task"], deps)).resolves.toBe(3);
    const parsed = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(parsed.at(-1)).toMatchObject({
      type: "result",
      subtype: "error_run",
      exit_code: 3,
    });
    expect(err[0]).toContain("anthropic/<model-id>");
  });
});

// ---------------------------------------------------------------------------
// runCli: settings subcommands (ADR-0006)
// ---------------------------------------------------------------------------

describe("runCli: settings subcommands", () => {
  /** Fresh harness with temp XDG config + workspace cwd, real filesystem. */
  function settingsDeps(overrides: { readonly files?: Readonly<Record<string, string>> } = {}): {
    deps: CliDeps;
    out: string[];
    err: string[];
    xdg: string;
    ws: string;
    editorCalls: [string, string][];
    setEditorExit: (code: number | Error) => void;
  } {
    const xdg = mkdtempSync(join(scratch, "set-xdg-"));
    const ws = mkdtempSync(join(scratch, "set-ws-"));
    for (const [rel, body] of Object.entries(overrides.files ?? {})) {
      const target = rel.startsWith("xdg:")
        ? join(xdg, "void", rel.slice(4))
        : join(ws, ".void", rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    const out: string[] = [];
    const err: string[] = [];
    const editorCalls: [string, string][] = [];
    let editorResult: number | Error = 0;
    const deps: CliDeps = {
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
      env: { XDG_CONFIG_HOME: xdg, EDITOR: "test-editor -w" },
      cwd: ws,
      runEditor: (editor, path) => {
        editorCalls.push([editor, path]);
        return editorResult instanceof Error
          ? Promise.reject(editorResult)
          : Promise.resolve(editorResult);
      },
    };
    return {
      deps,
      out,
      err,
      xdg,
      ws,
      editorCalls,
      setEditorExit: (code) => {
        editorResult = code;
      },
    };
  }

  it("settings path prints both layers with existence; exit 0 always", async () => {
    const s = settingsDeps({ files: { "xdg:settings.json": '{"settingsVersion":1}' } });
    await expect(runCli(["settings", "path"], s.deps)).resolves.toBe(0);
    expect(s.out).toEqual([
      `user:      ${join(s.xdg, "void", "settings.json")} — found`,
      `workspace: ${join(s.ws, ".void", "settings.json")} — missing`,
    ]);
  });

  it("settings effective prints the merged JSON plus provenance comment lines", async () => {
    const s = settingsDeps({
      files: {
        "xdg:settings.json": '{"settingsVersion":1,"defaultModel":"user/m"}',
        "settings.jsonc":
          '// workspace layer\n{"settingsVersion":1,"defaultModel":"ws/m","providerTimeoutMs":45000}',
      },
    });
    await expect(runCli(["settings", "effective"], s.deps)).resolves.toBe(0);
    const text = s.out.join("\n");
    expect(text).toContain('"defaultModel": "ws/m"');
    expect(text).toContain('"providerTimeoutMs": 45000');
    expect(text).toContain("# defaultModel: workspace");
    expect(text).toContain("# providerTimeoutMs: workspace");
    // JSONC fallback notice is an info log on stderr.
    expect(s.err.join("\n")).toContain("JSONC settings");
    // The effective body itself parses as JSON (comment tail stripped).
    const jsonEnd = s.out.lastIndexOf("}");
    const jsonLines = s.out.slice(0, jsonEnd + 1).filter((line) => !line.startsWith("#"));
    expect(JSON.parse(jsonLines.join("\n"))).toMatchObject({
      settingsVersion: 1,
      defaultModel: "ws/m",
    });
  });

  it("settings effective with no files prints the minimal effective object, exit 0", async () => {
    const s = settingsDeps();
    await expect(runCli(["settings", "effective"], s.deps)).resolves.toBe(0);
    expect(JSON.parse(s.out.join("\n"))).toEqual({ settingsVersion: 1 });
  });

  it("settings effective with a malformed file: exit 3, stderr names file+key+problem, stdout empty", async () => {
    const s = settingsDeps({
      files: { "xdg:settings.json": '{"settingsVersion":1,"frobnicate":true}' },
    });
    await expect(runCli(["settings", "effective"], s.deps)).resolves.toBe(3);
    expect(s.out).toEqual([]);
    expect(s.err[0]).toContain(join(s.xdg, "void", "settings.json"));
    expect(s.err[0]).toContain("frobnicate");
    expect(s.err[0]).toContain("Unknown setting");
  });

  it("settings edit without $EDITOR: exit 64, structured error, and NO file created", async () => {
    const s = settingsDeps();
    const deps: CliDeps = { ...s.deps, env: { XDG_CONFIG_HOME: s.xdg } };
    await expect(runCli(["settings", "edit"], deps)).resolves.toBe(64);
    expect(s.err[0]).toContain("$EDITOR is not set");
    expect(s.editorCalls).toEqual([]);
    expect(existsSync(join(s.xdg, "void", "settings.json"))).toBe(false);
  });

  it("settings edit creates the exact 0600 skeleton then opens $EDITOR on it", async () => {
    const s = settingsDeps();
    await expect(runCli(["settings", "edit"], s.deps)).resolves.toBe(0);
    const target = join(s.xdg, "void", "settings.json");
    expect(s.editorCalls).toEqual([["test-editor -w", target]]);
    expect(readFileSync(target, "utf8")).toBe('{"settingsVersion":1}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(s.err.join("\n")).toContain(`created ${target}`);
  });

  it("settings edit --workspace targets .void/settings.json; an existing file is left untouched", async () => {
    const s = settingsDeps({
      files: { "settings.json": '{"settingsVersion":1,"defaultModel":"ws/m"}' },
    });
    await expect(runCli(["settings", "edit", "--workspace"], s.deps)).resolves.toBe(0);
    const target = join(s.ws, ".void", "settings.json");
    expect(s.editorCalls).toEqual([["test-editor -w", target]]);
    expect(readFileSync(target, "utf8")).toBe('{"settingsVersion":1,"defaultModel":"ws/m"}');
    expect(s.err.join("\n")).not.toContain("created");
  });

  it("settings edit maps a nonzero editor exit to a structured error (exit 3)", async () => {
    const s = settingsDeps();
    s.setEditorExit(7);
    await expect(runCli(["settings", "edit"], s.deps)).resolves.toBe(3);
    expect(s.err.at(-1)).toContain('editor "test-editor -w" exited with code 7');
    expect(s.err.at(-1)).toContain(join(s.xdg, "void", "settings.json"));
  });

  it("settings edit maps an editor spawn failure to a structured error (exit 3)", async () => {
    const s = settingsDeps();
    s.setEditorExit(new Error("spawn test-editor ENOENT"));
    await expect(runCli(["settings", "edit"], s.deps)).resolves.toBe(3);
    expect(s.err.at(-1)).toContain("could not run editor");
    expect(s.err.at(-1)).toContain("spawn test-editor ENOENT");
  });
});

// ---------------------------------------------------------------------------
// Offline end-to-end `run` through the REAL anthropic adapter (scripted SSE)
// ---------------------------------------------------------------------------

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const TEXT_TURN_SSE = [
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
    delta: { type: "text_delta", text: "Hello from " },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "the scripted stream" },
  }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  }),
  frame("message_stop", { type: "message_stop" }),
].join("");

describe("runCli run (offline, scripted anthropic SSE)", () => {
  it("completes a text turn: init, assistant, result, thread persisted, exit 0", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-"));
    const { deps, out, err } = makeDeps({
      env: { VOID_ANTHROPIC_KEY: "test-key" },
      cwd: workspace,
      fetchImpl: (url: string, init?: RequestInit) => {
        expect(url).toContain("api.anthropic.com");
        expect(String(init?.headers && (init.headers as Record<string, string>)["x-api-key"])).toBe(
          "test-key",
        );
        return Promise.resolve(
          new Response(TEXT_TURN_SSE, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });

    const code = await runCli(
      ["run", "--workspace", workspace, "--text", "introduce yourself"],
      deps,
    );
    expect(code).toBe(0);

    const parsed = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(parsed[1]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello from the scripted stream" }],
      },
    });
    expect(parsed.at(-1)).toMatchObject({
      type: "result",
      subtype: "success",
      exit_code: 0,
      total_usage: { input_tokens: 25, output_tokens: 7 },
      result: "Hello from the scripted stream",
    });

    // --text human summary landed on stderr.
    expect(err.some((line) => line.startsWith("thread "))).toBe(true);

    // Thread persisted with the user message and the assistant reply.
    const threads = await new JsonlThreadStore({ dataDir: deps.dataDir as string }).list();
    expect(threads.length).toBe(1);
    const log = readFileSync(
      join(deps.dataDir as string, "threads", `${threads[0]?.id}.jsonl`),
      "utf8",
    );
    expect(log).toContain("introduce yourself");
    expect(log).toContain("Hello from the scripted stream");
  });

  it("resumes a thread: second run sees folded history", async () => {
    const workspace = mkdtempSync(join(scratch, "resume-ws-"));
    const bodies = [TEXT_TURN_SSE, TEXT_TURN_SSE];
    const requests: string[] = [];
    const { deps, out } = makeDeps({
      env: { VOID_ANTHROPIC_KEY: "test-key" },
      cwd: workspace,
      fetchImpl: (_url: string, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : "";
        requests.push(body);
        return Promise.resolve(
          new Response(bodies.shift() ?? TEXT_TURN_SSE, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });

    const first = await runCli(["run", "--workspace", workspace, "first task"], deps);
    expect(first).toBe(0);
    const initEvent = JSON.parse(out[0] as string) as { thread_id: string };
    const id = initEvent.thread_id;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);

    const outCount = out.length;
    const second = await runCli(["resume", id, "--workspace", workspace, "second task"], deps);
    expect(second).toBe(0);

    // The second provider request contains the folded first exchange.
    const secondRequest = JSON.parse(requests[1] as string) as {
      messages?: { role: string; content: unknown }[];
    };
    const roles = secondRequest.messages?.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(requests[1]).toContain("first task");

    // Resume's init event declares the resumed thread.
    const resumeInit = JSON.parse(out[outCount] as string) as Record<string, unknown>;
    expect(resumeInit.resumed_from).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Process-level smoke (Bun only)
// ---------------------------------------------------------------------------

const bunRuntime = typeof Bun !== "undefined";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

describe.skipIf(!bunRuntime)("void binary smoke (bun spawn)", () => {
  it("bun src/cli.ts --version prints the version", async () => {
    const proc = Bun.spawn([process.execPath, cliPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(`void ${VERSION}`);
  });

  it("bun src/cli.ts permissions test exits 1 for an ask", async () => {
    const proc = Bun.spawn(
      [process.execPath, cliPath, "permissions", "test", "bash", '{"command":"git push"}'],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });

  it("bun src/cli.ts run --help prints the subcommand usage and exits 0", async () => {
    const proc = Bun.spawn([process.execPath, cliPath, "run", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("--model <ref>");
  });

  it("schema piped to an early-closing reader exits 141 with no crash trace", async () => {
    // The review's `dist/void schema | head -3` crash: when the pipe reader
    // is gone, process.stdout.write fails with EPIPE and the runtime prints
    // a crash trace unless the entry path handles it. `head -3` only races
    // into EPIPE sometimes (the ~8KB schema fits the pipe buffer), so the
    // deterministic shape is a reader that exits without reading at all
    // (`| true`) — same EPIPE mode, guaranteed ordering.
    const stderrFile = join(scratch, "epipe-stderr.txt");
    const script = `set -o pipefail; "${process.execPath}" "${cliPath}" schema 2>"${stderrFile}" | true`;
    const proc = Bun.spawn(["/bin/bash", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const bashStdout = new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    await bashStdout; // drain; nothing should be written past the pipeline
    expect(exitCode).toBe(141);

    const cliStderr = readFileSync(stderrFile, "utf8");
    expect(cliStderr).toBe(""); // quiet: no EPIPE report, no stack trace
    for (const crashMarker of ["EPIPE", "Bun v", " at "]) {
      expect(cliStderr).not.toContain(crashMarker);
    }
  });

  it("schema piped to a patient reader completes normally with exit 0", async () => {
    // Control for the EPIPE handler: a reader that stays open must be
    // unaffected — full schema parses and the CLI exits 0.
    const proc = Bun.spawn(["/bin/bash", "-c", `"${process.execPath}" "${cliPath}" schema`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { type?: string; title?: string };
    expect(parsed.type).toBe("array");
    expect(parsed.title).toContain("stream-JSON contract");
  });
});
