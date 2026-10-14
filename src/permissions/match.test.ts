/**
 * Matcher matrix for `permissions/match.ts`: every matcher kind, nesting,
 * missing keys, arrays, regex-vs-glob disambiguation. Pure and deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  globToRegExp,
  isGlobPattern,
  looksLikeRegexLiteral,
  matchInput,
  matchInputDetailed,
  matchValue,
  parseRegexLiteral,
} from "./match";

describe("globToRegExp", () => {
  it("anchors patterns to the full string", () => {
    const re = globToRegExp("cat*");
    expect(re.test("cat")).toBe(true);
    expect(re.test("cat with args")).toBe(true);
    expect(re.test("concat")).toBe(false);
    expect(re.test("cat.exe")).toBe(true); // * spans ".exe"
    expect(re.test("cat src/foo.ts")).toBe(false); // * cannot span the /
    expect(globToRegExp("cat**").test("cat src/foo.ts")).toBe(true); // ** can
  });

  it("keeps * within one path segment", () => {
    expect(globToRegExp("a*b").test("axb")).toBe(true); // * spans the x
    expect(globToRegExp("a*b").test("a/b")).toBe(false); // * does not span /
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/a.ts")).toBe(false);
  });

  it("lets ** span separators", () => {
    expect(globToRegExp("a**b").test("a/b")).toBe(true);
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src")).toBe(false); // needs the slash
    expect(globToRegExp("**").test("anything/here")).toBe(true);
    expect(globToRegExp("**").test("")).toBe(true);
  });

  it("treats ? as one non-separator character", () => {
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a?c").test("ac")).toBe(false);
    expect(globToRegExp("a?c").test("a/c")).toBe(false);
    expect(globToRegExp("a??c").test("axxc")).toBe(true);
  });

  it("supports character classes, including negation", () => {
    expect(globToRegExp("[abc]at").test("bat")).toBe(true);
    expect(globToRegExp("[abc]at").test("hat")).toBe(false);
    expect(globToRegExp("[!a]at").test("bat")).toBe(true);
    expect(globToRegExp("[!a]at").test("aat")).toBe(false);
    expect(globToRegExp("[a-c]at").test("cat")).toBe(true);
    expect(globToRegExp("[]a]").test("]")).toBe(true); // literal ] first
  });

  it("escapes regex metacharacters as literals", () => {
    expect(globToRegExp("a.b").test("axb")).toBe(false); // dot is literal in a glob
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("v1.2").test("v192")).toBe(false);
    expect(globToRegExp("a+b(x)").test("a+b(x)")).toBe(true);
    expect(globToRegExp("{a,b}").test("{a,b}")).toBe(true); // no brace expansion
  });

  it("throws on malformed character classes", () => {
    expect(() => globToRegExp("a[b")).toThrow(/unterminated character class/);
    expect(() => globToRegExp("a[]b")).toThrow(/unterminated character class/); // ] was consumed as literal
    expect(globToRegExp("a[]b]").test("ab")).toBe(true); // []b] — class of ] and b
    expect(globToRegExp("a[]b]").test("a]")).toBe(true);
    expect(globToRegExp("a[]b]").test("a]b")).toBe(false); // class consumes one char only
  });

  it("detects glob metacharacters", () => {
    expect(isGlobPattern("a*b")).toBe(true);
    expect(isGlobPattern("a?b")).toBe(true);
    expect(isGlobPattern("a[b]")).toBe(true);
    expect(isGlobPattern("a.b")).toBe(false);
    expect(isGlobPattern("/regex/")).toBe(false); // slashes are not glob metachars
  });
});

describe("parseRegexLiteral (regex vs glob vs exact disambiguation)", () => {
  it("parses /pattern/flags literals", () => {
    const re = parseRegexLiteral("/^git\\s+push/");
    expect(re).toBeDefined();
    expect(re?.test("git push origin")).toBe(true);
    expect(re?.test("git  push")).toBe(true);
    expect(re?.test("git commit")).toBe(false);

    const ci = parseRegexLiteral("/^err(or)?$/i");
    expect(ci?.test("ERROR")).toBe(true);
    expect(ci?.test("errors")).toBe(false);
  });

  it("matches a dot wildcard: /a.b/ matches axb, a.b plain does not", () => {
    expect(matchValue("/a.b/", "axb")).toBe(true); // regex: . is any char
    expect(matchValue("/a.b/", "a.b")).toBe(true);
    expect(matchValue("/a.b/", "ab")).toBe(false);
    expect(matchValue("a.b", "axb")).toBe(false); // plain string: exact match
    expect(matchValue("a.b", "a.b")).toBe(true);
  });

  it("keeps /etc/hosts as an exact string (invalid flag run, not a regex)", () => {
    expect(parseRegexLiteral("/etc/hosts")).toBeUndefined();
    expect(looksLikeRegexLiteral("/etc/hosts")).toBe(false);
    expect(matchValue("/etc/hosts", "/etc/hosts")).toBe(true); // exact fallback
    expect(matchValue("/etc/hosts", "etc")).toBe(false);
  });

  it("detects malformed regex literals by shape", () => {
    expect(looksLikeRegexLiteral("/x(/")).toBe(true);
    expect(parseRegexLiteral("/x(/")).toBeUndefined(); // does not compile
    expect(matchValue("/x(/", "x(")).toBe(false); // never matches anything
    expect(parseRegexLiteral("/a.b/")).toBeDefined();
    expect(parseRegexLiteral("no slashes")).toBeUndefined();
    expect(parseRegexLiteral("/")).toBeUndefined(); // needs two slashes
    expect(parseRegexLiteral("//")).toBeDefined(); // empty pattern: matches all strings
  });

  it("supports flags and internal escaped slashes", () => {
    const withSlash = parseRegexLiteral("/src\\/main/");
    expect(withSlash?.test("src/main")).toBe(true);
    expect(withSlash?.test("srcXmain")).toBe(false);
  });
});

describe("matchValue", () => {
  it("matches primitives with strict equality", () => {
    expect(matchValue("cat", "cat")).toBe(true);
    expect(matchValue("cat", "cats")).toBe(false);
    expect(matchValue(3, 3)).toBe(true);
    expect(matchValue(3, "3")).toBe(false); // no cross-type coercion
    expect(matchValue(true, true)).toBe(true);
    expect(matchValue(true, 1)).toBe(false);
    expect(matchValue(null, null)).toBe(true);
    expect(matchValue(null, "null")).toBe(false);
  });

  it("treats * as always-true, for any value kind", () => {
    expect(matchValue("*", "anything")).toBe(true);
    expect(matchValue("*", 42)).toBe(true);
    expect(matchValue("*", false)).toBe(true);
    expect(matchValue("*", null)).toBe(true);
    expect(matchValue("*", ["a"])).toBe(true);
  });

  it("treats an undefined matcher as an unconstrained field", () => {
    expect(matchValue(undefined, "x")).toBe(true);
    expect(matchValue(undefined, undefined)).toBe(true);
  });

  it("never matches regex or glob matchers against non-string values", () => {
    expect(matchValue("/\\d+/", 123)).toBe(false);
    expect(matchValue("a*", 123)).toBe(false);
    expect(matchValue("a*", null)).toBe(false);
    expect(matchValue("a*", ["ax"])).toBe(false); // no auto-spread over arrays
  });

  it("ORs across array matcher entries (including nested arrays)", () => {
    expect(matchValue(["git status", "git diff*"], "git diff --stat")).toBe(true);
    expect(matchValue(["git status", "git diff*"], "git push")).toBe(false);
    expect(matchValue(["/\\d+/", 3], 3)).toBe(true);
    expect(matchValue([["a", "b"], "c"], "b")).toBe(true); // nested OR
    expect(matchValue([], "anything")).toBe(false); // empty OR matches nothing
  });
});

describe("matchInput", () => {
  it("matches any input with the * spec", () => {
    expect(matchInput("*", {})).toBe(true);
    expect(matchInput("*", { command: "rm -rf /" })).toBe(true);
  });

  it("ANDs across record keys", () => {
    const spec = { tool: "bash", command: "git*" } as const;
    expect(matchInput(spec, { tool: "bash", command: "git status" })).toBe(true);
    expect(matchInput(spec, { tool: "bash", command: "ls" })).toBe(false);
    expect(matchInput(spec, { tool: "node", command: "git status" })).toBe(false);
  });

  it("resolves nested dotted paths", () => {
    expect(matchInput({ "file.path": "src/**" }, { file: { path: "src/a.ts" } })).toBe(true);
    expect(matchInput({ "file.path": "src/**" }, { file: { path: "docs/a.md" } })).toBe(false);
    expect(matchInput({ "a.b.c": 1 }, { a: { b: { c: 1 } } })).toBe(true);
  });

  it("indexes arrays with numeric segments", () => {
    expect(matchInput({ "items.0.name": "x" }, { items: [{ name: "x" }] })).toBe(true);
    expect(matchInput({ "items.1.name": "x" }, { items: [{ name: "x" }] })).toBe(false);
    expect(matchInput({ "items.0": "*" }, { items: ["anything"] })).toBe(true);
  });

  it("fails entries whose key is missing (unless the matcher is undefined)", () => {
    expect(matchInput({ command: "ls" }, {})).toBe(false);
    expect(matchInput({ "file.path": "x" }, { file: {} })).toBe(false);
    expect(matchInput({ other: "x" }, { command: "ls" })).toBe(false);
    // undefined matcher = unconstrained, even when the key is missing
    expect(
      matchInputDetailed({ command: undefined } as unknown as Record<string, never>, {}),
    ).toEqual({ matched: true, key: "command" });
  });

  it("does not traverse into primitives mid-path", () => {
    expect(matchInput({ "a.b": 1 }, { a: "not an object" })).toBe(false);
    expect(matchInput({ "a.0": 1 }, { a: 0 })).toBe(false);
  });

  it("matches an empty record vacuously", () => {
    expect(matchInput({}, { anything: "goes" })).toBe(true);
  });

  it("reports which key decided the outcome", () => {
    expect(matchInputDetailed({ command: "ls" }, { command: "ls" })).toEqual({
      matched: true,
      key: "command",
    });
    expect(matchInputDetailed({ a: "x", b: "y" }, { a: "x", b: "z" })).toEqual({
      matched: false,
      key: "b",
    });
    expect(matchInputDetailed({ "file.path": "z" }, { file: { path: "a" } })).toEqual({
      matched: false,
      key: "file.path",
    });
  });
});
