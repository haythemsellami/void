# Void __TAG__

<!-- Owner: replace this block with the release summary before/after publishing.
     Everything below the marker is assembled by the release workflow and is
     the load-bearing part (checksums + license discipline, ADR-0014). -->

Void __TAG__ — a local-first, open-source agentic coding CLI (AGPL-3.0-only,
zero telemetry; see the repo README).

### Install

One command (no sudo, checksum-verified against SHA256SUMS below):

```sh
curl -fsSL https://raw.githubusercontent.com/haythemsellami/Void/main/install.sh | bash
```

Or with npm: `npm i -g void-cli` (a launcher that downloads and checksums the
same release binary at install time). Pin a version with
`VOID_VERSION=vX.Y.Z` before running install.sh.

### Verification

Each artifact's sha256 is recorded in SHA256SUMS below and verified by
install.sh before anything is installed (hard fail on mismatch).

### License & third-party notices

Void is AGPL-3.0-only — the full text is appended at the end of these notes
(and attached to this release as `LICENSE`). Third-party attributions ship in
the `NOTICE` block appended below (and as the `NOTICE` asset): the binary
embeds react, ink, and react-devtools-core, each MIT-licensed.
