# Void security posture — an honest audit

Status: living document (first edition 2026-10-13, current for the
post-MVP tree through the skills/task/distribution workstreams). This is the
detailed, no-marketing companion to the trust-properties table in
[../README.md](../README.md); the properties themselves are normative in
[adr/0002-local-first-architecture.md](adr/0002-local-first-architecture.md).

How to read this document:

- **Enforced by** — the mechanism and the test/CI job that would catch a
  regression. Every path cited exists in this repository.
- **Accepted residual risk** — something we know is not fully covered, with
  the reason it is accepted and where it is tracked. These are consolidated
  in the [residual-risk register](#residual-risk-register) at the bottom.
- **Out of scope** — threat classes this project does not attempt to defend
  against, stated plainly so nobody has to discover them by surprise.

Verification is layered the same way the egress checks are: in-process test
assertions (`src/app/egress.test.ts`, the per-component `*.test.ts` files)
plus OS-level wrappers in CI (`.github/workflows/ci.yml`, `ci` and `offline`
jobs) that would catch channels a JavaScript stub cannot see.

---

## Threat model

Void's security story is about one local process that executes model-chosen
commands on your machine, talks to exactly one LLM provider you configure,
and reads instruction files from the workspace. The adversaries worth naming:

| # | Attacker | Surface | Mitigation | Residual |
|---|---|---|---|---|
| T1 | Malicious repo content (cloned code, its `AGENTS.md`, its skills, files the model is asked to read) | Prompt injection into the system prompt and tool results (`src/context/agents-md.ts`, `src/skills/discover.ts`) | Instruction sources are user-curated local files, capped in size (64 KiB AGENTS.md chain, `src/context/agents-md.ts`); the OS sandbox bounds what an injected instruction can *do* (writes confined, network denied by default); permission defaults ask on shared-state mutations (`src/permissions/defaults.ts`) | Injection itself is not detected — a convincing injection that stays inside "read files and edit the workspace" succeeds. See [R7](#r7) |
| T2 | Malicious or compromised MCP server (a process you configured in `mcpServers`) | Unsandboxed local child process with network access, registered as tools (`src/mcp/`) | Trust act is the settings entry itself (ADR-0011); child env is constructed, never inherited, with a credential denylist (`src/mcp/env.ts`); 30 s call timeout; every call still passes the permission gate | The server runs with your full user privileges, unsandboxed, by design. See [R3](#r3) |
| T3 | The model (via compromised weights, provider-side prompt injection, or plain error) choosing destructive tool calls | `bash`, `async_shell_command`, `edit_file` | OS sandbox on every shell execution (ADR-0002 p3, `src/sandbox/`); ordered permission rules with catastrophic-command rejects (`src/permissions/defaults.ts`); workspace confinement in `edit_file` (`src/tools/edit_file.ts`) | Rules are heuristics on command text, not a boundary; `VOID_ALLOW_UNSANDBOXED=1` removes the OS layer. See [R1](#r1), [R4](#r4), [R8](#r8) |
| T4 | Another local process/user on a shared machine | Thread JSONL files, settings files, per-handle async temp logs | Threads are plain files under `$XDG_DATA_HOME/void` (`src/store/dataDir.ts`); settings created `0600` (`src/settings/edit.ts`); async temp dirs `0700` (`src/tools/async-shell.ts`) | No encryption or OS ACL work beyond the defaults; file permissions inherit the umask elsewhere. See [R9](#r9) |
| T5 | Network attacker (anyone between Void and the provider) | Provider HTTPS traffic (the only required egress) | TLS via the platform; base URLs are user-configured and validated (`src/providers/`) | Out of scope beyond TLS — see below |
| T6 | Supply chain (npm deps, install channel) | `bun install`, `install.sh` / npm launcher (ADR-0014) | Runtime deps are 3 (ink, react, react-devtools-core — TUI only); install.sh verifies sha256 against the release's `SHA256SUMS`; no postinstall code execution beyond the launcher | TOFU against the same host serves the checksums; no signature verification. See [R10](#r10) |
| T7 | A malicious background process outliving or evading control | `async_shell_command` children | Same sandbox wrappers as sync bash; detached process groups with TERM→3 s→KILL escalation; `--die-with-parent` on Linux; at most 3 handles, 30 min default lifetime, hard 4 h cap; reaped at process exit (`src/tools/async-shell.ts`, `src/sandbox/run.ts`) | Unpolled on-disk output logs grow unbounded until the lifetime kill. See [R5](#r5) |

---

## Property 1 — Local agent core

**Claim (ADR-0002):** turn engine, tool dispatch, and thread state run
in-process; no vendor endpoint is required for any core function.

**Enforced by.**

- `src/core/engine.ts` — the whole agent loop is an in-process function
  (`runConversation`); there is no RPC client, tunnel, or worker transport in
  the tree.
- `src/app/egress.test.ts` — runs complete `runTask` conversations
  end-to-end with a recording, always-failing `globalThis.fetch` stub: any
  fetch outside the injected provider seam fails the suite, and a control
  test proves the fixture actually fires.
- The `offline` CI job (`.github/workflows/ci.yml`) re-runs the suite inside
  OS-level network denial (`sandbox-exec '(deny network*)'` on macOS,
  `unshare -Urn` on Linux) — catching egress channels a JS stub cannot see.
- Local models are first-class: `src/providers/ollama.ts` and the
  OpenAI-compatible adapter (`src/providers/openai-compat.ts`) both target
  localhost endpoints by default (`VOID_OLLAMA_URL`,
  `VOID_OPENAI_BASE_URL`).

**Accepted residual risks.** None specific to this property beyond [R6](#r6)
(threads on disk) — the loop itself makes no calls.

**Out of scope.** Verifying that the *provider you configured* behaves
locally; a cloud provider obviously receives your prompts (that is property
4/5 territory, and the choice is yours).

## Property 2 — Transparent prompts

**Claim:** every system prompt is a versioned file in this repo; nothing
prompt-shaped is fetched remotely.

**Enforced by.**

- `prompts/default.md` (system prompt), `prompts/compaction.md` (ADR-0008
  summarization), `prompts/modes/explorer.md` + `prompts/modes/planner.md`
  (ADR-0013 subagent presets) — loaded by `src/context/prompts.ts`, which
  throws `PromptLoadError` on a missing/unreadable/empty prompt instead of
  substituting.
- Compiled binaries embed copies generated by `bun run sync-prompt`
  (`scripts/sync-prompt.ts`); `src/context/default-prompt.test.ts` fails the
  build if the repo file and the embedded copy drift.
- The egress tests (`src/app/egress.test.ts` + the offline CI job) prove no
  fetch path exists that could carry a remotely rendered prompt.

**Accepted residual risks.**

- User *overrides* are a local file read (`LoadPromptOptions.path` in
  `src/context/prompts.ts`) — a user who points Void at a prompt file they
  did not audit has changed their own trust boundary; that is the feature,
  not a hole.
- **Prompt injection is not detection territory.** `AGENTS.md` chains
  (`src/context/agents-md.ts`), skill bodies (`src/tools/skill.ts`), and
  every file the model reads can carry instructions that influence it. The
  defense is what those instructions can *do* (properties 3 and the
  permission layer), not filtering the text. See [R7](#r7).

**Out of scope.** Provenance or signing of user-authored prompt overrides.

## Property 3 — OS sandbox by default

**Claim:** shell tools execute inside OS-level sandboxing with an explicit,
logged opt-out; permission rules layer on top, never substitute.

**Enforced by.**

- `src/sandbox/detect.ts` — finds `sandbox-exec` (macOS) or `bwrap`
  (Linux); `src/sandbox/run.ts` throws `SandboxUnavailableError` with
  install guidance (`SANDBOX_INSTALL_GUIDANCE`) when neither exists. There
  is no silent fallback: `src/tools/bash.ts` and `src/tools/async-shell.ts`
  surface the refusal as a structured `sandbox_blocked` tool error unless
  `ctx.env.VOID_ALLOW_UNSANDBOXED === "1"`, and even then the output is
  stamped with a loud `[VOID] UNSANDBOXED EXECUTION` marker.
- `src/sandbox/macos.ts` — generated SBPL profile: default-allow reads and
  exec, `deny network*` (re-allowing only `network-outbound` when network is
  requested — listening stays denied), `deny file-write*` re-allowing only
  the workspace, the per-user temp base, the per-call temp dir, and
  `/dev/null`.
- `src/sandbox/linux.ts` — bwrap argv: `/` read-only, workspace read-write,
  fresh `/dev`, `/proc`, tmpfs `/tmp`, the *per-call* temp dir bound back
  (never the host `/tmp` mount point), `--unshare-net` unless network is
  requested, `--die-with-parent`.
- Real-sandbox test suites: `src/sandbox/run.test.ts`,
  `src/tools/bash.test.ts`, `src/tools/async-shell.test.ts` execute under
  the actual binaries on the Bun-runtime CI pass (macOS `sandbox-exec`,
  Linux bwrap installed via apt, unprivileged user namespace —
  `.github/workflows/ci.yml`).
- Process control: children are process-group leaders (`detached: true`), so
  timeouts kill the whole group; on the async side, lifetime ceilings
  (default 30 min, hard cap 4 h, `asyncShell.maxLifetimeMs` in settings —
  ADR-0006) and a `beforeExit` reap hook prevent stragglers
  (`src/tools/async-shell.ts`).

**Accepted residual risks.**

- **[R1] Linux `allowNetwork` shares the host network namespace.** A
  network-enabled sandboxed command can *bind and listen* on host
  interfaces, not just connect outbound. macOS's `allowNetwork` is
  outbound-only (the SBPL `deny network*` stays in force for listeners).
  Outbound-only filtering inside a Linux namespace is explicitly deferred —
  documented in `src/sandbox/linux.ts` ("allowNetwork honesty note") instead
  of papered over.
- **[R2] SBPL/bwrap profile composition is coarse.** The macOS profile is
  last-match-wins with `subpath` allowances only: there is no
  deny-within-allow, so "workspace writable" means *everything under it*
  (including `.git`) with no per-subtree carve-outs; reads are allowed
  everywhere by design (noted in `src/sandbox/macos.ts`); `/private/var/tmp`
  stays denied because it is not per-user. The generated profile is a fixed
  template — it cannot express per-command policy shapes beyond the
  workspace/temp/network axes.
- **[R8] Permission rules are heuristics on command text, not a
  boundary** — the boundary is the sandbox (`src/permissions/defaults.ts`
  header says exactly this). A rule-classified "read-only" command string
  that hides mutation (the reason `find` is deliberately *not* on the
  read-only allowlist) is the standing example.
- `VOID_ALLOW_UNSANDBOXED=1` is an explicit, logged, user-set opt-out. It is
  honest, not safe: with it set and no sandbox binary present, bash runs
  with full user privileges.

**Out of scope.** Hardening against a malicious *sandbox binary itself*;
seccomp profiles beyond what bwrap provides; container-based isolation
(remote runners are a roadmap item with their own ADR).

## Property 4 — Keys stay local

**Claim:** provider credentials are read by the local process only; no
credential ever leaves the machine except to its provider.

**Enforced by.**

- The runner is pure: credentials enter only through env/flags → injection
  seams (`ProviderOptions` in `src/app/runner.ts`); adapters receive keys at
  construction and send them only to their configured endpoint via the
  injected `fetchImpl` (asserted in `src/providers/*.test.ts`).
- The egress monitor (`src/app/egress.test.ts`) + offline CI job assert no
  other fetch path exists at all.
- MCP server children cannot receive Void's credentials by any route:
  `src/mcp/env.ts` builds the child env from a minimal base (PATH/HOME/
  TMPDIR) plus exactly what was configured, `${VAR}` expansion *refuses*
  denylisted credential variables (`MCPCredentialRefusalError` — argv is
  `ps`-visible), and the constructed env strips them again
  (`MCP_CREDENTIAL_ENV_DENYLIST`). A copy-pasted `mcpServers` block cannot
  forward Void's key material.
- Sandboxed bash runs with a minimal env (PATH + TMPDIR; per-call `env`
  input merges on top — `src/tools/bash.ts`, `src/sandbox/run.ts`), so keys
  are not present in the child environment by default either. Caveat below.

**Accepted residual risks.**

- **A model-chosen bash command can exfiltrate a key it learns some other
  way** (e.g. the key sits in a `.env` file inside the workspace the model
  reads, then the same run allows a network-enabled command). The sandbox's
  default network-deny is the control; `allowNetwork` calls legitimately
  punch it. This is inherent to "agent with shell access" — we bound it, we
  do not eliminate it.
- Per-call `env` input on bash/async shell means *the model* can ask to set
  variables it knows; it cannot read `process.env` of the CLI itself (only
  PATH/TMPDIR are pre-seeded), but anything it learned from file reads is
  fair game. Same class as above.
- **[R9] Thread transcripts persist secrets the session read.** Thread
  JSONL files under `$XDG_DATA_HOME/void` (`src/store/dataDir.ts`) record
  tool results verbatim — a session that catted a token file keeps it on
  disk until the user deletes the thread. Inspectable-by-design cuts both
  ways; `void threads list` + `rm` is the remediation.

**Out of scope.** OS keychain integration (ADR-0002 lists env/config
file/keychain; today env and settings files are what ships); encrypting
threads at rest.

## Property 5 — Zero telemetry

**Claim:** no analytics, crash reporting, or update pinging; version checks
are manual.

**Enforced by.**

- No telemetry code exists to disable: the egress monitor
  (`src/app/egress.test.ts`) fails on *any* fetch outside the provider seam,
  and the offline CI job denies networking at the OS level around the whole
  suite — the strongest statement available: nothing in the test corpus even
  attempts a ping.
- No update checker ships at all (ADR-0014): `install.sh` and the npm
  launcher only touch the network when the user runs them, and
  `install.sh`'s header documents that its only requests are the two release
  asset downloads.
- `void mcp list` / `void mcp doctor` spawn *local* configured servers only;
  no registry or marketplace lookups exist (ADR-0011 P1 is stdio-only).

**Accepted residual risks.** None claimed beyond the obvious: your LLM
provider sees your prompts and tool results (that is what a provider is);
Ollama/local endpoints keep even that on the machine.

**Out of scope.** Provider-side telemetry (choose a provider you trust);
crash reports (there are none — failures are structured errors on stderr
and stream-JSON).

## Property 6 — Threads are local files

**Claim:** threads are inspectable, exportable, deletable local JSONL; sync
is absent, not disabled.

**Enforced by.**

- `src/store/jsonl.ts` — append-only JSONL, one file per thread under the
  platform data dir; resume is replay (`src/app/runner.ts`).
- `void threads list` (CLI tests in `src/app/cli-composition.test.ts`) reads
  only local files; no sync/upload code exists in the tree (the egress tests
  would fail it).
- Deleting a thread is deleting a file — no service to notify.

**Accepted residual risks.** [R9] above (plaintext secrets in transcripts);
no per-thread encryption or shredding (`rm` is the tool).

---

## Residual risk register

The consolidated list — everything this audit accepts rather than fixes.
Coordinator-tracked; each entry names its file-level home.

| ID | Risk | Home | Accepted because |
|---|---|---|---|
| [R1] | Linux `allowNetwork` shares the host netns — sandboxed commands can listen, not just connect; outbound-only filtering is macOS-only | `src/sandbox/linux.ts` | Documented honesty over silent papering; namespace-local filtering is deferred work, tracked in the module header |
| [R2] | Sandbox profiles are coarse: no deny-within-allow, workspace-wide writable subtree (`.git` included), reads allowed everywhere (macOS) | `src/sandbox/macos.ts`, `src/sandbox/linux.ts` | The MVP confinement axes (workspace/temp/network) cover the realistic blast radius; finer SBPL shapes are per-feature work |
| [R3] | MCP servers run unsandboxed with user privileges by design; a malicious configured server is fully trusted code | `src/mcp/`, ADR-0011 | The trust act is the user's settings entry — same posture as any local tool the user installs; env construction + denylist bound *accidental* leakage, not malice |
| [R4] | `edit_file` has a residual check→use (TOCTOU) race: stat/read/validate and the atomic rename are not one transaction; the `st_nlink > 1` hard-link refusal is a heuristic a racing `link(2)` can slip past | `src/tools/edit_file.ts` (TOCTOU note in `execute()`) | The OS sandbox confines every racing writer to workspace+temp, and the write-to-temp + `rename(2)` guarantees the file on disk is always old-or-new, never torn |
| [R5] | Async-shell output logs grow unbounded on disk while unpolled: the 1 MiB cap bounds only the in-memory delivery window; the per-handle log file grows until the lifetime ceiling kills the child (default 30 min, hard 4 h) | `src/tools/async-shell.ts` | Log lives in the sandbox-writable per-handle 0700 temp dir and is deleted at teardown; lifetime ceiling bounds the window; temp-space exhaustion is the worst case |
| [R6] | Threads are plaintext local files; tool results persist any secret the session read | `src/store/jsonl.ts`, `src/store/dataDir.ts` | Inspectable-by-design is the property; encryption at rest is not in scope (`rm` the file) |
| [R7] | Prompt injection via repo content (AGENTS.md chain, skills, read files) is not detected or filtered | `src/context/agents-md.ts`, `src/skills/discover.ts`, `src/tools/skill.ts` | User-curated local files are the trust boundary (same as a Makefile); the sandbox + permission defaults bound what injected instructions can do; the sensitive-path ask rules (`SENSITIVE_EDIT_PATHS` in `src/permissions/defaults.ts` — `.git` and dotfiles) are the guarded-files layer, not injection detection |
| [R8] | Permission rules classify command *text* — a heuristic, not a security boundary | `src/permissions/defaults.ts` | The OS sandbox is the boundary; rules are the convenience/UX layer (stated in the module header) |
| [R9] | Key-material exposure paths inherent to agent-with-shell: model-learned secrets (e.g. a workspace `.env`) can leave via a network-allowed command in the same session | `src/tools/bash.ts` (`allowNetwork`), `src/sandbox/` | Network-deny-by-default bounds it; `allowNetwork` is an explicit user/model-visible escalation through the same permission gate |
| [R10] | Install channel is TOFU: `install.sh` verifies sha256 against `SHA256SUMS` served by the same GitHub Release; no signature verification; npm postinstall downloads share the property | `install.sh`, `npm/` (ADR-0014) | Checksums catch corrupt/stale downloads; a compromised GitHub account or npm registry is outside what an AGPL CLI can unilaterally defend — pin `VOID_VERSION` and verify manually if it matters |

### Explicitly out of scope (global)

- **Defending the user from their own configuration.** A deliberately
  permissive permissions file, `VOID_ALLOW_UNSANDBOXED=1`, a prompt override,
  or a malicious `mcpServers` entry are all user choices; Void makes them
  loud, not impossible.
- **Multi-tenant machine hardening.** File modes follow the umask except
  where noted (settings `0600`, async temp `0700`); nothing defends against a
  same-user compromise — no process can.
- **Side channels of the sandbox binaries themselves** (kernel exploits,
  sandbox escapes in `sandbox-exec`/bwrap): we consume the OS mechanism.
- **Provider-side confidentiality** — the provider you point at sees your
  prompts. Local providers (Ollama) are the answer for sensitive work.
- **Preventing the model from reading files you gave it access to.**

---

## Verifying the claims yourself

```sh
bun run lint && bun run check   # biome + tsc
bun run test                    # vitest (in-process egress monitor included)
bun test                        # Bun runtime pass — real sandbox suites execute
void schema                     # the frozen stream contract this all speaks
```

CI runs both test passes per-OS plus the `offline` job (whole suite with
OS-level network denied) on every push —
[.github/workflows/ci.yml](../.github/workflows/ci.yml). If a claim in this
document and the tests ever disagree, the tests win and this file is a bug.
