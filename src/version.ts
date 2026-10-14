/**
 * The single source of truth for the CLI version (package.json mirrors it;
 * the sync test in tests/release-discipline.test.ts enforces the pair).
 * Standalone module so any layer — cli entry, MCP handshake identity — can
 * import it without creating import cycles through the composition root.
 */
export const VERSION = "1.0.0";
