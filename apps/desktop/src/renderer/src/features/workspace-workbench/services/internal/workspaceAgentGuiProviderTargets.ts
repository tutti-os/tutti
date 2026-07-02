import type { AgentTarget, TuttidClient } from "@tutti-os/client-tuttid-ts";
import type {
  AgentGUIProvider,
  AgentGUIProviderTarget,
  AgentGUIProviderTargetRef
} from "@tutti-os/agent-gui";

export async function loadWorkspaceAgentGuiProviderTargets(
  tuttidClient: Pick<TuttidClient, "listAgentTargets">
): Promise<readonly AgentGUIProviderTarget[]> {
  const response = await tuttidClient.listAgentTargets();
  return mapAgentTargetsToAgentGuiProviderTargets(response.targets);
}

export function mapAgentTargetsToAgentGuiProviderTargets(
  targets: readonly AgentTarget[]
): readonly AgentGUIProviderTarget[] {
  return [...targets].sort(compareAgentTargetsForDisplay).map((target) => {
    const provider = target.provider as AgentGUIProvider;
    const ref: AgentGUIProviderTargetRef = {
      kind: target.launchRef.type,
      provider,
      targetId: target.id
    };
    return {
      targetId: target.id,
      agentTargetId: target.id,
      provider,
      ref,
      label: target.name,
      disabled: target.enabled !== true
    };
  });
}

function compareAgentTargetsForDisplay(
  left: AgentTarget,
  right: AgentTarget
): number {
  return (
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}
