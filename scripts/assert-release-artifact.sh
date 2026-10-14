#!/usr/bin/env bash
#
# assert-release-artifact.sh — shared release-discipline assertions (ADR-0014).
#
# Usage: assert-release-artifact.sh <artifact> [<SHA256SUMS>]
#
# Asserts, for one built artifact:
#   1. its name is one of the four canonical release targets
#      (void-macos-arm64 | void-macos-x64 | void-linux-x64 | void-linux-arm64),
#   2. it exists and carries the executable bit,
#   3. when a SHA256SUMS file is also given:
#      exactly one line names the artifact, that line has the canonical
#      `<64 lowercase hex>  <name>` format, and the recorded digest matches
#      the file's actual sha256 (hard fail otherwise — same policy as
#      install.sh).
#
# Used by BOTH the real release job (.github/workflows/release.yml) and every
# dry-run path (release-dry-run.yml, the CI push job), so what CI asserts is
# exactly what publishing asserts. Bash 3.2 compatible (macOS runners).
set -euo pipefail

fail() {
  echo "assert-release-artifact: FAIL: $*" >&2
  exit 1
}

[ $# -ge 1 ] && [ $# -le 2 ] || fail "usage: $0 <artifact> [<SHA256SUMS>]"

artifact="$1"
sums="${2:-}"
name="$(basename "$artifact")"

case "$name" in
  void-macos-arm64 | void-macos-x64 | void-linux-x64 | void-linux-arm64) ;;
  *) fail "artifact name '$name' is not a canonical release target" ;;
esac

[ -f "$artifact" ] || fail "$artifact does not exist"
[ -x "$artifact" ] || fail "$artifact is not executable"

if [ -n "$sums" ]; then
  [ -f "$sums" ] || fail "SHA256SUMS file '$sums' does not exist"

  lines="$(awk -v t="$name" '$2 == t' "$sums" | wc -l | tr -d '[:space:]')"
  [ "$lines" = "1" ] ||
    fail "expected exactly 1 SHA256SUMS line for $name, found $lines"

  line="$(awk -v t="$name" '$2 == t { print }' "$sums")"
  echo "$line" | grep -Eq '^[0-9a-f]{64}  '"$name"'$' ||
    fail "SHA256SUMS line for $name is not '<64 lowercase hex>  <name>': $line"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$artifact" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  else
    fail "no sha256 tool available (sha256sum or shasum)"
  fi
  expected="$(awk -v t="$name" '$2 == t { print $1 }' "$sums")"
  [ "$expected" = "$actual" ] ||
    fail "sha256 mismatch for $name: SHA256SUMS says $expected, file hashes to $actual"
fi

echo "OK: $name${sums:+ " (checksum verified)"}"
