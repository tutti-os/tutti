import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  issueManagerOpenActivationType,
  readIssueManagerOpenActivationPayload
} from "./openActivation.ts";

const issueManagerWorkbenchSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8"
);

test("issue-manager workbench reads canonical open activation payloads", () => {
  assert.deepEqual(
    readIssueManagerOpenActivationPayload({
      payload: {
        issueId: " issue-1 ",
        mode: "execute",
        outputDir: " issues/issue-1/tasks/task-1/runs/run-1 ",
        runId: " run-1 ",
        taskId: " task-1 ",
        topicId: " topic-1 "
      },
      sequence: 7,
      type: issueManagerOpenActivationType
    }),
    {
      issueId: "issue-1",
      mode: "execute",
      outputDir: "issues/issue-1/tasks/task-1/runs/run-1",
      runId: "run-1",
      taskId: "task-1",
      topicId: "topic-1"
    }
  );
});

test("issue-manager workbench ignores unsupported open activations", () => {
  assert.equal(readIssueManagerOpenActivationPayload(null), null);
  assert.equal(
    readIssueManagerOpenActivationPayload({
      payload: {
        issueId: "issue-1"
      },
      sequence: 8,
      type: "reveal-file"
    }),
    null
  );
  assert.equal(
    readIssueManagerOpenActivationPayload({
      payload: {
        taskId: "task-1"
      },
      sequence: 9,
      type: issueManagerOpenActivationType
    }),
    null
  );
});

test("issue-manager sidebar expansion resizes only from auto-collapsed layout", () => {
  assert.match(
    issueManagerWorkbenchSource,
    /if \(\s*isSidebarAutoCollapsed\s*&&\s*nextCollapsed === false\s*&&\s*node\.displayMode !== "fullscreen"\s*\) \{[\s\S]*windowActions\.resize\(/m
  );
  assert.doesNotMatch(
    issueManagerWorkbenchSource,
    /if \(\s*isSidebarCollapsed\s*&&\s*nextCollapsed === false\s*&&\s*node\.displayMode !== "fullscreen"\s*\) \{[\s\S]*windowActions\.resize\(/m
  );
});
