#!/usr/bin/env bash
#
# install.sh — the curl-able installer for Void (ADR-0014, channel 2).
#
# Behavior:
#   - detect platform: darwin arm64/x64 (incl. Rosetta check), linux x64/arm64
#   - resolve version: VOID_VERSION env (a "vX.Y.Z" tag or "latest"), default latest
#   - download the release binary + SHA256SUMS to a temp dir
#   - HARD FAIL on any sha256 mismatch against SHA256SUMS
#   - install to ~/.local/bin/void (mode 0755), print PATH advice when needed
#   - --uninstall removes it
#
# Zero telemetry (ADR-0002 property 5): the only network requests this script
# makes are the two release-asset downloads below (binary + SHA256SUMS), from
# the GitHub Releases redirect. No API tokens, no analytics, no pings.
#
# Test seams (see tests/install.sh.test.ts — the whole script runs offline
# against a file:// fixture):
#   VOID_RELEASE_URL  override the release base URL entirely (e.g. a local
#                     file:///tmp/fake-release directory); asset URLs are
#                     "$VOID_RELEASE_URL/void-<target>" and ".../SHA256SUMS"
#   VOID_VERSION      pin the release tag ("v0.2.0") or "latest" (default)
#   VOID_REPO         GitHub "<owner>/<repo>" of the release host (default
#                     haythemsellami/Void) — useful for AGPL forks
#
# Compatibility: bash 3.2 (the macOS default), no GNU-only tools.
set -euo pipefail

readonly VOID_DEFAULT_REPO="haythemsellami/Void"
readonly VOID_INSTALL_RELATIVE_DIR=".local/bin"

# ---------------------------------------------------------------------------
# Pure helpers — unit-tested by sourcing this file with VOID_INSTALL_SOURCED=1
# (tests/install.sh.test.ts). No side effects beyond child command output.
# ---------------------------------------------------------------------------

# Map an OS/machine pair (uname -s / uname -m values) to a release target
# name. Echoes "macos-arm64" | "macos-x64" | "linux-x64" | "linux-arm64",
# or returns 1 for anything we do not ship.
void_target_for() {
  local os="$1" machine="$2"
  case "$os/$machine" in
    Darwin/arm64) echo "macos-arm64" ;;
    Darwin/x86_64) echo "macos-x64" ;;
    Linux/x86_64) echo "linux-x64" ;;
    Linux/aarch64 | Linux/arm64) echo "linux-arm64" ;;
    *)
      return 1
      ;;
  esac
}

# True (0) when the shell reports x86_64 on macOS but the hardware is
# Apple Silicon — i.e. the installer itself runs under Rosetta 2 and the
# native binary for this machine is the arm64 one.
void_rosetta_arm64_host() {
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]
}

# Echo the release base URL for a repo and version ("latest" resolves via
# GitHub's redirect; anything else is the literal tag name).
void_release_base() {
  local repo="$1" version="$2"
  if [ "$version" = "latest" ]; then
    echo "https://github.com/${repo}/releases/latest/download"
  else
    echo "https://github.com/${repo}/releases/download/${version}"
  fi
}

# Echo the sha256 hex digest of a file using whichever tool exists
# (GNU/Linux: sha256sum; macOS/BSD: shasum). Returns 1 when neither exists.
void_hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "install.sh: no sha256 tool found (need sha256sum or shasum)" >&2
    return 1
  fi
}

# Echo the expected digest recorded for $2 in a SHA256SUMS file ($1).
# Empty output means "no entry" — callers must treat that as a hard fail.
void_expected_sha256() {
  local sums_file="$1" artifact_name="$2"
  awk -v t="$artifact_name" '$2 == t { print $1; exit }' "$sums_file"
}

# True (0) when $3 hashes to the digest recorded for $2 in $1.
void_checksum_ok() {
  local sums_file="$1" artifact_name="$2" file="$3" expected actual
  expected="$(void_expected_sha256 "$sums_file" "$artifact_name")"
  [ -n "$expected" ] || return 1
  actual="$(void_hash_file "$file")" || return 1
  [ "$expected" = "$actual" ]
}

# True (0) when $1 is an entry of $PATH.
void_path_has() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Impure helpers (network, filesystem).
# ---------------------------------------------------------------------------

void_die() {
  echo "install.sh: $*" >&2
  exit 1
}

void_download() {
  local url="$1" dest="$2"
  curl --fail --location --silent --show-error --retry 3 --output "$dest" "$url" ||
    void_die "download failed: $url"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

void_print_usage() {
  cat <<'EOF'
install.sh — install the Void CLI binary from GitHub Releases

usage: install.sh [--uninstall]

environment:
  VOID_VERSION      release tag to install (e.g. v0.2.0), or "latest" (default)
  VOID_REPO         GitHub <owner>/<repo> hosting releases (default haythemsellami/Void)
  VOID_RELEASE_URL  internal/test seam: use this URL as the release base
                    (asset URLs become <base>/void-<target> and <base>/SHA256SUMS)

installs to ~/.local/bin/void (no sudo, no shell-profile edits, no telemetry).
EOF
}

void_uninstall() {
  local dest="${HOME}/${VOID_INSTALL_RELATIVE_DIR}/void"
  if [ -f "$dest" ]; then
    rm -f "$dest"
    echo "removed $dest"
  else
    echo "nothing to uninstall: $dest does not exist"
  fi
}

main() {
  case "${1:-}" in
    --uninstall)
      void_uninstall
      return 0
      ;;
    --help | -h)
      void_print_usage
      return 0
      ;;
    "")
      ;;
    *)
      void_print_usage >&2
      void_die "unknown argument: $1"
      ;;
  esac

  command -v curl >/dev/null 2>&1 ||
    void_die "curl is required (https://curl.se)"
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
    void_die "a sha256 tool is required (sha256sum or shasum)"

  local os machine target
  os="$(uname -s)"
  machine="$(uname -m)"
  # Rosetta check: an x86_64 shell on Apple Silicon must still get the arm64
  # binary (it runs natively there; the reverse does not hold).
  if [ "$os" = "Darwin" ] && [ "$machine" = "x86_64" ] && void_rosetta_arm64_host; then
    machine="arm64"
  fi
  target="$(void_target_for "$os" "$machine")" ||
    void_die "unsupported platform: ${os} ${machine}
shipped targets: macos-arm64, macos-x64, linux-x64, linux-arm64.
Build from source instead: https://github.com/${VOID_DEFAULT_REPO}#build-from-source"

  local repo version base artifact
  repo="${VOID_REPO:-$VOID_DEFAULT_REPO}"
  version="${VOID_VERSION:-latest}"
  base="${VOID_RELEASE_URL:-$(void_release_base "$repo" "$version")}"
  artifact="void-${target}"

  # NOTE: `tmp` is deliberately a SCRIPT GLOBAL, not a local — the EXIT trap
  # below must still see it after main() returns (locals are destroyed then,
  # and `set -u` would turn the trap into an unbound-variable failure).
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/void-install.XXXXXXXX")"
  trap 'rm -rf "$tmp"' EXIT

  echo "installing void (${version}) for ${os}/${machine} → ${artifact}"
  echo "release base: ${base}"

  void_download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS"
  void_download "${base}/${artifact}" "${tmp}/${artifact}"

  void_checksum_ok "${tmp}/SHA256SUMS" "$artifact" "${tmp}/${artifact}" ||
    void_die "sha256 mismatch for ${artifact} — the download does not match
SHA256SUMS (${base}/SHA256SUMS). Nothing was installed."

  local install_dir dest
  install_dir="${HOME}/${VOID_INSTALL_RELATIVE_DIR}"
  dest="${install_dir}/void"
  mkdir -p "$install_dir"
  cp "${tmp}/${artifact}" "$dest"
  chmod 0755 "$dest"

  echo "installed: ${dest}"
  "$dest" --version || true

  if ! void_path_has "$install_dir"; then
    cat <<EOF

NOTE: ${install_dir} is not on your PATH. Add it to your shell profile:
  export PATH="${install_dir}:\$PATH"
EOF
  fi
}

# Sourcing guard: tests import the helpers above with VOID_INSTALL_SOURCED=1
# (tests/install.sh.test.ts); direct execution runs main.
if [ "${VOID_INSTALL_SOURCED:-0}" != "1" ]; then
  main "$@"
fi
