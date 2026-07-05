import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssueManagerRunTaskPlan,
  createIssueManagerSaveIssuePlan,
  createIssueManagerSaveTaskPlan,
  shouldIssueManagerNotifyRunFailure
} from "./controllerPlans.ts";
import {
  createIssueManagerAttachReferencesPlan,
  createIssueManagerAttachReferenceTarget,
  createIssueManagerInsertReferencesPlan,
  createIssueManagerInsertReferenceTarget
} from "./reference/controllerReferencePlans.ts";
import {
  createIssueDetail,
  createTaskDetail
} from "./controllerActionTestHarness.ts";

test("controllerPlans create run-task plans from detail and agent target intent", () => {
  assert.deepEqual(
    createIssueManagerRunTaskPlan({
      issueDetail: null,
      selectedAgentTargetId: "local:codex",
      taskDetail: createTaskDetail()
    }),
    { kind: "skip" }
  );
  assert.deepEqual(
    createIssueManagerRunTaskPlan({
      issueDetail: createIssueDetail(),
      agentTargetIdOverride: " local:claude-code ",
      selectedAgentTargetId: "local:codex",
      taskDetail: createTaskDetail()
    }),
    {
      agentTargetId: "local:claude-code",
      kind: "ready",
      provider: "claude-code",
      shouldUpdateSelectedAgentTargetId: true
    }
  );
  assert.deepEqual(
    createIssueManagerRunTaskPlan({
      issueDetail: createIssueDetail(),
      agentTargetIdOverride: "   ",
      selectedAgentTargetId: "local:codex",
      taskDetail: createTaskDetail()
    }),
    {
      agentTargetId: "local:codex",
      kind: "ready",
      provider: "codex",
      shouldUpdateSelectedAgentTargetId: false
    }
  );
});

test("controllerPlans block issue saves when the title is blank", () => {
  assert.deepEqual(
    createIssueManagerSaveIssuePlan({
      activeTopicId: "topic-1",
      issueDraft: {
        content: "Body",
        title: "   "
      }
    }),
    {
      kind: "blocked",
      notificationKey: "messages.titleRequired"
    }
  );
  assert.deepEqual(
    createIssueManagerSaveIssuePlan({
      activeTopicId: "topic-1",
      issueDraft: {
        content: "Body",
        title: "Ship renderer"
      }
    }),
    { kind: "ready", activeTopicId: "topic-1" }
  );
});

test("controllerPlans separate skip vs blocked task-save cases", () => {
  assert.deepEqual(
    createIssueManagerSaveTaskPlan({
      selectedIssueId: null,
      taskDraft: {
        content: "Body",
        priority: "medium",
        title: "Task"
      }
    }),
    { kind: "skip" }
  );
  assert.deepEqual(
    createIssueManagerSaveTaskPlan({
      selectedIssueId: "issue-1",
      taskDraft: {
        content: "Body",
        priority: "medium",
        title: "   "
      }
    }),
    {
      kind: "blocked",
      notificationKey: "messages.titleRequired"
    }
  );
  assert.deepEqual(
    createIssueManagerSaveTaskPlan({
      selectedIssueId: "issue-1",
      taskDraft: {
        content: "Body",
        priority: "medium",
        title: "Ship renderer"
      }
    }),
    {
      kind: "ready",
      selectedIssueId: "issue-1"
    }
  );
});

test("controllerPlans derive canonical reference targets", () => {
  assert.deepEqual(createIssueManagerAttachReferenceTarget("task", "task-9"), {
    mode: "attach",
    parentKind: "task",
    taskId: "task-9"
  });
  assert.deepEqual(createIssueManagerInsertReferenceTarget("issue", null), {
    mode: "insert",
    parentKind: "issue"
  });
});

test("controllerPlans choose attach flow from adapter and selection state", () => {
  assert.deepEqual(
    createIssueManagerAttachReferencesPlan({
      hasFileAdapter: false,
      parentKind: "issue",
      requestReferencesDirectly: false,
      selectedTaskId: null
    }),
    { kind: "skip" }
  );
  assert.deepEqual(
    createIssueManagerAttachReferencesPlan({
      hasFileAdapter: true,
      parentKind: "task",
      requestReferencesDirectly: true,
      selectedTaskId: null
    }),
    { kind: "skip" }
  );
  assert.deepEqual(
    createIssueManagerAttachReferencesPlan({
      hasFileAdapter: true,
      parentKind: "task",
      requestReferencesDirectly: true,
      selectedTaskId: "task-3"
    }),
    {
      kind: "request_directly",
      target: {
        mode: "attach",
        parentKind: "task",
        taskId: "task-3"
      }
    }
  );
  assert.deepEqual(
    createIssueManagerAttachReferencesPlan({
      hasFileAdapter: true,
      parentKind: "issue",
      requestReferencesDirectly: false,
      selectedTaskId: null
    }),
    {
      kind: "open_picker",
      target: {
        mode: "attach",
        parentKind: "issue"
      }
    }
  );
});

test("controllerPlans choose insert flow from mode and selection state", () => {
  assert.deepEqual(
    createIssueManagerInsertReferencesPlan({
      hasFileAdapter: false,
      parentKind: "issue",
      requestReferencesDirectly: false,
      selectedTaskId: null,
      taskEditorMode: "read"
    }),
    { kind: "skip" }
  );
  assert.deepEqual(
    createIssueManagerInsertReferencesPlan({
      hasFileAdapter: true,
      parentKind: "task",
      requestReferencesDirectly: false,
      selectedTaskId: null,
      taskEditorMode: "read"
    }),
    { kind: "skip" }
  );
  assert.deepEqual(
    createIssueManagerInsertReferencesPlan({
      hasFileAdapter: true,
      parentKind: "task",
      requestReferencesDirectly: true,
      selectedTaskId: null,
      taskEditorMode: "create"
    }),
    {
      kind: "request_directly",
      target: {
        mode: "insert",
        parentKind: "task",
        taskId: ""
      }
    }
  );
});

test("controllerPlans only notify for non-completed run results", () => {
  assert.equal(shouldIssueManagerNotifyRunFailure("completed"), false);
  assert.equal(shouldIssueManagerNotifyRunFailure("failed"), true);
  assert.equal(shouldIssueManagerNotifyRunFailure("canceled"), true);
});
