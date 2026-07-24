import {
  selectLatestActivationForSession,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { subscribe, subscribeCoalesced } from "../../../host/agentHostEventBus";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import { readNodeDefaultDraftSettings } from "./agentGuiController.composerHelpers";
import {
  composerTargetDataForConversation,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import {
  composerDefaultsPatchFromSettings,
  composerOptionsForTarget,
  mergeAgentModelCatalogInvalidationEvents,
  withoutAcknowledgedComposerDefaults
} from "./agentGuiController.providerHelpers";
import type { AgentGUIComposerDefaultsAuthorityReconciler } from "./agentGuiComposerDefaultsReconciliation";

export function useAgentGUIComposerOptionsSync(input: {
  activeConversationId: string | null;
  activeConversationIdRef: RefObject<string | null>;
  agentActivityRuntime: AgentActivityRuntime;
  composerTargetData: AgentGUIComposerTargetData;
  conversationFilter: unknown;
  currentUserId: string | null | undefined;
  data: AgentGUINodeData;
  dataRef: RefObject<AgentGUINodeData>;
  defaultReasoningEffort: AgentSessionReasoningEffort | null;
  draftSettingsBySessionIdRef: RefObject<
    Record<string, AgentSessionComposerSettings>
  >;
  isComposerHome: boolean;
  isComposerHomeRef: RefObject<boolean>;
  isCreatingConversation: boolean;
  loadDraftComposerOptionsRef: RefObject<() => void>;
  loadSessionState(agentSessionId: string, cause?: unknown): void;
  onComposerDefaultsAuthorityReloadedRef: RefObject<AgentGUIComposerDefaultsAuthorityReconciler>;
  previewMode: boolean;
  providerComposerOptions:
    | { behavior?: { prewarmDraftSession?: boolean } | null }
    | null
    | undefined;
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
    (
      targetData: AgentGUIComposerTargetData,
      options?: {
        allowWhileCreating?: boolean;
        excludePersistentDefaults?: boolean;
        force?: boolean;
        reconcileAcknowledgedDefaults?: boolean;
        settings?: AgentSessionComposerSettings;
      }
    ): Promise<void> => {
      if (
        (input.isCreatingConversation && !options?.allowWhileCreating) ||
        !targetData.agentTargetId
      ) {
        return Promise.resolve();
      }
      const localSettings =
        options?.settings ??
        readNodeDefaultDraftSettings({
          data: targetData.data,
          defaultReasoningEffort: input.defaultReasoningEffort,
          drafts: input.draftSettingsBySessionIdRef.current
        });
      const authorityRead = options?.reconcileAcknowledgedDefaults
        ? input.onComposerDefaultsAuthorityReloadedRef.current.prepareRead(
            targetData,
            localSettings
          )
        : { force: false, receipt: null, settings: localSettings };
      const localDefaults = options?.excludePersistentDefaults
        ? composerDefaultsPatchFromSettings(localSettings, localSettings)
        : null;
      const requestSettings = localDefaults
        ? withoutAcknowledgedComposerDefaults(
            authorityRead.settings,
            localDefaults
          )
        : authorityRead.settings;
      const cwd =
        input.selectedProjectPathRef.current?.trim() ||
        input.workspacePath.trim() ||
        "";
      return Promise.resolve(
        input.agentActivityRuntime.getComposerOptions({
          workspaceId: input.workspaceId,
          cwd,
          force: options?.force || authorityRead.force ? true : undefined,
          provider: targetData.provider,
          agentTargetId: targetData.agentTargetId,
          settings: requestSettings
        })
      ).then(() => {
        const loadedOptions = composerOptionsForTarget({
          snapshot: input.agentActivityRuntime.getSnapshot(input.workspaceId),
          target: targetData
        });
        if (loadedOptions) {
          input.onComposerDefaultsAuthorityReloadedRef.current.reconcileHomeDefaults(
            targetData,
            loadedOptions
          );
        }
        if (options?.reconcileAcknowledgedDefaults) {
          input.onComposerDefaultsAuthorityReloadedRef.current.reloaded(
            authorityRead.receipt
          );
        }
      });
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
      void loadComposerOptionsForTarget(
        composerTargetDataForConversation({
          activeConversationId: input.activeConversationIdRef.current,
          data: input.dataRef.current,
          optimisticTarget: null,
          selectedTarget: input.selectedComposerTargetDataRef.current
        }),
        {
          ...options,
          reconcileAcknowledgedDefaults:
            input.activeConversationIdRef.current === null &&
            input.isComposerHomeRef.current
        }
      ).catch(() => undefined);
    },
    [
      input.activeConversationIdRef,
      input.dataRef,
      input.isComposerHomeRef,
      input.selectedComposerTargetDataRef,
      loadComposerOptionsForTarget
    ]
  );
  const reloadComposerOptionsForTarget = useCallback(
    (reloadInput: {
      settings: AgentSessionComposerSettings;
      target: AgentGUIComposerTargetData;
    }): Promise<void> =>
      loadComposerOptionsForTarget(reloadInput.target, {
        allowWhileCreating: true,
        force: true,
        reconcileAcknowledgedDefaults: true,
        settings: reloadInput.settings
      }),
    [loadComposerOptionsForTarget]
  );
  input.loadDraftComposerOptionsRef.current = loadDraftComposerOptions;

  useEffect(() => {
    if (input.previewMode) return undefined;
    return subscribeCoalesced(
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
  }, [input.loadSessionState, input.previewMode, loadDraftComposerOptions]);

  useEffect(() => {
    if (input.previewMode) return undefined;
    return subscribe("agent-composer-defaults-invalidated", (event) => {
      const selectedTarget = composerTargetDataForConversation({
        activeConversationId: input.activeConversationIdRef.current,
        data: input.dataRef.current,
        optimisticTarget: null,
        selectedTarget: input.selectedComposerTargetDataRef.current
      });
      if (selectedTarget.agentTargetId !== event.agentTargetId) {
        return;
      }
      const localIntent = readNodeDefaultDraftSettings({
        data: selectedTarget.data,
        defaultReasoningEffort: input.defaultReasoningEffort,
        drafts: input.draftSettingsBySessionIdRef.current
      });
      // The target-only event is always a reread signal. Exclude local
      // persistent intent from the request so effectiveSettings can reflect
      // daemon authority, but do not retire that intent without its own ack.
      void loadComposerOptionsForTarget(selectedTarget, {
        allowWhileCreating: true,
        excludePersistentDefaults: true,
        force: true,
        reconcileAcknowledgedDefaults: true,
        settings: localIntent
      }).catch(() => undefined);
    });
  }, [
    input.defaultReasoningEffort,
    input.onComposerDefaultsAuthorityReloadedRef,
    input.previewMode,
    loadComposerOptionsForTarget
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
    input.isComposerHome,
    input.isCreatingConversation,
    input.previewMode,
    input.providerComposerOptions?.behavior?.prewarmDraftSession,
    input.selectedProjectPath,
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
      activation?.status === "canceled" ||
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

  return { loadDraftComposerOptions, reloadComposerOptionsForTarget };
}
