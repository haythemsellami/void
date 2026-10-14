/**
 * `src/settings/jsonc` — JSONC support for settings files (ADR-0006).
 *
 * JSONC = JSON with comments: `//` line comments and slash-star block
 * comments are allowed anywhere whitespace is, so a settings file can
 * document itself inline (the reason ADR-0006 picked the format: "JSONC
 * costs ~40 lines of comment-stripping and buys inline documentation").
 * Trailing commas are NOT part of the deal — only comments.
 *
 * Hand-rolled, zero dependencies: a single left-to-right scan that copies
 * string literals verbatim (a `//` inside a string is data, not a comment)
 * and drops comments everywhere else. The scanner is deliberately forgiving
 * about unterminated strings and unterminated block comments: it stops at
 * end-of-input and lets `JSON.parse` produce the precise syntax error.
 */
import { Buffer } from "node:buffer";

/** Cap on a settings file's byte size — 1 MiB, generous for hand-edited JSON. */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

/** Remove line and block comments, preserving string literals verbatim. */
export function stripJsoncComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : undefined;
    if (ch === '"') {
      // String literal: copy verbatim, honoring backslash escapes, so comment
      // markers inside strings ("https://…" is the classic) stay data.
      out += ch;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        out += c;
        i += 1;
        if (c === "\\") {
          if (i < text.length) {
            out += text[i];
            i += 1;
          }
          continue;
        }
        if (c === '"') {
          break;
        }
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      // Line comment: drop through end-of-line; the newline itself survives
      // (kept as whitespace, and so error line numbers stay honest).
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment: drop through the closing marker; replace with one
      // space so adjacent tokens never fuse (a comment between two digits
      // must not splice them into one number).
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i = i + 2 > text.length ? text.length : i + 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Parse JSONC (or plain JSON) text into an unknown value. Throws the
 * underlying `JSON.parse` SyntaxError (position included) on malformed input
 * — callers translate it into a structured settings problem naming the file.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsoncComments(text));
}

/** UTF-8 byte length of a settings file body (for the size cap). */
export function settingsByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
