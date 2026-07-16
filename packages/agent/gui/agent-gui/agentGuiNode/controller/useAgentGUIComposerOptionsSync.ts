import {
  type AgentActivityComposerOptions,
  selectLatestActivationForSession,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { subscribeCoalesced } from "../../../host/agentHostEventBus";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import {
  nodeDataFromComposerSettings,
  nodeDefaultDraftKey,
  readNodeDefaultDraftSettings
} from "./agentGuiController.composerHelpers";
import {
  composerTargetDataForConversation,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import {
  mergeAgentModelCatalogInvalidationEvents,
  mergeAgentModelConfigurationChangedEvents
} from "./agentGuiController.providerHelpers";

export function useAgentGUIComposerOptionsSync(input: {
  activeConversationId: string | null;
  activeConversationIdRef: RefObject<string | null>;
  agentActivityRuntime: AgentActivityRuntime;
  composerOptionsProjectKeyRef: RefObject<string | null>;
  composerTargetData: AgentGUIComposerTargetData;
  conversationFilter: unknown;
  currentUserId: string | null | undefined;
  data: AgentGUINodeData;
  dataRef: RefObject<AgentGUINodeData>;
  defaultReasoningEffort: AgentSessionReasoningEffort | null;
  draftSettingsBySessionIdRef: RefObject<
    Record<string, AgentSessionComposerSettings>
  >;
  setDraftSettingsBySessionId: Dispatch<
    SetStateAction<Record<string, AgentSessionComposerSettings>>
  >;
  isComposerHome: boolean;
  isComposerHomeRef: RefObject<boolean>;
  isCreatingConversation: boolean;
  loadDraftComposerOptionsRef: RefObject<() => void>;
  loadSessionState(agentSessionId: string, cause?: unknown): void;
  onDataChangeRef: RefObject<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  previewMode: boolean;
  providerComposerOptions: AgentActivityComposerOptions | null | undefined;
  reloadSelectedConversation(
    agentSessionId: string,
    options: { reloadConversations: boolean; reloadDetail: boolean }
  ): void;
  selectedComposerTargetDataRef: RefObject<AgentGUIComposerTargetData>;
  selectedProjectPath: string | null;
  selectedProjectPathRef: RefObject<string | null>;
  sessionEngine: AgentSessionEngine;
  syncConversationListProjection(agentSessionId?: string | null): Promise<void>;
  workspaceId: string;
  workspacePath: string;
}) {
  const previousActiveConversationIdRef = useRef(input.activeConversationId);
  const previousIsCreatingConversationRef = useRef(
    input.isCreatingConversation
  );
  const loadComposerOptionsForTarget = useCallback(
    (targetData: AgentGUIComposerTargetData, options?: { force?: boolean }) => {
      if (input.isCreatingConversation || !targetData.agentTargetId) return;
      const settings = readNodeDefaultDraftSettings({
        data: targetData.data,
        defaultReasoningEffort: input.defaultReasoningEffort,
        drafts: input.draftSettingsBySessionIdRef.current
      });
      const cwd =
        input.selectedProjectPathRef.current?.trim() ||
        input.workspacePath.trim() ||
        "";
      void Promise.resolve(
        input.agentActivityRuntime.getComposerOptions({
          workspaceId: input.workspaceId,
          cwd,
          force: options?.force,
          provider: targetData.provider,
          agentTargetId: targetData.agentTargetId,
          settings
        })
      ).catch(() => undefined);
    },
    [
      input.agentActivityRuntime,
      input.defaultReasoningEffort,
      input.isCreatingConversation,
      input.workspaceId,
      input.workspacePath
    ]
  );
  const loadDraftComposerOptions = useCallback(
    (options?: { force?: boolean }) => {
      loadComposerOptionsForTarget(
        composerTargetDataForConversation({
          activeConversationId: input.activeConversationIdRef.current,
          data: input.dataRef.current,
          optimisticTarget: null,
          selectedTarget: input.selectedComposerTargetDataRef.current
        }),
        options
      );
    },
    [
      input.activeConversationIdRef,
      input.dataRef,
      input.selectedComposerTargetDataRef,
      loadComposerOptionsForTarget
    ]
  );
  input.loadDraftComposerOptionsRef.current = loadDraftComposerOptions;

  useEffect(() => {
    if (input.previewMode) return;
    const projectKey = `${input.composerTargetData.agentTargetId ?? input.composerTargetData.provider}\0${input.selectedProjectPath ?? ""}`;
    const previous = input.composerOptionsProjectKeyRef.current;
    input.composerOptionsProjectKeyRef.current = projectKey;
    if (previous !== null && previous !== projectKey) {
      loadDraftComposerOptions({ force: true });
    }
  }, [
    input.composerTargetData.agentTargetId,
    input.composerTargetData.provider,
    input.previewMode,
    input.selectedProjectPath,
    loadDraftComposerOptions
  ]);

  useEffect(() => {
    if (input.previewMode) return undefined;
    const unsubscribeCatalog = subscribeCoalesced(
      "agent-model-catalog-invalidated",
      {
        delayMs: 150,
        key: () => "agent-model-catalog-invalidated",
        merge: mergeAgentModelCatalogInvalidationEvents
      },
      (event) => {
        const provider = composerTargetDataForConversation({
          activeConversationId: input.activeConversationIdRef.current,
          data: input.dataRef.current,
          optimisticTarget: null,
          selectedTarget: input.selectedComposerTargetDataRef.current
        }).provider;
        const activeId = input.activeConversationIdRef.current;
        if (!event.providers.some((candidate) => candidate === provider))
          return;
        loadDraftComposerOptions({ force: true });
        if (
          !activeId ||
          (activeId === null && input.isComposerHomeRef.current)
        ) {
          return;
        }
        input.loadSessionState(activeId, {
          source: "settings-update",
          force: true
        });
      }
    );
    const unsubscribeConfiguration = subscribeCoalesced(
      "agent-model-configuration-changed",
      {
        delayMs: 50,
        key: (event) => event.workspaceId,
        merge: mergeAgentModelConfigurationChangedEvents
      },
      (event) => {
        if (event.workspaceId !== input.workspaceId) return;
        const agentTargetId =
          input.selectedComposerTargetDataRef.current.agentTargetId?.trim() ??
          "";
        if (!agentTargetId || !event.agentTargetIds.includes(agentTargetId)) {
          return;
        }
        loadDraftComposerOptions({ force: true });
      }
    );
    return () => {
      unsubscribeCatalog();
      unsubscribeConfiguration();
    };
  }, [
    input.loadSessionState,
    input.previewMode,
    input.workspaceId,
    loadDraftComposerOptions
  ]);

  useEffect(() => {
    if (input.previewMode) return;
    // Session creation can finish after an earlier request cached the
    // provider's selected-model-only fallback. Once activation or creation
    // settles, bypass request-signature deduplication so runtime-discovered
    // model options replace that bootstrap snapshot.
    const conversationActivated =
      input.activeConversationId !== null &&
      previousActiveConversationIdRef.current !== input.activeConversationId;
    const conversationCreationSettled =
      previousIsCreatingConversationRef.current &&
      !input.isCreatingConversation;
    previousActiveConversationIdRef.current = input.activeConversationId;
    previousIsCreatingConversationRef.current = input.isCreatingConversation;
    const reconcileModelConfiguration = () => {
      if (!input.isComposerHome || input.activeConversationId !== null) return;
      const configuration = input.providerComposerOptions?.modelConfiguration;
      const agentTargetId =
        input.composerTargetData.agentTargetId?.trim() ?? "";
      if (!configuration || configuration.agentTargetId !== agentTargetId) {
        return;
      }
      const currentData = input.dataRef.current;
      const previous =
        currentData.modelConfigurationsByAgentTargetId?.[agentTargetId] ?? null;
      if (
        previous?.fingerprint === configuration.fingerprint ||
        (!previous && configuration.source === "provider-native")
      ) {
        return;
      }
      const selectedModel =
        configuration.source === "model-plan"
          ? configuration.defaultModel
          : null;
      const nextSettings: AgentSessionComposerSettings = {
        ...readNodeDefaultDraftSettings({
          data: currentData,
          defaultReasoningEffort: input.defaultReasoningEffort,
          drafts: input.draftSettingsBySessionIdRef.current
        }),
        model: selectedModel
      };
      const draftKey = nodeDefaultDraftKey(
        input.composerTargetData.provider,
        agentTargetId
      );
      input.setDraftSettingsBySessionId((current) => ({
        ...current,
        [draftKey]: nextSettings
      }));
      input.onDataChangeRef.current((current) => {
        if ((current.agentTargetId?.trim() ?? "") !== agentTargetId) {
          return current;
        }
        return nodeDataFromComposerSettings(
          {
            ...current,
            modelConfigurationsByAgentTargetId: {
              ...(current.modelConfigurationsByAgentTargetId ?? {}),
              [agentTargetId]: {
                defaultModel: configuration.defaultModel,
                fingerprint: configuration.fingerprint,
                selectedModel,
                source: configuration.source
              }
            }
          },
          nextSettings
        );
      });
    };
    reconcileModelConfiguration();
    loadDraftComposerOptions(
      conversationActivated ||
        conversationCreationSettled ||
        (input.providerComposerOptions?.behavior?.prewarmDraftSession ===
          true &&
          input.isComposerHome)
        ? { force: true }
        : undefined
    );
  }, [
    input.activeConversationId,
    input.composerTargetData.agentTargetId,
    input.composerTargetData.provider,
    input.defaultReasoningEffort,
    input.isComposerHome,
    input.isCreatingConversation,
    input.previewMode,
    input.providerComposerOptions?.behavior?.prewarmDraftSession,
    input.providerComposerOptions?.modelConfiguration,
    loadDraftComposerOptions
  ]);

  useEffect(() => {
    if (!input.previewMode) {
      void input.syncConversationListProjection(
        input.dataRef.current.lastActiveAgentSessionId
      );
    }
  }, [
    input.conversationFilter,
    input.currentUserId,
    input.data.provider,
    input.previewMode,
    input.syncConversationListProjection
  ]);

  useEffect(() => {
    if (input.previewMode || !input.activeConversationId) return;
    const activation = selectLatestActivationForSession(
      input.sessionEngine.getSnapshot(),
      input.activeConversationId
    );
    if (
      activation?.status === "failed" ||
      activation?.status === "requested" ||
      activation?.status === "uncertain"
    ) {
      return;
    }
    input.reloadSelectedConversation(input.activeConversationId, {
      reloadConversations: false,
      reloadDetail: true
    });
  }, [
    input.activeConversationId,
    input.previewMode,
    input.reloadSelectedConversation,
    input.sessionEngine
  ]);

  return { loadComposerOptionsForTarget, loadDraftComposerOptions };
}
