import {
  selectSessionDisplayStatuses,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";

export type WorkspaceAgentStatusPetMood =
  | "failed"
  | "idle"
  | "review"
  | "running"
  | "waiting";

export function resolveWorkspaceAgentStatusPetMood(
  snapshot: AgentActivitySnapshot,
  waitingCount: number
): WorkspaceAgentStatusPetMood {
  if (waitingCount > 0) {
    return "waiting";
  }
  const displayStatuses = selectSessionDisplayStatuses(snapshot);
  const statuses = snapshot.sessions.map((session) => {
    const rawStatus = session.status.trim().toLowerCase();
    const displayStatus = displayStatuses.get(session.agentSessionId);
    return displayStatus && displayStatus !== "idle"
      ? displayStatus
      : rawStatus;
  });
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.some((status) => status === "running" || status === "working")) {
    return "running";
  }
  if (statuses.some((status) => status === "queued" || status === "created")) {
    return "review";
  }
  return "idle";
}
