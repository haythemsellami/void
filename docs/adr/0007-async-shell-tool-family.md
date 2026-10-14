# ADR-0007: Async shell tool family (background processes)

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

The `bash` tool is synchronous with a hard timeout — it cannot host dev servers,
watchers, or long test runs, which real coding work needs continuously. Void's sync
`bash` stays as-is; this ADR adds an async family implemented from scratch.

## Decision

Three builtin tools:

1. **`async_shell_command`** — same input schema as `bash` (command, workdir,
   timeoutMs→`maxLifetimeMs`, env) but returns immediately with a handle:
   `{handle: "as_<short-id>", pid, hint: "poll with async_shell_command_status"}`.
   Runs through the SAME sandbox wrappers (`sandbox-exec`/bwrap, workspace-write,
   network-deny default) — no unsandboxed path, same `VOID_ALLOW_UNSANDBOXED` semantics
   when no sandbox binary exists. Process registry is in-process (`Map<handle,
   {proc, buffers, cursor}>`); handles are validated `[A-Za-z0-9_-]+`; at most 3 live
   handles (oldest killed, loudly, when exceeded); all children reaped at process exit.
2. **`async_shell_command_status`** — input `{handle, waitMs?}`: returns NEW output
   (stdout+stderr, interleaved by arrival, OutputLimits-truncated with markers) since
   the last poll (cursor model — never re-sends the whole buffer), plus
   `{running: bool, exitCode?}`. `waitMs` lets the model block briefly (cap 30s) for
   more output; exit is terminal — one final status after exit returns remaining output
   and marks the handle consumed.
3. **`async_shell_command_kill`** — input `{handle}`: process-group kill with the same
   escalation (TERM → 3s → KILL) as sync bash's timeout path; returns final status.
   [Amended 2026-10-14, implementation deviation adopted: **capture is a shared
   append-mode file descriptor, not pipes** — the child's stdout and stderr are the
   same fd, so the OS serializes writes into one per-handle log in true arrival order.
   Rationale (empirically probed): a pipe reader holds the host event loop open, which
   would keep the whole CLI alive after a task finished and prevent the beforeExit
   reap; fd capture + `proc.unref()` + unref'd timers let the loop drain. No pipes
   exist to destroy on kill — the sync-bash pipe-destruction fix is preserved
   structurally (a log file cannot be held hostage by an escaped grandchild). The log
   lives in the per-handle 0700 temp dir the sandbox profile already treats as
   writable.]

Default permission classification (explicit — the async names get their OWN rules;
name-keyed bash rules do not match them, and status/kill inputs carry no `command`
key to regex): `async_shell_command` mirrors bash's read-only-prefix allowlist and
ask-otherwise; `async_shell_command_status` is **allow** (read-only output
retrieval); `async_shell_command_kill` is **allow** (risk-reducing: it stops a
process). No default ask-classification exists in the async family — headless runs
stay usable; users can override with their own rules. Thread persistence: tool results record outputs as polled; the
registry itself is NOT persisted (a resumed thread starts no processes — documented).

## Consequences

Enables real dev-loop workflows (start server → edit → poll logs → kill). Risks
accepted: long-lived sandboxed children hold resources (bounded by the 3-handle cap +
lifetime ceiling, default 30 min, configurable via the settings key `asyncShell.maxLifetimeMs` (ADR-0006)); output is interleaved by the OS in true write-arrival order (the shared append fd);
cursors mean the model sees
history only via what it polled (mitigation documented in tool description: poll
before acting). No changes to the frozen stream contract (these are ordinary tool
calls/results).
