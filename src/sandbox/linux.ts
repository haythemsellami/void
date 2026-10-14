/**
 * Linux bubblewrap (`bwrap`) argv construction.
 *
 * Pure function: builds the argument vector only — no filesystem access, no
 * execution. Callers must pass absolute, symlink-resolved paths (see
 * `canonicalPath`); bubblewrap binds the literal strings it is given.
 *
 * Isolation model (docs/architecture.md §sandbox):
 * - `/` mounted read-only, workspace mounted read-write;
 * - fresh `/dev` (tmpfs devices), fresh `/proc`, tmpfs `/tmp`;
 * - the caller's PER-CALL temp dir (a mkdtemp under os.tmpdir(), see
 *   run.ts) bound back in read-write — never the host `/tmp` itself: a
 *   bind of the tmpfs mount point would re-expose the host's shared /tmp
 *   read-write over the fresh tmpfs and defeat the isolation macOS keeps
 *   via its per-user temp base (review minor);
 * - network namespace (no network at all) unless `allowNetwork`;
 * - `--die-with-parent` so the sandbox cannot outlive Void;
 * - command executed by `/bin/bash -c`.
 *
 * allowNetwork honesty note: on Linux, allowing network means SHARING the
 * host network namespace — the sandboxed command can bind/listen on host
 * interfaces, not just connect outbound. macOS's allowNetwork is
 * outbound-only (listen stays denied by the SBPL deny). Filtering to
 * outbound-only inside a Linux namespace is out of scope at this stage;
 * the difference is documented here and in the README trust properties
 * instead of being silently papered over.
 *
 * The ordering matters: bubblewrap applies mounts in argv order (bwrap(1):
 * "All the arguments are executed in order"), and `--tmpfs /tmp` OVERMOUNTS
 * /tmp — so both writable binds must come AFTER it. Test workspaces come
 * from mkdtemp under the system temp dir, so a bind placed before the tmpfs
 * is shadowed by it: the command would write into the throwaway tmpfs and
 * the host would never see the file (observed on CI as ENOENT at the
 * post-run assertion while `echo`-only tests passed).
 *
 * Unprivileged environments (bubblewrap installed without setuid, e.g. the
 * Debian/Ubuntu package on CI runners): bwrap sets up the user namespace it
 * needs BY ITSELF in that mode — bwrap(1) documents the user namespace as
 * required when not run as root, and `--unshare-user` only controls whether
 * the sandboxed app additionally sees a remapped uid/gid (which is what
 * `--uid`/`--gid` configure; both REQUIRE --unshare-user). We deliberately
 * pass neither: identity mapping keeps tool diagnostics honest (`id`, file
 * ownership) and adds no isolation the MVP needs. `--die-with-parent` must
 * stay so a sandbox can never outlive Void. Real unprivileged-bwrap
 * execution is verified on the Linux CI job (bubblewrap apt-installed);
 * this machine is macOS and can only assert the argv.
 */
export interface BwrapOptions {
  /** Absolute, symlink-resolved workspace root (mounted read-write). */
  readonly workspaceRoot: string;
  /**
   * Absolute, symlink-resolved PER-CALL temp dir (mounted read-write).
   * Optional and never the host `/tmp` itself — `buildBwrapArgs` refuses to
   * bind the tmpfs mount point (see the isolation-model note above).
   */
  readonly tempDir?: string;
  /**
   * Share the host network namespace instead of `--unshare-net`. NOTE:
   * sharing means inbound too (listeners are possible) — outbound-only
   * filtering is macOS-only at this stage (see module header).
   */
  readonly allowNetwork: boolean;
  /** Shell command handed to `/bin/bash -c`. */
  readonly command: string;
}

/** Build the bwrap argument vector (excluding the bwrap binary itself). */
export function buildBwrapArgs(opts: BwrapOptions): string[] {
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // The tmpfs over /tmp comes first; the writable binds re-expose the
    // workspace and tempDir AFTER it so a workspace living under the system
    // temp dir (mkdtemp) stays visible — see the ordering note above.
    "--tmpfs",
    "/tmp",
    "--bind",
    opts.workspaceRoot,
    opts.workspaceRoot,
  ];
  // Bind EXACTLY the caller's per-call temp dir. Never /tmp itself: that
  // would mount the host's shared /tmp read-write over the fresh tmpfs and
  // undo the isolation the tmpfs provides (an omitted or naive "/tmp"
  // tempDir therefore yields no temp bind at all).
  if (opts.tempDir !== undefined && opts.tempDir !== "/tmp") {
    args.push("--bind", opts.tempDir, opts.tempDir);
  }
  if (!opts.allowNetwork) {
    args.push("--unshare-net");
  }
  args.push("--die-with-parent", "--", "/bin/bash", "-c", opts.command);
  return args;
}
