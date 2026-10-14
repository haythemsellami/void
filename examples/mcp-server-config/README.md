# mcp-server-config — a complete, offline MCP example

Three files, one behavior: Void spawns `server.mjs` as a local stdio child,
handshakes (ADR-0011), and registers its tools as `mcp__example__hello` and
`mcp__example__add`.

| File | Goes to |
|---|---|
| `server.mjs` | stays here (a dependency-free Node script — any stdio MCP server works the same way) |
| `settings.json` | copy into `.void/settings.json` (workspace) or `~/.config/void/settings.json` (user) |

Notes on the wiring:

- `${PWD}` expands from the environment you launch `void` from — run from
  the repo root (`void mcp doctor` to verify), or replace it with the
  absolute path to this directory.
- The `permissions` block demonstrates the pattern for restricting a
  server: exact-name allow for the harmless tool, `ask` for everything else
  the server might offer (rules are evaluated first-match-wins).
- Server children run unsandboxed by design — an `mcpServers` entry is an
  explicit trust act (see docs/security-posture.md). Void never forwards its
  own credential env to the child (`src/mcp/env.ts`).

Check it works: `void mcp list` (tools discovered) and `void mcp doctor`
(handshake diagnostics + the server's stderr tail).
