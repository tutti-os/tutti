import type { PromptQueueRecord } from "@tutti-os/agent-activity-core";
import type { AgentGUIQueueStatus } from "../model/agentGuiNodeTypes";

export function agentGUIQueueStatusFromPromptQueue(
  record: PromptQueueRecord | null
): AgentGUIQueueStatus {
  return record?.suspendReason === "user_stop" ? "paused_by_user" : "active";
}
