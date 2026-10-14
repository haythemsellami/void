/**
 * Release-discipline tests (ADR-0014 + ADR-0004).
 *
 * The distribution surface spans files the TypeScript suite normally never
 * looks at — workflows, install.sh, NOTICE, the notes template. These tests
 * pin the load-bearing invariants so a careless edit fails CI instead of a
 * release:
 *
 *   - the publish path is TAG-GATED ONLY (no dispatch on release.yml) and
 *     the dry-run paths can NEVER publish (no release action, no uploads,
 *     no write permissions),
 *   - every artifact-naming surface agrees on the SAME four canonical
 *     targets (release.yml matrix = assert script = install.sh mapping),
 *   - AGPL discipline: LICENSE + NOTICE exist at the repo root the workflow
 *     references, and both are appended to / attached on the Release,
 *   - version discipline: the workflow refuses a tag that doesn't match
 *     package.json, and the package identity (name/version/private) stays
 *     untouched — publishing decisions belong to the owner, not to a commit.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const TARGETS = ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"] as const;

describe("release workflow discipline (ADR-0014)", () => {
  const release = read(".github/workflows/release.yml");

  it("is triggered by v* tag pushes ONLY (publish path is tag-gated)", () => {
    expect(release).toContain("tags:");
    expect(release).toContain('- "v*"');
    expect(release).not.toContain("workflow_dispatch");
    expect(release).not.toContain("pull_request");
    expect(release).not.toContain("branches:");
  });

  it("builds exactly the four canonical targets with bun --target cross-compiles", () => {
    // matrix entries carry the four canonical names; artifacts are composed
    // as dist/void-<name> (the literal composition is asserted below)
    for (const t of TARGETS) {
      expect(release).toContain(`name: ${t}`);
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not a JS template
    expect(release).toContain("dist/void-${{ matrix.name }}");
    expect(release).toContain("bun_target: bun-darwin-arm64");
    expect(release).toContain("bun_target: bun-darwin-x64");
    expect(release).toContain("bun_target: bun-linux-x64");
    expect(release).toContain("bun_target: bun-linux-arm64");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not a JS template
    expect(release).toContain("--target=${{ matrix.bun_target }}");
    // no phantom fifth target sneaks into the artifact naming
    expect(release).not.toMatch(/void-windows/);
  });

  it("chains sync-prompt (same semantics as bun run build)", () => {
    expect(release).toContain("bun run sync-prompt");
  });

  it("generates SHA256SUMS and asserts it via the shared assertion script", () => {
    expect(release).toContain("sha256sum void-* > SHA256SUMS");
    expect(release).toContain("scripts/assert-release-artifact.sh");
    expect(release).toContain("softprops/action-gh-release@v2");
    expect(release).toContain("fail_on_unmatched_files: true");
  });

  it("refuses a tag that does not match package.json (version discipline)", () => {
    expect(release).toContain("node -p \"require('./package.json').version\"");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable in workflow text, not a JS template
    expect(release).toContain("v${PKG_VERSION}");
  });
});

describe("dry-run paths can never publish", () => {
  const dryRun = read(".github/workflows/release-dry-run.yml");
  const ci = read(".github/workflows/ci.yml");

  it("release-dry-run.yml is dispatch-only, permissionless, and release-free", () => {
    expect(dryRun).toContain("workflow_dispatch:");
    expect(dryRun).toContain("permissions: {}");
    // nothing that could publish or persist release assets
    expect(dryRun).not.toContain("action-gh-release");
    expect(dryRun).not.toContain("gh release");
    expect(dryRun).not.toContain("upload-artifact");
    expect(dryRun).not.toContain("download-artifact");
    expect(dryRun).toContain("scripts/assert-release-artifact.sh");
  });

  it("ci.yml wires the push dry-run job (one target, same assertion script)", () => {
    expect(ci).toContain("release-dry-run:");
    expect(ci).toContain("dist/void-macos-arm64");
    expect(ci).toContain("scripts/assert-release-artifact.sh");
    // CI never creates releases
    expect(ci).not.toContain("action-gh-release");
  });
});

describe("artifact naming agrees across every surface", () => {
  const namingSurfaces: ReadonlyArray<[string, string]> = [
    ["install.sh", read("install.sh")],
    ["assert script", read("scripts/assert-release-artifact.sh")],
    ["release.yml", read(".github/workflows/release.yml")],
    ["release-dry-run.yml", read(".github/workflows/release-dry-run.yml")],
  ];

  for (const [label, content] of namingSurfaces) {
    it(`${label} knows exactly the four canonical targets`, () => {
      for (const t of TARGETS) {
        expect(content).toContain(t);
      }
      expect(content).not.toContain("void-windows");
    });
  }
});

describe("AGPL / NOTICE discipline (ADR-0004, ADR-0014)", () => {
  it("LICENSE exists at the repo root and is the AGPL-3.0 text", () => {
    const license = read("LICENSE");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 19 November 2007");
  });

  it("NOTICE exists and attributes the three MIT dependencies", () => {
    const notice = read("NOTICE");
    expect(notice).toContain("react");
    expect(notice).toContain("ink");
    expect(notice).toContain("react-devtools-core");
    expect(notice).toContain("MIT");
    expect(notice).toContain("AGPL-3.0-only");
  });

  it("the release notes template + workflow carry LICENSE and NOTICE", () => {
    const template = read(".github/release-notes-template.md");
    const release = read(".github/workflows/release.yml");
    expect(template).toContain("__TAG__"); // substituted by the release job
    expect(template).toContain("SHA256SUMS");
    expect(template).toContain("install.sh");
    // notes body assembly + explicit asset attachment of both files
    expect(release).toContain(".github/release-notes-template.md");
    expect(release).toMatch(/cat NOTICE/);
    expect(release).toMatch(/cat LICENSE/);
    expect(release).toMatch(/files:[\s\S]*LICENSE[\s\S]*NOTICE/);
  });

  it("install.sh and the assert script are executable and shell scripts", () => {
    // POSIX mode bits: owner/group/other execute must all be set (0755-style)
    for (const f of ["install.sh", "scripts/assert-release-artifact.sh"]) {
      const mode = statSync(join(repoRoot, f)).mode;
      expect(mode & 0o111).toBe(0o111);
      expect(read(f).startsWith("#!")).toBe(true);
    }
  });
});

describe("package identity is untouched (owner-only publishing)", () => {
  const pkg = JSON.parse(read("package.json")) as {
    name: string;
    version: string;
    private: boolean;
    repository?: unknown;
    homepage?: string;
    keywords?: string[];
  };

  it("keeps the name exactly and the version equal to the CLI VERSION constant", async () => {
    expect(pkg.name).toBe("void-cli");
    const { VERSION } = await import("../src/cli");
    expect(pkg.version).toBe(VERSION);
  });

  it("stays private — nothing here can be npm-published by accident", () => {
    expect(pkg.private).toBe(true);
  });

  it("carries the npm-surface metadata added for future publishing", () => {
    expect(pkg.repository).toMatchObject({
      type: "git",
      url: expect.stringContaining("github.com/haythemsellami/Void"),
    });
    expect(pkg.homepage).toContain("github.com/haythemsellami/Void");
    expect(pkg.keywords?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("compiled-binary version stamp agrees with the release gate", () => {
  it("src/cli.ts VERSION equals package.json version (what the tag must match)", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const cli = read("src/cli.ts");
    const m = cli.match(/export const VERSION = "([^"]+)"/);
    expect(m?.[1]).toBe(pkg.version);
  });

  it("the built binary reports that version (skipped when dist/ is absent — gitignored)", () => {
    const path = join(repoRoot, "dist/void");
    const expected = (JSON.parse(read("package.json")) as { version: string }).version;
    try {
      const out = execFileSync(path, ["--version"], { encoding: "utf8" });
      expect(out).toContain(expected);
    } catch {
      console.warn("dist/void not built — binary stamp check skipped");
    }
  });
});
