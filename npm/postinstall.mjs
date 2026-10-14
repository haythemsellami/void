/**
 * npm postinstall hook (ADR-0014, channel 3) — downloads the platform
 * binary for THIS package's version from GitHub Releases, verifies its
 * sha256 against the release SHA256SUMS (same policy as install.sh), and
 * installs it to ~/.void-cli/bin/<version>/void-<target> for
 * npm/bin/void.js to exec.
 *
 * Failure policy (the ADR-0014 "decide at implementation" clause, recorded
 * in the ADR's implementation notes):
 *   - download failure → WARN and exit 0 (npm sandboxes and offline installs
 *     commonly block postinstall downloads; the package still installs, and
 *     `void` prints an actionable error pointing at install.sh),
 *   - checksum mismatch → exit 1, HARD FAIL (tamper evidence beats
 *     convenience),
 *   - unsupported platform → exit 0 with guidance (nothing we can fetch).
 *
 * Env knobs: see npm/lib.mjs (VOID_NPM_SKIP_DOWNLOAD=1 skips the download —
 * used by tests and deliberately-offline installs).
 *
 * Plain Node ESM, zero dependencies: postinstall must run under whatever
 * node/npm the user has.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  binaryPath,
  checksumOk,
  installRoot,
  parseExpectedChecksum,
  planInstall,
  sha256Hex,
} from "./lib.mjs";

const INSTALL_SH_HINT = `The platform binary could not be installed automatically.
Install it directly with the checksum-verified installer:
  ${"curl -fsSL https://raw.githubusercontent.com/haythemsellami/Void/main/install.sh | bash"}
or build from source: https://github.com/haythemsellami/Void#build-from-source`;

async function readPackageVersion() {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
  return pkg.version;
}

/**
 * The install flow, parameterized for tests (fetch/fs seams; see
 * tests/npm-stub.test.ts). Returns the process exit code postinstall
 * should use.
 */
export async function postinstall(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((msg) => console.log(`void-cli postinstall: ${msg}`));
  const warn = options.warn ?? ((msg) => console.warn(`void-cli postinstall: WARNING: ${msg}`));
  const mkdirImpl = options.mkdir ?? mkdir;
  const writeFileImpl = options.writeFile ?? writeFile;
  const existsImpl = options.existsImpl ?? existsSync;
  const pkgVersion = options.pkgVersion ?? (await readPackageVersion());

  if (env.VOID_NPM_SKIP_DOWNLOAD === "1") {
    log(
      "VOID_NPM_SKIP_DOWNLOAD=1 — skipping binary download (launcher will error until installed)",
    );
    return 0;
  }

  const plan = planInstall({
    platform,
    arch,
    envVersion: env.VOID_VERSION,
    pkgVersion,
    repo: env.VOID_REPO,
    releaseUrlOverride: env.VOID_RELEASE_URL,
  });

  if (!plan.ok) {
    warn(
      `no prebuilt binary for ${plan.platform}/${plan.arch}. Build from source: https://github.com/haythemsellami/Void#build-from-source`,
    );
    return 0;
  }

  const dest = binaryPath(installRoot(env), plan.version, plan.target);
  if (existsImpl(dest)) {
    log(`${dest} already present — nothing to do`);
    return 0;
  }

  let sumsText;
  let binaryBytes;
  try {
    log(`downloading ${plan.sumsUrl}`);
    const sumsRes = await fetchImpl(plan.sumsUrl);
    if (!sumsRes.ok) {
      throw new Error(`SHA256SUMS download failed: HTTP ${sumsRes.status}`);
    }
    sumsText = await sumsRes.text();
    log(`downloading ${plan.binaryUrl}`);
    const binRes = await fetchImpl(plan.binaryUrl);
    if (!binRes.ok) {
      throw new Error(`binary download failed: HTTP ${binRes.status}`);
    }
    binaryBytes = Buffer.from(await binRes.arrayBuffer());
  } catch (err) {
    // Graceful (ADR-0014): sandboxed/offline npm installs must still work;
    // the launcher prints actionable guidance on first run.
    warn(`${err instanceof Error ? err.message : String(err)}
${INSTALL_SH_HINT}`);
    return 0;
  }

  const actual = sha256Hex(binaryBytes);
  if (!checksumOk(sumsText, plan.artifactName, actual)) {
    console.error(
      `void-cli postinstall: sha256 mismatch for ${plan.artifactName} from ${plan.baseUrl} — refusing to install (expected ${
        parseExpectedChecksum(sumsText, plan.artifactName) ?? "<no entry>"
      }, got ${actual}). Nothing was installed.`,
    );
    return 1;
  }

  await mkdirImpl(dirname(dest), { recursive: true });
  await writeFileImpl(dest, binaryBytes, { mode: 0o755 });
  log(`installed ${plan.artifactName} (${plan.version}) → ${dest}`);
  return 0;
}

// Run only when executed as a script (node npm/postinstall.mjs), not when
// imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await postinstall());
}
