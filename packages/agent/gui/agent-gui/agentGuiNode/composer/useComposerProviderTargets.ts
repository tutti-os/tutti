import { useMemo } from "react";
import { cn } from "../../../app/renderer/lib/utils";
import styles from "../AgentGUINode.styles";
import type { AgentGUIAgentTarget } from "../../../types";

interface Input {
  layoutMode: "dock" | "hero";
  previewMode: boolean;
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
    layoutMode,
    previewMode,
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
    hasHandoffConversation: onHandoffConversation !== undefined,
    handoffMenuTargetCount: handoffMenuTargets.length
  });
  const showProviderSelect =
    !isHeroLayout &&
    selectedProviderSwitchTarget !== null &&
    providerMenuTargets.length > 0;
  const showHandoffSelect =
    showProviderSelect && providerSelectReadonly && !previewMode;

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
  handoffMenuTargetCount: number;
}): boolean {
  return (
    input.composerControlsHardDisabled ||
    !input.hasHandoffConversation ||
    input.handoffMenuTargetCount === 0
  );
}
