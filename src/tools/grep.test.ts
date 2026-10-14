/**
 * Tests for the grep builtin (ripgrep-backed).
 *
 * Test-environment note: the tool shells out via Bun.spawn/Bun.which, which
 * only exist under the Bun runtime. Runtime tests are registered with
 * describe.skip when Bun is absent, so `bun test` runs everything while
 * vitest-under-node skips just these (validation-only cases still run
 * everywhere — they return before any spawn). The missing-rg case is tested
 * by pointing the ToolContext env PATH at an empty temp directory
 * (deterministic, no spawn injection needed).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../contracts/tools";
import { buildRgArgs, grepTool } from "./grep";

const bunRuntime = typeof Bun !== "undefined";
const runtimeDescribe = bunRuntime ? describe : describe.skip;

const cleanups: string[] = [];

function workspace(): { ws: string; ctx: ToolContext } {
  const ws = mkdtempSync(join(tmpdir(), "void-grep-"));
  cleanups.push(ws);
  return {
    ws,
    ctx: {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      requestPermission: async () => ({ action: "allow", message: "allow" }),
      outputLimits: { maxTotalChars: 200_000, maxSectionChars: 200_000 },
    },
  };
}

function text(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Validation errors happen before any spawn: safe under every runner. */
describe("grep: input validation (runner-independent)", () => {
  it("rejects bad pattern/glob/flag types and invalid regexes", async () => {
    const { ctx } = workspace();
    expect((await grepTool.execute({}, ctx)).error?.code).toBe("invalid_input");
    expect((await grepTool.execute({ pattern: "" }, ctx)).error?.code).toBe("invalid_input");
    expect((await grepTool.execute({ pattern: "x", glob: "" }, ctx)).error?.code).toBe(
      "invalid_input",
    );
    expect((await grepTool.execute({ pattern: "x", caseSensitive: "yes" }, ctx)).error?.code).toBe(
      "invalid_input",
    );
    expect((await grepTool.execute({ pattern: "x", maxResults: 0 }, ctx)).error?.code).toBe(
      "invalid_input",
    );
    expect((await grepTool.execute({ pattern: "a(b" }, ctx)).error?.code).toBe("invalid_input");
  });
});

describe("buildRgArgs (runner-independent argv assertions)", () => {
  it("never passes --sort: it would force rg to buffer its whole output", () => {
    const args = buildRgArgs("pat", "/ws", "*.ts", true, false);
    expect(args).not.toContain("--sort");
    expect(args).toEqual(["--json", "--no-heading", "--glob", "*.ts", "-e", "pat", "/ws"]);
  });

  it("stacks literal and case flags correctly", () => {
    expect(buildRgArgs("a.b", "/ws", undefined, false, true)).toEqual([
      "--json",
      "--no-heading",
      "--fixed-strings",
      "--ignore-case",
      "-e",
      "a.b",
      "/ws",
    ]);
  });
});

runtimeDescribe("grep: ripgrep execution (Bun runtime)", () => {
  it("returns path:line:text matches with display paths relative to the workspace", async () => {
    const { ws, ctx } = workspace();
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "a.ts"), "import x\n// TODO fix\nexport {}\n");
    writeFileSync(join(ws, "b.md"), "nothing here\n");
    const res = await grepTool.execute({ pattern: "TODO" }, ctx);
    expect(res.isError).toBe(false);
    expect(text(res)).toBe("src/a.ts:2:// TODO fix");
  });

  it("searches a single file path and reports no matches without erroring", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "one.txt"), "alpha\nbeta\n");
    const hit = await grepTool.execute({ pattern: "beta", path: join(ws, "one.txt") }, ctx);
    expect(text(hit)).toBe("one.txt:2:beta");
    const miss = await grepTool.execute({ pattern: "zeta", path: join(ws, "one.txt") }, ctx);
    expect(miss.isError).toBe(false);
    expect(text(miss)).toContain("No matches");
  });

  it("matches case-insensitively when asked", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "c.txt"), "Hello World\n");
    const sensitive = await grepTool.execute({ pattern: "hello" }, ctx);
    expect(text(sensitive)).toContain("No matches");
    const insensitive = await grepTool.execute({ pattern: "hello", caseSensitive: false }, ctx);
    expect(text(insensitive)).toBe("c.txt:1:Hello World");
  });

  it("treats the pattern as a fixed string with literal: true", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "d.txt"), "a.b+c\naxbbc\n");
    const literal = await grepTool.execute({ pattern: "a.b+c", literal: true }, ctx);
    expect(text(literal)).toBe("d.txt:1:a.b+c");
    const regex = await grepTool.execute({ pattern: "a.b+c" }, ctx);
    expect(text(regex)).toBe("d.txt:2:axbbc");
  });

  it("filters files with the glob option", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "k.ts"), "needle\n");
    writeFileSync(join(ws, "k.md"), "needle\n");
    const res = await grepTool.execute({ pattern: "needle", glob: "*.ts" }, ctx);
    expect(text(res)).toBe("k.ts:1:needle");
  });

  it("caps matches at maxResults and flags further matches", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(
      join(ws, "many.txt"),
      `${Array.from({ length: 5 }, (_, i) => `hit number ${i + 1}`).join("\n")}\n`,
    );
    const res = await grepTool.execute({ pattern: "hit number", maxResults: 2 }, ctx);
    const out = text(res);
    expect(out).toContain("many.txt:1:hit number 1");
    expect(out).toContain("many.txt:2:hit number 2");
    expect(out).not.toContain("many.txt:3");
    // The streaming stop kills rg at the quota; when the summary event was
    // still buffered the footer is exact ("2 of 5"), otherwise it honestly
    // says the search stopped early. Both name the cap.
    expect(out).toContain("maxResults: 2");
    expect(out).toContain("…");
    expect(res.content[0]?.truncated).toBe(true);
  });

  it("stops early on huge result sets: exactly maxResults returned, promptly", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(
      join(ws, "huge.txt"),
      `${Array.from({ length: 20_000 }, (_, i) => `needle line ${i + 1}`).join("\n")}\n`,
    );
    const startedAt = Date.now();
    const res = await grepTool.execute({ pattern: "^needle", maxResults: 5 }, ctx);
    expect(Date.now() - startedAt).toBeLessThan(10_000); // did not drain 20k matches
    expect(res.isError).toBe(false);
    const lines = text(res)
      .split("\n")
      .filter((l) => l.includes("huge.txt:"));
    expect(lines).toHaveLength(5);
    expect(text(res)).toContain("maxResults: 5");
    expect(res.content[0]?.truncated).toBe(true);
  });

  it("kills a slow rg the moment maxResults is reached (stubbed generator)", async () => {
    // A stub `rg` that emits 3 match events, flushes, then holds the pipes
    // open for 30s (exec sleep). With maxResults=2 the tool must kill it and
    // return in milliseconds, not after the sleep.
    const bin = mkdtempSync(join(tmpdir(), "void-slowrg2-"));
    cleanups.push(bin);
    const events = [1, 2, 3]
      .map(
        (n) =>
          `{"type":"match","data":{"path":{"text":"/ws/gen.txt"},"line_number":${n},"lines":{"text":"gen ${n}\\n"}}}`,
      )
      .map((line) => `'${line}'`)
      .join(" ");
    // printf is a shell builtin (the spawn env carries only this stub's bin
    // on PATH, so cat would not be found — same CI note as the abort test);
    // /bin/sleep is absolute for the same reason.
    writeFileSync(join(bin, "rg"), `#!/bin/sh\nprintf '%s\\n' ${events}\nexec /bin/sleep 30\n`);
    chmodSync(join(bin, "rg"), 0o755);
    const { ws } = workspace();
    const ctx: ToolContext = {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: bin },
      requestPermission: async () => ({ action: "allow", message: "allow" }),
      outputLimits: { maxTotalChars: 200_000, maxSectionChars: 200_000 },
    };

    const startedAt = Date.now();
    const res = await grepTool.execute({ pattern: "gen", maxResults: 2 }, ctx);
    expect(Date.now() - startedAt).toBeLessThan(5_000); // killed, not waited out
    expect(res.isError).toBe(false);
    const out = text(res);
    expect(out).toContain("gen.txt:1:gen 1");
    expect(out).toContain("gen.txt:2:gen 2");
    expect(out).not.toContain("gen.txt:3");
    // No summary event was ever emitted: the footer must not imply completeness.
    expect(out).toContain("stopped early");
    expect(out).toContain("further matches may exist");
  });

  it("returns not_found for a missing search path", async () => {
    const { ctx } = workspace();
    const res = await grepTool.execute({ pattern: "x", path: "/definitely/void/missing" }, ctx);
    expect(res.error?.code).toBe("not_found");
  });

  it("fails with install guidance when rg is not on the context PATH", async () => {
    // PATH manipulation (documented approach): an empty temp dir has no rg,
    // and Bun.which resolves against exactly the provided PATH.
    const emptyBin = mkdtempSync(join(tmpdir(), "void-emptybin-"));
    cleanups.push(emptyBin);
    const { ws } = workspace();
    const ctx: ToolContext = {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: emptyBin },
      requestPermission: async () => ({ action: "allow", message: "allow" }),
      outputLimits: { maxTotalChars: 200_000, maxSectionChars: 200_000 },
    };
    const res = await grepTool.execute({ pattern: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("execution_failed");
    expect(res.error?.message).toContain("ripgrep");
    expect(res.error?.message).toContain("no fallback");
    expect(res.error?.retryable).toBe(false);
  });
});

runtimeDescribe("grep: cancellation via ctx.signal (Bun runtime)", () => {
  it("fails fast without spawning when the signal is already aborted", async () => {
    const { ctx } = workspace();
    const controller = new AbortController();
    controller.abort();
    const res = await grepTool.execute({ pattern: "x" }, { ...ctx, signal: controller.signal });
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("execution_failed");
    expect(res.error?.message).toContain("already fired");
    expect(res.error?.retryable).toBe(false);
  });

  it("kills a long-running rg child when the signal fires mid-run", async () => {
    // A stub `rg` that sleeps forever (exec, so the kill lands on the very
    // process holding the pipes) makes the abort path deterministic. The
    // sleep path is absolute on purpose: the spawn env carries only this
    // stub's bin on PATH, and /bin/sh's default PATH need not include
    // /usr/bin (CI observed "exec: sleep: not found", exit 127).
    const bin = mkdtempSync(join(tmpdir(), "void-slowrg-"));
    cleanups.push(bin);
    writeFileSync(join(bin, "rg"), "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(join(bin, "rg"), 0o755);
    const { ws } = workspace();
    const controller = new AbortController();
    const ctx: ToolContext = {
      workspaceRoot: ws,
      workingDir: ws,
      env: { PATH: bin },
      requestPermission: async () => ({ action: "allow", message: "allow" }),
      outputLimits: { maxTotalChars: 200_000, maxSectionChars: 200_000 },
      signal: controller.signal,
    };

    const startedAt = Date.now();
    const pending = grepTool.execute({ pattern: "x" }, ctx);
    setTimeout(() => controller.abort(), 25);
    const res = await pending;

    expect(Date.now() - startedAt).toBeLessThan(10_000); // did not wait for sleep 30
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("execution_failed");
    expect(res.error?.message).toContain("killed");
    expect(res.error?.retryable).toBe(false);
  });

  it("still returns results when a signal is provided but never fires", async () => {
    const { ws, ctx } = workspace();
    writeFileSync(join(ws, "s.txt"), "needle\n");
    const controller = new AbortController();
    const res = await grepTool.execute(
      { pattern: "needle" },
      { ...ctx, signal: controller.signal },
    );
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toContain("s.txt:1:needle");
  });
});
