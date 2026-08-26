import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAgentMessageCenterItem } from "@tutti-os/agent-gui/agent-message-center";
import {
  buildWorkspaceAgentDecisionNotification,
  isWorkspaceAgentDecisionNotificationPresentable,
  type WorkspaceAgentDecisionNotificationLabels
} from "./workspaceAgentDecisionNotification.ts";

const labels: WorkspaceAgentDecisionNotificationLabels = {
  approvalOptionLabel: (option) => option.label,
  commandLabel: "Command",
  fallbackAgentIconUrl: "agent-icon://fallback",
  fallbackAgentName: "Agent",
  isRequestIdTitle: (value) => value.startsWith("requestId:"),
  planModes: [],
  promptCommand: () => null
};

test("public notification builder makes a synthetic plan prompt presentable", () => {
  const item = planItem();

  const notification = buildWorkspaceAgentDecisionNotification(item, labels);

  assert.deepEqual(notification, {
    agentIconUrl: "agent-icon://fallback",
    agentName: "Agent",
    conversationTitle: "Canonical session",
    description: "Implement plan?",
    options: [],
    prompt: item.pendingPrompt
  });
  assert.equal(
    isWorkspaceAgentDecisionNotificationPresentable(notification),
    true
  );
});

test("ordinary notifications without options remain filtered", () => {
  const notification = buildWorkspaceAgentDecisionNotification(
    {
      ...planItem(),
      pendingPrompt: {
        agentSessionId: "session-1",
        kind: "ask-user",
        requestId: "request-question",
        title: "Question",
        turnId: "turn-plan",
        questions: [
          {
            id: "question-1",
            header: "",
            question: "Explain the choice",
            options: [],
            multiSelect: false,
            answer: null
          }
        ]
      }
    },
    labels
  );

  assert.equal(notification?.options.length, 0);
  assert.equal(
    isWorkspaceAgentDecisionNotificationPresentable(notification),
    false
  );
});

function planItem(): WorkspaceAgentMessageCenterItem {
  return {
    id: "message-center-session-1",
    agentSessionId: "session-1",
    provider: "codex",
    userId: null,
    title: "Canonical session",
    identity: null,
    cwd: "/workspace",
    status: "waiting",
    digest: {
      primary: {
        kind: "input-required",
        summary: "Implement plan?",
        occurredAtUnixMs: 20
      }
    },
    lastAgentMessageSummary: "Implement plan?",
    lastAgentMessageAtUnixMs: 20,
    pendingInteractionTarget: null,
    pendingPrompt: {
      kind: "plan-implementation",
      requestId: "turn-plan",
      title: "Implement plan?"
    },
    needsAttentionKind: "constraint",
    needsAttentionSummary: "Implement plan?",
    latestTurnOutcome: null,
    sortTimeUnixMs: 20
  };
}
