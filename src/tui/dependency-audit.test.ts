/**
 * Dependency-boundary audit (ADR-0005 rules 1, 2, 3, and 5):
 *
 * 1. `package.json` `dependencies` is EXACTLY the allowlist {react, ink,
 *    react-devtools-core} — react/ink are the TUI's own deps;
 *    react-devtools-core is ink's OPTIONAL PEER whose module graph references
 *    it regardless (bun does not install optional peers), so it must be an
 *    explicit dependency or `bun build --compile` fails to resolve it.
 *    Anything else must not sneak in.
 * 2. `devDependencies` stay within the known set (ink-testing-library and
 *    @types/react are the TUI's dev-only additions — rule: testing library
 *    never ships as a runtime dep).
 * 3. No file outside `src/tui/**` imports react/ink (static `from`,
 *    side-effect `import`, dynamic `import()`, or `require`) — keeping the
 *    headless binary buildable with the TUI deps absent (rule 3).
 * 4. `src/tui/**` never writes to the thread store: store access is
 *    READ-ONLY replay (rule 2 as amended 2026-10-14; persistence flows
 *    through runTask, which owns its own store instance).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("dependency audit (ADR-0005)", () => {
  it("runtime dependencies are exactly the allowlist {react, ink, react-devtools-core}", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "ink",
      "react",
      "react-devtools-core",
    ]);
  });

  it("devDependencies stay within the audited set (TUI adds only the testing library + types)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const allowed = new Set([
      "@biomejs/biome",
      "@types/bun",
      "@types/react",
      "ink-testing-library",
      "typescript",
      "vitest",
    ]);
    const actual = Object.keys(pkg.devDependencies ?? {});
    const unexpected = actual.filter((name) => !allowed.has(name));
    expect(
      unexpected,
      `unexpected devDependencies ${JSON.stringify(unexpected)} — extend the allowlist deliberately (ADR-0005)`,
    ).toEqual([]);
  });

  it("no module outside src/tui imports react or ink (static, side-effect, dynamic, require)", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(repoRoot, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(text)) {
        if (isTuiOnlyModule(specifier)) {
          offenders.push(`${relativeToRoot(file)} imports "${specifier}"`);
        }
      }
    }
    expect(offenders, "react/ink imports are confined to src/tui/** (ADR-0005 rule 1)").toEqual([]);
  });

  it("tui never writes to the thread store (read-only replay, rule 2 as amended)", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(repoRoot, "src", "tui"))) {
      // Product code only — this test file itself mentions ".append(" in
      // its scan literal.
      if (file.endsWith(".test.ts")) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (text.includes(".append(")) {
        offenders.push(`${relativeToRoot(file)} calls .append() — the store's write API`);
      }
    }
    expect(
      offenders,
      "store access from src/tui is read-only replay; persistence flows through runTask",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers (deliberately boring: readdir walk + regex scan)
// ---------------------------------------------------------------------------

/** Recursively list .ts/.tsx files under a directory. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tui") {
        continue; // the boundary's inside
      }
      files.push(...listSourceFiles(path));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(path);
    }
  }
  return files;
}

function relativeToRoot(path: string): string {
  return path.slice(repoRoot.length);
}

/** Extract module specifiers from every import/require form we use. */
function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** True for react/ink module roots and subpaths (the ADR-0005 island). */
function isTuiOnlyModule(specifier: string): boolean {
  return (
    specifier === "react" ||
    specifier === "ink" ||
    specifier === "ink-testing-library" ||
    specifier === "@types/react" ||
    specifier.startsWith("react/") ||
    specifier.startsWith("ink/") ||
    specifier.startsWith("ink-testing-library/")
  );
}
