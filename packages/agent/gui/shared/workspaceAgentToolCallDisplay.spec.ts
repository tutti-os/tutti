import { describe, expect, it } from "vitest";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import {
  buildWorkspaceAgentToolCallDisplay,
  resolveWorkspaceAgentToolName
} from "./workspaceAgentToolCallDisplay";

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

describe("buildWorkspaceAgentToolCallDisplay", () => {
  it("marks a structured provider error as failed when no terminal status exists", () => {
    const display = buildWorkspaceAgentToolCallDisplay({
      id: 2,
      agentSessionId: "session-1",
      eventId: "event-2",
      actorType: "agent",
      actorId: "cursor",
      itemType: "call",
      callType: "tool",
      name: "MCP request",
      payload: {
        toolName: "McpTool",
        error: {
          response: { detail: { message: "MCP request failed" } }
        }
      }
    });

    expect(display.statusKind).toBe("failed");
    expect(display.detail).toBe("MCP request failed");
  });

  it("keeps a canonical completed status while preserving diagnostic detail", () => {
    const display = buildWorkspaceAgentToolCallDisplay({
      id: 3,
      agentSessionId: "session-1",
      eventId: "event-3",
      actorType: "agent",
      actorId: "cursor",
      itemType: "call.completed",
      callType: "tool",
      name: "MCP request",
      payload: {
        toolName: "McpTool",
        error: {
          stderr: "provider emitted a diagnostic after completion"
        }
      }
    });

    expect(display.statusKind).toBe("completed");
    expect(display.detail).toBe(
      "provider emitted a diagnostic after completion"
    );
  });
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
