import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EXTENSION_ACTIVATION_FLAGS,
  AGENT_EXTENSION_CODEBUDDY_FLAG,
  AGENT_EXTENSION_COPILOT_FLAG,
  AGENT_EXTENSION_GEMINI_FLAG,
  AGENT_EXTENSION_HERMES_FLAG,
  AGENT_EXTENSION_KIMI_CODE_FLAG,
  AGENT_EXTENSION_GROK_FLAG,
  AGENT_EXTENSION_KILO_FLAG,
  AGENT_EXTENSION_QWEN_FLAG,
  AGENT_REFERENCE_PROVENANCE_FILTER_FLAG,
  AGENT_QUICK_PROMPT_LIBRARY_FLAG,
  isFeatureEnabled,
  labFeatureDefinitions,
  LAB_ENABLED_FLAG,
  LAB_AUTOMATION_RULES_FLAG,
  LAB_MODEL_PLANS_FLAG,
  LAB_TUTTI_MODE_FLAG,
  LAB_WORKSPACE_AGENTS_FLAG,
  MOBILE_REMOTE_ACCESS_SETTINGS_FLAG,
  resolveDesktopWorkspaceUiMode,
  withDesktopWorkspaceUiMode,
  WORKSPACE_STANDALONE_AGENT_MODE_FLAG
} from "./catalog.ts";

test("Agent Extension activation flags stay catalog-driven", () => {
  assert.deepEqual(AGENT_EXTENSION_ACTIVATION_FLAGS, [
    AGENT_EXTENSION_GEMINI_FLAG,
    AGENT_EXTENSION_CODEBUDDY_FLAG,
    AGENT_EXTENSION_COPILOT_FLAG,
    AGENT_EXTENSION_KILO_FLAG,
    AGENT_EXTENSION_QWEN_FLAG,
    AGENT_EXTENSION_HERMES_FLAG,
    AGENT_EXTENSION_KIMI_CODE_FLAG,
    AGENT_EXTENSION_GROK_FLAG
  ]);
  for (const flag of AGENT_EXTENSION_ACTIVATION_FLAGS) {
    assert.equal(isFeatureEnabled({}, flag), false);
  }
});

test("isFeatureEnabled falls back to catalog default when key absent", () => {
  assert.equal(isFeatureEnabled({}, LAB_ENABLED_FLAG), false);
  assert.equal(
    isFeatureEnabled({ [LAB_ENABLED_FLAG]: true }, LAB_ENABLED_FLAG),
    true
  );
  assert.equal(
    isFeatureEnabled({}, AGENT_REFERENCE_PROVENANCE_FILTER_FLAG),
    false
  );
  assert.equal(isFeatureEnabled({}, AGENT_QUICK_PROMPT_LIBRARY_FLAG), false);
  assert.equal(isFeatureEnabled({}, MOBILE_REMOTE_ACCESS_SETTINGS_FLAG), false);
  assert.equal(
    isFeatureEnabled(
      { [AGENT_QUICK_PROMPT_LIBRARY_FLAG]: false },
      AGENT_QUICK_PROMPT_LIBRARY_FLAG
    ),
    false
  );
  assert.equal(
    isFeatureEnabled(
      { [AGENT_QUICK_PROMPT_LIBRARY_FLAG]: true },
      AGENT_QUICK_PROMPT_LIBRARY_FLAG
    ),
    true
  );
  assert.equal(
    isFeatureEnabled(
      { [MOBILE_REMOTE_ACCESS_SETTINGS_FLAG]: true },
      MOBILE_REMOTE_ACCESS_SETTINGS_FLAG
    ),
    true
  );
});

test("isFeatureEnabled returns false for unknown keys", () => {
  assert.equal(isFeatureEnabled({ "unknown.x": true }, "unknown.x"), true); // present wins
  assert.equal(isFeatureEnabled({}, "unknown.x"), false); // absent + no catalog default
});

test("labFeatureDefinitions excludes the master switch", () => {
  assert.ok(labFeatureDefinitions().every((d) => d.group === "lab"));
});

test("experimental Agent features require independent Lab opt-ins", () => {
  const flags = [
    LAB_TUTTI_MODE_FLAG,
    LAB_MODEL_PLANS_FLAG,
    LAB_WORKSPACE_AGENTS_FLAG,
    LAB_AUTOMATION_RULES_FLAG
  ];

  for (const flag of flags) {
    assert.equal(isFeatureEnabled({}, flag), false);
    assert.equal(isFeatureEnabled({ [flag]: true }, flag), true);
  }
});

test("workspace UI mode defaults to OS and preserves explicit selections", () => {
  const agentFlags = withDesktopWorkspaceUiMode(
    { [LAB_ENABLED_FLAG]: true },
    "agent"
  );
  const osFlags = withDesktopWorkspaceUiMode(agentFlags, "os");

  assert.equal(resolveDesktopWorkspaceUiMode({}), "os");
  assert.equal(resolveDesktopWorkspaceUiMode(agentFlags), "agent");
  assert.equal(resolveDesktopWorkspaceUiMode(osFlags), "os");
  assert.equal(agentFlags[WORKSPACE_STANDALONE_AGENT_MODE_FLAG], true);
  assert.equal(osFlags[WORKSPACE_STANDALONE_AGENT_MODE_FLAG], false);
  assert.equal(agentFlags[LAB_ENABLED_FLAG], true);
  assert.equal(osFlags[LAB_ENABLED_FLAG], true);
});
