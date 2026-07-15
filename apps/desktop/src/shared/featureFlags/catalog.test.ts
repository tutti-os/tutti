import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_REFERENCE_PROVENANCE_FILTER_FLAG,
  isFeatureEnabled,
  labFeatureDefinitions,
  LAB_ENABLED_FLAG,
  resolveDesktopWorkspaceUiMode,
  withDesktopWorkspaceUiMode,
  WORKSPACE_STANDALONE_AGENT_MODE_FLAG
} from "./catalog.ts";

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
});

test("isFeatureEnabled returns false for unknown keys", () => {
  assert.equal(isFeatureEnabled({ "unknown.x": true }, "unknown.x"), true); // present wins
  assert.equal(isFeatureEnabled({}, "unknown.x"), false); // absent + no catalog default
});

test("labFeatureDefinitions excludes the master switch", () => {
  assert.ok(labFeatureDefinitions().every((d) => d.group === "lab"));
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
