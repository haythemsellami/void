# Void

Void — a local-first, open-source agentic coding CLI.

The agent loop runs entirely in a local process: OS-sandboxed tool execution,
transparent in-repo system prompts, local-only credentials, zero telemetry,
threads as local files (see [docs/adr/0002-local-first-architecture.md](docs/adr/0002-local-first-architecture.md)).

New here? The [user guide](docs/user-guide.md) covers install, models, every
tool, settings, and troubleshooting; the
[security posture audit](docs/security-posture.md) documents what the trust
claims below are enforced by and which risks are accepted.

MVP shipped (M0–M4). The `void` binary runs tasks end-to-end headless with a
frozen stream-JSON contract ([docs/stream-json.md](docs/stream-json.md));
scope and acceptance criteria per milestone live in
[docs/mvp-scope.md](docs/mvp-scope.md).

## Installation

Three channels, one source of truth: a GitHub Release carrying checksummed
platform binaries ([ADR-0014](docs/adr/0014-distribution-channels.md)).
Binaries are available from the first release cut with the release pipeline
(`vX.Y.Z` tags, matching `package.json` version); until then use
build-from-source below.

**curl (install.sh)** — checksum-verified, no sudo, no telemetry:

```sh
curl -fsSL https://raw.githubusercontent.com/haythemsellami/Void/main/install.sh | bash
```

Installs to `~/.local/bin/void` (0755) and prints PATH advice if needed.
Read it first if you prefer: the script detects darwin arm64/x64 (including
Rosetta) and linux x64/arm64, downloads the binary plus the release's
`SHA256SUMS`, and hard-fails on any checksum mismatch. Pin a version with
`VOID_VERSION=vX.Y.Z` (default `latest` via GitHub's redirect — no API
calls); `--uninstall` removes it.

**npm**:

```sh
npm i -g void-cli
```

A launcher stub: postinstall downloads the same checksummed release binary
into `~/.void-cli/bin/<version>/` and `void` execs it. When postinstall
downloads are blocked (npm sandbox, offline install), the install still
succeeds and the first `void` run prints the fix — re-run
`npm rebuild void-cli` or use the curl installer above.

**Build from source** (works everywhere Bun does):

```sh
git clone https://github.com/haythemsellami/Void && cd Void
bun install && bun run build
./dist/void --version
```

### Updating

Updates are **manual by design** — Void has no update checker and never
phones home ([ADR-0002](docs/adr/0002-local-first-architecture.md) property
5). Check [releases](https://github.com/haythemsellami/Void/releases) (or
`git fetch --tags` in a source checkout) and re-run the installer with
`VOID_VERSION=vX.Y.Z`, or `npm i -g void-cli@X.Y.Z`.

## Quickstart (from source)

Requires [Bun](https://bun.sh) ≥ 1.4.
## Quickstart (3 commands)

```sh
curl -fsSL https://raw.githubusercontent.com/haythemsellami/Void/main/install.sh | bash   # or: npm install -g void-cli
export VOID_ANTHROPIC_KEY=sk-…                # or --model ollama/<id> for fully-local
void run "explain what this repo does"
```

No account, no login, no cloud. From source instead: `bun install && bun
link`, then the same `void run` (requires [Bun](https://bun.sh) ≥ 1.4 —
details and the npm/build-from-source channels in the
[user guide](docs/user-guide.md#install)).

stdout is the machine contract — one JSON object per line
([docs/stream-json.md](docs/stream-json.md)):

```sh
void run "run the tests" | jq -r 'select(.type=="result") | .result'
```

Add `--text` for a human-readable progress summary on stderr, `--workspace
<dir>` to target another checkout, `--thread <id>` to continue a thread,
`void resume <id> "next step"` to pick one up later, `void ui` for the
interactive TUI, and `void threads list` to see them all. `void schema`
prints the machine-readable JSON Schema; `void permissions test bash
'{"command":"…"}'` previews a permission decision (exit 0 allow / 1 ask /
2 reject).

## Trust properties & how they're verified

Every [ADR-0002](docs/adr/0002-local-first-architecture.md) property is
falsifiable in CI — the checks are the product, not hygiene. The table is
the summary; **the full audit — enforcement mechanisms, the accepted
residual-risk register (10 tracked items), and the explicit out-of-scope
list — lives in [docs/security-posture.md](docs/security-posture.md).**

Jobs live in [.github/workflows/ci.yml](.github/workflows/ci.yml): `ci`
(per-OS lint, typecheck, and both test runners — including the real-sandbox
suites) and `offline` (the whole suite with OS-level network denied).

| Property | One-line enforcement |
|---|---|
| **1. Local agent core** — no vendor endpoint for any core function | The `offline` CI job runs the suite with kernel-level network denial (`sandbox-exec '(deny network*)'` / `unshare -Urn`); `src/app/egress.test.ts` runs complete conversations end-to-end with zero fetch |
| **2. Transparent prompts** — versioned in-repo files | `prompts/*.md` loaded by `src/context/prompts.ts`, which hard-fails instead of substituting; a drift test pins the embedded copy; egress tests prove nothing prompt-shaped is fetched |
| **3. OS sandbox by default** — never a silent fallback | Real `sandbox-exec`/`bwrap` suites run on CI; a missing sandbox binary is a hard `sandbox_blocked` error with install guidance. Caveat: Linux `allowNetwork` shares the host netns ([audit](docs/security-posture.md)) |
| **4. Keys stay local** — read by the local process only | Credentials enter only through injection seams; adapter tests assert the key goes only to the provider endpoint; MCP children cannot receive Void's credentials by any route (`src/mcp/env.ts`) |
| **5. Zero telemetry** — no analytics, crash reporting, or update pinging | In-process fetch monitor + the OS-level offline job around the whole suite |
| **6. Threads are local files** — inspectable JSONL | `src/store` tests (append-only, replay), resume tests; no sync or upload code exists |

## Settings files

Beyond env vars and flags, Void reads layered settings files
([ADR-0006](docs/adr/0006-settings-format-and-precedence.md)): a user-scope
`$XDG_CONFIG_HOME/void/settings.json` (default `~/.config/void/`) and a
workspace-scope `.void/settings.json` — or `.jsonc`, with comments — found by
walking from the cwd up to the git root. Precedence for any single value:
defaults < user < workspace < `VOID_*` env < CLI flags; `permissions` rules
merge workspace-first ahead of the built-in defaults (first match wins).
Missing files are fine; a malformed file is a loud error naming file, key,
and problem.

```jsonc
{
  "settingsVersion": 1,
  "defaultModel": "ollama/qwen3:14b",
  "mcpServers": { "fancy": { "command": "npx", "args": ["-y", "fancy-mcp"] } },
  "permissions": [
    { "tool": "bash", "matches": { "command": "/^git status$/" }, "action": "allow" }
  ],
  "providerTimeoutMs": 120000,
  "skills": { "path": "~/skills" },
  "compaction": { "thresholdPercent": 90, "keepTurns": 2 },
  "asyncShell": { "maxLifetimeMs": 1800000 }
}
```

Inspect and edit the layers with `void settings path` (both files + which
exist), `void settings effective` (merged view with per-key provenance), and
`void settings edit [--workspace]` (creates a `0600`
`{"settingsVersion":1}` skeleton when absent, then opens `$EDITOR`).
Unknown keys are rejected — a typo fails loudly instead of silently no-opping.

### Skills (ADR-0012)

A skill is a directory containing `SKILL.md` (or `skill.md`) with strict
YAML frontmatter — `name` (required, ≤64 chars, `[a-z0-9-]`) and
`description` (required, ≤300 chars); the body is the instruction payload,
and sibling files are bundled resources the agent can read. Unknown
frontmatter keys are rejected loudly, and a malformed skill fails the run
naming file and key — never silently ignored. There is no install command
and no skill registry: you manage the directories (a local-only
`void skills add` is P3).

Discovery scans, in order (first wins per name): workspace
`.agents/skills/` and `skills/` walked from the workspace root up to the
git root, then `~/.config/void/skills/` (XDG-aware), then every
colon-separated entry of the settings `skills.path` key (`~` expanded).

Skills are injected lazily: the system prompt carries only each skill's
name + description, and the model loads full instructions on demand
through the `skill` tool (`reload_skills` rescans mid-run). `void skills
list` shows the whole discovery map — roots, valid skills, invalid
entries, shadowed duplicates.

**Trust note:** a skill's body is instructions the model will follow, at
the same trust level as AGENTS.md files already in your workspace — both
are user-curated local files, never fetched remotely. Only install skills
you have read; the OS sandbox and permission rules still bound what the
model can actually do while following them.

### Build from source

```sh
bun run build      # compiles the standalone binary to dist/void
./dist/void --version
```

`dist/` is gitignored. The system prompt is embedded in the executable
(generated from `prompts/default.md`, kept in sync by
`src/context/default-prompt.test.ts`), so the compiled binary is
self-contained.

## Trust properties & how they're verified

Every [ADR-0002](docs/adr/0002-local-first-architecture.md) property is
falsifiable in CI — the checks below are the product, not hygiene. Jobs live
in [.github/workflows/ci.yml](.github/workflows/ci.yml): `ci` (per-OS lint,
typecheck, and both test runners — including the real-sandbox suites) and
`offline` (the whole suite with OS-level network denied).

| Property | Enforced by |
|---|---|
| **1. Local agent core** — no vendor endpoint for any core function | The `offline` CI job runs the suite with kernel-level network denial (`sandbox-exec '(deny network*)'` on macOS, `unshare -Urn` on Linux); `src/app/egress.test.ts` runs complete `runTask` conversations end-to-end with zero fetch |
| **2. Transparent prompts** — versioned in-repo files | `prompts/default.md` is the system prompt, loaded by `src/context/prompts.ts`, which hard-fails on a missing/unreadable prompt instead of substituting; the egress tests prove nothing prompt-shaped is ever fetched |
| **3. OS sandbox by default** — never a silent fallback | Real `sandbox-exec` suites (`src/sandbox/run.test.ts`, `src/tools/bash.test.ts`) execute on the macOS CI `bun test` pass; real `bwrap` suites execute on Linux CI (bubblewrap apt-installed, unprivileged user namespace). A missing sandbox binary is a hard `sandbox_blocked` error with install guidance — tested. Note: `allowNetwork` on Linux shares the host network namespace (listening sockets included; outbound-only filtering is macOS-only at this stage) |
| **4. Keys stay local** — read by the local process only | The runner is pure: credentials enter only through env → injection seams (`src/app/runner.test.ts`); adapter tests assert the key is sent only to the provider endpoint via the injected `fetchImpl`, and the egress monitor asserts no other fetch path exists |
| **5. Zero telemetry** — no analytics, crash reporting, or update pinging | Two complementary halves: the in-process monitor of `src/app/egress.test.ts` (a recording, always-failing `globalThis.fetch` stub plus a control test proving the fixture fires) and the `offline` CI job denying networking at the OS level around the entire suite |
| **6. Threads are local files** — inspectable JSONL | `src/store` tests (append-only events, replay), `runTask` persistence/resume tests, and the `void threads list` CLI tests; no sync or upload code exists |

The egress verification is layered on purpose: the in-process monitor sees
call-time lookups of the global `fetch` (everything that skipped the
provider injection seam), while the OS wrappers catch any egress a test
process could attempt at all — including channels JavaScript stubs cannot
see. A regression in either layer fails CI.

### Environment variables

| Variable | Effect |
|---|---|
| `VOID_ANTHROPIC_KEY` (or `ANTHROPIC_API_KEY`) | Anthropic API key; first hit wins. |
| `VOID_ANTHROPIC_BASE_URL` | Anthropic-compatible base URL override (default `https://api.anthropic.com`); e.g. `https://api.z.ai/anthropic` runs the GLM registry entries (`--model anthropic/glm-4.6`) on Z.AI with a Z.AI key in `VOID_ANTHROPIC_KEY`. |
| `VOID_OLLAMA_URL` | Ollama base URL (default `http://127.0.0.1:11434`); use local models via `--model ollama/<id>`. |
| `VOID_OPENAI_BASE_URL` | Base URL for `openai/<model-id>` models (default `https://api.openai.com/v1`); trailing-slash tolerant, `/v1` appended only when missing. |
| `VOID_OPENAI_KEY` | API key sent as `Authorization: Bearer` for `openai/<model-id>` models; omit it for keyless local servers (LM Studio, vLLM). |
| `VOID_MODEL` | Default model ref when `--model` is absent (default: `anthropic/claude-sonnet-4-5`, a placeholder — override me). Outranks the settings files' `defaultModel`; see `void settings effective`. |
| `VOID_DEFAULT_MODEL` | Settings-shaped env shadow for `defaultModel` — same layer position as `VOID_MODEL` (env beats files), kept distinct so scripts keep using `VOID_MODEL` unchanged. |
| `VOID_DATA_DIR` | Thread storage directory (default: `$XDG_DATA_HOME/void` or `~/.local/share/void`). |
| `VOID_ALLOW_UNSANDBOXED=1` | Explicit, logged opt-out letting bash run when no OS sandbox binary exists. Without it, missing sandboxes are a hard error. |

Any OpenAI-compatible endpoint works through those two `VOID_OPENAI_*`
variables (ADR-0010) — e.g. Kimi/Moonshot, Groq, OpenRouter, LM Studio
(keyless), vLLM (keyless). The full model matrix is in the
[user guide](docs/user-guide.md#first-run).

### Build from source

```sh
bun run build      # compiles the standalone binary to dist/void
./dist/void --version
```

`dist/` is gitignored. The system prompt is embedded in the executable
(generated from `prompts/default.md`, kept in sync by
`src/context/default-prompt.test.ts`), so the compiled binary is
self-contained.

## Repository

- [docs/](docs/) — [user guide](docs/user-guide.md),
  [security posture](docs/security-posture.md), architecture, MVP scope,
  stream-JSON contract, and ADRs (guided reading order in
  [docs/README.md](docs/README.md))
- [examples/](examples/) — runnable examples: a stream-JSON consumer
  script, a complete offline MCP server config, and layered permission
  settings (each covered by tests)
- `src/contracts/` — shared TypeScript contracts every component codes against
- `src/app/` + `src/cli.ts` — composition root and the headless CLI
- `src/context/` — system prompt + AGENTS.md discovery
- `src/{core,providers,tools,permissions,sandbox,store,mcp,skills,settings,tui}/` — the components per [docs/architecture.md](docs/architecture.md)
- [AGENTS.md](AGENTS.md) — operating manual for the LLM agents developing this repo

Note: the CLI binary is named `void`; the npm package name is `void-cli`
(`void` on npm is already taken).

## Third-party notices

The compiled binary embeds three MIT-licensed dependencies: `react`,
`ink`, and `react-devtools-core`. Their copyright notices and the full
attribution list live in [NOTICE](NOTICE) (also appended to every Release's
notes). No other third-party code is compiled in — see
[ADR-0005](docs/adr/0005-tui-dependency-boundary.md).

## License

AGPL-3.0-only — see [LICENSE](LICENSE). Void competes with a proprietary
product; strong copyleft guarantees every improvement to it stays open
([ADR-0004](docs/adr/0004-license-agpl3.md)).
