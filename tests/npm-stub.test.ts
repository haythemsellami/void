/**
 * npm launcher-stub tests (ADR-0014, channel 3).
 *
 * Covers the PURE logic of npm/lib.mjs (target mapping, version resolution,
 * URL composition, checksum parsing — the same contract install.sh
 * implements in bash; the two must stay in lockstep) and drives
 * npm/postinstall.mjs's full flow through injected fetch/fs seams: success,
 * graceful download-failure (exit 0 + guidance), hard checksum-mismatch
 * failure (exit 1), skip knob, unsupported platform, idempotence. The
 * launcher (npm/bin/void.js) is exercised as a REAL child process for both
 * the missing-binary guidance and the exec path.
 *
 * Everything here is offline: the "release" is an in-memory fixture behind
 * the fetch seam (VOID_RELEASE_URL is the seam install.sh's e2e uses against
 * a file:// fixture — the npm side needs only its fetch equivalent).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assetUrl,
  binaryPath,
  checksumOk,
  DEFAULT_REPO,
  INSTALL_SH_ONE_LINER,
  installRoot,
  parseExpectedChecksum,
  planInstall,
  releaseBaseUrl,
  resolveVersion,
  sha256Hex,
  targetFor,
} from "../npm/lib.mjs";
import { postinstall } from "../npm/postinstall.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const PKG = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

describe("target mapping (npm/lib.mjs)", () => {
  it("maps node platform/arch pairs onto the four canonical release targets", () => {
    expect(targetFor("darwin", "arm64")).toBe("macos-arm64");
    expect(targetFor("darwin", "x64")).toBe("macos-x64");
    expect(targetFor("linux", "x64")).toBe("linux-x64");
    expect(targetFor("linux", "arm64")).toBe("linux-arm64");
  });

  it("returns null for platforms we do not ship (launcher points at source)", () => {
    expect(targetFor("win32", "x64")).toBeNull();
    expect(targetFor("freebsd", "arm64")).toBeNull();
    expect(targetFor("darwin", "ia32")).toBeNull();
  });
});

describe("version resolution (ADR-0014 version discipline)", () => {
  it("pins the npm package's own version by default (void-cli@0.2.0 ↔ release v0.2.0)", () => {
    expect(resolveVersion(undefined, "0.2.0")).toBe("v0.2.0");
    expect(resolveVersion("", "0.2.0")).toBe("v0.2.0");
  });

  it("VOID_VERSION overrides, including latest", () => {
    expect(resolveVersion("v0.9.9", "0.2.0")).toBe("v0.9.9");
    expect(resolveVersion("latest", "0.2.0")).toBe("latest");
  });

  it("latest composes the redirect URL; a tag composes the tagged URL", () => {
    expect(releaseBaseUrl(DEFAULT_REPO, "latest")).toBe(
      "https://github.com/haythemsellami/Void/releases/latest/download",
    );
    expect(releaseBaseUrl("fork/void", "v0.3.0")).toBe(
      "https://github.com/fork/void/releases/download/v0.3.0",
    );
  });
});

describe("URL composition and checksum parsing", () => {
  it("assetUrl joins base and asset name", () => {
    expect(assetUrl("https://x/y", "void-linux-x64")).toBe("https://x/y/void-linux-x64");
  });

  it("parseExpectedChecksum picks the artifact's line, tolerates whitespace, rejects garbage", () => {
    const digest = "a".repeat(64);
    const other = "b".repeat(64);
    const sums = `${other}  void-macos-arm64\n${digest}  void-linux-x64\n`;
    expect(parseExpectedChecksum(sums, "void-linux-x64")).toBe(digest);
    expect(parseExpectedChecksum(sums, "void-macos-arm64")).toBe(other);
    expect(parseExpectedChecksum(sums, "void-linux-arm64")).toBeNull();
    expect(parseExpectedChecksum("garbage\n\nno sums here", "void-linux-x64")).toBeNull();
  });

  it("checksumOk matches only the true lowercase digest", () => {
    const digest = sha256Hex(Buffer.from("payload"));
    const sums = `${digest}  void-linux-x64\n`;
    expect(checksumOk(sums, "void-linux-x64", digest)).toBe(true);
    expect(checksumOk(sums, "void-linux-x64", "0".repeat(64))).toBe(false);
    expect(checksumOk(sums, "void-linux-x64", digest.toUpperCase())).toBe(false);
    expect(checksumOk("unrelated  file\n", "void-linux-x64", digest)).toBe(false);
  });

  it("sha256Hex matches a known vector", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("paths", () => {
  it("installRoot defaults to ~/.void-cli/bin and honors both env overrides", () => {
    expect(installRoot({ HOME: "/home/u" })).toBe("/home/u/.void-cli/bin");
    expect(installRoot({ HOME: "/home/u", VOID_NPM_BIN_HOME: "/custom" })).toBe("/custom");
    expect(installRoot({})).toContain(".void-cli"); // homedir() fallback
  });

  it("binaryPath is per-version and per-target", () => {
    expect(binaryPath("/r", "v0.2.0", "linux-x64")).toBe("/r/v0.2.0/void-linux-x64");
  });
});

describe("planInstall", () => {
  it("composes the full plan from env + package identity", () => {
    const plan = planInstall({
      platform: "linux",
      arch: "x64",
      envVersion: undefined,
      pkgVersion: "0.2.0",
      repo: undefined,
      releaseUrlOverride: undefined,
    });
    expect(plan).toEqual({
      ok: true,
      target: "linux-x64",
      version: "v0.2.0",
      baseUrl: "https://github.com/haythemsellami/Void/releases/download/v0.2.0",
      artifactName: "void-linux-x64",
      sumsUrl: "https://github.com/haythemsellami/Void/releases/download/v0.2.0/SHA256SUMS",
      binaryUrl: "https://github.com/haythemsellami/Void/releases/download/v0.2.0/void-linux-x64",
    });
  });

  it("VOID_RELEASE_URL replaces the base entirely (the offline test seam)", () => {
    const plan = planInstall({
      platform: "darwin",
      arch: "arm64",
      envVersion: undefined,
      pkgVersion: "0.1.0",
      repo: undefined,
      releaseUrlOverride: "file:///tmp/fake-release",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.sumsUrl).toBe("file:///tmp/fake-release/SHA256SUMS");
    expect(plan.binaryUrl).toBe("file:///tmp/fake-release/void-macos-arm64");
  });

  it("reports unsupported platforms without throwing", () => {
    const plan = planInstall({
      platform: "win32",
      arch: "x64",
      envVersion: undefined,
      pkgVersion: "0.1.0",
      repo: undefined,
      releaseUrlOverride: undefined,
    });
    expect(plan.ok).toBe(false);
  });
});

/** In-memory release fixture: one linux-x64 binary + its true SHA256SUMS. */
function makeFixtureRelease() {
  const binary = Buffer.from("#!/bin/sh\necho stub-void\n");
  const digest = sha256Hex(binary);
  const sums = `${"c".repeat(64)}  void-macos-arm64\n${digest}  void-linux-x64\n`;
  const urls = {
    "https://release.test/v0.2.0/SHA256SUMS": { text: sums },
    "https://release.test/v0.2.0/void-linux-x64": { bytes: binary },
  };
  const fetchImpl = async (url: string | URL): Promise<FakeResponse> => {
    const body = urls[String(url) as keyof typeof urls];
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => ("text" in body ? body.text : ""),
      arrayBuffer: async () =>
        "bytes" in body
          ? (body.bytes.buffer.slice(
              body.bytes.byteOffset,
              body.bytes.byteOffset + body.bytes.byteLength,
            ) as ArrayBuffer)
          : new ArrayBuffer(0),
    };
  };
  return { fetchImpl, binary, digest };
}

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

interface Written {
  data: Buffer | string;
  opts?: { mode?: number };
}

function makeFsSeam() {
  const files = new Map<string, Written>();
  const mkdirs: Array<[string, { recursive: boolean }]> = [];
  return {
    files,
    mkdirs,
    existsImpl: (p: string) => files.has(p),
    mkdir: async (p: string, opts: { recursive: boolean }) => {
      mkdirs.push([p, opts]);
    },
    writeFile: async (p: string, data: Buffer | string, opts?: { mode?: number }) => {
      files.set(p, opts === undefined ? { data } : { data, opts });
    },
  };
}

describe("postinstall flow (seamed fs/fetch)", () => {
  const baseEnv = { HOME: "/home/t", VOID_RELEASE_URL: "https://release.test/v0.2.0" };

  it("downloads, verifies, and installs the platform binary 0755", async () => {
    const { fetchImpl } = makeFixtureRelease();
    const fs = makeFsSeam();
    const logs: string[] = [];
    const code = await postinstall({
      env: { ...baseEnv },
      platform: "linux",
      arch: "x64",
      pkgVersion: "0.2.0",
      fetchImpl,
      log: (m: string) => logs.push(m),
      existsImpl: fs.existsImpl,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
    });

    expect(code).toBe(0);
    const dest = "/home/t/.void-cli/bin/v0.2.0/void-linux-x64";
    const written = fs.files.get(dest);
    expect(written).toBeDefined();
    expect(String(written?.data)).toContain("stub-void");
    expect(written?.opts?.mode).toBe(0o755);
    expect(fs.mkdirs).toEqual([[dirname(dest), { recursive: true }]]);
    expect(logs.some((l) => l.includes("installed void-linux-x64 (v0.2.0)"))).toBe(true);
  });

  it("is a no-op when the binary is already present (idempotent installs)", async () => {
    const { fetchImpl } = makeFixtureRelease();
    const fs = makeFsSeam();
    fs.files.set("/home/t/.void-cli/bin/v0.2.0/void-linux-x64", { data: Buffer.alloc(0) });
    let fetched = 0;
    const countingFetch = async (url: string | URL): Promise<FakeResponse> => {
      fetched += 1;
      return fetchImpl(url);
    };
    const code = await postinstall({
      env: { ...baseEnv },
      platform: "linux",
      arch: "x64",
      pkgVersion: "0.2.0",
      fetchImpl: countingFetch,
      log: () => {},
      existsImpl: fs.existsImpl,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
    });
    expect(code).toBe(0);
    expect(fetched).toBe(0); // zero downloads when present
  });

  it("fails GRACEFULLY (exit 0 + install.sh one-liner) when downloads are blocked", async () => {
    const warnings: string[] = [];
    const failingFetch = async (): Promise<FakeResponse> => {
      throw new Error("blocked by npm sandbox");
    };
    const fs = makeFsSeam();
    const code = await postinstall({
      env: { ...baseEnv },
      platform: "linux",
      arch: "x64",
      pkgVersion: "0.2.0",
      fetchImpl: failingFetch,
      log: () => {},
      warn: (m: string) => warnings.push(m),
      existsImpl: fs.existsImpl,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
    });
    expect(code).toBe(0); // npm install must not break
    const all = warnings.join("\n");
    expect(all).toContain("blocked by npm sandbox");
    expect(all).toContain(INSTALL_SH_ONE_LINER);
    expect(fs.files.size).toBe(0); // nothing written
  });

  it("HARD-FAILS (exit 1) on a checksum mismatch and installs nothing", async () => {
    // Real binary bytes, but SHA256SUMS records a different digest.
    const binary = Buffer.from("#!/bin/sh\necho tampered\n");
    const sums = `${"d".repeat(64)}  void-linux-x64\n`;
    const fetchImpl = async (url: string | URL): Promise<FakeResponse> => {
      if (String(url).endsWith("SHA256SUMS")) {
        return {
          ok: true,
          status: 200,
          text: async () => sums,
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () =>
          binary.buffer.slice(
            binary.byteOffset,
            binary.byteOffset + binary.byteLength,
          ) as ArrayBuffer,
      };
    };
    const fs = makeFsSeam();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      const code = await postinstall({
        env: { ...baseEnv },
        platform: "linux",
        arch: "x64",
        pkgVersion: "0.2.0",
        fetchImpl,
        log: () => {},
        existsImpl: fs.existsImpl,
        mkdir: fs.mkdir,
        writeFile: fs.writeFile,
      });
      expect(code).toBe(1);
    } finally {
      console.error = origError;
    }
    expect(errors.join("\n")).toContain("sha256 mismatch");
    expect(fs.files.size).toBe(0);
  });

  it("skips entirely with VOID_NPM_SKIP_DOWNLOAD=1 (offline installs)", async () => {
    const code = await postinstall({
      env: { ...baseEnv, VOID_NPM_SKIP_DOWNLOAD: "1" },
      platform: "linux",
      arch: "x64",
      pkgVersion: "0.2.0",
      fetchImpl: async (): Promise<FakeResponse> => {
        throw new Error("must not be called");
      },
      log: () => {},
    });
    expect(code).toBe(0);
  });

  it("exits 0 with guidance on unsupported platforms", async () => {
    const warnings: string[] = [];
    const code = await postinstall({
      env: { ...baseEnv },
      platform: "win32",
      arch: "x64",
      pkgVersion: "0.2.0",
      fetchImpl: async (): Promise<FakeResponse> => {
        throw new Error("must not be called");
      },
      log: () => {},
      warn: (m: string) => warnings.push(m),
    });
    expect(code).toBe(0);
    expect(warnings.join("\n")).toContain("no prebuilt binary for win32/x64");
  });
});

describe("launcher (npm/bin/void.js) as a real child process", () => {
  it("prints install.sh guidance and exits 1 when the binary is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "void-launcher-"));
    try {
      const res = spawnSync(process.execPath, [join(repoRoot, "npm/bin/void.js"), "--version"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("platform binary not found");
      expect(res.stderr).toContain("npm rebuild void-cli");
      expect(res.stderr).toContain("install.sh");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("execs a present binary with the passed arguments and exit code", () => {
    const home = mkdtempSync(join(tmpdir(), "void-launcher-"));
    try {
      // Place a stub "downloaded" binary exactly where the launcher looks:
      // ~/.void-cli/bin/v<pkg version>/void-<host target>.
      const target = targetFor(process.platform, process.arch);
      expect(target).not.toBeNull();
      if (target === null) return;
      const binDir = join(home, ".void-cli", "bin", `v${PKG.version}`);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, `void-${target}`), '#!/bin/sh\necho "launched:$1:$2"\nexit 7\n', {
        mode: 0o755,
      });
      const res = spawnSync(
        process.execPath,
        [join(repoRoot, "npm/bin/void.js"), "run", "task-id"],
        { encoding: "utf8", env: { ...process.env, HOME: home } },
      );
      expect(res.status).toBe(7);
      expect(res.stdout).toContain("launched:run:task-id");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
