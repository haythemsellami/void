/**
 * `src/mcp/exit` — zombie-server prevention (ADR-0011 shutdown contract).
 *
 * Normal exit paths already await `manager.shutdown()` in a finally
 * (runTaskCommand, `void mcp list`, `void mcp doctor`), which closes stdin,
 * SIGTERMs, and SIGKILLs after the grace period. The gap is a SIGNAL tearing
 * the CLI down mid-run (Ctrl-C): no finally runs, and a server child that
 * ignores SIGHUP/SIGTERM would outlive the CLI as an orphan. This module
 * keeps a live set of manager-cleanups and (installed exactly once, from the
 * CLI's process boundary) runs them on SIGINT/SIGTERM before exiting with
 * the conventional 128+signal codes.
 *
 * Purity: nothing here runs at import time — `process` is touched only
 * inside {@link installMcpExitHooks}, called solely from the `import.meta.main`
 * entry block, so embedding runCli as a library never installs handlers.
 * The cleanup is best-effort and hard-capped: a wedged shutdown cannot hold
 * the exit hostage past grace + 1s (SIGKILL escalation already lives in the
 * client's shutdown).
 */
import { MCP_SHUTDOWN_GRACE_MS } from "./client";

/** Registered cleanup callbacks (manager shutdowns), keyed by identity. */
const cleaners = new Set<() => Promise<void>>();

/**
 * Register one cleanup; returns its unregister function (call it after the
 * normal-path shutdown so a later signal does not await a settled promise).
 */
export function registerMcpCleaner(clean: () => Promise<void>): () => void {
  cleaners.add(clean);
  return () => {
    cleaners.delete(clean);
  };
}

/** Hard cap for exit-path cleanup: grace + 1s, then the process exits anyway. */
const EXIT_CLEANUP_CAP_MS = MCP_SHUTDOWN_GRACE_MS + 1_000;

/** Run every registered cleanup, bounded; never throws. */
export async function runMcpExitCleanups(): Promise<void> {
  const pending = [...cleaners].map((clean) => clean());
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, EXIT_CLEANUP_CAP_MS);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** Install the SIGINT/SIGTERM hooks (idempotent). Entry-block use only. */
let hooksInstalled = false;

export function installMcpExitHooks(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.once(signal, () => {
      void (async () => {
        try {
          await runMcpExitCleanups();
        } finally {
          process.exit(signal === "SIGINT" ? 130 : 143);
        }
      })();
    });
  }
}
