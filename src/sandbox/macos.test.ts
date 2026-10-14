/**
 * String-assertion tests for the macOS sandbox-exec profile template.
 * These are pure (no sandbox execution) and run on every platform.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateMacosProfile } from "./macos";

const base = realpathSync(tmpdir());
const workspace = mkdtempSync(join(base, "void-macos-ws-"));
const tempDir = mkdtempSync(join(base, "void-macos-tmp-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
});

describe("generateMacosProfile", () => {
  it("uses the allow-default + targeted-deny skeleton", () => {
    const profile = generateMacosProfile({ workspaceRoot: workspace });
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    // SBPL is last-match-wins: blanket denies must precede the allowances.
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(
      profile.indexOf("(allow file-write*"),
    );
  });

  it("embeds canonical (realpath-resolved) subpaths for workspace and tempDir", () => {
    const profile = generateMacosProfile({ workspaceRoot: workspace, tempDir });
    expect(profile).toContain(`(subpath "${workspace}")`);
    expect(profile).toContain(`(subpath "${tempDir}")`);
  });

  it("normalizes symlinked inputs to their canonical form (/var -> /private/var)", () => {
    // tmpdir() on macOS is /var/folders/... — a symlink into /private/var.
    // Feeding the non-canonical spelling must still produce the canonical rule.
    const nonCanonical = workspace.replace("/private/", "/");
    const profile = generateMacosProfile({ workspaceRoot: nonCanonical });
    expect(profile).toContain(`(subpath "${workspace}")`);
    if (nonCanonical !== workspace) {
      expect(profile).not.toContain(`(subpath "${nonCanonical}")`);
    }
  });

  it("denies network by default and allows outbound-only when requested", () => {
    const off = generateMacosProfile({ workspaceRoot: workspace });
    expect(off).not.toContain("network-outbound");

    const on = generateMacosProfile({ workspaceRoot: workspace, allowNetwork: true });
    expect(on).toContain("(allow network-outbound)");
    // The outbound allowance must override the blanket network deny, not precede it.
    expect(on.indexOf("(deny network*)")).toBeLessThan(on.indexOf("(allow network-outbound)"));
  });

  it("keeps /dev/null writable (redirects must keep working)", () => {
    const profile = generateMacosProfile({ workspaceRoot: workspace });
    expect(profile).toContain('(allow file-write-data (literal "/dev/null"))');
  });

  it("allows the per-user temp base (confstr-based tools like mktemp)", () => {
    const profile = generateMacosProfile({ workspaceRoot: workspace });
    expect(profile).toContain(`(subpath "${base}")`);
  });

  it("does not duplicate a tempDir identical to the workspace root", () => {
    const profile = generateMacosProfile({ workspaceRoot: workspace, tempDir: workspace });
    expect(profile.split(`(subpath "${workspace}")`).length - 1).toBe(1);
  });
});
