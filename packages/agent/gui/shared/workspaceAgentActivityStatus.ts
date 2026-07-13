import { type AgentActivitySession } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityStatus } from "./workspaceAgentActivityListTypes";

export function resolveWorkspaceAgentActivityStatus(
  session: AgentActivitySession
): WorkspaceAgentActivityStatus {
  const normalized = canonicalSessionStatus(session);
  switch (normalized) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "completed":
      return "completed";
    case "waiting":
      return "waiting";
    case "working":
      return "working";
    default:
      return "idle";
  }
}

function canonicalSessionStatus(
  session: AgentActivitySession
): WorkspaceAgentActivityStatus {
  if ((session.pendingInteractions?.length ?? 0) > 0) return "waiting";
  if (session.activeTurn && session.activeTurn.phase !== "settled") {
    return session.activeTurn.phase === "waiting" ? "waiting" : "working";
  }
  switch (session.latestTurn?.outcome) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "interrupted":
      return "canceled";
    default:
      return "idle";
  }
}
