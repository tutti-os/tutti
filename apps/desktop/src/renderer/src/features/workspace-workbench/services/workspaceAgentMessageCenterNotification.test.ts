import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceAgentMessageCenterItem,
  WorkspaceAgentMessageCenterModel
} from "@tutti-os/agent-gui/agent-message-center";
import {
  createWorkspaceAgentMessageCenterNotificationTracker,
  type WorkspaceAgentMessageCenterNotificationLabels
} from "./workspaceAgentMessageCenterNotification.ts";

const labels: WorkspaceAgentMessageCenterNotificationLabels = {
  description({ summary }) {
    return summary;
  },
  fallbackSummary: "Open Agent messages for details.",
  status: {
    canceled: "Canceled",
    completed: "Completed",
    failed: "Failed",
    idle: "Idle",
    waiting: "Waiting",
    working: "Running"
  },
  title({ status, title }) {
    return `Conversation ${title} ${status}`;
  }
};

test("message center notification tracker uses first model as baseline", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();

  assert.deepEqual(
    tracker.collect(model([item({ status: "working" })]), labels),
    []
  );
});

test("message center notification tracker reports failures", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(model([item({ status: "working" })]), labels);

  assert.deepEqual(
    tracker.collect(model([item({ status: "failed" })]), labels),
    [
      {
        description: "Summarized progress",
        level: "error",
        title: "Conversation Build feature Failed"
      }
    ]
  );
});

test("message center notification tracker stays silent on completion", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(model([item({ status: "working" })]), labels);

  assert.deepEqual(
    tracker.collect(model([item({ status: "completed" })]), labels),
    []
  );
});

test("message center notification tracker stays silent on cancellation", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(model([item({ status: "working" })]), labels);

  assert.deepEqual(
    tracker.collect(model([item({ status: "canceled" })]), labels),
    []
  );
});

test("message center notification tracker ignores new working items after baseline", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(model([]), labels);

  assert.deepEqual(
    tracker.collect(model([item({ status: "working" })]), labels),
    []
  );
});

test("message center notification tracker ignores new visible completed items after baseline", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(model([]), labels);

  assert.deepEqual(
    tracker.collect(model([item({ status: "completed" })]), labels),
    []
  );
});

test("message center notification tracker dedupes unchanged important states", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  const currentModel = model([item({ status: "failed" })]);
  tracker.collect(model([item({ status: "working" })]), labels);
  assert.equal(tracker.collect(currentModel, labels).length, 1);

  assert.deepEqual(tracker.collect(currentModel, labels), []);
});

test("message center notification tracker reports waiting attention as warning", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(model([item({ status: "working" })]), labels);

  assert.deepEqual(
    tracker.collect(
      model([
        item({
          needsAttentionKind: "permission",
          needsAttentionSummary: "Approve command",
          status: "working"
        })
      ]),
      labels
    ),
    [
      {
        description: "Approve command",
        level: "warning",
        title: "Conversation Build feature Waiting"
      }
    ]
  );
});

test("message center notification tracker ignores summary-only changes", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(
    model([item({ lastAgentMessageSummary: "Initial progress" })]),
    labels
  );

  assert.deepEqual(
    tracker.collect(
      model([
        item({
          lastAgentMessageAtUnixMs: 200,
          lastAgentMessageSummary: "Updated progress",
          status: "working"
        })
      ]),
      labels
    ),
    []
  );
});

test("message center notification tracker reports a new waiting request once", () => {
  const tracker = createWorkspaceAgentMessageCenterNotificationTracker();
  tracker.collect(
    model([
      item({
        pendingPrompt: approvalPrompt("request-1"),
        status: "working"
      })
    ]),
    labels
  );

  assert.deepEqual(
    tracker.collect(
      model([
        item({
          pendingPrompt: approvalPrompt("request-2"),
          status: "working"
        })
      ]),
      labels
    ),
    [
      {
        description: "Approve command",
        level: "warning",
        title: "Conversation Build feature Waiting"
      }
    ]
  );
});

function model(
  items: WorkspaceAgentMessageCenterItem[]
): WorkspaceAgentMessageCenterModel {
  return {
    counts: {
      all: items.length,
      completed: items.filter((entry) => entry.status === "completed").length,
      failed: items.filter((entry) => entry.status === "failed").length,
      waiting: items.filter((entry) => entry.needsAttentionKind !== null)
        .length,
      working: items.filter((entry) => entry.status === "working").length
    },
    items,
    waitingCount: items.filter((entry) => entry.needsAttentionKind !== null)
      .length
  };
}

function item(
  overrides: Partial<WorkspaceAgentMessageCenterItem>
): WorkspaceAgentMessageCenterItem {
  return {
    agentSessionId: "session-1",
    cwd: "/workspace",
    id: "message-center-session-1",
    identity: null,
    lastAgentMessageAtUnixMs: 100,
    lastAgentMessageSummary: "Summarized progress",
    needsAttentionKind: null,
    needsAttentionSummary: null,
    pendingPrompt: null,
    provider: "codex",
    sortTimeUnixMs: 100,
    status: "working",
    title: "Build feature",
    userId: null,
    ...overrides
  };
}

function approvalPrompt(
  requestId: string
): NonNullable<WorkspaceAgentMessageCenterItem["pendingPrompt"]> {
  return {
    callId: `call-${requestId}`,
    id: `approval-${requestId}`,
    input: {},
    kind: "approval",
    occurredAtUnixMs: 100,
    options: [],
    requestId,
    status: null,
    title: "Approve command",
    toolName: "shell",
    turnId: `turn-${requestId}`
  };
}
