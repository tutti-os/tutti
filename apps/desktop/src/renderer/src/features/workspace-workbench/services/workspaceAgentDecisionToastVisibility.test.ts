import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowWorkspaceAgentDecisionToast } from "./workspaceAgentDecisionToastVisibility.ts";

test("workspace agent decision toast shows when the window is focused and the message center is closed", () => {
  assert.equal(
    shouldShowWorkspaceAgentDecisionToast({
      messageCenterOpen: false,
      windowForeground: true
    }),
    true
  );
});

test("workspace agent decision toast is suppressed when the window is not focused", () => {
  assert.equal(
    shouldShowWorkspaceAgentDecisionToast({
      messageCenterOpen: false,
      windowForeground: false
    }),
    false
  );
});

test("workspace agent decision toast is suppressed when the message center is already open", () => {
  assert.equal(
    shouldShowWorkspaceAgentDecisionToast({
      messageCenterOpen: true,
      windowForeground: true
    }),
    false
  );
});

test("workspace agent decision toast stays suppressed when both the message center is open and the window is unfocused", () => {
  assert.equal(
    shouldShowWorkspaceAgentDecisionToast({
      messageCenterOpen: true,
      windowForeground: false
    }),
    false
  );
});
