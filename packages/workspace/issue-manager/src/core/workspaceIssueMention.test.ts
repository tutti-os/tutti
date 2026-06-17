import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceIssueMentionHref,
  parseWorkspaceIssueMentionHref
} from "./workspaceIssueMention.ts";

test("workspace issue mention helpers round-trip canonical issue context", () => {
  const href = buildWorkspaceIssueMentionHref({
    issueId: "issue-1",
    mode: "execute",
    outputDir: "/workspace/issues/issue-1/tasks/task-1/runs/run-1",
    runId: "run-1",
    taskId: "task-1",
    topicId: "topic-1",
    workspaceId: "workspace-1"
  });

  assert.equal(
    href,
    "mention://workspace-issue/issue-1?workspaceId=workspace-1&topicId=topic-1&mode=execute&taskId=task-1&runId=run-1&outputDir=%2Fworkspace%2Fissues%2Fissue-1%2Ftasks%2Ftask-1%2Fruns%2Frun-1"
  );
  assert.deepEqual(parseWorkspaceIssueMentionHref(href), {
    issueId: "issue-1",
    mode: "execute",
    outputDir: "/workspace/issues/issue-1/tasks/task-1/runs/run-1",
    runId: "run-1",
    taskId: "task-1",
    topicId: "topic-1",
    workspaceId: "workspace-1"
  });
});

test("workspace issue mention parser ignores non-canonical or incomplete mentions", () => {
  assert.equal(
    parseWorkspaceIssueMentionHref(
      "mention://workspace-issue?source=plain-title"
    ),
    null
  );
  assert.equal(
    parseWorkspaceIssueMentionHref(
      "mention://agent-session?workspaceId=ws&id=session-1"
    ),
    null
  );
  assert.equal(
    parseWorkspaceIssueMentionHref(
      "mention://workspace-issue?workspaceId=ws&id=issue-1"
    ),
    null
  );
  assert.equal(
    parseWorkspaceIssueMentionHref(
      "mention://workspace-issue/issue-1?workspaceId=ws&meta.status=running"
    ),
    null
  );
  assert.equal(
    parseWorkspaceIssueMentionHref("mention://workspace-issue/issue-1"),
    null
  );
  assert.equal(
    parseWorkspaceIssueMentionHref(
      "mention://workspace-issue/issue-1?workspaceId=ws&link=%2Fissues%2Fissue-1"
    ),
    null
  );
});
