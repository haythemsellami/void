/**
 * Regenerate the embedded prompt modules from `prompts/` so the compiled
 * binary carries them (`bun build --compile` has no source tree):
 *
 * - `prompts/default.md`            → `src/context/default-prompt.ts`
 * - `prompts/compaction.md`         → `src/context/compaction-prompt.ts` (ADR-0008)
 * - `prompts/modes/explorer.md`     → `src/context/explorer-mode-prompt.ts` (ADR-0013)
 * - `prompts/modes/planner.md`      → `src/context/planner-mode-prompt.ts` (ADR-0013)
 *
 * `bun run build` chains this; the drift tests (`*-prompt.test.ts`) fail the
 * suite if an embedded copy ever diverges from its source file.
 */
import { readFile, writeFile } from "node:fs/promises";

interface PromptSpec {
  readonly source: string;
  readonly output: string;
  readonly constant: string;
  readonly description: string;
  /** Drift test guarding this copy (named in the generated header). */
  readonly driftTest: string;
}

const SPECS: readonly PromptSpec[] = [
  {
    source: "../prompts/default.md",
    output: "../src/context/default-prompt.ts",
    constant: "EMBEDDED_DEFAULT_PROMPT",
    description: "The built-in system prompt, embedded for compiled binaries (see prompts.ts).",
    driftTest: "default-prompt.test.ts",
  },
  {
    source: "../prompts/compaction.md",
    output: "../src/context/compaction-prompt.ts",
    constant: "EMBEDDED_COMPACTION_PROMPT",
    description:
      "The compaction summarization prompt (ADR-0008), embedded for compiled binaries (see prompts.ts).",
    driftTest: "compaction-prompt.test.ts",
  },
  {
    source: "../prompts/modes/explorer.md",
    output: "../src/context/explorer-mode-prompt.ts",
    constant: "EMBEDDED_EXPLORER_MODE_PROMPT",
    description:
      "The explorer mode preset for the task tool (ADR-0013), embedded for compiled binaries (see prompts.ts).",
    driftTest: "explorer-mode-prompt.test.ts",
  },
  {
    source: "../prompts/modes/planner.md",
    output: "../src/context/planner-mode-prompt.ts",
    constant: "EMBEDDED_PLANNER_MODE_PROMPT",
    description:
      "The planner mode preset for the task tool (ADR-0013), embedded for compiled binaries (see prompts.ts).",
    driftTest: "planner-mode-prompt.test.ts",
  },
];

for (const spec of SPECS) {
  const source = await readFile(new URL(spec.source, import.meta.url), "utf8");
  // Path relative to prompts/ for the generated header ("modes/explorer.md").
  const promptRelative = spec.source.replace(/^\.\.\/prompts\//, "");
  const output = `/**
 * GENERATED FILE — do not edit by hand. Regenerate with \`bun run sync-prompt\`.
 * Source of truth: prompts/${promptRelative}; ${spec.driftTest} fails the
 * build if this embedded copy ever drifts from it.
 */

/** ${spec.description} */
export const ${spec.constant} = ${JSON.stringify(source)};
`;
  await writeFile(new URL(spec.output, import.meta.url), output, "utf8");
  console.log(`${spec.output} synced from ${spec.source}`);
}
