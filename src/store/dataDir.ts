/**
 * `src/store/dataDir` — resolves Void's platform data directory.
 *
 * Precedence (docs/architecture.md §store/, ADR-0002 property 6: threads are
 * local files, inspectable by the user):
 *   1. `$VOID_DATA_DIR`  — explicit override, used as-is (power users/CI/tests)
 *   2. `$XDG_DATA_HOME/void` — only when the value is absolute (per the XDG
 *      Base Directory spec, non-absolute values MUST be ignored)
 *   3. `~/.local/share/void` — the XDG default (via `os.homedir()`, which
 *      honors `$HOME` on POSIX)
 *
 * Creation is lazy: nothing happens at import time; the first call to
 * `resolveDataDir()` mkdirs the directory (recursive) and returns its absolute
 * path. Subdirectories (e.g. `threads/`) are created by the store on demand.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Resolves (and lazily creates) Void's data directory. */
export async function resolveDataDir(): Promise<string> {
  const override = process.env.VOID_DATA_DIR?.trim();
  if (override !== undefined && override !== "") {
    return ensureDir(resolve(override));
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome !== undefined && xdgDataHome !== "" && isAbsolute(xdgDataHome)) {
    return ensureDir(resolve(join(xdgDataHome, "void")));
  }

  // The XDG default is defined in terms of $HOME; prefer it when set (also
  // deterministic under test) and fall back to os.homedir() for platforms
  // where HOME is absent (e.g. Windows).
  const home = process.env.HOME?.trim() || homedir();
  return ensureDir(resolve(join(home, ".local", "share", "void")));
}

async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}
