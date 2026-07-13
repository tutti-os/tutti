import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  agentGUIAgentTargetRefsEqual,
  normalizeAgentGUIAgentTargets,
  resolveAgentGUIAgentTarget
} from "../../../agentTargets";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIProviderRailMode,
  AgentGUIProviderReadinessGate,
  AgentGUIAgentTarget
} from "../../../types";
import {
  composerTargetDataFromNodeData,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";
import {
  applyComingSoonProviderTargets,
  emptyComingSoonProviders
} from "./agentGuiController.draftMessageHelpers";
import {
  agentGUINodeDataHasComposerTarget,
  agentGUIProviderTargetsEqual,
  composerTargetDataFromProviderTarget
} from "./agentGuiController.providerHelpers";

interface UseAgentGUIProviderCatalogSelectionInput {
  comingSoonProviders: readonly AgentGUIProvider[] | undefined;
  data: AgentGUINodeData;
  defaultAgentTargetId: string | null | undefined;
  providerRailMode: AgentGUIProviderRailMode | undefined;
  providerReadinessGates:
    | Partial<Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>>
    | null
    | undefined;
  agentTargets: readonly AgentGUIAgentTarget[] | undefined;
  agentTargetsLoading: boolean | undefined;
}

export function useAgentGUIProviderCatalogSelection(
  input: UseAgentGUIProviderCatalogSelectionInput
): {
  effectiveSelectedProviderTarget: AgentGUIAgentTarget;
  firstReadyHomeComposerProviderTarget: AgentGUIAgentTarget | null;
  handoffAgentTargets: readonly AgentGUIAgentTarget[];
  homeComposerTargetOverride: AgentGUIAgentTarget | null;
  homeComposerTargetOverrideIsExplicit: boolean;
  normalizedComingSoonProviders: readonly AgentGUIProvider[];
  normalizedExplicitProviderTargets: readonly AgentGUIAgentTarget[];
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  selectedComposerTargetData: AgentGUIComposerTargetData;
  selectedAgentTarget: AgentGUIAgentTarget;
  selectedAgentTargetIsExplicit: boolean;
  setHomeComposerTargetOverride: Dispatch<
    SetStateAction<AgentGUIAgentTarget | null>
  >;
  shouldUseStaticProviderTargets: boolean;
} {
  const {
    comingSoonProviders,
    data,
    defaultAgentTargetId,
    providerRailMode,
    providerReadinessGates,
    agentTargets,
    agentTargetsLoading
  } = input;
  const normalizedComingSoonProviders = useMemo(
    () =>
      comingSoonProviders && comingSoonProviders.length > 0
        ? ([...comingSoonProviders] as readonly AgentGUIProvider[])
        : emptyComingSoonProviders,
    [comingSoonProviders]
  );
  const isExactProviderRailMode = providerRailMode === "exact";
  const normalizedExplicitProviderTargets = useMemo(() => {
    const normalized = normalizeAgentGUIAgentTargets(agentTargets, {
      includeDisabledPlaceholders: !isExactProviderRailMode,
      useStaticCatalog: false
    });
    return isExactProviderRailMode
      ? normalized
      : applyComingSoonProviderTargets(
          normalized,
          normalizedComingSoonProviders
        );
  }, [isExactProviderRailMode, normalizedComingSoonProviders, agentTargets]);
  const normalizedProviderTargets = useMemo(() => {
    if (agentTargetsLoading) return [];
    if (
      !isExactProviderRailMode &&
      (agentTargets === undefined ||
        normalizedExplicitProviderTargets.length === 0)
    ) {
      return applyComingSoonProviderTargets(
        normalizeAgentGUIAgentTargets(null, {
          includeDisabledPlaceholders: true
        }),
        normalizedComingSoonProviders
      );
    }
    return normalizedExplicitProviderTargets;
  }, [
    isExactProviderRailMode,
    normalizedComingSoonProviders,
    normalizedExplicitProviderTargets,
    agentTargets,
    agentTargetsLoading
  ]);
  const shouldUseStaticProviderTargets =
    !isExactProviderRailMode &&
    !agentTargetsLoading &&
    (agentTargets === undefined ||
      normalizedExplicitProviderTargets.length === 0);
  const handoffAgentTargets = useMemo(
    () =>
      agentTargetsLoading
        ? []
        : normalizedExplicitProviderTargets.filter(
            (target) => target.disabled !== true
          ),
    [normalizedExplicitProviderTargets, agentTargetsLoading]
  );
  const selectedAgentTarget = useMemo(
    () =>
      resolveAgentGUIAgentTarget({
        agentTargetId: data.agentTargetId,
        defaultAgentTargetId,
        provider: data.provider,
        agentTargets: normalizedProviderTargets,
        useStaticCatalog: shouldUseStaticProviderTargets
      }) ?? {
        targetId: data.agentTargetId ?? "__loading__",
        provider: data.provider,
        ref: { kind: "loading", provider: data.provider },
        label: data.provider,
        disabled: true
      },
    [
      data.agentTargetId,
      data.provider,
      defaultAgentTargetId,
      normalizedProviderTargets,
      shouldUseStaticProviderTargets
    ]
  );
  const selectedAgentTargetIsExplicit = useMemo(
    () =>
      normalizedExplicitProviderTargets.some(
        (target) =>
          target.provider === selectedAgentTarget.provider &&
          target.targetId === selectedAgentTarget.targetId &&
          agentGUIAgentTargetRefsEqual(target.ref, selectedAgentTarget.ref)
      ),
    [normalizedExplicitProviderTargets, selectedAgentTarget]
  );
  const [homeComposerTargetOverride, setHomeComposerTargetOverride] =
    useState<AgentGUIAgentTarget | null>(null);
  const homeComposerTargetOverrideIsExplicit = useMemo(
    () =>
      homeComposerTargetOverride
        ? normalizedExplicitProviderTargets.some(
            (target) =>
              target.provider === homeComposerTargetOverride.provider &&
              target.targetId === homeComposerTargetOverride.targetId &&
              agentGUIAgentTargetRefsEqual(
                target.ref,
                homeComposerTargetOverride.ref
              )
          )
        : false,
    [homeComposerTargetOverride, normalizedExplicitProviderTargets]
  );
  const effectiveSelectedProviderTarget =
    homeComposerTargetOverride ?? selectedAgentTarget;
  const firstReadyHomeComposerProviderTarget = useMemo(
    () =>
      providerReadinessGates
        ? (normalizedProviderTargets.find(
            (target) =>
              target.disabled !== true &&
              providerReadinessGates[target.provider] === null
          ) ?? null)
        : null,
    [normalizedProviderTargets, providerReadinessGates]
  );
  const nodeComposerTargetResolvedByProviderTarget =
    agentGUINodeDataHasComposerTarget(data) &&
    normalizeOptionalText(data.agentTargetId) !== null &&
    selectedAgentTarget.agentTargetId ===
      normalizeOptionalText(data.agentTargetId);
  const selectedComposerTargetData = useMemo(
    () =>
      homeComposerTargetOverride
        ? composerTargetDataFromProviderTarget({
            current: data,
            isExplicit: homeComposerTargetOverrideIsExplicit,
            target: homeComposerTargetOverride
          })
        : nodeComposerTargetResolvedByProviderTarget
          ? composerTargetDataFromProviderTarget({
              current: data,
              isExplicit: selectedAgentTargetIsExplicit,
              target: selectedAgentTarget
            })
          : agentGUINodeDataHasComposerTarget(data)
            ? composerTargetDataFromNodeData(data)
            : composerTargetDataFromProviderTarget({
                current: data,
                isExplicit: selectedAgentTargetIsExplicit,
                target: selectedAgentTarget
              }),
    [
      data,
      homeComposerTargetOverride,
      homeComposerTargetOverrideIsExplicit,
      nodeComposerTargetResolvedByProviderTarget,
      selectedAgentTarget,
      selectedAgentTargetIsExplicit
    ]
  );

  useEffect(() => {
    if (
      homeComposerTargetOverride &&
      agentGUIProviderTargetsEqual(
        homeComposerTargetOverride,
        selectedAgentTarget
      )
    ) {
      setHomeComposerTargetOverride(null);
    }
  }, [homeComposerTargetOverride, selectedAgentTarget]);

  return {
    effectiveSelectedProviderTarget,
    firstReadyHomeComposerProviderTarget,
    handoffAgentTargets,
    homeComposerTargetOverride,
    homeComposerTargetOverrideIsExplicit,
    normalizedComingSoonProviders,
    normalizedExplicitProviderTargets,
    normalizedProviderTargets,
    selectedComposerTargetData,
    selectedAgentTarget,
    selectedAgentTargetIsExplicit,
    setHomeComposerTargetOverride,
    shouldUseStaticProviderTargets
  };
}
