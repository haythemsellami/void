import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/ = cross-cutting suites (distribution: install.sh, npm stub,
    // release discipline, repo hygiene) and examples/ — both exercise repo
    // artifacts rather than a single component (ADR-0014). The 30s ceiling is
    // for loaded CI runners (default 5s produced starvation timeouts across
    // unrelated suites); bun's runner has no per-test ceiling.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "examples/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
