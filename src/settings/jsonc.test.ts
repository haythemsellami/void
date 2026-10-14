/**
 * JSONC stripper tests: the comment matrix (line, block, nested-ish,
 * in-string markers, edge shapes) plus parseJsonc end-to-end behavior.
 */
import { describe, expect, it } from "vitest";
import { parseJsonc, settingsByteLength, stripJsoncComments } from "./jsonc";

describe("stripJsoncComments", () => {
  it("strips full-line and trailing line comments, keeps newlines", () => {
    // Whitespace BEFORE the marker survives (it precedes the comment); only
    // the marker-to-end-of-line span is dropped.
    expect(stripJsoncComments("// leading\n{\n  // inner\n} // trailing\n")).toBe("\n{\n  \n} \n");
  });

  it("strips block comments, inline and multiline", () => {
    expect(stripJsoncComments("{/*c*/}")).toBe("{ }");
    expect(stripJsoncComments("{\n/* one\n two\n*/\n}")).toBe("{\n \n}");
  });

  it("replaces a block comment with a space so tokens never fuse", () => {
    expect(stripJsoncComments('{"a":1/*c*/2}')).toBe('{"a":1 2}');
  });

  it("never treats comment markers inside strings as comments", () => {
    const url = '{"u": "https://example.com/x", "p": "//not-a-comment"}';
    expect(stripJsoncComments(url)).toBe(url);
  });

  it("keeps escaped quotes and escapes inside strings intact", () => {
    const tricky = '{"s": "a \\" // b /* c", "n": 1}';
    expect(stripJsoncComments(tricky)).toBe(tricky);
  });

  it("unterminated block comment drops to end of input without throwing", () => {
    // The comment span (marker to EOF) is replaced by one space; the space
    // that preceded the marker was already copied.
    expect(stripJsoncComments('{"a":1} /* never closed')).toBe('{"a":1}  ');
  });

  it("unterminated string copies to end of input without throwing", () => {
    expect(stripJsoncComments('{"s": "abc')).toBe('{"s": "abc');
  });

  it("empty input and comment-only input", () => {
    expect(stripJsoncComments("")).toBe("");
    expect(stripJsoncComments("// nothing here\n")).toBe("\n");
  });
});

describe("parseJsonc", () => {
  it("parses commented JSON into the same value plain JSON.parse would", () => {
    const text = [
      "{",
      "  // the schema version this file speaks",
      '  "settingsVersion": 1,',
      '  "defaultModel": "ollama/qwen3:14b" /* local default */',
      "}",
    ].join("\n");
    expect(parseJsonc(text)).toEqual({
      settingsVersion: 1,
      defaultModel: "ollama/qwen3:14b",
    });
  });

  it("rejects trailing commas exactly like strict JSON (comments-only format)", () => {
    expect(() => parseJsonc('{"a":1,} // comma stays\n')).toThrow();
  });

  it("surfaces JSON.parse syntax errors for malformed bodies", () => {
    expect(() => parseJsonc("{oops}")).toThrow(SyntaxError);
  });

  it("settingsByteLength counts UTF-8 bytes, not UTF-16 units", () => {
    expect(settingsByteLength("aé…")).toBe(1 + 2 + 3);
    expect(settingsByteLength("")).toBe(0);
  });
});
