import assert from "node:assert/strict";
import test from "node:test";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import {
  DesktopWorkspaceSettingsDaemonError,
  isModelPlanReferencedError
} from "./desktopWorkspaceSettingsClient.ts";

test("isModelPlanReferencedError recognizes the desktop daemon error wrapper", () => {
  assert.equal(
    isModelPlanReferencedError(
      new DesktopWorkspaceSettingsDaemonError(409, "model_plan_referenced")
    ),
    true
  );
  assert.equal(
    isModelPlanReferencedError(
      new DesktopWorkspaceSettingsDaemonError(500, "workspace_operation_failed")
    ),
    false
  );
});

test("isModelPlanReferencedError still recognizes TuttidProtocolError", () => {
  assert.equal(
    isModelPlanReferencedError(
      new TuttidProtocolError({
        code: "model_plan_referenced",
        statusCode: 409
      })
    ),
    true
  );
});
