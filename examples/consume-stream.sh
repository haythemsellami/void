#!/usr/bin/env bash
#
# examples/consume-stream.sh — a human-readable tail of a Void stream-JSON run.
#
# Usage:
#   void run "your task here" | ./examples/consume-stream.sh
#   ./examples/consume-stream.sh < some-captured-session.jsonl
#
# Requires: bash 3.2+ (the macOS default — no bash-4 features) and jq.
# Contract: docs/stream-json.md (v1.1) — one JSON object per line on stdin;
# the first line is always system/init, the last is always result.
#
# This script is intentionally line-at-a-time (one jq invocation per event) so
# it can keep up with a live `void run` stream and stay easy to read. Exit
# code: the result event's exit_code, so `void run … | consume-stream.sh`
# fails exactly when the run failed.
#
# Tested by examples/examples.test.ts (bash -n syntax gate + fixture session).
set -euo pipefail

# Dim/bold helpers (plain text when stdout is not a TTY).
if [ -t 1 ]; then
  dim=$'\033[2m'; bold=$'\033[1m'; red=$'\033[31m'; reset=$'\033[0m'
else
  dim=""; bold=""; red=""; reset=""
fi

jq_field() { # jq_field '<filter>' — extract from $line, empty on null
  printf '%s' "$line" | jq -r "$1 // empty" 2>/dev/null || true
}

printf '%s── void session ──%s\n' "$dim" "$reset"

while IFS= read -r line; do
  [ -z "$line" ] && continue
  type=$(jq_field '.type')

  case "$type" in
    system)
      model=$(jq_field '.model')
      thread=$(jq_field '.thread_id')
      root=$(jq_field '.workspace_root')
      ntools=$(printf '%s' "$line" | jq -r '.tools | length' 2>/dev/null || echo "?")
      printf '%s[%s]%s thread %s\n' "$bold" "$model" "$reset" "$thread"
      printf '%s  workspace %s · %s tools\n' "$dim" "$root" "$ntools"
      ;;
    assistant)
      # One event may carry text blocks and/or one tool_use block.
      n=$(printf '%s' "$line" | jq -r '.message.content | length' 2>/dev/null || echo 0)
      i=0
      while [ "$i" -lt "$n" ]; do
        block=$(printf '%s' "$line" | jq -c ".message.content[$i]" 2>/dev/null || echo "null")
        btype=$(printf '%s' "$block" | jq -r '.type // empty' 2>/dev/null || true)
        case "$btype" in
          text)
            printf '%s\n' "$(printf '%s' "$block" | jq -r '.text' 2>/dev/null)"
            ;;
          tool_use)
            name=$(printf '%s' "$block" | jq -r '.name // empty' 2>/dev/null || true)
            args=$(printf '%s' "$block" | jq -c '.input // {}' 2>/dev/null || echo "{}")
            printf '%s→ %s%s %s\n' "$dim" "$name" "$reset" "$args"
            ;;
        esac
        i=$((i + 1))
      done
      ;;
    user)
      is_err=$(jq_field '.message.content[0].is_error')
      if [ "$is_err" = "true" ]; then
        detail=$(jq_field '.message.content[0].content')
        printf '%s! tool error:%s %s\n' "$red" "$reset" "$detail"
      fi
      ;;
    permission)
      decision=$(jq_field '.decision')
      tool=$(jq_field '.tool')
      denied=$(jq_field '.headless_denied')
      if [ "$denied" = "true" ]; then
        printf '%s✗ %s → %s (denied headless — headless runs cannot ask)%s\n' "$red" "$tool" "$decision" "$reset"
      else
        printf '%s  · %s → %s\n' "$dim" "$tool" "$decision"
      fi
      ;;
    compaction)
      summarized=$(jq_field '.summarized_turns')
      kept=$(jq_field '.kept_turns')
      trigger=$(jq_field '.trigger')
      printf '%s∽ compacted: %s turns summarized, %s kept (%s)%s\n' "$dim" "$summarized" "$kept" "$trigger" "$reset"
      ;;
    result)
      subtype=$(jq_field '.subtype')
      code=$(jq_field '.exit_code')
      turns=$(jq_field '.num_turns')
      ms=$(jq_field '.duration_ms')
      in_tok=$(jq_field '.total_usage.input_tokens')
      out_tok=$(jq_field '.total_usage.output_tokens')
      if [ "$code" = "0" ]; then
        printf '%s✔ %s%s — %s turns, %s ms, %s/%s tokens\n' "$bold" "$subtype" "$reset" "$turns" "$ms" "$in_tok" "$out_tok"
        printf '%s\n' "$(jq_field '.result')"
      else
        printf '%s✖ %s (exit %s)%s\n' "$red" "$subtype" "$code" "$reset"
        printf '%s\n' "$(jq_field '.error')"
      fi
      exit "$code"
      ;;
    *)
      # Unknown (future, additive) event types pass through raw, dimmed.
      printf '%s? %s%s\n' "$dim" "$line" "$reset"
      ;;
  esac
done

# A session without a result event is a malformed capture; say so.
printf '%s(no result event — stream ended early)%s\n' "$red" "$reset" >&2
exit 3
