import assert from "node:assert/strict";
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
    tools: { type: "preset", preset: "claude_code" }
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
});
