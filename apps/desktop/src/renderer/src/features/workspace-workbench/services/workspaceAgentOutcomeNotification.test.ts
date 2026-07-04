import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityMessage,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { NotificationMessage } from "@tutti-os/ui-notifications";
import {
  buildWorkspaceAgentOutcomeNotificationFromSessionEvent,
  createWorkspaceAgentOutcomeNotificationController
} from "./workspaceAgentOutcomeNotification.ts";

test("outcome notification builder reports completed turn state patches as success", () => {
  assert.deepEqual(
    buildWorkspaceAgentOutcomeNotificationFromSessionEvent(
      statePatchEvent({ outcome: "success" })
    ),
    {
      agentSessionId: "session-1",
      conversationTitle: "Build feature",
      level: "success",
      provider: "codex",
      status: "completed",
      workspaceId: "ws-1"
    }
  );
});

test("outcome notification builder reports failed turn state patches as error", () => {
  assert.deepEqual(
    buildWorkspaceAgentOutcomeNotificationFromSessionEvent(
      statePatchEvent({ outcome: "failed" })
    ),
    {
      agentSessionId: "session-1",
      conversationTitle: "Build feature",
      level: "error",
      provider: "codex",
      status: "failed",
      workspaceId: "ws-1"
    }
  );
});

test("outcome notification builder uses the state patch title as the conversation title", () => {
  assert.deepEqual(
    buildWorkspaceAgentOutcomeNotificationFromSessionEvent(
      statePatchEvent({
        outcome: "success",
        title: "Fix the installer bug"
      })
    ),
    {
      agentSessionId: "session-1",
      conversationTitle: "Fix the installer bug",
      level: "success",
      provider: "codex",
      status: "completed",
      workspaceId: "ws-1"
    }
  );
});

test("outcome notification builder ignores message updates", () => {
  assert.equal(
    buildWorkspaceAgentOutcomeNotificationFromSessionEvent({
      eventType: "message_update",
      data: {
        workspaceId: "ws-1",
        agentSessionId: "session-1",
        messages: [
          {
            role: "assistant",
            status: "completed",
            turnId: "turn-1"
          }
        ]
      }
    }),
    null
  );
});

test("outcome notification builder ignores state patches without stable turn outcome", () => {
  assert.equal(
    buildWorkspaceAgentOutcomeNotificationFromSessionEvent(
      statePatchEvent({ outcome: "canceled" })
    ),
    null
  );
  assert.equal(
    buildWorkspaceAgentOutcomeNotificationFromSessionEvent(
      statePatchEvent({ outcome: "success", turnId: "" })
    ),
    null
  );
  assert.equal(
    buildWorkspaceAgentOutcomeNotificationFromSessionEvent({
      eventType: "state_patch",
      data: {
        workspaceId: "ws-1",
        agentSessionId: "session-1",
        lifecycleStatus: "failed",
        provider: "codex",
        title: "Build feature"
      }
    }),
    null
  );
});

test("outcome notification controller notifies from live session events", () => {
  const harness = createOutcomeNotificationHarness((workspaceId) =>
    activitySnapshot({ workspaceId })
  );

  harness.events[0]?.(
    messageUpdateEvent({
      content: "Fix the installer bug",
      role: "user",
      turnId: "turn-1"
    })
  );
  harness.events[0]?.(
    statePatchEvent({ outcome: "success", title: "Build feature" })
  );

  assert.deepEqual(harness.foregroundNotifications, [
    {
      agentName: "Codex",
      agentSessionId: "session-1",
      body: "The agent finished this run.",
      closeLabel: "Close",
      conversationTitle: "Fix the installer bug",
      level: "success",
      provider: "codex",
      statusLabel: "Completed",
      workspaceId: "ws-1"
    }
  ]);
  assert.equal(harness.notifications.length, 1);
  assert.deepEqual(harness.notifications[0], {
    description: "The agent finished this run.",
    level: "success",
    navigation: {
      agentSessionId: "session-1",
      provider: "codex",
      workspaceId: "ws-1"
    },
    presentation: "background-only",
    title: "Fix the installer bug completed"
  });

  harness.controller.dispose();
  assert.equal(harness.events.length, 0);
});

test("outcome notification controller uses the matching latest user message title", () => {
  const harness = createOutcomeNotificationHarness((workspaceId) =>
    activitySnapshot({ workspaceId })
  );

  harness.events[0]?.(
    messageUpdateEvent({
      content: "6",
      role: "user",
      turnId: "turn-6"
    })
  );
  harness.events[0]?.(
    statePatchEvent({
      outcome: "completed",
      title: "1",
      turnId: "turn-6"
    })
  );

  assert.equal(
    (harness.foregroundNotifications[0] as { conversationTitle?: string })
      .conversationTitle,
    "6"
  );
  assert.equal(harness.notifications[0]?.title, "6 completed");
});

const snapshotMentionTitleCases = [
  {
    name: "session mention markdown",
    title:
      "[@wang jomes & Codex hi](mention://agent-session/session-linked?workspaceId=ws-1)",
    expected: "@session · wang jomes & Codex hi"
  },
  {
    name: "plain session mention",
    title: "@sunhello135-png & Nexight 长标题会话",
    expected: "@session · sunhello135-png & Nexight 长标题会话"
  },
  {
    name: "workspace issue mention markdown",
    title:
      "[@调研 spool 仓库 这个任务](mention://workspace-issue/issue-1?workspaceId=ws-1)",
    expected: "@调研 spool 仓库 这个任务"
  },
  {
    name: "workspace app mention markdown",
    title:
      "[@Claude Code](mention://workspace-app/agent-claude-code?workspaceId=ws-1) 派发个子agent去看看呢？",
    expected: "@Claude Code 派发个子agent去看看呢？"
  }
] as const;

for (const { name, title, expected } of snapshotMentionTitleCases) {
  test(`outcome notification controller formats ${name} like Agent GUI`, () => {
    const harness = createOutcomeNotificationHarness((workspaceId) =>
      activitySnapshot({ workspaceId, title })
    );

    harness.events[0]?.(
      statePatchEvent({ outcome: "completed", title: "Codex" })
    );

    assert.equal(
      (harness.foregroundNotifications[0] as { conversationTitle?: string })
        .conversationTitle,
      expected
    );
    assert.equal(harness.notifications[0]?.title, `${expected} completed`);
  });
}

test("outcome notification controller resolves provider default titles from snapshot messages", () => {
  const harness = createOutcomeNotificationHarness((workspaceId) =>
    activitySnapshot({
      messages: [
        activityMessage({
          content: "Ship the title fix.",
          messageId: "message-user-1"
        })
      ],
      workspaceId,
      title: "Codex"
    })
  );

  harness.events[0]?.(
    statePatchEvent({ outcome: "completed", title: "Codex" })
  );

  assert.equal(
    (harness.foregroundNotifications[0] as { conversationTitle?: string })
      .conversationTitle,
    "Ship the title fix"
  );
  assert.equal(harness.notifications[0]?.title, "Ship the title fix completed");
});

function statePatchEvent(input: {
  outcome: string;
  title?: string;
  turnId?: string;
}): unknown {
  return {
    eventType: "state_patch",
    data: {
      workspaceId: "ws-1",
      agentSessionId: "session-1",
      provider: "codex",
      title: input.title ?? "Build feature",
      turn: {
        turnId: input.turnId ?? "turn-1",
        outcome: input.outcome
      }
    }
  };
}

function messageUpdateEvent(input: {
  content: string;
  role: "assistant" | "user";
  turnId: string;
}): unknown {
  return {
    data: {
      agentSessionId: "session-1",
      kind: "text",
      messageId: `message-${input.turnId}`,
      payload: {
        content: [{ text: input.content, type: "text" }],
        text: input.content
      },
      role: input.role,
      status: "completed",
      turnId: input.turnId,
      workspaceId: "ws-1"
    },
    eventType: "message_update"
  };
}

function activitySnapshot(input: {
  messages?: AgentActivityMessage[];
  title?: string;
  workspaceId: string;
}): AgentActivitySnapshot {
  return {
    workspaceId: input.workspaceId,
    sessions: [
      {
        workspaceId: input.workspaceId,
        agentSessionId: "session-1",
        provider: "codex",
        cwd: "/workspace",
        title: input.title ?? "Build feature",
        status: "completed"
      }
    ],
    presences: [],
    sessionMessagesById: {
      "session-1": input.messages ?? []
    }
  };
}

function createOutcomeNotificationHarness(
  snapshot:
    | AgentActivitySnapshot
    | ((workspaceId: string) => AgentActivitySnapshot)
): {
  controller: ReturnType<
    typeof createWorkspaceAgentOutcomeNotificationController
  >;
  events: Array<(event: unknown) => void>;
  foregroundNotifications: unknown[];
  notifications: NotificationMessage[];
} {
  const events: Array<(event: unknown) => void> = [];
  const foregroundNotifications: unknown[] = [];
  const notifications: NotificationMessage[] = [];
  const controller = createWorkspaceAgentOutcomeNotificationController({
    foreground: {
      show(notification) {
        foregroundNotifications.push(notification);
      }
    },
    notifications: {
      notify(message) {
        notifications.push(message);
      }
    },
    translate(key, params) {
      if (key.endsWith("CompletedBody")) {
        return "The agent finished this run.";
      }
      if (key.endsWith("CompletedTitle")) {
        return `${params?.title} completed`;
      }
      if (key.endsWith("CompletedStatus")) {
        return "Completed";
      }
      if (key === "workspace.agentGui.fallbackAgentLabel") {
        return "Agent";
      }
      if (key === "common.close") {
        return "Close";
      }
      return key;
    },
    workspaceAgentActivityService: {
      getSnapshot(workspaceId) {
        return typeof snapshot === "function"
          ? snapshot(workspaceId)
          : snapshot;
      },
      onSessionEvent(workspaceId, listener) {
        assert.equal(workspaceId, "ws-1");
        events.push(listener);
        return () => {
          const index = events.indexOf(listener);
          if (index >= 0) {
            events.splice(index, 1);
          }
        };
      }
    },
    workspaceId: "ws-1"
  });
  return { controller, events, foregroundNotifications, notifications };
}

function activityMessage(input: {
  content: string;
  messageId: string;
}): AgentActivityMessage {
  return {
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    messageId: input.messageId,
    version: 1,
    turnId: "turn-1",
    role: "user",
    kind: "message.user",
    payload: {
      text: input.content
    },
    occurredAtUnixMs: 1
  };
}
