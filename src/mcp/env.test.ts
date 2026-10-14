/**
 * MCP env-policy unit tests (ADR-0011): ${VAR} expansion (undefined var is
 * a loud error naming it; denylisted credential vars are REFUSED even when
 * defined — they must never be inlined into argv where `ps` can read them),
 * and the constructed child env (minimal base + configured entries, denylist
 * stripped even when explicitly configured, CLI credentials structurally
 * absent). Pure: no spawn.
 *
 * varRef() builds `${NAME}` literals at runtime so the source itself never
 * contains a string that looks like an unfilled template placeholder
 * (biome's noTemplateCurlyInString would otherwise flag the test data).
 */
import { describe, expect, it } from "vitest";
import {
  buildChildEnv,
  expandEnvVars,
  expandServerConfig,
  MCP_CREDENTIAL_ENV_DENYLIST,
  McpCredentialRefusalError,
  McpEnvError,
} from "./env";

/** A literal `${NAME}` reference, built where the linter cannot misread it. */
const varRef = (name: string): string => ["$", "{", name, "}"].join("");

describe("mcp braced-env expansion", () => {
  it("expands braced references from the CLI env, repeatedly and embedded", () => {
    const env = { HOME: "/Users/void", MODE: "debug", PORT: "8080" };
    expect(expandEnvVars(`${varRef("HOME")}/.local/bin/server`, env, "mcpServers.s.args[0]")).toBe(
      "/Users/void/.local/bin/server",
    );
    expect(
      expandEnvVars(
        `--mode=${varRef("MODE")} --port=${varRef("PORT")}`,
        env,
        "mcpServers.s.args[1]",
      ),
    ).toBe("--mode=debug --port=8080");
    expect(expandEnvVars(`${varRef("MODE")}${varRef("MODE")}`, env, "mcpServers.s.env.K")).toBe(
      "debugdebug",
    );
  });

  it("leaves $VAR without braces literal (only the braced form expands)", () => {
    expect(expandEnvVars("$HOME stays", { HOME: "/h" }, "where")).toBe("$HOME stays");
  });

  it("an undefined variable is a LOUD error naming the variable and its location", () => {
    expect(() =>
      expandEnvVars(`x${varRef("MISSING_TOKEN")}y`, {}, "mcpServers.github.args[1]"),
    ).toThrow(McpEnvError);
    try {
      expandEnvVars(varRef("MISSING_TOKEN"), { OTHER: "1" }, "mcpServers.github.args[1]");
      expect.unreachable("must throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("MISSING_TOKEN");
      expect(message).toContain("mcpServers.github.args[1]");
    }
  });

  it("an empty-string variable counts as unset (same loud error)", () => {
    expect(() => expandEnvVars(varRef("EMPTY"), { EMPTY: "" }, "where")).toThrow(McpEnvError);
  });

  it("REFUSES to expand denylisted credential vars even when they are set", () => {
    for (const variable of ["VOID_ANTHROPIC_KEY", "ANTHROPIC_API_KEY", "VOID_OPENAI_KEY"]) {
      const env = { [variable]: "sk-secret" };
      expect(() =>
        expandEnvVars(`--key=${varRef(variable)}`, env, "mcpServers.sneaky.args[0]"),
      ).toThrow(McpCredentialRefusalError);
    }
    try {
      expandEnvVars(
        `--key=${varRef("VOID_ANTHROPIC_BASE_URL")}`,
        { VOID_ANTHROPIC_BASE_URL: "https://x" },
        "mcpServers.sneaky.args[0]",
      );
      expect.unreachable("must throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("VOID_ANTHROPIC_BASE_URL");
      expect(message).toContain("mcpServers.sneaky.args[0]");
      expect(message).toContain("ps"); // the argv-exposure rationale is in the error
    }
  });

  it("expandServerConfig expands args and env VALUES but leaves command literal", () => {
    const expanded = expandServerConfig(
      "srv",
      {
        command: `${varRef("HOME")}/bin/${varRef("MODE")}`,
        args: ["--config", `${varRef("HOME")}/conf.json`],
        env: { TOKEN: varRef("MODE"), LITERAL: "$HOME" },
      },
      { HOME: "/h", MODE: "m" },
    );
    // command stays literally unexpanded by design (auditable executable)
    expect(expanded.command).toBe(`${varRef("HOME")}/bin/${varRef("MODE")}`);
    expect(expanded.args).toEqual(["--config", "/h/conf.json"]);
    expect(expanded.env).toEqual({ TOKEN: "m", LITERAL: "$HOME" });
  });
});

describe("mcp child env construction", () => {
  it("forwards ONLY the minimal base from the CLI env, never anything ambient", () => {
    const child = buildChildEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/void",
        TMPDIR: "/tmp/void",
        SECRET_TOKEN: "canary",
        VOID_ANTHROPIC_KEY: "sk-x",
        ANTHROPIC_API_KEY: "sk-y",
        VOID_OPENAI_KEY: "sk-z",
        VOID_OLLAMA_URL: "http://127.0.0.1:1",
        VOID_MODEL: "anthropic/x",
      },
      {},
    );
    expect(child).toEqual({ PATH: "/usr/bin:/bin", HOME: "/Users/void", TMPDIR: "/tmp/void" });
  });

  it("drops absent/empty base keys instead of forwarding empties", () => {
    expect(buildChildEnv({ PATH: "/p", HOME: "" }, { EXTRA: "1" })).toEqual({
      PATH: "/p",
      EXTRA: "1",
    });
  });

  it("configured entries ride on top of the base", () => {
    expect(
      buildChildEnv({ PATH: "/p", HOME: "/h" }, { MY_SERVER_TOKEN: "tok", DEBUG: "1" }),
    ).toEqual({ PATH: "/p", HOME: "/h", MY_SERVER_TOKEN: "tok", DEBUG: "1" });
  });

  it("strips EVERY denylisted key even when a settings file configures it explicitly", () => {
    const explicit: Record<string, string> = {};
    for (const denied of MCP_CREDENTIAL_ENV_DENYLIST) {
      explicit[denied] = "must-not-reach-the-child";
    }
    const child = buildChildEnv({ PATH: "/p" }, explicit);
    expect(child).toEqual({ PATH: "/p" });
  });
});
