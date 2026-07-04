import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityMessage,
  AgentActivitySessionStatus,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import { resolveWorkspaceAgentStatusPetMood } from "./workspaceAgentStatusPetMood.ts";

test("workspace agent status pet mood is idle when no sessions are active or waiting", () => {
  assert.equal(resolveWorkspaceAgentStatusPetMood(createSnapshot(), 0), "idle");
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(
      createSnapshot(["completed", "canceled", "unknown"]),
      0
    ),
    "idle"
  );
});

test("workspace agent status pet mood prioritizes actionable states", () => {
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(createSnapshot(["completed"]), 1),
    "waiting"
  );
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(createSnapshot(["failed"]), 0),
    "failed"
  );
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(createSnapshot(["working"]), 0),
    "running"
  );
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(createSnapshot(["queued"]), 0),
    "review"
  );
});

test("workspace agent status pet mood follows latest turn over stale failed session status", () => {
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(
      createSnapshot(["failed"], {
        "session-1": [
          message({
            messageId: "old-failed",
            status: "failed",
            turnId: "turn-1",
            version: 1
          }),
          message({
            messageId: "latest-completed",
            status: "completed",
            turnId: "turn-2",
            version: 2
          })
        ]
      }),
      0
    ),
    "idle"
  );
});

test("workspace agent status pet mood keeps failed when the latest turn failed", () => {
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(
      createSnapshot(["failed"], {
        "session-1": [
          message({
            messageId: "latest-failed",
            status: "failed",
            turnId: "turn-1",
            version: 1
          })
        ]
      }),
      0
    ),
    "failed"
  );
});

function createSnapshot(
  statuses: AgentActivitySessionStatus[] = [],
  sessionMessagesById: Record<string, AgentActivityMessage[]> = {}
): AgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    sessions: statuses.map((status, index) => ({
      agentSessionId: `session-${index + 1}`,
      cwd: "/tmp",
      provider: "codex",
      status,
      title: `Session ${index + 1}`,
      workspaceId: "workspace-1"
    })),
    presences: [],
    sessionMessagesById
  };
}

function message(
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind: "message.assistant",
    messageId: "message-1",
    occurredAtUnixMs: 1,
    payload: {},
    role: "assistant",
    status: "completed",
    turnId: "turn-1",
    version: 1,
    workspaceId: "workspace-1",
    ...overrides
  };
}
