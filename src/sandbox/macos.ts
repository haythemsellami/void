/**
 * macOS sandbox-exec profile generation (SBPL, version 1 dialect).
 *
 * Strategy, verified empirically on macOS 26 arm64 (see src/sandbox/run.test.ts):
 *
 *   (allow default)                       — reads, exec, mach lookups all pass
 *   (deny network*)                       — no sockets at all by default
 *   (allow network-outbound)              — outbound-only when network is requested
 *   (deny file-write*)                    — then deny every file write…
 *   (allow file-write* (subpath …))       — …and re-allow exactly the workspace,
 *                                            the sandbox temp dir, and the
 *                                            per-user temp base
 *   (allow file-write-data /dev/null)     — redirected output must keep working
 *
 * SBPL evaluation is last-match-wins, so the targeted allowances must come
 * after the blanket denies. Two empirical caveats shaped the template:
 *
 * - Writes to inherited pipes (stdout/stderr) are NOT governed by file-write
 *   rules (no vnode path to match), so captured output works under a full
 *   write deny — but /dev/null IS a vnode and needs its own allowance.
 * - Darwin tools that use confstr(_CS_DARWIN_USER_TEMPDIR) — mktemp(1),
 *   compilers, … — write to the per-user temp base regardless of $TMPDIR, so
 *   that base must be writable or basic commands break. /private/var/tmp
 *   (system-wide sticky temp) stays denied on purpose: it is not per-user.
 *
 * Reads are deliberately allowed everywhere (reads are not the risk surface
 * for the MVP; docs/architecture.md §sandbox).
 *
 * This module is a pure template function: it resolves/normalizes paths and
 * renders a string, nothing else. Execution lives in run.ts.
 */
import { tmpdir } from "node:os";
import { canonicalPath } from "./paths";

export interface MacosProfileOptions {
  /** Directory the sandboxed command may write to (the workspace). */
  readonly workspaceRoot: string;
  /** Extra writable temp dir (e.g. a per-call mkdtemp). Defaults to none. */
  readonly tempDir?: string;
  /** Allow outbound network (listening sockets stay denied either way). */
  readonly allowNetwork?: boolean;
}

/** Escape a path for use inside a double-quoted SBPL string literal. */
function escapeSbplString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Render the sandbox-exec v1 profile for one invocation. */
export function generateMacosProfile(opts: MacosProfileOptions): string {
  const workspaceRoot = canonicalPath(opts.workspaceRoot);
  // Per-user temp base (confstr(_CS_DARWIN_USER_TEMPDIR), symlink-resolved).
  const userTempBase = canonicalPath(tmpdir());
  const tempDir = opts.tempDir === undefined ? null : canonicalPath(opts.tempDir);

  const writableRoots = [workspaceRoot, userTempBase];
  if (tempDir !== null && !writableRoots.includes(tempDir)) {
    writableRoots.push(tempDir);
  }

  const lines: string[] = ["(version 1)", "(allow default)", "(deny network*)"];
  if (opts.allowNetwork === true) {
    // Outbound only: bind()/listen stay denied by (deny network*) above.
    lines.push("(allow network-outbound)");
  }
  lines.push("(deny file-write*)");
  for (const root of writableRoots) {
    lines.push(`(allow file-write* (subpath "${escapeSbplString(root)}"))`);
  }
  lines.push('(allow file-write-data (literal "/dev/null"))');
  return `${lines.join("\n")}\n`;
}
