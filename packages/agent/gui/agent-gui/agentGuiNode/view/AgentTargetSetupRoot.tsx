import { useCallback, useMemo, type ReactNode } from "react";
import { resolveAgentGUIProviderCatalogIdentity } from "../../../providerIdentityCatalog.ts";
import { openAgentEnvPanel } from "../../../shared/agentEnv/agentEnvPanelStore.ts";
import {
  AgentTargetSetupControllerProvider,
  type AgentTargetSetupController,
  useCreateAgentTargetSetupController
} from "../../../shared/agentEnv/agentTargetSetupController.tsx";
import type { AgentGUIAgentTarget } from "../../../types.ts";
import {
  projectAgentGUIManagedHomeTargets,
  type AgentGUIManagedHomeTargetProjection
} from "../model/agentGuiProviderRailOrder.ts";
import { AgentTargetSetupGate } from "./AgentTargetSetupGate.tsx";
import { useAgentGUIProviderRailPreferences } from "./useAgentGUIProviderRailPreferences.ts";

export function useAgentTargetSetupRoot(input: {
  activeConversationId: string | null;
  agentTargets: readonly AgentGUIAgentTarget[];
  environmentProvider: string | null | undefined;
  selectedAgentTarget: AgentGUIAgentTarget;
}): {
  controller: AgentTargetSetupController;
  environmentSetupVisible: boolean;
  homeTargetProjection: AgentGUIManagedHomeTargetProjection;
  openAgentEnvSetup: () => void;
} {
  const { preferences } = useAgentGUIProviderRailPreferences();
  const homeTargetProjection = useMemo(
    () =>
      projectAgentGUIManagedHomeTargets({
        agentTargets: input.agentTargets,
        preferences,
        selectedAgentTarget: input.selectedAgentTarget
      }),
    [input.agentTargets, input.selectedAgentTarget, preferences]
  );
  const effectiveSelectedTarget =
    input.activeConversationId === null
      ? (homeTargetProjection.selectedAgentTarget ?? input.selectedAgentTarget)
      : input.selectedAgentTarget;
  const controller = useCreateAgentTargetSetupController(
    effectiveSelectedTarget
  );
  const targetRuntimeSetupVisible =
    effectiveSelectedTarget.ref.setupKind === "target_runtime";
  const environmentSetupVisible =
    targetRuntimeSetupVisible ||
    !!resolveAgentGUIProviderCatalogIdentity(input.environmentProvider ?? "");
  const openAgentEnvSetup = useCallback(() => {
    if (targetRuntimeSetupVisible) {
      controller.setDialogOpen(true);
      return;
    }
    openAgentEnvPanel({ provider: input.environmentProvider, focus: null });
  }, [controller, input.environmentProvider, targetRuntimeSetupVisible]);
  return {
    controller,
    environmentSetupVisible,
    homeTargetProjection,
    openAgentEnvSetup
  };
}

export function AgentTargetSetupRoot({
  children,
  controller
}: {
  children: ReactNode;
  controller: AgentTargetSetupController;
}): React.JSX.Element {
  return (
    <AgentTargetSetupControllerProvider controller={controller}>
      {children}
      <AgentTargetSetupGate
        carouselMountedExternally={false}
        dialogOwner
        gateVisible={false}
      />
    </AgentTargetSetupControllerProvider>
  );
}
