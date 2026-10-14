# ADR-0014: Distribution — GitHub Releases binaries + install.sh + npm

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

Production-ready means one-command install. Void has no static host of its own —
GitHub Releases IS the host. Zero telemetry means no update
pinging: updates are user-initiated, and P1 ships no update checker at all.

## Decision

Three channels, one source of truth (a GitHub Release):

1. **GitHub Releases carry the binaries.** A release workflow (tag-push triggered):
   `bun run build` per target (macos arm64/x64, linux x64/arm64 via runner matrix),
   artifacts named `void-<target>` + a `SHA256SUMS` file attached to the Release.
2. **install.sh** (curl-able from the repo's raw URL): detect platform → download
   the Release asset by tag (`VOID_VERSION` env overridable; default `latest`
   resolved via GitHub's redirect) → **sha256 verification against SHA256SUMS**
   (hard fail on mismatch) → install to `~/.local/bin/void` (0755) with PATH
   advice. No telemetry, no sudo, no shell-profile edits.
3. **npm package `void-cli`**: P1 = launcher stub that execs the platform binary
   downloaded at postinstall from the same Releases (checksummed identically),
   documenting a build-from-source fallback when postinstall downloads are blocked
   by npm sandboxes. If the download proves fragile in testing, ship the stub with
   a clear error directing to install.sh — decide at implementation, record here.

Version discipline: tags `vX.Y.Z` mirror `package.json` version, which the release
workflow stamps into the binary (the VERSION/package.json sync test already enforces
the pair locally). The workflow gains a `--dry-run` mode CI-exercises on every push
(artifact naming + checksums asserted, nothing published); real publishes are
tag-gated only.

## Implementation notes (2026-10-14, the distribution workstream)

Recorded per the "decide at implementation" clauses above; the decision text
is unchanged.

- **Cross-compile choice (verified, not assumed).** With bun 1.4.0 on a
  macOS arm64 host, `bun build --compile --target=` accepts all four
  targets (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`,
  `bun-linux-arm64`), each downloading a ~30–40 MB target shim on first
  use; a full 591-module build of this repo produced correct Mach-O
  arm64/x86_64 and ELF x86-64/aarch64 outputs (`file`-checked). Therefore
  the release matrix does NOT need a macos-13 x64 runner and does NOT need
  qemu to build linux-arm64: darwin legs share `macos-latest` (x64 smoke via
  Rosetta 2 `arch -x86_64`), linux legs share `ubuntu-latest` (arm64 smoke
  via `qemu-user-static`). Every leg smoke-tests its binary; only the
  runner-native target is tested without emulation.
- **npm failure ladder (the "fragile postinstall" decision).** Postinstall
  download failures (npm sandboxes, offline installs) WARN and exit 0 — the
  package still installs, and the `void` launcher prints actionable guidance
  (install.sh one-liner first, `npm rebuild void-cli` second) on first run.
  A checksum mismatch is the one hard failure (exit 1): tamper evidence
  beats convenience. The launcher never downloads at run time.
- **One testable seam set, shared by both channels.** `VOID_RELEASE_URL`
  replaces the entire release base (tests point install.sh at a `file://`
  fixture via its curl path and give the npm stub a fetch implementation);
  `VOID_VERSION` pins/overrides; `VOID_REPO` serves AGPL forks. This is how
  every distribution test runs offline — through the real download path,
  not around it.
- **npm version pinning.** The npm package's own version selects the release
  tag (`void-cli@0.2.0` → release `v0.2.0`); `VOID_VERSION` overrides. The
  bin/postinstall wiring is deliberately NOT switched on yet (package stays
  `private: true`); the stubs in `npm/` are the pre-publish surface.

## Consequences

curl-users and npm-users both get one command; GitHub is the only infrastructure.
Risks accepted: GitHub API rate limits on `latest` resolution (pin-able via env);
npm postinstall sandbox restrictions (documented fallback). AGPL-3.0-only (ADR-0004)
applies to all channels; third-party notice for react/ink (MIT) ships in a NOTICE
block in the README and inside the Release notes.

**Implementation note (reviewer N2):** the release workflow builds, smokes, and
asserts artifacts but deliberately does not run the test suite — tags are cut by
the owner from CI-green main commits, so the release job is an artifact gate, not
the test gate. CI's push dry-run job remains the always-on rehearsal.
