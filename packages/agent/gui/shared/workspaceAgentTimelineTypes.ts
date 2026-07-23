import type { AgentActivityMessageSemantics } from "@tutti-os/agent-activity-core";

export interface WorkspaceAgentActivityFileChange {
  path: string;
  change?: "added" | "modified" | "deleted" | "moved" | string;
  tools?: string[];
}

export interface WorkspaceAgentActivityFileChanges {
  coverage?: string;
  files?: WorkspaceAgentActivityFileChange[];
}

export interface WorkspaceAgentActivityTimelineItem {
  id: number;
  workspaceId?: string;
  agentSessionId: string;
  seq?: number;
  turnId?: string;
  eventSource?: string;
  eventId: string;
  actorType: string;
  actorId: string;
  itemType: "message" | "call" | "event" | "error" | "lifecycle" | string;
  role?: string;
  callType?: "tool" | "skill" | "subagent" | "approval" | "workflow" | string;
  callId?: string;
  name?: string;
  status?: string | null;
  messageSemantics?: AgentActivityMessageSemantics;
  content?: string;
  payload?: Record<string, unknown> & {
    content?: unknown;
    text?: unknown;
    fileChanges?: WorkspaceAgentActivityFileChanges;
  };
  occurredAtUnixMs?: number;
  createdAtUnixMs?: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}
