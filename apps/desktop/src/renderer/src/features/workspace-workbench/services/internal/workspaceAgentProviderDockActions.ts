import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import {
  openAgentEnvPanel,
  type AgentEnvPanelFocus
} from "@tutti-os/agent-gui/agent-env";
import type { AgentProviderStatusService } from "@renderer/features/workspace-agent";
import { workspaceAgentGuiProviderFromIdentifier } from "./workspaceWorkbenchComposition.ts";

export interface WorkspaceAgentProviderDockActionInput {
  actionId: string;
  agentProviderStatusService: Pick<AgentProviderStatusService, "runAction">;
  entryId: string;
  host: WorkbenchHostHandle;
  workspaceId: string;
}

// Every dock action funnels into the setup wizard: remediation actions auto-start
// their focused stage, and re-detect opens the wizard and re-runs detection there
// (rather than silently re-probing in the background with no visible result).
const DOCK_ACTION_FOCUS: Record<string, AgentEnvPanelFocus> = {
  install: "install",
  login: "auth",
  refresh: "detect"
};

export async function runWorkspaceAgentProviderDockAction(
  input: WorkspaceAgentProviderDockActionInput
): Promise<void> {
  const provider = workspaceAgentGuiProviderFromIdentifier(input.entryId);
  if (!provider) {
    return;
  }
  const focus = DOCK_ACTION_FOCUS[input.actionId];
  if (focus) {
    openAgentEnvPanel({ provider, focus });
    return;
  }
  await input.agentProviderStatusService.runAction(provider, input.actionId, {
    workbenchHost: input.host,
    workspaceId: input.workspaceId
  });
}
