import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction
} from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
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
  matchesAgentGUIConversationSummaryFilter,
  normalizeAgentGUIConversationFilter,
  type AgentGUIConversationFilter
} from "../model/agentGuiConversationFilter";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { type AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import { mergeVisibleConversations } from "./agentGuiController.conversationHelpers";
import {
  agentGUINodeDataHasComposerTarget,
  composerTargetDataFromProviderTarget
} from "./agentGuiController.providerHelpers";
import { reportAgentGUIConversationFilterTargetUnresolved } from "./agentGuiController.reporting";
import {
  resolveConversationSummaryById,
  type ConversationIntent
} from "./useAgentConversationSelection";

interface CurrentValue<T> {
  current: T;
}

interface UseAgentGUIProviderHomeInput {
  activeConversationId: string | null;
  activeConversationIdRef: CurrentValue<string | null>;
  agentActivityRuntime: AgentActivityRuntime;
  conversationFilter: AgentGUIConversationFilter;
  conversationFilterRef: CurrentValue<AgentGUIConversationFilter>;
  conversationListInitialized: boolean;
  conversations: readonly AgentGUIConversationSummary[];
  conversationsRef: CurrentValue<readonly AgentGUIConversationSummary[]>;
  data: AgentGUINodeData;
  dataRef: CurrentValue<AgentGUINodeData>;
  defaultAgentTargetId: string | null;
  effectiveSelectedProviderTarget: AgentGUIAgentTarget;
  firstReadyHomeComposerProviderTarget: AgentGUIAgentTarget | null;
  homeComposerTargetOverride: AgentGUIAgentTarget | null;
  isComposerHomeRef: CurrentValue<boolean>;
  isLoadingConversations: boolean;
  loadComposerOptionsForTarget(
    targetData: AgentGUIComposerTargetData,
    options?: { force?: boolean }
  ): void;
  normalizedExplicitProviderTargets: readonly AgentGUIAgentTarget[];
  normalizedProviderTargets: readonly AgentGUIAgentTarget[];
  onDataChangeRef: CurrentValue<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  persistActiveConversation(agentSessionId: string | null): void;
  previewMode: boolean;
  providerReadinessGates: Partial<
    Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>
  > | null;
  agentTargetsLoading: boolean;
  selectedComposerTargetDataRef: CurrentValue<AgentGUIComposerTargetData>;
  selectConversation(
    agentSessionId: string,
    options?: { reloadConversations?: boolean }
  ): void;
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
    if (currentInput.previewMode) return;
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
    if (nextTarget.disabled !== true) {
      currentInput.loadComposerOptionsForTarget(nextTargetData, {
        force: true
      });
    }
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
      if (currentInput.previewMode) return;
      const nextTarget = resolveAgentGUIAgentTarget({
        agentTargetId: selection.agentTargetId,
        defaultAgentTargetId: currentInput.defaultAgentTargetId,
        provider: selection.provider,
        agentTargets: currentInput.normalizedProviderTargets,
        useStaticCatalog: currentInput.shouldUseStaticProviderTargets
      });
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
      if (previous) void currentInput.unactivate(previous);
      currentInput.setIntent({ tag: "home" });
      currentInput.isComposerHomeRef.current = true;
      currentInput.setIsComposerHome(true);
      currentInput.activeConversationIdRef.current = null;
      currentInput.setActiveConversationId(null);
      currentInput.setIsLoadingMessages(false);
      currentInput.setDetailError(null);
      currentInput.persistActiveConversation(null);
      currentInput.onDataChangeRef.current((current) => {
        const currentNextTargetData = composerTargetDataFromProviderTarget({
          current,
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
          ...current,
          provider: currentNextTargetData.provider,
          agentTargetId: currentNextTargetData.agentTargetId,
          lastActiveAgentSessionId: null,
          composerOverrides: providerTargetChanged
            ? null
            : current.composerOverrides
        };
        currentInput.dataRef.current = nextData;
        return nextData;
      });
      if (nextTarget.disabled !== true) {
        currentInput.loadComposerOptionsForTarget(nextTargetData, {
          force: true
        });
      }
    },
    []
  );

  useEffect(() => {
    if (
      input.previewMode ||
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
    input.conversationFilter.kind,
    input.data,
    input.effectiveSelectedProviderTarget,
    input.firstReadyHomeComposerProviderTarget,
    input.homeComposerTargetOverride,
    input.previewMode,
    input.providerReadinessGates,
    selectHomeComposerAgentTarget
  ]);

  const selectConversationFilterTarget = useCallback(
    (selection: {
      provider: AgentGUIProvider;
      agentTargetId?: string | null;
    }) => {
      const current = inputRef.current;
      const nextTarget = resolveAgentGUIAgentTarget({
        agentTargetId: selection.agentTargetId,
        defaultAgentTargetId: current.defaultAgentTargetId,
        provider: selection.provider,
        agentTargets: current.normalizedProviderTargets,
        useStaticCatalog: current.shouldUseStaticProviderTargets
      });
      if (!nextTarget) {
        reportAgentGUIConversationFilterTargetUnresolved({
          provider: selection.provider,
          agentTargetId: selection.agentTargetId ?? null,
          providerTargetCount: current.normalizedProviderTargets.length,
          reason: "unresolved",
          runtime: current.agentActivityRuntime,
          workspaceId: current.workspaceId
        });
        return;
      }
      const agentTargetId = nextTarget.agentTargetId?.trim() ?? "";
      const nextFilter = agentTargetId
        ? { kind: "agentTarget" as const, agentTargetId }
        : { kind: "all" as const };
      const previousFilter = current.conversationFilterRef.current;
      const isSameFilterTarget =
        nextFilter.kind === "agentTarget"
          ? previousFilter.kind === "agentTarget" &&
            previousFilter.agentTargetId === nextFilter.agentTargetId
          : previousFilter.kind === "all";
      current.setConversationFilter(nextFilter);
      const activeId = current.activeConversationIdRef.current;
      if (activeId) {
        const activeSummary = resolveConversationSummaryById(
          current.conversationsRef.current,
          activeId,
          current.transientConversation
        );
        if (
          activeSummary &&
          matchesAgentGUIConversationSummaryFilter(activeSummary, nextFilter)
        ) {
          return;
        }
      } else if (isSameFilterTarget) {
        selectHomeComposerAgentTarget(selection);
        return;
      }
      const recentConversation = agentTargetId
        ? mergeVisibleConversations(
            current.conversationsRef.current,
            current.transientConversation
          ).find((conversation) =>
            matchesAgentGUIConversationSummaryFilter(conversation, nextFilter)
          )
        : null;
      if (recentConversation) {
        current.selectConversation(recentConversation.id, {
          reloadConversations: false
        });
        return;
      }
      selectHomeComposerAgentTarget(selection);
    },
    [selectHomeComposerAgentTarget]
  );

  useEffect(() => {
    if (
      input.previewMode ||
      input.agentTargetsLoading ||
      input.activeConversationId === null ||
      input.conversationFilter.kind !== "agentTarget" ||
      input.isLoadingConversations ||
      !input.conversationListInitialized
    ) {
      return;
    }
    if (
      input.conversations.some((conversation) =>
        matchesAgentGUIConversationSummaryFilter(
          conversation,
          input.conversationFilter
        )
      )
    ) {
      return;
    }
    const filterAgentTargetId = input.conversationFilter.agentTargetId;
    const target = input.normalizedProviderTargets.find(
      (candidate) =>
        (candidate.agentTargetId?.trim() ?? "") === filterAgentTargetId
    );
    if (!target) return;
    selectHomeComposerAgentTarget({
      provider: target.provider,
      agentTargetId: target.targetId
    });
  }, [
    input.activeConversationId,
    input.conversationFilter,
    input.conversationListInitialized,
    input.conversations,
    input.isLoadingConversations,
    input.normalizedProviderTargets,
    input.previewMode,
    input.agentTargetsLoading,
    selectHomeComposerAgentTarget
  ]);

  return {
    resetHomeComposerAgentTargetToDefault,
    selectConversationFilterTarget,
    selectHomeComposerAgentTarget,
    updateConversationFilter
  };
}
