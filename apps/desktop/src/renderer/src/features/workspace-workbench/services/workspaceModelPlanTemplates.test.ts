import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkspaceModelPlanTemplateGroup,
  workspaceModelPlanUsesNativeLogin
} from "./workspaceModelPlanTemplates.ts";

test("official subscriptions reuse provider-native login without endpoint credentials", () => {
  const group = getWorkspaceModelPlanTemplateGroup("official_subscription");

  assert.ok(group);
  assert.equal(workspaceModelPlanUsesNativeLogin(group.kind), true);
  assert.equal(group.presets.length, 2);
  for (const preset of group.presets) {
    assert.equal(preset.baseUrl, "");
    assert.equal(preset.apiKeyUrl, null);
    assert.deepEqual(preset.models, []);
  }
});
