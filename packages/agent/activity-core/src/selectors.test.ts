import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeAgentActivityDisplayStatus,
  selectNeedsAttentionCount,
  selectNeedsAttentionItems
} from "./selectors.ts";
import type {
  AgentActivityInteraction,
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivitySnapshot
} from "./types.ts";
import { normalizeAgentActivitySession } from "./sessionNormalization.ts";

test("needs-attention selectors read only canonical pending interactions", () => {
  const canonical = session({
    pendingInteractions: [
      interaction({
        requestId: "approval-1",
        kind: "approval",
        input: { summary: "Approve file edit" },
        updatedAtUnixMs: 10
      }),
      interaction({
        requestId: "question-1",
        kind: "question",
        input: { questions: [{ question: "Choose an option" }] },
        updatedAtUnixMs: 20
      }),
      interaction({
        requestId: "plan-1",
        kind: "plan",
        toolName: "ExitPlanMode",
        updatedAtUnixMs: 30
      })
    ]
  });
  const snapshot = snapshotWithSessions([canonical]);

  assert.equal(selectNeedsAttentionCount(snapshot), 3);
  assert.deepEqual(
    selectNeedsAttentionItems(snapshot).map((item) => [
      item.kind,
      item.summary,
      item.provider,
      item.title
    ]),
    [
      ["constraint", "ExitPlanMode", "codex", "Status card fields"],
      ["question", "Choose an option", "codex", "Status card fields"],
      ["permission", "Approve file edit", "codex", "Status card fields"]
    ]
  );
});

test("stale waiting transcript has no attention when canonical pending is empty", () => {
  const snapshot = snapshotWithSessions([session()], {
    "session-1": [
      message({
        messageId: "approval-stale",
        status: "waiting_approval",
        payload: { callType: "approval", toolName: "Approval" }
      }),
      message({
        messageId: "question-stale",
        status: "waiting_input",
        payload: { callType: "interactive", toolName: "AskUserQuestion" }
      })
    ]
  });

  assert.equal(selectNeedsAttentionCount(snapshot), 0);
  assert.deepEqual(selectNeedsAttentionItems(snapshot), []);
});

test("needs-attention selectors ignore non-pending interaction rows", () => {
  const snapshot = snapshotWithSessions([
    session({
      pendingInteractions: [
        interaction({ requestId: "answered", status: "answered" }),
        interaction({ requestId: "superseded", status: "superseded" })
      ]
    })
  ]);

  assert.deepEqual(selectNeedsAttentionItems(snapshot), []);
});

test("needs-attention selectors sort canonical interactions by recency and composite id", () => {
  const snapshot = snapshotWithSessions([
    session({
      pendingInteractions: [
        interaction({ requestId: "b", updatedAtUnixMs: 100 }),
        interaction({ requestId: "a", updatedAtUnixMs: 100 })
      ]
    }),
    session({
      agentSessionId: "session-2",
      provider: "claude",
      title: "Other session",
      cwd: "/other",
      pendingInteractions: [
        interaction({
          agentSessionId: "session-2",
          requestId: "latest",
          input: { title: "Newest" },
          updatedAtUnixMs: 200
        })
      ]
    })
  ]);

  assert.deepEqual(
    selectNeedsAttentionItems(snapshot).map((item) => [
      item.id,
      item.provider,
      item.summary,
      item.occurredAtUnixMs
    ]),
    [
      ["session-2:turn-1:latest", "claude", "Newest", 200],
      ["session-1:turn-1:a", "codex", "approval", 100],
      ["session-1:turn-1:b", "codex", "approval", 100]
    ]
  );
});

test("agent activity display status normalizes raw status aliases", () => {
  assert.equal(normalizeAgentActivityDisplayStatus("running"), "working");
  assert.equal(
    normalizeAgentActivityDisplayStatus("active", {
      activeTurnPhase: "running"
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

function snapshotWithSessions(
  sessions: AgentActivitySession[],
  sessionMessagesById: Record<string, AgentActivityMessage[]> = {}
): AgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    sessions,
    presences: [],
    sessionMessagesById,
    composerOptionsByTargetKey: {}
  };
}

function session(
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/repo",
    title: "Status card fields",
    updatedAtUnixMs: 1,
    ...overrides
  });
}

function interaction(
  overrides: Partial<AgentActivityInteraction> = {}
): AgentActivityInteraction {
  return {
    agentSessionId: "session-1",
    requestId: "request-1",
    turnId: "turn-1",
    kind: "approval",
    status: "pending",
    toolName: null,
    input: null,
    metadata: null,
    output: null,
    createdAtUnixMs: 1,
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
    sequence: overrides.version ?? 1,
    kind: "tool_call",
    status: "waiting_input",
    payload: {},
    occurredAtUnixMs: 1,
    ...overrides
  };
}
