/**
 * `src/store/errors` — structured errors thrown by the thread store.
 *
 * The codes and shape are defined by the contract
 * (`ThreadStoreErrorCode` / `ThreadStoreErrorShape` in
 * src/contracts/thread.ts); this class implements that shape so callers can
 * narrow on `code`/`path`/`line` without importing the store. Loud,
 * structured failure — never a silent skip — is the store's failure policy
 * (docs/architecture.md §store/: fail loudly instead of silently degrading).
 */
import type { ThreadStoreErrorCode, ThreadStoreErrorShape } from "../contracts/thread";

/** Re-exported from the contract so existing imports keep working. */
export type { ThreadStoreErrorCode };

interface ThreadStoreErrorOptions {
  readonly cause?: unknown;
  readonly path?: string;
  readonly line?: number;
}

/** Structured failure of the thread store; `path`/`line` localize log corruption. */
export class ThreadStoreError extends Error implements ThreadStoreErrorShape {
  readonly code: ThreadStoreErrorCode;
  /** Absolute path of the offending file, when one is known. */
  readonly path?: string | undefined;
  /** 1-based line number within `path`, when the error localizes to a line. */
  readonly line?: number | undefined;

  constructor(code: ThreadStoreErrorCode, message: string, options: ThreadStoreErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ThreadStoreError";
    this.code = code;
    this.path = options.path;
    this.line = options.line;
  }
}
