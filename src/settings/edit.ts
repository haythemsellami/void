/**
 * `src/settings/edit` — the `void settings edit` file side (ADR-0006): when
 * the target file is absent, create it as an EXCLUSIVE 0600 skeleton whose
 * content is exactly `{"settingsVersion":1}` (byte-exact per the ADR-0006
 * amendment), creating the parent directory when needed. An existing file is
 * never touched — the editor opens whatever is already there.
 *
 * Exclusive creation (`wx`): two concurrent `void settings edit` invocations
 * cannot clobber each other or an existing file; EEXIST is the benign
 * "already present" outcome. I/O seams are injectable for tests.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The exact skeleton body written for a missing settings file (ADR-0006). */
export const SETTINGS_SKELETON = '{"settingsVersion":1}';

/** Outcome of {@link ensureSettingsFile}. */
export interface EnsureSettingsFileResult {
  /** True when THIS call created the file (false: it already existed). */
  readonly created: boolean;
}

/** Injectability seams (tests); defaults touch the real filesystem. */
export interface EnsureSettingsFileOptions {
  readonly mkdir?: (path: string) => Promise<void>;
  readonly writeFile?: (path: string, data: string) => Promise<void>;
}

/**
 * Make sure the settings file at `path` exists, creating the parent directory
 * and the 0600 skeleton when it does not. Throws on anything other than
 * EEXIST (caller maps to a structured error naming the path).
 */
export async function ensureSettingsFile(
  path: string,
  options: EnsureSettingsFileOptions = {},
): Promise<EnsureSettingsFileResult> {
  const doMkdir = options.mkdir ?? ((dir: string) => mkdir(dir, { recursive: true }));
  const doWrite =
    options.writeFile ??
    ((file: string, data: string) => writeFile(file, data, { flag: "wx", mode: 0o600 }));
  await doMkdir(dirname(path));
  try {
    await doWrite(path, SETTINGS_SKELETON);
    return { created: true };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return { created: false };
    }
    throw cause;
  }
}
