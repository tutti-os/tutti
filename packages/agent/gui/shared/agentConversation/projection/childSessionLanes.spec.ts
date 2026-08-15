import { describe, expect, it } from "vitest";
import {
  normalizeAgentActivitySession,
  type AgentActivityMessage,
  type AgentActivitySession,
  type AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import {
  buildChildSessionLanesByParentToolCallId,
  deriveSubAgentNameFromTask
} from "./childSessionLanes";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";

describe("buildChildSessionLanesByParentToolCallId", () => {
  it("attaches a child session by its immutable parent tool call", () => {
    const child = childSession({
      id: "child-1",
      parentSessionId: "root-1",
      parentToolCallId: "spawn-1",
      title: "API reviewer",
      turn: turn("child-1", "running", null)
    });
    const lanes = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [
        spawnCall("root-1", "spawn-1", "You are API reviewer.")
      ],
      childSessions: [child],
      messagesBySessionId: {
        "child-1": [message("child-1", "Checking request validation", 20)]
      }
    });

    expect(lanes.get("spawn-1")?.[0]).toMatchObject({
      childSessionId: "child-1",
      parentToolCallId: "spawn-1",
      status: "running",
      name: "API reviewer",
      task: "You are API reviewer.",
      latestActivity: "Checking request validation"
    });
  });

  it("uses the child turn outcome and keeps nested children under their direct parent", () => {
    const parent = childSession({
      id: "child-1",
      parentSessionId: "root-1",
      parentToolCallId: "spawn-1",
      turn: turn("child-1", "settled", "completed")
    });
    const nested = childSession({
      id: "child-2",
      parentSessionId: "child-1",
      parentToolCallId: "task-2",
      turn: turn("child-2", "settled", "failed", "nested failed")
    });
    const lanes = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [spawnCall("root-1", "spawn-1", "Review the API")],
      childSessions: [parent, nested],
      messagesBySessionId: {
        "child-1": [toolCallMessage("child-1", "task-2", 30)]
      }
    });

    expect(lanes.get("spawn-1")?.[0]).toMatchObject({
      childSessionId: "child-1",
      status: "completed",
      childSessions: [
        {
          childSessionId: "child-2",
          parentToolCallId: "task-2",
          status: "failed",
          failureDetail: "nested failed"
        }
      ]
    });
  });

  it("preserves a completed child result as full Markdown", () => {
    const markdown = `## Result\n\n[report](/workspace/report.pdf)\n\n${"detail ".repeat(40)}`;
    const child = childSession({
      id: "child-1",
      parentSessionId: "root-1",
      parentToolCallId: "spawn-1",
      turn: turn("child-1", "settled", "completed")
    });
    const lane = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [spawnCall("root-1", "spawn-1", "Prepare report")],
      childSessions: [child],
      messagesBySessionId: { "child-1": [message("child-1", markdown, 30)] }
    }).get("spawn-1")?.[0];

    expect(lane?.assistantMarkdown).toBe(markdown);
    expect(lane?.latestActivity).not.toBe(markdown);
  });

  it.each([
    ["running", turn("child-1", "running", null)],
    ["completed", turn("child-1", "settled", "completed")]
  ] as const)(
    "preserves the complete assistant Markdown while %s",
    (_label, childTurn) => {
      const child = childSession({
        id: "child-1",
        parentSessionId: "root-1",
        parentToolCallId: "spawn-1",
        turn: childTurn
      });
      const markdown = `Important opening context ${"detail ".repeat(24)}[PDF](C:/Reports/final%20report.pdf)`;
      const lanes = buildChildSessionLanesByParentToolCallId({
        rootSession: rootSession(),
        rootTimelineItems: [spawnCall("root-1", "spawn-1", "Build report")],
        childSessions: [child],
        messagesBySessionId: {
          "child-1": [message("child-1", markdown, 20)]
        }
      });

      expect(lanes.get("spawn-1")?.[0]?.assistantMarkdown).toBe(markdown);
      expect(lanes.get("spawn-1")?.[0]?.latestActivity).toHaveLength(141);
    }
  );

  it("preserves leading indentation and surrounding blank lines in assistant Markdown", () => {
    const child = childSession({
      id: "child-1",
      parentSessionId: "root-1",
      parentToolCallId: "spawn-1",
      turn: turn("child-1", "settled", "completed")
    });
    const markdown = "\n    console.log('preserved')\n\n";
    const lanes = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [spawnCall("root-1", "spawn-1", "Build report")],
      childSessions: [child],
      messagesBySessionId: {
        "child-1": [message("child-1", markdown, 20)]
      }
    });

    expect(lanes.get("spawn-1")?.[0]?.assistantMarkdown).toBe(markdown);
  });

  it("uses bounded activity only before an assistant message exists", () => {
    const child = childSession({
      id: "child-1",
      parentSessionId: "root-1",
      parentToolCallId: "spawn-1",
      turn: turn("child-1", "running", null)
    });
    const lanes = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [spawnCall("root-1", "spawn-1", "Build report")],
      childSessions: [child],
      messagesBySessionId: {
        "child-1": [toolCallMessage("child-1", "inspect-1", 20)]
      }
    });

    expect(lanes.get("spawn-1")?.[0]?.latestActivity).toBe("Agent");
    expect(lanes.get("spawn-1")?.[0]?.assistantMarkdown).toBeNull();
  });

  it("does not replace assistant Markdown with a later status notice", () => {
    const child = childSession({
      id: "child-1",
      parentSessionId: "root-1",
      parentToolCallId: "spawn-1",
      turn: turn("child-1", "settled", "failed", "provider failed")
    });
    const assistant = message("child-1", "Partial **report**", 20);
    const notice: AgentActivityMessage = {
      ...message("child-1", "Connection failed", 30),
      messageId: "child-1-error",
      kind: "error"
    };
    const lanes = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [spawnCall("root-1", "spawn-1", "Build report")],
      childSessions: [child],
      messagesBySessionId: { "child-1": [assistant, notice] }
    });

    expect(lanes.get("spawn-1")?.[0]?.assistantMarkdown).toBe(
      "Partial **report**"
    );
    expect(lanes.get("spawn-1")?.[0]?.failureDetail).toBe("provider failed");
  });

  it("does not replace assistant Markdown with a later plan issue annotation", () => {
    const child = childSession({
      id: "child-1",
      parentSessionId: "root-1",
      parentToolCallId: "spawn-1",
      turn: turn("child-1", "running", null)
    });
    const assistant = message("child-1", "Current **report**", 20);
    const annotation: AgentActivityMessage = {
      ...message("child-1", "[Issue](mention://workspace-issue/issue-1)", 30),
      messageId: "plan-issue:issue-1",
      kind: "session_audit"
    };
    const lanes = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [spawnCall("root-1", "spawn-1", "Build report")],
      childSessions: [child],
      messagesBySessionId: { "child-1": [assistant, annotation] }
    });

    expect(lanes.get("spawn-1")?.[0]?.assistantMarkdown).toBe(
      "Current **report**"
    );
  });

  it("does not reconstruct legacy owner fields without a child session", () => {
    const legacyItem: WorkspaceAgentActivityTimelineItem = {
      id: 2,
      eventId: "legacy-child-message",
      seq: 2,
      agentSessionId: "root-1",
      actorType: "agent",
      actorId: "root-1",
      itemType: "message.assistant",
      role: "assistant",
      payload: {
        text: "legacy child output",
        ownerThreadId: "legacy-child",
        ownerCallId: "spawn-1"
      }
    };
    const lanes = buildChildSessionLanesByParentToolCallId({
      rootSession: rootSession(),
      rootTimelineItems: [spawnCall("root-1", "spawn-1", "Review"), legacyItem],
      childSessions: [],
      messagesBySessionId: {}
    });

    expect(lanes.size).toBe(0);
  });
});

describe("deriveSubAgentNameFromTask", () => {
  it("uses only an explicit self-addressed opening", () => {
    expect(
      deriveSubAgentNameFromTask("You are API reviewer. Check routes")
    ).toBe("API reviewer");
    expect(deriveSubAgentNameFromTask("Check the API routes")).toBeNull();
  });
});

function rootSession(): AgentActivitySession {
  return normalizeAgentActivitySession({
    workspaceId: "workspace-1",
    agentSessionId: "root-1",
    kind: "root",
    provider: "codex",
    cwd: "/workspace",
    title: "Root",
    activeTurnId: "root-turn-1",
    activeTurn: turn("root-1", "running", null, null, "root-turn-1"),
    latestTurn: turn("root-1", "running", null, null, "root-turn-1"),
    latestTurnInteractions: [],
    pendingInteractions: []
  });
}

function childSession(input: {
  id: string;
  parentSessionId: string;
  parentToolCallId: string;
  title?: string;
  turn: AgentActivityTurn;
}): AgentActivitySession {
  return normalizeAgentActivitySession({
    workspaceId: "workspace-1",
    agentSessionId: input.id,
    kind: "child",
    rootAgentSessionId: "root-1",
    rootTurnId: "root-turn-1",
    parentAgentSessionId: input.parentSessionId,
    parentTurnId:
      input.parentSessionId === "root-1" ? "root-turn-1" : "child-turn-1",
    parentToolCallId: input.parentToolCallId,
    provider: "codex",
    cwd: "/workspace",
    title: input.title ?? "",
    activeTurnId: input.turn.phase === "settled" ? null : input.turn.turnId,
    activeTurn: input.turn.phase === "settled" ? null : input.turn,
    latestTurn: input.turn,
    latestTurnInteractions: [],
    pendingInteractions: [],
    createdAtUnixMs: 10,
    updatedAtUnixMs: input.turn.updatedAtUnixMs
  });
}

function turn(
  agentSessionId: string,
  phase: AgentActivityTurn["phase"],
  outcome: AgentActivityTurn["outcome"],
  errorMessage: string | null = null,
  turnId = agentSessionId === "child-2" ? "child-turn-2" : "child-turn-1"
): AgentActivityTurn {
  return {
    agentSessionId,
    turnId,
    origin: "user_prompt",
    phase,
    outcome,
    error: errorMessage ? { message: errorMessage } : null,
    startedAtUnixMs: 10,
    updatedAtUnixMs: 40,
    settledAtUnixMs: phase === "settled" ? 40 : null
  };
}

function message(
  agentSessionId: string,
  text: string,
  occurredAtUnixMs: number
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId,
    messageId: `${agentSessionId}-message`,
    version: 1,
    turnId: `${agentSessionId}-turn`,
    role: "assistant",
    kind: "text",
    payload: { text },
    occurredAtUnixMs
  };
}

function toolCallMessage(
  agentSessionId: string,
  callId: string,
  occurredAtUnixMs: number
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId,
    messageId: callId,
    version: 1,
    turnId: "child-turn-1",
    role: "assistant",
    kind: "tool_call",
    status: "running",
    payload: {
      callId,
      toolName: "Task",
      input: { task: "Inspect nested behavior" }
    },
    occurredAtUnixMs
  };
}

function spawnCall(
  agentSessionId: string,
  callId: string,
  task: string
): WorkspaceAgentActivityTimelineItem {
  return {
    id: 1,
    eventId: `${callId}-started`,
    seq: 1,
    agentSessionId,
    actorType: "agent",
    actorId: agentSessionId,
    itemType: "call.started",
    role: "assistant",
    callType: "subagent",
    callId,
    name: "Task",
    status: "running",
    payload: { callId, toolName: "Task", input: { task } },
    occurredAtUnixMs: 10
  };
}
