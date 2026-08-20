import type { AgentGUIRuntime } from "../../../agentActivityRuntime";

export interface AgentGUIProjectChangeMetadata {
  action: "clear" | "create_new" | "import_directory" | "select_existing";
}

export function trackAgentGUISettingsProjectChange(input: {
  agentActivityRuntime: AgentGUIRuntime;
  agentSessionId: string | null;
  metadata?: AgentGUIProjectChangeMetadata;
  provider?: string | null;
  workspaceId: string;
}): void {
  if (!input.metadata) {
    return;
  }
  const tracking = input.agentActivityRuntime.trackSettingsProjectChange?.({
    action: input.metadata.action,
    agentSessionId: input.agentSessionId,
    provider: input.provider,
    workspaceId: input.workspaceId
  });
  void tracking?.catch(() => {});
}
