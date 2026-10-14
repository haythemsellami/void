# ADR-0011: MCP client — hand-rolled stdio, P1

- **Status:** Accepted (2026-10-14)
- **Deciders:** project owner, on agent recommendation

## Context

Roadmap workstream 3. ADR-0001 keeps
us zero-runtime-dep. The protocol subset needed for stdio servers is small and stable:
JSON-RPC 2.0 over the child's stdio, `initialize` handshake → `notifications/initialized`
→ `tools/list` → `tools/call`.

## Decision

**P1 (this workstream): hand-rolled stdio client.** New `src/mcp/` module: spawn server
per config entry (child process, `node:child_process` — runtime-agnostic per the
run.ts precedent), newline-delimited JSON-RPC framing, handshake with protocolVersion
negotiation, tools/list with schema passthrough, tools/call with content-block mapping
to our ToolResult shape, `notifications/cancelled` on abort, lifecycle (restart on
config change is P2; shutdown at exit).

- **Config:** `mcpServers` from settings (ADR-0006; shape `{command, args?, env?}`,
  per-name workspace-over-user merge as the settings loader already provides).
  `${VAR}` expansion in args/env from the CLI env; the CLI's own credential env vars
  are never forwarded to server children — we strip everything not explicitly
  configured).
- **Tools:** registered as `mcp__<server>__<tool>` (name pattern already assumed by
  permission defaults), input schema passthrough, 30s per-call timeout, structured
  errors per our ToolError taxonomy (timeout/execution_failed/invalid_input).
- **Permissions:** the existing rules engine, tool-name matched (`mcp__*` defaults
  allow). Rationale: an `mcpServers` entry in the user's settings file is an explicit
  trust act in that server — the same posture as user-curated AGENTS.md/skills content
  (ADR-0002 property 1 keeps this local and inspectable). MCP tools are NOT read-only
  by nature — servers can execute commands and write files — so the trust is the
  user's configuration choice, not a protocol property. Users can restrict with
  their own rules; a loud first-use marker is a P2 consideration.
- **CLI:** `void mcp list` (configured servers + discovered tools), `void mcp doctor`
  (handshake diagnostics). No remote transports at P1.

**P2+ (later, separate decisions):** StreamableHTTP (+SSE fallback reusing our
parseSSE), OAuth/dynamic registration, restart-on-change, deferred `tool_search`
context economy. Adopting the official SDK remains a fallback if P2's surface proves
larger than hand-rolling — decided at P2 entry, not now.

## Consequences

No dependency exception; full control over env scrubbing and timeouts (the trust
posture). Cost: we own protocol conformance — mitigated by testing against a scripted
in-repo MCP server and (CI) against real `npx`-free fixtures only (offline jobs).
