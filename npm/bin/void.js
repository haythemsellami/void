#!/usr/bin/env node
/**
 * npm `void` launcher (ADR-0014, channel 3) — thin exec wrapper.
 *
 * Runs the platform binary that npm/postinstall.mjs downloaded and
 * checksum-verified into ~/.void-cli/bin/<version>/void-<target>. When that
 * binary is absent (postinstall download blocked by an npm sandbox,
 * VOID_NPM_SKIP_DOWNLOAD=1, or an unsupported platform), prints actionable
 * guidance — the install.sh one-liner first — and exits 1. Never downloads
 * anything itself, and contains no telemetry (ADR-0002 p5).
 *
 * Plain Node ESM, zero dependencies.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { binaryPath, installRoot, planInstall } from "../lib.mjs";

async function main() {
  const env = process.env;
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const plan = planInstall({
    platform: process.platform,
    arch: process.arch,
    envVersion: env.VOID_VERSION,
    pkgVersion: pkg.version,
    repo: env.VOID_REPO,
    releaseUrlOverride: env.VOID_RELEASE_URL,
  });

  if (!plan.ok) {
    console.error(
      `void: no prebuilt binary for ${plan.platform}/${plan.arch}.\nBuild from source: https://github.com/haythemsellami/Void#build-from-source`,
    );
    process.exit(1);
  }

  const bin = binaryPath(installRoot(env), plan.version, plan.target);
  if (!existsSync(bin)) {
    console.error(
      `void: platform binary not found at ${bin}
It is normally downloaded and checksum-verified at install time (postinstall).
Either it was blocked (npm sandbox / offline install) or skipped
(VOID_NPM_SKIP_DOWNLOAD=1). Fix it with either:
  1. npm rebuild void-cli        # retry the postinstall download
  2. curl -fsSL https://raw.githubusercontent.com/haythemsellami/Void/main/install.sh | bash
     (checksum-verified install of the same binary to ~/.local/bin/void)`,
    );
    process.exit(1);
  }

  const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) {
    console.error(`void: failed to execute ${bin}: ${result.error.message}`);
    process.exit(1);
  }
  // Shell-style exit code: 128+signal when the child died by signal (e.g.
  // SIGTERM → 143), its own status otherwise, 1 when unknown.
  const signalNumber = result.signal ? Number(result.signal.replace("SIG", "")) || 0 : 0;
  process.exit(result.status ?? (signalNumber > 0 ? 128 + signalNumber : 1));
}

await main();
