/**
 * npm launcher-stub logic (ADR-0014, channel 3) — PURE module shared by
 * npm/postinstall.mjs (download + verify at install time) and npm/bin/void.js
 * (exec the platform binary at run time). No side effects here: every
 * function takes explicit inputs, which is what tests/npm-stub.test.ts
 * exercises (target mapping, version resolution, URL composition, checksum
 * parsing — no network, no fs).
 *
 * One source of truth with install.sh: the same GitHub Releases assets
 * (void-<target> + SHA256SUMS), the same env knobs, the same hard-fail
 * checksum policy.
 *
 * Env seams (mirroring install.sh):
 *   VOID_VERSION       release tag override ("vX.Y.Z" or "latest")
 *   VOID_REPO          GitHub <owner>/<repo> hosting releases
 *   VOID_RELEASE_URL   override the release base URL entirely (tests point
 *                      this at a local file:// fixture via a fetch impl)
 *   VOID_NPM_BIN_HOME  override the ~/.void-cli/bin install root
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_REPO = "haythemsellami/Void";

export const INSTALL_SH_ONE_LINER =
  "curl -fsSL https://raw.githubusercontent.com/haythemsellami/Void/main/install.sh | bash";

/**
 * Map a node platform/arch pair to the release target name, or null when we
 * ship no binary for it (the launcher then points at build-from-source).
 * NOTE the deliberate renames: darwin→macos, x64 stays x64, arm64 stays arm64.
 */
export function targetFor(platform, arch) {
  switch (`${platform}/${arch}`) {
    case "darwin/arm64":
      return "macos-arm64";
    case "darwin/x64":
      return "macos-x64";
    case "linux/x64":
      return "linux-x64";
    case "linux/arm64":
      return "linux-arm64";
    default:
      return null;
  }
}

/**
 * Which release does this package install from? The npm package's OWN
 * version pins the release (void-cli@0.2.0 ↔ release v0.2.0 — ADR-0014
 * version discipline), unless VOID_VERSION overrides (any "vX.Y.Z" or
 * "latest"). Returns the version STRING used in URLs.
 */
export function resolveVersion(envVersion, pkgVersion) {
  const override = typeof envVersion === "string" && envVersion.length > 0 ? envVersion : null;
  if (override) {
    return override;
  }
  return `v${pkgVersion}`;
}

/** Release base URL; "latest" resolves through GitHub's redirect (no API). */
export function releaseBaseUrl(repo, version) {
  if (version === "latest") {
    return `https://github.com/${repo}/releases/latest/download`;
  }
  return `https://github.com/${repo}/releases/download/${version}`;
}

/** Asset URL composition (the seam tests override). */
export function assetUrl(baseUrl, assetName) {
  return `${baseUrl}/${assetName}`;
}

/** Extract the expected sha256 for an artifact from SHA256SUMS text, or null. */
export function parseExpectedChecksum(sumsText, artifactName) {
  for (const line of sumsText.split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+(\S+)\s*$/);
    if (match && match[2] === artifactName) {
      return match[1];
    }
  }
  return null;
}

/** True when actualHex matches the recorded digest for artifactName. */
export function checksumOk(sumsText, artifactName, actualHex) {
  const expected = parseExpectedChecksum(sumsText, artifactName);
  return expected !== null && expected === actualHex;
}

/** sha256 hex digest of a byte buffer (node:crypto, no deps). */
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Where launcher-managed binaries live (overridable for tests). */
export function installRoot(env) {
  const override =
    env && typeof env.VOID_NPM_BIN_HOME === "string" && env.VOID_NPM_BIN_HOME !== ""
      ? env.VOID_NPM_BIN_HOME
      : null;
  const home = env && typeof env.HOME === "string" && env.HOME !== "" ? env.HOME : homedir();
  return override ?? join(home, ".void-cli", "bin");
}

/** Per-version binary path: <root>/<version>/void-<target>. */
export function binaryPath(root, version, target) {
  return join(root, version, `void-${target}`);
}

/**
 * Everything postinstall and the launcher need to know, computed once.
 * Returns { ok: true, target, version, baseUrl, sumsUrl, binaryUrl,
 * artifactName } or { ok: false, reason: "unsupported_platform" }.
 */
export function planInstall({ platform, arch, envVersion, pkgVersion, repo, releaseUrlOverride }) {
  const target = targetFor(platform, arch);
  if (target === null) {
    return { ok: false, reason: "unsupported_platform", platform, arch };
  }
  const version = resolveVersion(envVersion, pkgVersion);
  const baseUrl =
    typeof releaseUrlOverride === "string" && releaseUrlOverride !== ""
      ? releaseUrlOverride
      : releaseBaseUrl(repo ?? DEFAULT_REPO, version);
  const artifactName = `void-${target}`;
  return {
    ok: true,
    target,
    version,
    baseUrl,
    artifactName,
    sumsUrl: assetUrl(baseUrl, "SHA256SUMS"),
    binaryUrl: assetUrl(baseUrl, artifactName),
  };
}
