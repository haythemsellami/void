/**
 * Path canonicalization shared by the sandbox generators and the bash tool.
 *
 * Sandbox rule matching happens on the paths the kernel resolves, not the
 * paths the user typed: on macOS `/tmp` and `/var` are symlinks into
 * `/private/tmp` and `/private/var`, so a profile that allows `/var/folders/…`
 * as written would silently fail to match. Every path embedded in a sandbox
 * rule or compared against one must go through `canonicalPath` first.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve symlinks and make the path absolute. Falls back to lexical
 * resolution when the path does not exist yet (realpathSync would throw);
 * callers that require existence (e.g. the bash tool's workdir) must check
 * it separately.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
