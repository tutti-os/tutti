import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLiveTurnLifecyclePhase,
  LIVE_TURN_LIFECYCLE_PHASES,
  normalizeAgentActivityDisplayStatus,
  resolveLatestAgentActivityMessageDisplayStatus,
  selectNeedsAttentionCount,
  selectNeedsAttentionItems,
  selectSessionDisplayStatuses
} from "./selectors.ts";
import type {
  AgentActivityMessage,
  AgentActivityNeedsAttentionKind,
  AgentActivitySession,
  AgentActivitySnapshot
} from "./types.ts";

test("needs-attention selectors count pending permission and question items", () => {
  const snapshot = snapshotWithMessages([
    message({
      messageId: "permission-1",
      kind: "tool.permission_request",
      payload: { summary: "Approve file edit" },
      occurredAtUnixMs: 10
    }),
    message({
      messageId: "question-1",
      kind: "ask_user_question",
      payload: { title: "Choose an option" },
      occurredAtUnixMs: 20
    }),
    message({
      messageId: "done-1",
      kind: "tool.permission_request",
      status: "completed",
      occurredAtUnixMs: 30
    })
  ]);

  assert.equal(selectNeedsAttentionCount(snapshot), 2);
  assert.deepEqual(
    selectNeedsAttentionItems(snapshot).map((item) => [
      item.kind,
      item.summary,
      item.provider,
      item.title
    ]),
    [
      ["question", "Choose an option", "codex", "Status card fields"],
      ["permission", "Approve file edit", "codex", "Status card fields"]
    ]
  );
});

test("session display status is waiting when a working session needs attention", () => {
  const snapshot = snapshotWithSessionMessages(
    [session({ agentSessionId: "session-1", status: "working" })],
    {
      "session-1": [
        message({
          messageId: "approval-tool",
          kind: "tool_call",
          status: "waiting_approval",
          payload: { callType: "approval", toolName: "Approval" }
        })
      ]
    }
  );

  assert.equal(
    selectSessionDisplayStatuses(snapshot).get("session-1"),
    "waiting"
  );
});

test("session display status uses current phase when lifecycle status is active", () => {
  const snapshot = snapshotWithSessionMessages(
    [
      session({
        agentSessionId: "session-working",
        status: "active",
        currentPhase: "working"
      }),
      session({
        agentSessionId: "session-waiting",
        status: "active",
        currentPhase: "waiting_input"
      }),
      session({
        agentSessionId: "session-failed",
        status: "active",
        currentPhase: "failed"
      })
    ],
    {}
  );
  const statuses = selectSessionDisplayStatuses(snapshot);

  assert.equal(statuses.get("session-working"), "working");
  assert.equal(statuses.get("session-waiting"), "waiting");
  assert.equal(statuses.get("session-failed"), "failed");
});

test("session display status treats settled turn lifecycle as terminal", () => {
  const snapshot = snapshotWithSessionMessages(
    [
      session({
        agentSessionId: "session-completed",
        status: "working",
        currentPhase: "working",
        turnLifecycle: {
          activeTurnId: null,
          phase: "settled",
          outcome: "completed"
        }
      }),
      session({
        agentSessionId: "session-failed",
        status: "working",
        currentPhase: "working",
        turnLifecycle: {
          activeTurnId: null,
          phase: "settled",
          outcome: "failed"
        }
      })
    ],
    {}
  );
  const statuses = selectSessionDisplayStatuses(snapshot);

  assert.equal(statuses.get("session-completed"), "completed");
  assert.equal(statuses.get("session-failed"), "failed");
});

test("session display status follows the latest turn instead of stale session failure", () => {
  const snapshot = snapshotWithSessionMessages(
    [
      session({
        agentSessionId: "session-1",
        status: "failed",
        currentPhase: "failed"
      })
    ],
    {
      "session-1": [
        message({
          messageId: "failed-message",
          status: "failed",
          turnId: "turn-1",
          version: 1
        }),
        message({
          messageId: "latest-user",
          role: "user",
          status: null,
          turnId: "turn-2",
          version: 2
        }),
        message({
          messageId: "latest-assistant",
          status: "completed",
          turnId: "turn-2",
          version: 3
        })
      ]
    }
  );

  assert.equal(
    selectSessionDisplayStatuses(snapshot).get("session-1"),
    "completed"
  );
});

test("session display status keeps failed sessions failed while latest turn is only working", () => {
  const snapshot = snapshotWithSessionMessages(
    [
      session({
        agentSessionId: "session-1",
        status: "error"
      })
    ],
    {
      "session-1": [
        message({
          messageId: "latest-user",
          role: "user",
          status: null,
          turnId: "turn-1",
          version: 1
        })
      ]
    }
  );

  assert.equal(
    selectSessionDisplayStatuses(snapshot).get("session-1"),
    "failed"
  );
});

test("latest message display status uses only the newest turn", () => {
  assert.equal(
    resolveLatestAgentActivityMessageDisplayStatus([
      message({
        messageId: "old-failed",
        status: "failed",
        turnId: "turn-1",
        version: 1
      }),
      message({
        messageId: "new-user",
        role: "user",
        status: null,
        turnId: "turn-2",
        version: 2
      })
    ]),
    "working"
  );
});

test("agent activity display status normalizes raw status aliases", () => {
  assert.equal(normalizeAgentActivityDisplayStatus("running"), "working");
  assert.equal(
    normalizeAgentActivityDisplayStatus("active", {
      currentPhase: "working"
    }),
    "working"
  );
  assert.equal(
    normalizeAgentActivityDisplayStatus("waiting_approval"),
    "waiting"
  );
  assert.equal(normalizeAgentActivityDisplayStatus("ready"), "idle");
  assert.equal(normalizeAgentActivityDisplayStatus("error"), "failed");
});

test("needs-attention selectors treat waiting assistant constraints as actionable", () => {
  const snapshot = snapshotWithMessages([
    message({
      messageId: "constraint-1",
      kind: "message.assistant",
      status: "waiting",
      payload: { action: "constraint_adjustment", text: "Confirm constraint" }
    }),
    message({
      messageId: "failed-1",
      kind: "message.assistant",
      status: "failed"
    })
  ]);

  const items = selectNeedsAttentionItems(snapshot);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "constraint");
});

test("needs-attention selectors classify adapter-normalized action metadata", () => {
  const cases: Array<{
    name: string;
    expectedKind: AgentActivityNeedsAttentionKind;
    message: Partial<AgentActivityMessage>;
  }> = [
    {
      name: "permission from kind",
      expectedKind: "permission",
      message: {
        messageId: "permission-kind",
        kind: "tool.permission_request"
      }
    },
    {
      name: "approval from payload type",
      expectedKind: "permission",
      message: {
        messageId: "approval-type",
        kind: "tool.call",
        payload: { type: "ApprovalRequest" }
      }
    },
    {
      name: "approval from call type",
      expectedKind: "permission",
      message: {
        messageId: "approval-call-type",
        kind: "tool_call",
        status: "waiting_approval",
        payload: { callType: "approval", toolName: "Approval" }
      }
    },
    {
      name: "permission from request type",
      expectedKind: "permission",
      message: {
        messageId: "permission-request-type",
        kind: "tool.call",
        payload: { requestType: "permission" }
      }
    },
    {
      name: "question from kind",
      expectedKind: "question",
      message: {
        messageId: "question-kind",
        kind: "ask-user-question"
      }
    },
    {
      name: "question from action",
      expectedKind: "question",
      message: {
        messageId: "question-action",
        kind: "message.assistant",
        payload: { action: "ask_user" }
      }
    },
    {
      name: "question from interactive tool name",
      expectedKind: "question",
      message: {
        messageId: "question-tool",
        kind: "tool_call",
        status: "waiting_input",
        payload: { callType: "interactive", toolName: "AskUserQuestion" }
      }
    },
    {
      name: "constraint from payload type",
      expectedKind: "constraint",
      message: {
        messageId: "constraint-type",
        kind: "message.assistant",
        payload: { type: "ConstraintAdjustment" }
      }
    },
    {
      name: "fallback waiting assistant item",
      expectedKind: "other",
      message: {
        messageId: "other-waiting",
        kind: "message.assistant",
        payload: { text: "Waiting for input" }
      }
    },
    {
      name: "fallback waiting system item",
      expectedKind: "other",
      message: {
        messageId: "system-waiting",
        role: "system",
        kind: "system.prompt",
        payload: { text: "Confirm system prompt" }
      }
    }
  ];

  for (const item of cases) {
    const items = selectNeedsAttentionItems(
      snapshotWithMessages([message(item.message)])
    );
    assert.equal(items.length, 1, item.name);
    assert.equal(items[0]?.kind, item.expectedKind, item.name);
  }
});

test("needs-attention selectors prefer more specific categories", () => {
  const items = selectNeedsAttentionItems(
    snapshotWithMessages([
      message({
        messageId: "permission-before-question",
        kind: "ask_user_question",
        payload: { type: "permission" }
      }),
      message({
        messageId: "question-before-constraint",
        kind: "message.assistant",
        payload: { action: "ask_user_constraint" }
      })
    ])
  );

  assert.deepEqual(
    items.map((item) => [item.id, item.kind]),
    [
      ["session-1:permission-before-question", "permission"],
      ["session-1:question-before-constraint", "question"]
    ]
  );
});

test("needs-attention selectors ignore terminal and non-agent waiting messages", () => {
  const snapshot = snapshotWithMessages([
    message({
      messageId: "completed-permission",
      kind: "tool.permission_request",
      status: "Completed"
    }),
    message({
      messageId: "answered-question",
      kind: "ask_user_question",
      status: "answered"
    }),
    message({
      messageId: "user-waiting",
      role: "user",
      kind: "message.user",
      status: "waiting"
    }),
    message({
      messageId: "assistant-working",
      role: "assistant",
      kind: "message.assistant",
      status: "working"
    })
  ]);

  assert.equal(selectNeedsAttentionCount(snapshot), 0);
  assert.deepEqual(selectNeedsAttentionItems(snapshot), []);
});

test("needs-attention selectors use summary and timestamp fallbacks", () => {
  const items = selectNeedsAttentionItems(
    snapshotWithMessages([
      message({
        messageId: "display-prompt",
        payload: {
          displayPrompt: "Display prompt wins",
          summary: "Summary loses"
        },
        occurredAtUnixMs: 60
      }),
      message({
        messageId: "summary",
        payload: { summary: "Summary wins", title: "Title loses" },
        occurredAtUnixMs: 50
      }),
      message({
        messageId: "title",
        occurredAtUnixMs: undefined as unknown as number,
        payload: { title: "Title wins", content: "Content loses" },
        startedAtUnixMs: 40
      }),
      message({
        messageId: "content",
        occurredAtUnixMs: undefined as unknown as number,
        payload: { content: "Content loses", text: "Text wins" },
        completedAtUnixMs: 30
      }),
      message({
        messageId: "text",
        occurredAtUnixMs: undefined as unknown as number,
        payload: { text: "Text wins" }
      }),
      message({
        messageId: "kind",
        occurredAtUnixMs: undefined as unknown as number,
        payload: {}
      })
    ])
  );

  assert.deepEqual(
    items.map((item) => [item.id, item.summary, item.occurredAtUnixMs]),
    [
      ["session-1:display-prompt", "Display prompt wins", 60],
      ["session-1:summary", "Summary wins", 50],
      ["session-1:title", "Title wins", 40],
      ["session-1:content", "Text wins", 30],
      ["session-1:kind", "message.assistant", 1],
      ["session-1:text", "Text wins", 1]
    ]
  );
});

test("needs-attention selectors sort by recency then id across sessions", () => {
  const snapshot = snapshotWithSessionMessages(
    [
      session({ agentSessionId: "session-1", updatedAtUnixMs: 10 }),
      session({
        agentSessionId: "session-2",
        title: "Other session",
        cwd: "/other",
        provider: "claude",
        updatedAtUnixMs: 30
      })
    ],
    {
      "session-1": [
        message({
          agentSessionId: "session-1",
          messageId: "b",
          occurredAtUnixMs: 100
        }),
        message({
          agentSessionId: "session-1",
          messageId: "a",
          occurredAtUnixMs: 100
        })
      ],
      "session-2": [
        message({
          agentSessionId: "session-2",
          messageId: "latest",
          payload: { title: "Newest" },
          occurredAtUnixMs: 200
        })
      ],
      "missing-session": [
        message({
          agentSessionId: "missing-session",
          messageId: "fallback",
          occurredAtUnixMs: 150
        })
      ]
    }
  );

  const items = selectNeedsAttentionItems(snapshot);
  assert.deepEqual(
    items.map((item) => [
      item.id,
      item.provider,
      item.title,
      item.cwd,
      item.occurredAtUnixMs
    ]),
    [
      ["session-2:latest", "claude", "Other session", "/other", 200],
      ["missing-session:fallback", "", "", "", 150],
      ["session-1:a", "codex", "Status card fields", "/repo", 100],
      ["session-1:b", "codex", "Status card fields", "/repo", 100]
    ]
  );
});

function snapshotWithMessages(
  messages: AgentActivityMessage[]
): AgentActivitySnapshot {
  return snapshotWithSessionMessages([session()], {
    "session-1": messages
  });
}

function snapshotWithSessionMessages(
  sessions: AgentActivitySession[],
  sessionMessagesById: Record<string, AgentActivityMessage[]>
): AgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    sessions,
    presences: [],
    sessionMessagesById,
    composerOptionsByProvider: {}
  };
}

function session(
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/repo",
    title: "Status card fields",
    status: "waiting",
    updatedAtUnixMs: 1,
    ...overrides
  };
}

function message(
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    version: 1,
    turnId: "turn-1",
    role: "assistant",
    kind: "message.assistant",
    status: "waiting",
    payload: {},
    occurredAtUnixMs: 1,
    ...overrides
  };
}

test("LIVE_TURN_LIFECYCLE_PHASES mirrors the Go canonical list", () => {
  // SOURCE OF TRUTH: packages/agent/daemon/activity/events/turn_lifecycle_snapshot.go
  // (LiveTurnLifecyclePhases). The Go side pins the same literal list in
  // TestLiveTurnLifecyclePhasesCanonicalList; change both together.
  assert.deepEqual(
    [...LIVE_TURN_LIFECYCLE_PHASES],
    ["submitted", "running", "waiting_approval", "waiting_input"]
  );
  for (const phase of LIVE_TURN_LIFECYCLE_PHASES) {
    assert.equal(isLiveTurnLifecyclePhase(phase), true);
  }
  for (const legacy of [
    "working",
    "streaming",
    "waiting",
    "awaiting_approval"
  ]) {
    assert.equal(isLiveTurnLifecyclePhase(legacy), true);
  }
  for (const dead of ["", "settled", "idle", "failed"]) {
    assert.equal(isLiveTurnLifecyclePhase(dead), false);
  }
});

test("a present turn lifecycle resolves the display status entirely", () => {
  // Legacy live tokens resolve inside the lifecycle branch — a contradictory
  // session.status must not override them (ADR 0008).
  assert.equal(
    normalizeAgentActivityDisplayStatus("ready", {
      turnLifecyclePhase: "working"
    }),
    "working"
  );
  assert.equal(
    normalizeAgentActivityDisplayStatus("failed", {
      turnLifecyclePhase: "streaming"
    }),
    "working"
  );
});
