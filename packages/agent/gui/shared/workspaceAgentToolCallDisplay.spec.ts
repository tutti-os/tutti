import { describe, expect, it } from "vitest";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import { resolveWorkspaceAgentToolName } from "./workspaceAgentToolCallDisplay";

describe("resolveWorkspaceAgentToolName", () => {
  it.each([
    ["edit", "apply_patch", "Success. Updated index.html", "Edit"],
    ["execute", "python3 -c 'print(1)'", "python3 finished", "Bash"],
    ["read", "read", "/workspace/index.html", "Read"],
    ["search", "glob", "/workspace/**/*.ts", "Glob"],
    ["other", "todowrite", "0 todos", "TodoWrite"],
    ["other", "skill", "Loaded skill: webapp-testing", "Skill"]
  ])(
    "recovers canonical %s tools from previously persisted standard ACP input",
    (kind, title, dynamicName, expected) => {
      expect(
        resolveWorkspaceAgentToolName(
          legacyStandardACPCall({ kind, title, dynamicName })
        )
      ).toBe(expected);
    }
  );
});

function legacyStandardACPCall(input: {
  kind: string;
  title: string;
  dynamicName: string;
}): WorkspaceAgentActivityTimelineItem {
  return {
    id: 1,
    agentSessionId: "session-1",
    eventId: "event-1",
    actorType: "agent",
    actorId: "opencode",
    itemType: "call",
    callType: "tool",
    callId: "call-1",
    name: input.dynamicName,
    payload: {
      callId: "call-1",
      callType: "tool",
      toolName: input.dynamicName,
      input: {
        kind: input.kind,
        title: input.title,
        rawInput: {}
      }
    }
  };
}
