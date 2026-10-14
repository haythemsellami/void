/**
 * Egress monitor — the in-process half of ADR-0002 property 5 verification
 * ("zero telemetry": no analytics, crash reporting, or update pinging; the
 * only network egress is the user-configured LLM provider, which tests reach
 * through an injected `fetchImpl`, never the global).
 *
 * Mechanism: replace `globalThis.fetch` with a recording stub that fails
 * every call. Any component that calls the REAL global `fetch` at call time
 * (i.e. anything not wired through the runner's `fetchImpl` injection seam)
 * trips the monitor and gets a loud rejection. Save/restore is explicit and
 * runtime-agnostic: it works identically under `bun test` and under
 * plain-Node vitest workers (no vi.mock, no Bun APIs).
 *
 * Coverage boundary, on purpose: this fixture sees call-time lookups of the
 * global `fetch` binding in this (or a child) realm. It cannot see a
 * reference captured before installation, `Bun.fetch`, or raw node:http
 * sockets — those egress channels are covered by the OS-level wrappers in
 * CI (sandbox-exec `(deny network*)` on macOS, `unshare -Urn` on Linux),
 * which deny at the kernel and catch everything. The two layers together
 * make the zero-egress property falsifiable; neither alone is complete.
 */
/** One real-fetch attempt observed through the patched global. */
export interface EgressAttempt {
  readonly url: string;
  readonly method: string | undefined;
  readonly stack: string | undefined;
}

/** Handle over an installed monitor: the attempt log plus teardown. */
export interface EgressMonitor {
  /** Every real-fetch attempt seen so far, in call order. */
  readonly attempts: readonly EgressAttempt[];
  /** Put the original global fetch back. Idempotent. */
  restore(): void;
}

/** Render a URL-ish value from the fetch signature's first parameter. */
function describeUrl(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

/**
 * Patch `globalThis.fetch` with the recording + failing stub. The returned
 * monitor MUST be restored (try/finally) — an unrestored stub would fail
 * every later fetch in the worker, which is exactly the loud failure mode
 * we want, but makes unrelated suites hard to read.
 */
export function installEgressMonitor(): EgressMonitor {
  type GlobalFetch = typeof globalThis.fetch;
  const saved: GlobalFetch = globalThis.fetch;
  const attempts: EgressAttempt[] = [];
  let restored = false;
  // Bun's global fetch type carries a non-standard `preconnect` member (DNS/
  // TCP warmup). Routing it to the real implementation would open sockets,
  // so the stub records it like any other egress attempt and does nothing.
  const stub: GlobalFetch = Object.assign(
    (input: Parameters<GlobalFetch>[0], init: Parameters<GlobalFetch>[1]) => {
      const url = describeUrl(input);
      attempts.push({
        url,
        method: init?.method,
        stack: new Error("egress probe stack").stack,
      });
      return Promise.reject(
        new Error(
          `[void egress monitor] unexpected real network fetch to ${url} — ` +
            "ADR-0002 property 5 (zero telemetry) forbids egress outside the " +
            "user-configured provider; tests must inject a fetchImpl instead",
        ),
      );
    },
    {
      preconnect: (url: string | URL): void => {
        attempts.push({
          url: describeUrl(url),
          method: undefined,
          stack: new Error("egress probe stack (preconnect)").stack,
        });
      },
    },
  );
  globalThis.fetch = stub;
  return {
    attempts,
    restore: () => {
      if (!restored) {
        globalThis.fetch = saved;
        restored = true;
      }
    },
  };
}

/**
 * Assert the monitor saw zero attempts; on failure, throw with every URL and
 * capture site so the offending component is identifiable from the log.
 */
export function assertNoEgress(monitor: EgressMonitor, label: string): void {
  if (monitor.attempts.length === 0) {
    return;
  }
  const lines = monitor.attempts.map(
    (attempt, index) =>
      `  #${index + 1}: ${attempt.method ?? "GET"} ${attempt.url}\n${attempt.stack ?? "(no stack)"}`,
  );
  throw new Error(
    `egress monitor: ${label} made ${monitor.attempts.length} real-fetch attempt(s):\n${lines.join("\n")}`,
  );
}
