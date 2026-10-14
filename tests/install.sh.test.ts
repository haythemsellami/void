/**
 * install.sh tests (ADR-0014, channel 2).
 *
 * Two layers, both offline:
 *
 * 1. Pure-function units — the script is SOURCED with VOID_INSTALL_SOURCED=1
 *    (the sourcing guard keeps `main` from running) and each helper is
 *    invoked directly. On macOS this deliberately runs under /bin/bash 3.2,
 *    the shipped default, so bash-3 compatibility is asserted, not assumed.
 * 2. One real end-to-end run against a LOCAL file:// fixture "release"
 *    directory, driven through the VOID_RELEASE_URL seam — the same path a
 *    network install takes (curl download + SHA256SUMS verification +
 *    install to ~/.local/bin), with zero network access. This is what lets
 *    the suite pass inside the offline CI wrappers (ADR-0002 property 5).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const script = join(repoRoot, "install.sh");
/** macOS: the system bash (3.2) on purpose; elsewhere the platform bash. */
const BASH = process.platform === "darwin" ? "/bin/bash" : "bash";

interface BashResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runBash(code: string, env: NodeJS.ProcessEnv = {}): BashResult {
  const res = spawnSync(BASH, ["-c", code], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** Source the installer (guard active) and run one expression. */
function callHelper(expr: string): BashResult {
  return runBash(`VOID_INSTALL_SOURCED=1 source ${JSON.stringify(script)}; ${expr}`);
}

describe("install.sh pure helpers", () => {
  describe("void_target_for", () => {
    const cases: ReadonlyArray<[string, string, string | null]> = [
      ["Darwin", "arm64", "macos-arm64"],
      ["Darwin", "x86_64", "macos-x64"],
      ["Linux", "x86_64", "linux-x64"],
      ["Linux", "aarch64", "linux-arm64"],
      ["Linux", "arm64", "linux-arm64"],
      ["Darwin", "i386", null],
      ["Windows_NT", "x86_64", null],
      ["FreeBSD", "amd64", null],
    ];
    for (const [os, machine, expected] of cases) {
      it(`maps ${os}/${machine} → ${expected ?? "unsupported"}`, () => {
        const res = callHelper(`void_target_for ${os} ${machine}`);
        if (expected === null) {
          expect(res.status).toBe(1);
          expect(res.stdout.trim()).toBe("");
        } else {
          expect(res.status).toBe(0);
          expect(res.stdout.trim()).toBe(expected);
        }
      });
    }
  });

  describe("void_release_base", () => {
    it("latest resolves through GitHub's redirect (no API call, no token)", () => {
      const res = callHelper("void_release_base haythemsellami/Void latest");
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(
        "https://github.com/haythemsellami/Void/releases/latest/download",
      );
    });

    it("a pinned version composes the tagged download URL", () => {
      const res = callHelper("void_release_base some-owner/fork v0.2.0");
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe("https://github.com/some-owner/fork/releases/download/v0.2.0");
    });
  });

  describe("void_expected_sha256 / void_checksum_ok", () => {
    let fixture: string;
    let sumsFile: string;
    let goodFile: string;

    beforeAll(() => {
      fixture = mkdtempSync(join(tmpdir(), "void-sums-"));
      goodFile = join(fixture, "void-linux-x64");
      writeFileSync(goodFile, "fake binary bytes\n");
      const digest = createHash("sha256").update("fake binary bytes\n").digest("hex");
      sumsFile = join(fixture, "SHA256SUMS");
      // A distractor line for another target proves selection is by name.
      writeFileSync(sumsFile, `${"0".repeat(64)}  void-macos-arm64\n${digest}  void-linux-x64\n`);
    });

    afterAll(() => {
      rmSync(fixture, { recursive: true, force: true });
    });

    it("extracts the digest for the requested artifact only", () => {
      const res = callHelper(`void_expected_sha256 ${sumsFile} void-linux-x64`);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(
        createHash("sha256").update("fake binary bytes\n").digest("hex"),
      );
    });

    it("returns empty for a missing entry (callers hard-fail)", () => {
      const res = callHelper(`void_expected_sha256 ${sumsFile} void-linux-arm64`);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe("");
    });

    it("void_checksum_ok accepts a matching file", () => {
      const res = callHelper(
        `void_checksum_ok ${sumsFile} void-linux-x64 ${goodFile} && echo "rc=0" || echo "rc=1"`,
      );
      expect(res.stdout).toContain("rc=0");
    });

    it("void_checksum_ok rejects a tampered file", () => {
      const tampered = join(fixture, "tampered");
      writeFileSync(tampered, "different bytes entirely\n");
      const res = callHelper(
        `void_checksum_ok ${sumsFile} void-linux-x64 ${tampered} && echo "rc=0" || echo "rc=1"`,
      );
      expect(res.stdout).toContain("rc=1");
    });

    it("void_checksum_ok rejects when the artifact has no SHA256SUMS entry", () => {
      const res = callHelper(
        `void_checksum_ok ${sumsFile} void-macos-arm64 ${goodFile} && echo "rc=0" || echo "rc=1"`,
      );
      expect(res.stdout).toContain("rc=1");
    });
  });

  describe("void_path_has", () => {
    it("detects membership and non-membership of $PATH entries", () => {
      expect(
        callHelper('PATH="/a:/b/c" void_path_has /b/c && echo "rc=0" || echo "rc=1"').stdout,
      ).toContain("rc=0");
      expect(
        callHelper('PATH="/a:/b/c" void_path_has /b && echo "rc=0" || echo "rc=1"').stdout,
      ).toContain("rc=1");
    });
  });

  it("--help documents the env seams (VOID_RELEASE_URL, VOID_VERSION, VOID_REPO)", () => {
    const res = runBash(`${JSON.stringify(script)} --help`);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("VOID_RELEASE_URL");
    expect(res.stdout).toContain("VOID_VERSION");
    expect(res.stdout).toContain("VOID_REPO");
    expect(res.stdout).toContain("--uninstall");
  });

  it("rejects unknown arguments instead of guessing", () => {
    const res = runBash(`${JSON.stringify(script)} --definitely-not-a-flag`);
    expect(res.status).not.toBe(0);
  });

  it("is shellcheck-clean when shellcheck is available (guarded: advisory tool)", () => {
    const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
    if (probe.error) {
      console.warn("shellcheck not installed — skipping (guarded check)");
      return;
    }
    const res = spawnSync("shellcheck", [script], { encoding: "utf8" });
    expect(res.status).toBe(0);
  });
});

describe("install.sh end-to-end against a local file:// release fixture", () => {
  let fixture: string;
  let releaseDir: string;
  let home: string;
  let target: string;

  /** Build the fake release: one void-<host target> asset + its SHA256SUMS. */
  function buildFixture(opts: { tamperSums?: boolean } = {}): void {
    releaseDir = join(fixture, "release");
    mkdirSync(releaseDir, { recursive: true });
    const artifact = join(releaseDir, `void-${target}`);
    writeFileSync(artifact, '#!/bin/sh\necho "fixture-void 0.0.0"\n');
    chmodSync(artifact, 0o755);
    const digest = createHash("sha256")
      .update('#!/bin/sh\necho "fixture-void 0.0.0"\n')
      .digest("hex");
    const recorded = opts.tamperSums ? "f".repeat(64) : digest;
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      `${"0".repeat(64)}  void-some-other-target\n${recorded}  void-${target}\n`,
    );
  }

  function runInstaller(args: string[] = []): BashResult {
    return runBash(`${JSON.stringify(script)} ${args.join(" ")}`, {
      HOME: home,
      VOID_RELEASE_URL: `file://${releaseDir}`,
      VOID_VERSION: "latest",
    });
  }

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), "void-install-e2e-"));
    home = join(fixture, "home");
    mkdirSync(home);
    // Resolve THIS host's target through the script itself (exercises the
    // real uname path) so the fixture always matches the runner.
    const res = callHelper('void_target_for "$(uname -s)" "$(uname -m)"');
    expect(res.status).toBe(0);
    target = res.stdout.trim();
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it("downloads, verifies, installs to ~/.local/bin, and advises on PATH", () => {
    buildFixture();
    const res = runInstaller();
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`installing void (latest)`);

    const dest = join(home, ".local", "bin", "void");
    expect(existsSync(dest)).toBe(true);
    const run = spawnSync(dest, ["--version"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("fixture-void");
    // Fresh HOME → ~/.local/bin is not on PATH → advice must be printed.
    expect(res.stdout).toContain("is not on your PATH");

    // --uninstall removes exactly that file.
    const un = runInstaller(["--uninstall"]);
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("removed");
    expect(existsSync(dest)).toBe(false);
  });

  it("hard-fails on a sha256 mismatch and installs nothing", () => {
    buildFixture({ tamperSums: true });
    const res = runInstaller();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("sha256 mismatch");
    expect(existsSync(join(home, ".local", "bin", "void"))).toBe(false);
  });

  it("--uninstall is a no-op when nothing is installed", () => {
    releaseDir = join(fixture, "release-unused");
    mkdirSync(releaseDir, { recursive: true });
    const res = runInstaller(["--uninstall"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("nothing to uninstall");
  });
});
