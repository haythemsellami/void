# Void user guide

Everything you need to install Void, point it at a model, run tasks, and
wire it into scripts. The frozen machine contract is
[stream-json.md](stream-json.md); the trust and risk story is
[security-posture.md](security-posture.md); decisions of record live in
[adr/](adr/).

## Install

Three channels, one source of truth: every channel installs the same
checksummed binaries from a GitHub Release (ADR-0014). Pick one.

**1. install.sh (curl):**

```sh
curl -fsSL <release-host>/install.sh | bash
```

Detects your platform (macOS arm64/x64 incl. Rosetta, Linux x64/arm64),
downloads the Release binary plus its `SHA256SUMS`, hard-fails on any
checksum mismatch, and installs to `~/.local/bin/void` (0755) with PATH
advice. Pin a version with `VOID_VERSION=v0.2.0`; point at a different
Release host (e.g. your fork) with `VOID_REPO=owner/repo`. Remove with
`bash install.sh --uninstall`. The script makes exactly two network
requests — the binary and the checksums — and nothing else
(zero telemetry, ADR-0002 property 5).

**2. npm:**

```sh
npm install -g void-cli
```

The package is a launcher stub; postinstall downloads the platform binary
from the same Releases with the same checksum verification. Where npm
sandboxes block postinstall downloads, the stub warns and points you at
channel 1 — or channel 3.

**3. Build from source** (requires [Bun](https://bun.sh) ≥ 1.4):

```sh
git clone <repo> void && cd void
bun install
bun run build        # -> dist/void, a self-contained compiled binary
./dist/void --version
```

For development use, `bun link` puts a source-running `void` on your PATH.

## First run

Void needs exactly one thing before its first task: a model. Pick a row.

| You have… | Do this | Model ref |
|---|---|---|
| An Anthropic API key | `export VOID_ANTHROPIC_KEY=sk-…` | `anthropic/claude-sonnet-4-5` (default), `anthropic/claude-opus-4-5`, `anthropic/claude-haiku-4-5`, or any `anthropic/<new-id>` (unlisted ids resolve with a 200k fallback window) |
| A Z.AI key (GLM) | `export VOID_ANTHROPIC_KEY=<zai-key>` **and** `export VOID_ANTHROPIC_BASE_URL=https://api.z.ai/anthropic` | `anthropic/glm-4.6`, `anthropic/glm-4.7` |
| Ollama locally | `ollama pull qwen3:14b` (nothing to export; `VOID_OLLAMA_URL` overrides `http://127.0.0.1:11434`) | `ollama/<id>`, e.g. `ollama/qwen3:14b` — fully offline |
| Any OpenAI-compatible endpoint | `export VOID_OPENAI_BASE_URL=<base>` and, if it needs auth, `export VOID_OPENAI_KEY=<key>` | `openai/<id>` — base URL picks the service |

OpenAI-compatible endpoints verified against the adapter (ADR-0010):
OpenAI itself (`https://api.openai.com/v1`, the default), Kimi/Moonshot
(`https://api.moonshot.ai/v1` → `openai/moonshot-v1-auto`), Groq
(`https://api.groq.com/openai/v1`), OpenRouter
(`https://openrouter.ai/api/v1`), and keyless local servers — LM Studio
(`http://localhost:1234/v1`), vLLM (`http://localhost:8000/v1`). Trailing
slashes are tolerated; `/v1` is appended only when missing.

Then:

```sh
void run "explain what this repo does in two sentences"
```

stdout is stream-JSON (one JSON object per line — see
[Consuming the stream](#consuming-the-stream)); add `--text` for a
human-readable summary on stderr. Set your default model once with
`VOID_MODEL` or the settings `defaultModel` instead of passing `--model`
every time.

Model precedence for a single value: CLI flag > `VOID_MODEL` > settings
`defaultModel` (workspace > user) > the built-in placeholder default
(`src/app/models.ts`).

## Everyday commands

| Command | What it does |
|---|---|
| `void run "<task>"` | One-shot task in a new thread. `--thread <id>` continues one instead. |
| `void resume <threadId> "<task>"` | Replay a thread and continue it. `--compact` first summarizes older turns (ADR-0008). |
| `void threads list` | Thread summaries as JSONL (id, title, createdAt). |
| `void ui` | Interactive TUI — see [TUI](#tui-interactive-mode). |
| `void permissions test <tool> '<input-json>'` | Preview a permission decision without running anything. Exit 0 allow / 1 ask / 2 reject. |
| `void settings path` / `effective` / `edit` | Inspect and edit layered settings (see [Settings](#settings)). |
| `void mcp list` / `void mcp doctor` | Inspect configured MCP servers and their handshake health. |
| `void skills list` | List discovered skills and their validation status (ADR-0012). |
| `void schema` | Print the stream-JSON JSON Schema. |
| `void --help`, `void <subcommand> --help` | Full flag tables and examples. |

Exit codes: `0` success · `1` a rule said `ask` (denied headless with
remediation) · `2` a rule rejected the call · `3` provider/stream or
run-level failure · `64` malformed CLI usage. Full matrix:
[stream-json.md](stream-json.md#exit-code-matrix-process-exit-and-resultexit_code).

## The tool set

What the model can call, and what guards each call. Every call passes the
permission gate first; shell execution additionally passes the OS sandbox
(macOS `sandbox-exec` / Linux `bwrap`; workspace+temp writable, network
denied by default — [security-posture.md](security-posture.md)).

**Core tools.** `read_file`, `glob`, `grep` (read-only, allowed by default —
reading outside the workspace is normal agent work), `edit_file`
(unique-match replace with a unified diff; confined to the workspace; asks
before touching `.git` internals or dotfiles), `bash` (sandboxed, default
30 s timeout, `timeoutMs`/`workdir`/`env` inputs).

**Async shell (ADR-0007)** — for dev servers, watchers, long test runs:

- `async_shell_command` — same shape as bash but returns immediately with a
  handle (`as_<id>`), running sandboxed in the background under a lifetime
  ceiling (default 30 min, hard cap 4 h; `asyncShell.maxLifetimeMs`).
- `async_shell_command_status` — returns only NEW output since the last poll
  (cursor model) plus `{running, exitCode}`; `waitMs` blocks up to 30 s.
- `async_shell_command_kill` — kills the process group (TERM → 3 s → KILL).

At most 3 live handles; a 4th spawn kills the oldest, loudly. Handles are
in-process only — a resumed thread starts no processes. Poll before acting:
output that was never polled is lost when the handle closes.

**Task subagents (ADR-0013).** The `task` tool (`{description, prompt,
mode?}`) spawns a scoped child conversation with the same provider and an
isolated context: no parent history in, no child messages out — only the
child's final report returns as the tool result. Children get the read-only
tools plus async status/kill (no bash, no edit_file, no recursion), smaller
budgets (10 tool rounds), and every call evaluated under the
`context: "subagent"` permission marker. Modes are versioned prompt files:
`prompts/modes/explorer.md` (read-only investigation) and
`prompts/modes/planner.md` (step plans).

**Skills (ADR-0012).** A skill is a directory with a `SKILL.md` (YAML
frontmatter: `name` slug + `description`; body = instructions). The system
prompt carries only names+descriptions; the model loads bodies on demand
via the `skill` tool (`reload_skills` rescans). Discovery order (first wins
per name): workspace `.agents/skills/` and `skills/` (walked to the git
root), then `~/.config/void/skills/`, then each entry of the settings
`skills.path` (colon-separated). Malformed skills fail loudly, never load
silently. Skills carry arbitrary instructions — same trust level as the
repo's own AGENTS.md files.

**AGENTS.md.** Your repo's `AGENTS.md` (and `.agents/AGENTS.md`) files are
discovered from the workspace up to the git root and injected as
instructions, deepest-last, capped at 64 KiB
(`src/context/agents-md.ts`).

## MCP servers

MCP tools register as `mcp__<server>__<tool>` behind the same permission
gate as the builtins (ADR-0011). Configure stdio servers in any settings
layer:

```jsonc
// .void/settings.json (workspace) or ~/.config/void/settings.json (user)
{
  "settingsVersion": 1,
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/abs/allowed/root"]
    },
    "internal-tools": {
      "command": "/usr/local/bin/our-mcp-server",
      "args": ["--verbose"],
      "env": { "INTERNAL_TOKEN": "${INTERNAL_TOKEN}" }  // expanded from YOUR env
    }
  }
}
```

Trust and safety mechanics worth knowing:

- An `mcpServers` entry is an explicit trust act — server children run
  **unsandboxed** with your user privileges. Restrict with a permission
  rule (`{"tool": "mcp__internal-tools__*", "action": "ask"}`).
- `${VAR}` (braced form only) expands from the CLI environment; an unset
  variable is a loud error, and Void's *own* credential variables
  (`VOID_ANTHROPIC_KEY` etc.) are refused and stripped — a server child
  never receives them by any route (`src/mcp/env.ts`).
- Child environments are constructed (PATH/HOME/TMPDIR + exactly your
  config), never inherited wholesale.
- 30 s per-call timeout; a failed server degrades to a structured
  `mcp__<name>__unavailable` tool error the model can react to.
- Diagnose with `void mcp doctor` (per-server handshake diagnostics incl.
  a stderr tail; exit 0 healthy / 1 any failure / 3 bad settings).

A complete runnable example — settings file plus a trivial offline server —
lives in [../examples/mcp-server-config/](../examples/mcp-server-config/).

## Settings

Two layers: user (`~/.config/void/settings.json`, or
`$XDG_CONFIG_HOME/void/`) and workspace (`.void/settings.json` or
`.jsonc`, found by walking cwd → git root). Precedence per value: defaults
< user < workspace < `VOID_*` env < CLI flags. Permission rules merge
workspace-first, then user, then the built-in defaults — first match wins,
so **order is semantics**. Unknown keys are rejected (a typo fails loudly);
malformed files name the file, key, and problem. JSONC comments work
everywhere; `void settings edit [--workspace]` creates a `0600` skeleton
and opens `$EDITOR`.

Every key, with its consumer:

```jsonc
{
  "settingsVersion": 1,
  "defaultModel": "ollama/qwen3:14b",          // ModelRef string
  "providerTimeoutMs": 120000,                 // per-request provider deadline
  "compaction": {                              // ADR-0008
    "thresholdPercent": 90,                    // compact at % of context window
    "keepTurns": 2                             // newest turns kept verbatim
  },
  "asyncShell": { "maxLifetimeMs": 1800000 },  // background-command ceiling (cap 4h)
  "skills": { "path": "~/more-skills:../shared-skills" }, // extra skill roots (colon-separated)
  "mcpServers": { /* see above */ },
  "permissions": [ /* rules; see below and examples/permissions/ */ ]
}
```

### Permission rules

Ordered entries; the first match wins; no match = `ask` (in headless mode,
`ask` denies the call with remediation text and the run exits 1). Actions:
`allow`, `reject`, `ask`, `delegate` (hand the decision to an external
command — `src/permissions/delegate.ts`). Matchers are literals, globs,
`/regex/`, or nested input paths.

```jsonc
{
  "settingsVersion": 1,
  "permissions": [
    { "tool": "bash", "matches": { "command": "/^git status$/" }, "action": "allow" },
    { "tool": "bash", "matches": { "command": "/\\bgit push\\b/" }, "action": "ask",
      "message": "pushing needs a human" },
    { "tool": "mcp__internal-tools__*", "matches": "*", "action": "ask" },
    { "tool": "edit_file", "matches": { "path": "/(^|\\/)\\.env$/" }, "action": "reject",
      "message": "never touch .env" }
  ]
}
```

The built-in defaults (`src/permissions/defaults.ts`) reject
catastrophes (`rm -rf ~`, fork bombs, raw-device `dd`, `chmod -R 777 /`),
ask on shared-state mutations (git commit/push, package installs), allow
bare read-only commands and the read-only tools, and ask before editing
`.git`/dotfiles. Test any input against the merged rule set with
`void permissions test bash '{"command":"git push"}'` (exit 1 = ask).

A layered merge example ships in
[../examples/permissions/](../examples/permissions/).

## Consuming the stream

`void run`/`void resume` emit one JSON object per line on stdout; the first
line is always `system/init`, the last is always `result`
([stream-json.md](stream-json.md)). Quick reads:

```sh
# final answer only
void run "fix the failing test" | jq -r 'select(.type=="result") | .result'

# every tool call, one line each
void run "audit the deps" | jq -rc 'select(.type=="assistant")
  | .message.content[] | select(.type=="tool_use") | "\(.name) \(.input)"'

# permission denials + exit code, awk-only (no jq)
void run "ship it" --text 2>/dev/null | awk -F'"decision":"' '/"decision"/ {split($2,a,"\""); print a[1]}'
```

A complete tail-follow consumer script is
[../examples/consume-stream.sh](../examples/consume-stream.sh); a Node
readline driver is in [stream-json.md](stream-json.md#consumer-example).

## TUI (interactive mode)

```sh
void ui --task "explain what this repo does"   # live run, then keep chatting
void ui --thread <id>                          # replay a thread, then continue it
```

Keys: `i` focus input · `enter` send · `ctrl+c` clear the prompt (a second
ctrl+c quits; quitting mid-run aborts the run) · `esc` switch to scroll
mode · `j/k` scroll · pgup/pgdn page · `⏎` on a selected event expands it ·
`q` quit (scroll mode). The TUI is just another consumer of the same
runner surface — sessions persist to the same local threads
(`src/tui/entry.ts`).

## Where your data lives

| Data | Location |
|---|---|
| Threads (JSONL, one per thread) | `$XDG_DATA_HOME/void` (default `~/.local/share/void`); override with `VOID_DATA_DIR` |
| User settings | `$XDG_CONFIG_HOME/void/settings.json` (default `~/.config/void/`) |
| Workspace settings | `<repo>/.void/settings.json` or `.jsonc` |
| User skills | `~/.config/void/skills/` |
| Async-shell temp logs | per-handle 0700 temp dirs under the system temp, removed at teardown |

Delete a thread by deleting its file; nothing syncs anywhere.

## Troubleshooting

**"sandbox_blocked" / no sandbox binary.** Every shell command requires an
OS sandbox: `sandbox-exec` (ships with macOS) or `bwrap` (Linux:
`sudo apt install bubblewrap` and, on Ubuntu 24.04+, allow unprivileged
user namespaces if AppArmor restricts them). Void never silently runs
unsandboxed — if you truly must, `VOID_ALLOW_UNSANDBOXED=1` opts out and
every such command is stamped `[VOID] UNSANDBOXED EXECUTION` in its output.

**Provider errors (exit 3).** `result.subtype` is `error_provider` and
`stop_reason` is `provider_error`. Check the model ref prefix
(`anthropic/` `ollama/` `openai/` are the valid ones), the matching env
vars for that prefix, and — for `openai/<id>` — that `VOID_OPENAI_BASE_URL`
points at the right service. GLM needs *both* the Z.AI key and the
`api.z.ai/anthropic` base URL. Timeouts raise `providerTimeoutMs`
(default 120 s).

**Malformed settings (exit 3, stderr names file+key+problem).** Find the
file with `void settings path`, test the merge with
`void settings effective`. Unknown keys are intentional errors — check
spelling against the key list above.

**`ask` denials in headless runs (exit 1).** No human is attached, so
`ask` denies with remediation text. Add an explicit rule (allow or reject)
for the tool/input in a settings layer, or pre-decide with
`void permissions test`.

**MCP server will not start.** `void mcp doctor` prints per-server
handshake diagnostics including the server's stderr tail. Common causes:
unset `${VAR}` (loud error naming the variable), the command not on PATH
for a constructed child env, or a server that needs more than the 10 s
startup deadline.

**Async handles vanished after a restart.** Expected: the handle registry
is in-process only; a resumed thread starts no processes. Restart the
command and re-poll.

## FAQ

**Why AGPL-3.0-only?** Void competes with a proprietary product; strong
copyleft guarantees every improvement to it stays open
([ADR-0004](adr/0004-license-agpl3.md)). The react/ink TUI dependency is
MIT (NOTICE block in the README).

**What leaves my machine?** The prompts and tool results you send to your
chosen LLM provider, over TLS — and nothing else. No telemetry, no crash
reporting, no update pinging exists in the codebase; CI proves it by
running the whole test suite with OS-level network denial
(`.github/workflows/ci.yml`, `offline` job). With `--model ollama/<id>`
even provider traffic stays on localhost.

**Do I need an account?** No. There is no sign-up, no login, no vendor
cloud — the agent loop is a local process (ADR-0002).

**Where do threads live? Can I delete them?** Plain JSONL files under
`~/.local/share/void` — inspect them, `rm` them, back them up. No service
holds a copy.

**Can I trust a repo I point Void at?** Read
[security-posture.md](security-posture.md) — the short version: repo files
(including AGENTS.md and skills) can carry prompt injections; Void does not
filter them, it bounds what they can do (sandbox + permission defaults).
Treat running Void in a repo like running its build scripts.

**How do I update?** Re-run your install channel (or `VOID_VERSION=… bash
install.sh`); there is no auto-updater by design. From source:
`git pull && bun install && bun run build`.
