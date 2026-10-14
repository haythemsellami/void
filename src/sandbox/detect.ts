/**
 * Sandbox capability detection: which OS-level sandbox this machine can run.
 *
 * ADR-0002 property 3: shell tools execute OS-sandboxed by default and Void
 * never silently falls back to unsandboxed execution. Detection is the first
 * half of that promise — `run.ts` refuses to execute a command when no sandbox
 * binary is found, and `tools/bash.ts` surfaces that refusal as a structured
 * `sandbox_blocked` error carrying the install guidance exported here.
 *
 * macOS: `sandbox-exec` (SBPL profiles; ships with the OS at /usr/bin).
 * Linux: `bubblewrap` (`bwrap`, namespace-based; distro package).
 */
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export type SandboxPlatform = "darwin" | "linux" | "unsupported";

export type SandboxKind = "sandbox-exec" | "bwrap";

export interface SandboxDetection {
  readonly platform: SandboxPlatform;
  /** Sandbox mechanism usable on this machine; null when none was found. */
  readonly kind: SandboxKind | null;
  /** Absolute path of the sandbox binary; null when none was found. */
  readonly binaryPath: string | null;
}

/**
 * PATH lookup for a sandbox binary. Prefers Bun.which (the native resolver in
 * Void's own runtime); falls back to an explicit PATH scan so the module also
 * works under a plain Node runtime (e.g. vitest workers), where the `Bun`
 * global does not exist. Exported for test skip-guards.
 */
export function whichBinary(binary: string): string | null {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which(binary);
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not present/not executable in this PATH entry — keep scanning.
    }
  }
  return null;
}

/** Detect the OS-level sandbox for the current platform via PATH lookup. */
export function detectSandbox(): SandboxDetection {
  switch (process.platform) {
    case "darwin": {
      const binaryPath = whichBinary("sandbox-exec");
      return binaryPath === null
        ? { platform: "darwin", kind: null, binaryPath: null }
        : { platform: "darwin", kind: "sandbox-exec", binaryPath };
    }
    case "linux": {
      const binaryPath = whichBinary("bwrap");
      return binaryPath === null
        ? { platform: "linux", kind: null, binaryPath: null }
        : { platform: "linux", kind: "bwrap", binaryPath };
    }
    default:
      return { platform: "unsupported", kind: null, binaryPath: null };
  }
}

/**
 * Human-readable remediation per platform, embedded in `sandbox_blocked`
 * tool errors. Every string names the explicit unsandboxed opt-out knob so
 * the escape hatch is discoverable exactly where the refusal happens.
 */
export const SANDBOX_INSTALL_GUIDANCE: Readonly<Record<SandboxPlatform, string>> = {
  darwin:
    "sandbox-exec ships with macOS at /usr/bin/sandbox-exec; if it is missing the system is " +
    "unusually modified (MDM/hardening). Void refuses to run shell commands unsandboxed. " +
    "Explicit opt-out: set VOID_ALLOW_UNSANDBOXED=1 in the tool environment.",
  linux:
    "Install bubblewrap: 'apt install bubblewrap' (Debian/Ubuntu), 'dnf install bubblewrap' " +
    "(Fedora), 'pacman -S bubblewrap' (Arch), or 'apk add bubblewrap' (Alpine). Void refuses " +
    "to run shell commands unsandboxed. Explicit opt-out: set VOID_ALLOW_UNSANDBOXED=1 in the " +
    "tool environment.",
  unsupported:
    "Void has no OS sandbox implementation for this platform yet, so shell commands are " +
    "refused. Explicit opt-out: set VOID_ALLOW_UNSANDBOXED=1 in the tool environment.",
};
