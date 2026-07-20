import assert from "node:assert/strict";
import test from "node:test";
import type { IssueManagerController } from "../../react/index.ts";
import {
  IssueManagerExecutionProfileFields,
  IssueManagerTaskAssignmentFields
} from "./IssueManagerOrchestrationFields.tsx";

const nonTuttiModeController = {
  isTuttiModePlanIssue: false
} as IssueManagerController;

test("execution profile fields stay hidden outside Tutti Mode planning", () => {
  assert.equal(
    IssueManagerExecutionProfileFields({
      controller: nonTuttiModeController
    }),
    null
  );
});

test("task assignment fields stay hidden outside Tutti Mode planning", () => {
  assert.equal(
    IssueManagerTaskAssignmentFields({
      controller: nonTuttiModeController
    }),
    null
  );
});
