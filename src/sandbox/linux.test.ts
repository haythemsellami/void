/**
 * Argv-assertion tests for the bubblewrap argument builder. Pure unit tests:
 * no bwrap binary is required and nothing is executed (this machine is macOS;
 * the real bwrap integration lives in run.test.ts behind capability checks).
 */
import { describe, expect, it } from "vitest";
import { buildBwrapArgs } from "./linux";

const baseOpts = {
  workspaceRoot: "/home/u/proj",
  tempDir: "/tmp/void-xyz",
  allowNetwork: false,
  command: "echo ok",
} as const;

describe("buildBwrapArgs", () => {
  it("builds the full argv in mount order with a per-call temp dir (network denied)", () => {
    expect(buildBwrapArgs(baseOpts)).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      "/home/u/proj",
      "/home/u/proj",
      "--bind",
      "/tmp/void-xyz",
      "/tmp/void-xyz",
      "--unshare-net",
      "--die-with-parent",
      "--",
      "/bin/bash",
      "-c",
      "echo ok",
    ]);
  });

  it("drops --unshare-net when network is allowed", () => {
    const args = buildBwrapArgs({ ...baseOpts, allowNetwork: true });
    expect(args).not.toContain("--unshare-net");
    expect(args).toHaveLength(20); // 21 entries minus --unshare-net
    expect(args[args.length - 1]).toBe("echo ok");
  });

  it("binds the workspace and tempDir after the /tmp tmpfs so mkdtemp paths stay visible", () => {
    // Regression pin for the CI failure: bwrap applies argv in order, and a
    // bind placed BEFORE `--tmpfs /tmp` is shadowed by it — test workspaces
    // (mkdtemp under the system temp) must therefore be bound afterwards.
    const args = buildBwrapArgs(baseOpts);
    const tmpfsAt = args.indexOf("--tmpfs");
    expect(tmpfsAt).toBeGreaterThan(-1);
    const bindIndices = [args.indexOf("--bind"), args.lastIndexOf("--bind")];
    for (const at of bindIndices) {
      expect(at).toBeGreaterThan(tmpfsAt);
    }
    expect(args.indexOf("--bind", args.indexOf("--bind") + 1)).toBeGreaterThan(tmpfsAt);
  });

  it("NEVER binds the host /tmp itself over the fresh tmpfs (review minor)", () => {
    // A tempDir of exactly "/tmp" used to produce `--bind /tmp /tmp`, which
    // re-exposes the host's shared /tmp read-write OVER the fresh tmpfs and
    // defeats the isolation macOS keeps via its per-user temp base. The
    // refusal is silent-by-design at the argv level: no temp bind at all.
    const asHostTmp = buildBwrapArgs({ ...baseOpts, tempDir: "/tmp" });
    expect(asHostTmp).not.toContain("/tmp/void-xyz");
    // Exactly one --bind pair: the workspace. /tmp stays the fresh tmpfs.
    expect(asHostTmp.filter((a) => a === "--bind")).toHaveLength(1);
    expect(asHostTmp).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      "/home/u/proj",
      "/home/u/proj",
      "--unshare-net",
      "--die-with-parent",
      "--",
      "/bin/bash",
      "-c",
      "echo ok",
    ]);

    // An omitted tempDir yields the same minimal posture: run.ts creates a
    // per-call mkdtemp and passes it explicitly (exactOptionalPropertyTypes
    // means "omitted" is built by not naming the key at all).
    const omitted = buildBwrapArgs({
      workspaceRoot: baseOpts.workspaceRoot,
      allowNetwork: baseOpts.allowNetwork,
      command: baseOpts.command,
    });
    expect(omitted).toEqual(asHostTmp);
  });

  it("passes paths and the command through verbatim (pure function, no fs access)", () => {
    const args = buildBwrapArgs({
      workspaceRoot: "relative/ws",
      tempDir: "t",
      allowNetwork: false,
      command: "printf 'a b'",
    });
    expect(args[10]).toBe("relative/ws");
    expect(args[13]).toBe("t");
    expect(args[args.length - 1]).toBe("printf 'a b'");
  });

  // Documents the unprivileged-userns decision (see linux.ts): bwrap creates
  // the user namespace it needs by itself when not setuid, --die-with-parent
  // must always be present, and we deliberately do NOT remap uid/gid. These
  // assertions pin the argv shape CI relies on with apt-installed bubblewrap.
  it("always carries --die-with-parent and never remaps the user namespace", () => {
    for (const allowNetwork of [false, true]) {
      const args = buildBwrapArgs({ ...baseOpts, allowNetwork });
      expect(args).toContain("--die-with-parent");
      expect(args).not.toContain("--unshare-user");
      expect(args).not.toContain("--unshare-user-try");
      expect(args.filter((arg) => arg.startsWith("--uid"))).toEqual([]);
      expect(args.filter((arg) => arg.startsWith("--gid"))).toEqual([]);
    }
  });
});
