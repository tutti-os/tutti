import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkspaceModelPlanTemplateGroup,
  workspaceModelPlanCreationSeed,
  workspaceModelPlanUsesNativeLogin
} from "./workspaceModelPlanTemplates.ts";

test("new model plans use one editable endpoint configuration", () => {
  assert.deepEqual(workspaceModelPlanCreationSeed, {
    baseUrl: "",
    protocol: "openai",
    templateId: null,
    templateKind: "custom"
  });
  assert.equal(
    workspaceModelPlanUsesNativeLogin(
      workspaceModelPlanCreationSeed.templateKind
    ),
    false
  );
});

test("legacy official subscriptions keep their native-login behavior", () => {
  const group = getWorkspaceModelPlanTemplateGroup("official_subscription");

  assert.ok(group);
  assert.equal(workspaceModelPlanUsesNativeLogin(group.kind), true);
});
