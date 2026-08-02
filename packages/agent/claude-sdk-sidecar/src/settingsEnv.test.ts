import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeQuerySettingsEnv } from "./settingsEnv.ts";

test("query settings cannot relocate the process-level Claude transcript store", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-claude-settings-env-"));
  const configDirectory = join(root, "config");
  const workspace = join(root, "workspace");
  const originalConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  try {
    await mkdir(configDirectory, { recursive: true });
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          CLAUDE_CONFIG_DIR: join(root, "other-config"),
          CLAUDE_CODE_EXECUTABLE: "/custom/claude"
        }
      })
    );
    process.env.CLAUDE_CONFIG_DIR = configDirectory;

    assert.deepEqual(claudeQuerySettingsEnv(workspace), {
      CLAUDE_CODE_EXECUTABLE: "/custom/claude"
    });
  } finally {
    if (originalConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDirectory;
    }
    await rm(root, { recursive: true, force: true });
  }
});
