import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudeQueryOptionOverrides,
  sidecarClaudeOptionsFromPayload
} from "./options.ts";

test("sidecarClaudeOptionsFromPayload maps Claude provider meta into query options", () => {
  const options = sidecarClaudeOptionsFromPayload({
    systemPromptAppend: "Use Tutti CLI for issue context.",
    planModeInstructions: "Inspect files, then produce a plan.",
    allowedTools: ["Grep", "Glob"],
    disallowedTools: ["Monitor"],
    plugins: [
      { type: "local", path: "/tmp/tutti-plugin" },
      { type: "remote", path: "/tmp/ignored" }
    ],
    extraArgs: {
      "plugin-dir": "/tmp/tutti-plugin",
      model: "MiniMax-M2.7",
      verbose: null
    },
    tools: { type: "preset", preset: "claude_code" },
    mcpServers: {
      connector: {
        type: "http",
        url: "http://127.0.0.1:1234/mcp/connector",
        headers: { Authorization: "Bearer test-token" }
      }
    }
  });
  const overrides = claudeQueryOptionOverrides(options);

  assert.deepEqual(overrides.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: "Use Tutti CLI for issue context."
  });
  assert.deepEqual(overrides.tools, {
    type: "preset",
    preset: "claude_code"
  });
  assert.equal(
    overrides.planModeInstructions,
    "Inspect files, then produce a plan."
  );
  assert.deepEqual(overrides.allowedTools, ["Grep", "Glob"]);
  assert.deepEqual(overrides.disallowedTools, ["Monitor"]);
  assert.deepEqual(overrides.plugins, [
    { type: "local", path: "/tmp/tutti-plugin" }
  ]);
  assert.deepEqual(overrides.extraArgs, {
    "plugin-dir": "/tmp/tutti-plugin",
    model: "MiniMax-M2.7",
    verbose: null
  });
  assert.deepEqual(overrides.mcpServers, {
    connector: {
      type: "http",
      url: "http://127.0.0.1:1234/mcp/connector",
      headers: { Authorization: "Bearer test-token" }
    }
  });
});

test("sidecarClaudeOptionsFromPayload defaults to Claude Code tool preset", () => {
  const options = sidecarClaudeOptionsFromPayload({});
  const overrides = claudeQueryOptionOverrides(options);

  assert.deepEqual(overrides.systemPrompt, {
    type: "preset",
    preset: "claude_code"
  });
  assert.deepEqual(overrides.tools, {
    type: "preset",
    preset: "claude_code"
  });
  assert.equal(overrides.planModeInstructions, undefined);
  assert.equal(overrides.allowedTools, undefined);
  assert.equal(overrides.disallowedTools, undefined);
  assert.equal(overrides.plugins, undefined);
  assert.equal(overrides.extraArgs, undefined);
  assert.equal(overrides.mcpServers, undefined);
});

test("sidecarClaudeOptionsFromPayload resolves prepared metadata in the sidecar filesystem", (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "tutti-claude-meta-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const systemPromptPath = join(runtimeRoot, "claude-system-prompt.md");
  const pluginDir = join(runtimeRoot, "claude-plugin", "tutti-cli");
  const additionalDirectory = join(runtimeRoot, "claude-personal-skills");
  writeFileSync(systemPromptPath, "Use Tutti CLI for issue context.\n", "utf8");
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(additionalDirectory, { recursive: true });

  const options = sidecarClaudeOptionsFromPayload({
    env: {
      TUTTI_CLAUDE_SYSTEM_PROMPT_FILE: systemPromptPath,
      TUTTI_CLAUDE_PLUGIN_DIR: pluginDir,
      TUTTI_CLAUDE_ADDITIONAL_DIRECTORIES_JSON: JSON.stringify([
        additionalDirectory
      ])
    },
    extraArgs: { model: "MiniMax-M2.7" }
  });
  const overrides = claudeQueryOptionOverrides(options);

  assert.deepEqual(overrides.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: "Use Tutti CLI for issue context."
  });
  assert.deepEqual(overrides.plugins, [{ type: "local", path: pluginDir }]);
  assert.deepEqual(overrides.additionalDirectories, [additionalDirectory]);
  assert.deepEqual(overrides.extraArgs, {
    model: "MiniMax-M2.7",
    "plugin-dir": pluginDir
  });
});

test("sidecarClaudeOptionsFromPayload rejects invalid additional directories", () => {
  assert.throws(
    () =>
      sidecarClaudeOptionsFromPayload({
        env: { TUTTI_CLAUDE_ADDITIONAL_DIRECTORIES_JSON: "not-json" }
      }),
    /decode claude additional directories/u
  );
  assert.throws(
    () =>
      sidecarClaudeOptionsFromPayload({
        env: {
          TUTTI_CLAUDE_ADDITIONAL_DIRECTORIES_JSON: JSON.stringify(["relative"])
        }
      }),
    /must be absolute/u
  );
});

test("sidecarClaudeOptionsFromPayload reports missing prepared metadata", () => {
  const missingRoot = join(
    tmpdir(),
    `tutti-claude-missing-${crypto.randomUUID()}`
  );

  assert.throws(
    () =>
      sidecarClaudeOptionsFromPayload({
        env: {
          TUTTI_CLAUDE_SYSTEM_PROMPT_FILE: join(missingRoot, "prompt.md")
        }
      }),
    /read claude system prompt:.*ENOENT/u
  );
  assert.throws(
    () =>
      sidecarClaudeOptionsFromPayload({
        env: {
          TUTTI_CLAUDE_PLUGIN_DIR: join(missingRoot, "plugin")
        }
      }),
    /stat claude plugin dir:.*ENOENT/u
  );
});
