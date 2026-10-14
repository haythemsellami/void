/**
 * Tests for sandbox capability detection. Platform-dependent expectations
 * are written so both macOS and Linux CI runners exercise their own branch
 * without skips (the assertions degrade to consistency checks elsewhere).
 */
import { describe, expect, it } from "vitest";
import { detectSandbox, SANDBOX_INSTALL_GUIDANCE, whichBinary } from "./detect";

describe("detectSandbox", () => {
  it("reports the current platform", () => {
    const detection = detectSandbox();
    expect(["darwin", "linux", "unsupported"]).toContain(detection.platform);
  });

  it("detects sandbox-exec on darwin", () => {
    const detection = detectSandbox();
    if (process.platform === "darwin") {
      // sandbox-exec ships with macOS; this machine has it.
      expect(detection.kind).toBe("sandbox-exec");
      expect(detection.binaryPath).toContain("sandbox-exec");
    } else {
      expect(detection.platform).not.toBe("darwin");
    }
  });

  it("detects bwrap on linux when installed", () => {
    const detection = detectSandbox();
    if (process.platform === "linux" && whichBinary("bwrap") !== null) {
      expect(detection.kind).toBe("bwrap");
      expect(detection.binaryPath).toContain("bwrap");
    }
  });

  it("keeps kind and binaryPath consistent", () => {
    const detection = detectSandbox();
    if (detection.binaryPath === null) {
      expect(detection.kind).toBeNull();
    } else {
      expect(detection.kind).not.toBeNull();
    }
  });

  it("exports install guidance for every platform, each naming the opt-out", () => {
    for (const platform of ["darwin", "linux", "unsupported"] as const) {
      const guidance = SANDBOX_INSTALL_GUIDANCE[platform];
      expect(guidance.length).toBeGreaterThan(20);
      expect(guidance).toContain("VOID_ALLOW_UNSANDBOXED");
    }
  });
});
