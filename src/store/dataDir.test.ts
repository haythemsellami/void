/**
 * Tests for `src/store/dataDir` — precedence and lazy creation of the data
 * directory. Deterministic and network-free: every path points into a
 * per-test `fs.mkdtemp` temp dir and `$HOME` is redirected so the fallback
 * branch never touches the real home directory.
 */
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDataDir } from "./dataDir";

const ENV_KEYS = ["VOID_DATA_DIR", "XDG_DATA_HOME", "HOME"] as const;

let savedEnv: Record<string, string | undefined>;
let tmp: string;

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmp = await mkdtemp(join(tmpdir(), "void-datadir-"));
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(tmp, { recursive: true, force: true });
});

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path);
  expect(info.isDirectory()).toBe(true);
}

describe("resolveDataDir", () => {
  it("honors VOID_DATA_DIR and creates it lazily", async () => {
    const override = join(tmp, "custom-data");
    process.env.VOID_DATA_DIR = override;

    await expect(resolveDataDir()).resolves.toBe(override);
    await assertDirectory(override);
  });

  it("beats XDG_DATA_HOME when both are set", async () => {
    const override = join(tmp, "override");
    process.env.VOID_DATA_DIR = override;
    process.env.XDG_DATA_HOME = join(tmp, "xdg");

    await expect(resolveDataDir()).resolves.toBe(override);
  });

  it("treats an empty VOID_DATA_DIR as unset", async () => {
    process.env.VOID_DATA_DIR = "  ";
    process.env.XDG_DATA_HOME = join(tmp, "xdg");

    await expect(resolveDataDir()).resolves.toBe(join(tmp, "xdg", "void"));
  });

  it("appends void to an absolute XDG_DATA_HOME and creates it", async () => {
    process.env.XDG_DATA_HOME = join(tmp, "xdg");

    const resolved = await resolveDataDir();
    expect(resolved).toBe(join(tmp, "xdg", "void"));
    await assertDirectory(resolved);
  });

  it("ignores a relative XDG_DATA_HOME and falls back to $HOME/.local/share/void", async () => {
    process.env.XDG_DATA_HOME = "relative/path";
    process.env.HOME = join(tmp, "home");
    await mkdir(join(tmp, "home"), { recursive: true });

    const resolved = await resolveDataDir();
    expect(resolved).toBe(join(tmp, "home", ".local", "share", "void"));
    await assertDirectory(resolved);
  });
});
