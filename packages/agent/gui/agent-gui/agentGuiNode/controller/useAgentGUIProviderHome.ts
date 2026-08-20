import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction
} from "react";
import type { AgentGUIRuntime } from "../../../agentActivityRuntime";
import {
  selectEngineSession,
  selectEngineSessionDeleted,
  type AgentSessionEngine,
  type PendingActivationIntentRecord
} from "@tutti-os/agent-activity-core";
import {
  agentGUIAgentTargetRefsEqual,
  resolveAgentGUIAgentTarget
} from "../../../agentTargets";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIProviderReadinessGate,
  AgentGUIAgentTarget
} from "../../../types";
import {
  normalizeAgentGUIConversationFilter,
  type AgentGUIConversationFilter
} from "../model/agentGuiConversationFilter";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import {
  forgetAgentGUISessionMemories,
  rememberAgentGUIActiveConversation,
  resolveAgentGUIRememberedSessionSelection,
  resolveAgentGUISessionMemoryTarget
} from "../model/agentGuiSessionNavigationMemory";
import { type AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import {
  agentGUINodeDataHasComposerTarget,
  composerTargetDataFromProviderTarget,
  resolveAgentGUIProviderRailTargetSelection
} from "./agentGuiController.providerHelpers";
import { reportAgentGUIConversationFilterTargetUnresolved } from "./agentGuiController.reporting";
import type {
  AgentGUIOpenSessionRequest,
  AgentGUIOpenSessionSelectionOutcome
} from "./agentGuiController.draftMessageHelpers";
import { isPendingNewConversationActivationForSession } from "./useAgentGUIActivation";
import {
  resolveConversationSummaryById,
  type AgentGUIConversationSelectionOptions,
  type ConversationIntent
} from "./useAgentConversationSelection";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUIProviderHomeInput {
  activeConversationId: string | null;
  activeConversationIdRef: CurrentValue<string | null>;
  activePendingActivation: PendingActivationIntentRecord | null;
  agentActivityRuntime: AgentGUIRuntime;
  clearRailRevealRequest(): void;
  conversationFilter: AgentGUIConversationFilter;
  conversationFilterRef: CurrentValue<AgentGUIConversationFilter>;
  conversationsRef: CurrentValue<readonly AgentGUIConversationSummary[]>;
  data: AgentGUINodeData;
  dataRef: CurrentValue<AgentGUINodeData>;
  defaultAgentTargetId: string | null;
  effectiveSelectedProviderTarget: AgentGUIAgentTarget;
  firstReadyHomeComposerProviderTarget: AgentGUIAgentTarget | null;
  homeComposerTargetOverride: AgentGUIAgentTarget | null;
  isComposerHomeRef: CurrentValue<boolean>;
  isLoadingConversations: boolean;
  normalizedExplicitProviderTargets: readonly AgentGUIAgentTarget[];
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  onDataChangeRef: CurrentValue<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  persistActiveConversation(agentSessionId: string | null): void;
  providerReadinessGates: Partial<
    Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>
  > | null;
  selectedComposerTargetDataRef: CurrentValue<AgentGUIComposerTargetData>;
  selectConversation(
    agentSessionId: string,
    options?: AgentGUIConversationSelectionOptions
  ): void;
  sessionEngine: AgentSessionEngine;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setConversationFilter: Dispatch<SetStateAction<AgentGUIConversationFilter>>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setHomeComposerTargetOverride: Dispatch<
    SetStateAction<AgentGUIAgentTarget | null>
  >;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setIsComposerHome: Dispatch<SetStateAction<boolean>>;
  setIsLoadingMessages: Dispatch<SetStateAction<boolean>>;
  shouldUseStaticProviderTargets: boolean;
  transientConversation: AgentGUIConversationSummary | null;
  unactivate(agentSessionId: string): Promise<void>;
  workspaceId: string;
}

export function useAgentGUIProviderHome(input: UseAgentGUIProviderHomeInput) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const resolveDefaultHomeComposerTarget = useCallback(() => {
    const current = inputRef.current;
    const defaultTargetId = current.defaultAgentTargetId?.trim() ?? "";
    const explicitDefaultTarget = defaultTargetId
      ? (current.normalizedProviderTargets.find(
          (target) =>
            target.targetId === defaultTargetId ||
            target.agentTargetId === defaultTargetId
        ) ?? null)
      : null;
    return (
      explicitDefaultTarget ??
      current.normalizedProviderTargets.find(
        (target) => target.disabled !== true
      ) ??
      current.normalizedProviderTargets[0] ??
      null
    );
  }, []);

  const resetHomeComposerAgentTargetToDefault = useCallback(() => {
    const currentInput = inputRef.current;

    const nextTarget = resolveDefaultHomeComposerTarget();
    if (!nextTarget) return;
    const nextTargetIsExplicit =
      currentInput.normalizedExplicitProviderTargets.some(
        (target) =>
          target.provider === nextTarget.provider &&
          target.targetId === nextTarget.targetId &&
          agentGUIAgentTargetRefsEqual(target.ref, nextTarget.ref)
      );
    const nextTargetData = composerTargetDataFromProviderTarget({
      current: currentInput.dataRef.current,
      isExplicit: nextTargetIsExplicit,
      target: nextTarget
    });
    currentInput.setHomeComposerTargetOverride(nextTarget);
    currentInput.setIntent({ tag: "home" });
    currentInput.isComposerHomeRef.current = true;
    currentInput.setIsComposerHome(true);
    currentInput.onDataChangeRef.current((current) => {
      const currentNextTargetData = composerTargetDataFromProviderTarget({
        current,
        isExplicit: nextTargetIsExplicit,
        target: nextTarget
      });
      const nextData = {
        ...currentNextTargetData.data,
        lastActiveAgentSessionId: null
      };
      currentInput.dataRef.current = nextData;
      return nextData;
    });
    currentInput.dataRef.current = {
      ...nextTargetData.data,
      lastActiveAgentSessionId: null
    };
  }, [resolveDefaultHomeComposerTarget]);

  const updateConversationFilter = useCallback(
    (filter: AgentGUIConversationFilter) => {
      const current = inputRef.current;
      const nextFilter = normalizeAgentGUIConversationFilter(filter);
      current.setConversationFilter(nextFilter);
      if (
        nextFilter.kind === "all" &&
        current.activeConversationIdRef.current === null
      ) {
        resetHomeComposerAgentTargetToDefault();
      }
    },
    [resetHomeComposerAgentTargetToDefault]
  );

  const selectHomeComposerAgentTarget = useCallback(
    (selection: {
      provider: AgentGUIProvider;
      agentTargetId?: string | null;
    }) => {
      const currentInput = inputRef.current;

      const nextTarget = resolveAgentGUIAgentTarget({
        agentTargetId: selection.agentTargetId,
        defaultAgentTargetId: currentInput.defaultAgentTargetId,
        provider: selection.provider,
        agentTargets: currentInput.normalizedProviderTargets,
        useStaticCatalog: currentInput.shouldUseStaticProviderTargets
      });
      if (!nextTarget) return;
      currentInput.clearRailRevealRequest();
      const nextTargetIsExplicit =
        currentInput.normalizedExplicitProviderTargets.some(
          (target) =>
            target.provider === nextTarget.provider &&
            target.targetId === nextTarget.targetId &&
            agentGUIAgentTargetRefsEqual(target.ref, nextTarget.ref)
        );
      const shouldSyncScopedRailFilter =
        currentInput.conversationFilterRef.current.kind === "agentTarget";
      currentInput.setHomeComposerTargetOverride(nextTarget);
      if (shouldSyncScopedRailFilter) {
        const nextAgentTargetId = nextTarget.agentTargetId?.trim() ?? "";
        currentInput.setConversationFilter(
          nextAgentTargetId
            ? { kind: "agentTarget", agentTargetId: nextAgentTargetId }
            : { kind: "all" }
        );
      }
      const previous = currentInput.activeConversationIdRef.current;
      const previousSummary = resolveConversationSummaryById(
        currentInput.conversationsRef.current,
        previous,
        currentInput.transientConversation
      );
      const previousAgentTargetId = resolveAgentGUISessionMemoryTarget({
        agentSessionId: previous,
        canonicalAgentTargetId: previous
          ? selectEngineSession(
              currentInput.sessionEngine.getSnapshot(),
              previous
            )?.agentTargetId
          : null,
        pendingActivation: currentInput.activePendingActivation,
        projectedAgentTargetId: previousSummary?.agentTargetId
      });
      if (
        previous &&
        !isPendingNewConversationActivationForSession(
          currentInput.activePendingActivation,
          previous
        )
      ) {
        void currentInput.unactivate(previous);
      }
      currentInput.setIntent({ tag: "home" });
      currentInput.isComposerHomeRef.current = true;
      currentInput.setIsComposerHome(true);
      currentInput.activeConversationIdRef.current = null;
      currentInput.setActiveConversationId(null);
      currentInput.setIsLoadingMessages(false);
      currentInput.setDetailError(null);
      currentInput.persistActiveConversation(null);
      currentInput.onDataChangeRef.current((current) => {
        const rememberedCurrent = previous
          ? rememberAgentGUIActiveConversation(
              current,
              previous,
              previousAgentTargetId
            )
          : current;
        const currentNextTargetData = composerTargetDataFromProviderTarget({
          current: rememberedCurrent,
          isExplicit: nextTargetIsExplicit,
          target: nextTarget
        });
        const nextAgentTargetId = currentNextTargetData.agentTargetId;
        const currentTargetId = current.agentTargetId ?? null;
        const nextTargetId = nextAgentTargetId ?? nextTarget.targetId;
        const providerTargetChanged =
          current.provider !== selection.provider ||
          ((currentTargetId !== null || nextAgentTargetId !== null) &&
            currentTargetId !== nextTargetId);
        const nextData: AgentGUINodeData = {
          ...rememberedCurrent,
          provider: currentNextTargetData.provider,
          agentTargetId: currentNextTargetData.agentTargetId,
          lastActiveAgentSessionId: null,
          composerOverrides: providerTargetChanged
            ? null
            : rememberedCurrent.composerOverrides
        };
        currentInput.dataRef.current = nextData;
        return nextData;
      });
    },
    []
  );

  const openExternalSession = useCallback(
    (
      request: AgentGUIOpenSessionRequest
    ): AgentGUIOpenSessionSelectionOutcome => {
      const current = inputRef.current;
      const agentSessionId = request.agentSessionId.trim();
      const hasAgentTargetId = Object.prototype.hasOwnProperty.call(
        request,
        "agentTargetId"
      );
      const agentTargetId = request.agentTargetId?.trim() || null;
      const requestedProvider =
        request.provider?.trim() || current.dataRef.current.provider;
      if (!agentSessionId || !hasAgentTargetId || !requestedProvider) {
        return "rejected";
      }

      const nextTarget = agentTargetId
        ? resolveAgentGUIAgentTarget({
            agentTargetId,
            defaultAgentTargetId: current.defaultAgentTargetId,
            provider: requestedProvider,
            agentTargets: current.normalizedProviderTargets,
            useStaticCatalog: current.shouldUseStaticProviderTargets
          })
        : null;
      const knownSummary = resolveConversationSummaryById(
        current.conversationsRef.current,
        agentSessionId,
        current.transientConversation
      );
      const knownSession = selectEngineSession(
        current.sessionEngine.getSnapshot(),
        agentSessionId
      );
      const knownAgentTargetId = knownSession
        ? knownSession.agentTargetId?.trim() || null
        : knownSummary
          ? knownSummary.agentTargetId?.trim() || null
          : undefined;
      const knownProvider =
        knownSession?.provider?.trim() || knownSummary?.provider?.trim() || "";
      if (
        (agentTargetId !== null && !nextTarget) ||
        (nextTarget && nextTarget.provider !== requestedProvider) ||
        (knownAgentTargetId !== undefined &&
          knownAgentTargetId !== agentTargetId) ||
        (knownProvider && knownProvider !== requestedProvider) ||
        (agentTargetId === null &&
          ((current.dataRef.current.agentTargetId?.trim() || null) !== null ||
            current.dataRef.current.provider !== requestedProvider))
      ) {
        reportAgentGUIConversationFilterTargetUnresolved({
          provider: requestedProvider,
          agentTargetId: agentTargetId ?? "",
          providerTargetCount: current.normalizedProviderTargets.length,
          reason: "unresolved",
          runtime: current.agentActivityRuntime,
          workspaceId: current.workspaceId
        });
        return "rejected";
      }

      if (agentTargetId === null) {
        if (current.conversationFilterRef.current.kind === "agentTarget") {
          current.setConversationFilter({ kind: "all" });
        }
        current.selectConversation(agentSessionId, {
          reloadConversations: false,
          reveal: "external-open"
        });
        return "selected";
      }
      if (!nextTarget) return "rejected";

      const currentAgentTargetId =
        current.dataRef.current.agentTargetId?.trim() ||
        current.effectiveSelectedProviderTarget.agentTargetId?.trim() ||
        "";
      const targetChanged =
        currentAgentTargetId !== agentTargetId ||
        current.dataRef.current.provider !== nextTarget.provider;
      if (targetChanged) {
        selectHomeComposerAgentTarget({
          provider: nextTarget.provider,
          agentTargetId
        });
      } else if (
        current.conversationFilterRef.current.kind === "agentTarget" &&
        current.conversationFilterRef.current.agentTargetId.trim() !==
          agentTargetId
      ) {
        current.setConversationFilter({
          kind: "agentTarget",
          agentTargetId
        });
      }
      current.selectConversation(agentSessionId, {
        reloadConversations: false,
        reveal: "external-open"
      });
      return "selected";
    },
    [selectHomeComposerAgentTarget]
  );

  useEffect(() => {
    const effectiveAgentTargetId =
      input.effectiveSelectedProviderTarget.agentTargetId?.trim() ?? "";
    if (
      input.activeConversationId === null &&
      input.conversationFilter.kind === "agentTarget" &&
      effectiveAgentTargetId &&
      effectiveAgentTargetId !== input.conversationFilter.agentTargetId.trim()
    ) {
      input.setConversationFilter({
        kind: "agentTarget",
        agentTargetId: effectiveAgentTargetId
      });
    }
    if (
      input.activeConversationId !== null ||
      input.conversationFilter.kind !== "all" ||
      input.homeComposerTargetOverride !== null ||
      agentGUINodeDataHasComposerTarget(input.data) ||
      !input.providerReadinessGates ||
      !input.firstReadyHomeComposerProviderTarget
    ) {
      return;
    }
    const readyTarget = input.firstReadyHomeComposerProviderTarget;
    if (
      readyTarget.provider === input.effectiveSelectedProviderTarget.provider &&
      readyTarget.targetId === input.effectiveSelectedProviderTarget.targetId &&
      agentGUIAgentTargetRefsEqual(
        readyTarget.ref,
        input.effectiveSelectedProviderTarget.ref
      )
    ) {
      return;
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        input.providerReadinessGates,
        input.effectiveSelectedProviderTarget.provider
      ) ||
      !input.providerReadinessGates[
        input.effectiveSelectedProviderTarget.provider
      ]
    ) {
      return;
    }
    selectHomeComposerAgentTarget({
      provider: readyTarget.provider,
      agentTargetId: readyTarget.targetId
    });
  }, [
    input.activeConversationId,
    input.conversationFilter,
    input.data,
    input.effectiveSelectedProviderTarget,
    input.firstReadyHomeComposerProviderTarget,
    input.homeComposerTargetOverride,
    input.providerReadinessGates,
    input.setConversationFilter,
    selectHomeComposerAgentTarget
  ]);

  const selectConversationFilterTarget = useCallback(
    (selection: { provider: AgentGUIProvider; agentTargetId: string }) => {
      const current = inputRef.current;
      const agentTargetId = selection.agentTargetId.trim();
      if (!agentTargetId) {
        reportAgentGUIConversationFilterTargetUnresolved({
          provider: selection.provider,
          agentTargetId: null,
          providerTargetCount: current.normalizedProviderTargets.length,
          reason: "unresolved",
          runtime: current.agentActivityRuntime,
          workspaceId: current.workspaceId
        });
        return;
      }
      const nextTarget = resolveAgentGUIAgentTarget({
        agentTargetId,
        defaultAgentTargetId: current.defaultAgentTargetId,
        provider: selection.provider,
        agentTargets: current.normalizedProviderTargets,
        useStaticCatalog: current.shouldUseStaticProviderTargets
      });
      if (!nextTarget) {
        reportAgentGUIConversationFilterTargetUnresolved({
          provider: selection.provider,
          agentTargetId,
          providerTargetCount: current.normalizedProviderTargets.length,
          reason: "unresolved",
          runtime: current.agentActivityRuntime,
          workspaceId: current.workspaceId
        });
        return;
      }
      current.clearRailRevealRequest();
      const nextFilter = { kind: "agentTarget" as const, agentTargetId };
      current.setConversationFilter(nextFilter);
      const activeId = current.activeConversationIdRef.current;
      const activeSummary = resolveConversationSummaryById(
        current.conversationsRef.current,
        activeId,
        current.transientConversation
      );
      if (
        resolveAgentGUIProviderRailTargetSelection({
          activeConversation: activeSummary,
          nextFilter
        }) === "keep-active-conversation"
      ) {
        return;
      }
      const rememberedAgentSessionId =
        agentTargetId &&
        current.dataRef.current.lastActiveAgentSessionIdByAgentTargetId?.[
          agentTargetId
        ];
      const rememberedSummary = resolveConversationSummaryById(
        current.conversationsRef.current,
        rememberedAgentSessionId,
        current.transientConversation
      );
      const rememberedEngineSession = selectEngineSession(
        current.sessionEngine.getSnapshot(),
        rememberedAgentSessionId
      );
      const rememberedSelection = resolveAgentGUIRememberedSessionSelection({
        data: current.dataRef.current,
        deleted: selectEngineSessionDeleted(
          current.sessionEngine.getSnapshot(),
          rememberedAgentSessionId
        ),
        knownAgentTargetId:
          rememberedEngineSession?.agentTargetId ??
          rememberedSummary?.agentTargetId ??
          null,
        targetAgentTargetId: agentTargetId || null
      });
      if (rememberedSelection.kind === "restore") {
        selectHomeComposerAgentTarget({
          provider: nextTarget.provider,
          agentTargetId
        });
        current.selectConversation(rememberedSelection.agentSessionId, {
          reloadConversations: false
        });
        return;
      }
      if (rememberedSelection.kind === "stale") {
        const staleIds = new Set([rememberedSelection.agentSessionId]);
        current.onDataChangeRef.current((data) =>
          forgetAgentGUISessionMemories(data, staleIds)
        );
        current.dataRef.current = forgetAgentGUISessionMemories(
          current.dataRef.current,
          staleIds
        );
      }
      selectHomeComposerAgentTarget({
        provider: nextTarget.provider,
        agentTargetId
      });
    },
    [selectHomeComposerAgentTarget]
  );

  return {
    openExternalSession,
    resetHomeComposerAgentTargetToDefault,
    selectConversationFilterTarget,
    selectHomeComposerAgentTarget,
    updateConversationFilter
  };
}
