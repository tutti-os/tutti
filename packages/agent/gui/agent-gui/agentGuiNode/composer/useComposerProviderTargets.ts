import { useMemo } from "react";
import { cn } from "../../../app/renderer/lib/utils";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import styles from "../AgentGUINode.styles";
import type { AgentGUIAgentTarget } from "../../../types";
import { reportAgentComposerDiagnostic } from "./agentComposerDiagnostics";

interface Input {
  workspaceId: string;
  agentActivityRuntime?: AgentActivityRuntime | null;
  layoutMode: "dock" | "hero";
  provider: string;
  agentTargets: readonly AgentGUIAgentTarget[];
  handoffAgentTargets?: readonly AgentGUIAgentTarget[];
  selectedAgentTarget: AgentGUIAgentTarget | null;
  providerSelectReadonly: boolean;
  composerControlsHardDisabled: boolean;
  isSelectedProjectMissing: boolean;
  disabled: boolean;
  canQueueWhileBusy: boolean;
  onHandoffConversation?: (target: AgentGUIAgentTarget) => void;
  handoffLabel?: string;
  handoffMenuLabel?: string;
  defaultHandoffLabel: string;
  defaultHandoffMenuLabel: string;
}

export function useComposerProviderTargets(input: Input) {
  const {
    workspaceId,
    agentActivityRuntime,
    layoutMode,
    provider,
    agentTargets,
    handoffAgentTargets,
    selectedAgentTarget,
    providerSelectReadonly,
    composerControlsHardDisabled,
    isSelectedProjectMissing,
    disabled,
    canQueueWhileBusy,
    onHandoffConversation,
    handoffLabel,
    handoffMenuLabel
  } = input;
  const labels = {
    handoffConversation: input.defaultHandoffLabel,
    handoffConversationMenu: input.defaultHandoffMenuLabel
  };
  const isHeroLayout = layoutMode === "hero";
  const composerClassName = isHeroLayout
    ? styles.composerHero
    : styles.composer;
  const providerSwitchTargets = useMemo(
    () => agentTargets.filter(Boolean),
    [agentTargets]
  );
  const selectedAgentTargetId =
    selectedAgentTarget?.targetId ?? `local:${provider}`;
  const selectedProviderSwitchTarget =
    providerSwitchTargets.find(
      (target) => target.targetId === selectedAgentTargetId
    ) ??
    providerSwitchTargets.find((target) => target.provider === provider) ??
    selectedAgentTarget;
  const providerMenuTargets =
    selectedProviderSwitchTarget &&
    !providerSwitchTargets.some(
      (target) => target.targetId === selectedProviderSwitchTarget.targetId
    )
      ? [selectedProviderSwitchTarget, ...providerSwitchTargets]
      : providerSwitchTargets;
  const enabledHandoffProviderTargets = useMemo(
    () =>
      (handoffAgentTargets ?? providerMenuTargets).filter(
        (target) => target.disabled !== true
      ),
    [handoffAgentTargets, providerMenuTargets]
  );
  const handoffMenuTargets = selectedProviderSwitchTarget
    ? enabledHandoffProviderTargets.filter((target) => {
        if (target.targetId === selectedProviderSwitchTarget.targetId) {
          return false;
        }
        const selectedAgentTargetId =
          selectedProviderSwitchTarget.agentTargetId ??
          selectedProviderSwitchTarget.targetId;
        const targetAgentTargetId = target.agentTargetId ?? target.targetId;
        return targetAgentTargetId !== selectedAgentTargetId;
      })
    : enabledHandoffProviderTargets;
  const selectedProviderLabel =
    selectedProviderSwitchTarget?.label ??
    selectedAgentTarget?.label ??
    provider;
  const effectiveHandoffLabel = handoffLabel || labels.handoffConversation;
  const effectiveHandoffMenuLabel =
    handoffMenuLabel || labels.handoffConversationMenu;
  const inputShellClassName = cn(
    styles.composerInputShell,
    isHeroLayout && styles.composerInputShellHero
  );
  const inputDisabled =
    isSelectedProjectMissing || (disabled && !canQueueWhileBusy);
  const providerSelectDisabled =
    providerSelectReadonly || composerControlsHardDisabled || inputDisabled;
  const handoffDisabled = resolveComposerHandoffDisabled({
    composerControlsHardDisabled,
    hasHandoffConversation: onHandoffConversation !== undefined
  });
  const showProviderSelect =
    !isHeroLayout &&
    selectedProviderSwitchTarget !== null &&
    providerMenuTargets.length > 0;
  const showHandoffSelect = showProviderSelect && providerSelectReadonly;

  useMemo(() => {
    reportAgentComposerDiagnostic(agentActivityRuntime ?? null, {
      event: "agent.gui.composer.handoff.state",
      level: "debug",
      workspaceId,
      details: {
        composerControlsHardDisabled,
        hasHandoffConversation: onHandoffConversation !== undefined,
        inputDisabled,
        providerTargetCount: providerMenuTargets.length,
        providerTargetIds: providerMenuTargets.map((target) => target.targetId),
        handoffTargetCount: handoffMenuTargets.length,
        handoffTargetIds: handoffMenuTargets.map((target) => target.targetId),
        selectedTargetId: selectedProviderSwitchTarget?.targetId ?? null,
        showProviderSelect,
        showHandoffSelect,
        handoffDisabled
      }
    });
  }, [
    agentActivityRuntime,
    composerControlsHardDisabled,
    handoffDisabled,
    handoffMenuTargets,
    inputDisabled,
    onHandoffConversation,
    providerMenuTargets,
    selectedProviderSwitchTarget,
    showHandoffSelect,
    showProviderSelect,
    workspaceId
  ]);

  return {
    composerClassName,
    effectiveHandoffLabel,
    effectiveHandoffMenuLabel,
    handoffDisabled,
    handoffMenuTargets,
    inputDisabled,
    inputShellClassName,
    isHeroLayout,
    providerMenuTargets,
    providerSelectDisabled,
    selectedProviderLabel,
    selectedProviderSwitchTarget,
    showHandoffSelect,
    showProviderSelect
  };
}

export function resolveComposerHandoffDisabled(input: {
  composerControlsHardDisabled: boolean;
  hasHandoffConversation: boolean;
}): boolean {
  return input.composerControlsHardDisabled || !input.hasHandoffConversation;
}
