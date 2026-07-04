import type { AgentToolCallVM } from "./agentToolCallVM";

export type AgentTaskSubAgentStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

// Live view of one delegated sub-agent thread (Codex collab child thread).
// The child thread's transcript rows are segregated out of the parent
// conversation; this VM is the parent-side surface that keeps the sub-agent
// perceivable while it runs.
export type AgentTaskSubAgentActivityKind = "message" | "reasoning" | "tool";

export interface AgentTaskSubAgentActivityVM {
  kind: AgentTaskSubAgentActivityKind;
  text: string;
  atUnixMs: number | null;
}

export interface AgentTaskSubAgentVM {
  ownerThreadId: string;
  status: AgentTaskSubAgentStatus;
  // The sub-agent's own identity: its child thread name when known (daemon
  // forwards child thread/name/updated as a subAgentName marker). Null until
  // named - the view falls back to a localized numbered label, never the
  // collab tool name.
  name: string | null;
  task: string | null;
  laneIndex: number;
  laneCount: number;
  latestActivity: string | null;
  latestActivityKind: AgentTaskSubAgentActivityKind | null;
  // Chronological recent activity (markers excluded), capped; older entries
  // are summarized by activityOmittedCount.
  activityLog: readonly AgentTaskSubAgentActivityVM[];
  activityOmittedCount: number;
  // True while the spawn call is accepted but no child thread exists yet -
  // codex queues spawns beyond its per-session concurrency cap.
  queued?: boolean;
  failureDetail: string | null;
  startedAtUnixMs: number | null;
  latestActivityAtUnixMs: number | null;
  terminalAtUnixMs: number | null;
}

export interface AgentTaskStepVM {
  id: string;
  turnId: string;
  name: string;
  toolName: string | null;
  status: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  tool: AgentToolCallVM | null;
  occurredAtUnixMs: number | null;
}

export interface AgentTaskItemVM {
  kind: "task";
  id: string;
  turnId: string;
  title: string;
  status: string | null;
  prompt?: string | null;
  delegateSessionId?: string | null;
  steps: AgentTaskStepVM[];
  subAgents?: AgentTaskSubAgentVM[];
  result?: string | null;
  resultMarkdown?: string | null;
  durationMs?: number | null;
  occurredAtUnixMs: number | null;
}
