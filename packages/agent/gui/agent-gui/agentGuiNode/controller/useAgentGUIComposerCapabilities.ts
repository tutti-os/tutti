import {
  resolveAgentActivityCapability,
  resolveAgentActivityUsage,
  selectComposerOptions,
  selectComposerOptionsLoadStatus,
  selectComposerOptionsSectionLoadStatus,
  type AgentActivityUsage,
  type CanonicalAgentSession,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { useMemo, useRef } from "react";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";
import {
  composerTargetDataForConversation,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import { resolvePromptImageSelectedModel } from "./agentGuiController.draftMessageHelpers";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";

interface UseAgentGUIComposerCapabilitiesInput {
  activeConversationId: string | null;
  activeEngineSession: CanonicalAgentSession | null;
  activeSessionState: AgentSessionState | null;
  data: AgentGUINodeData;
  draftSettingsBySessionId: Record<string, AgentSessionComposerSettings>;
  selectedComposerTargetData: AgentGUIComposerTargetData;
  sessionEngine: AgentSessionEngine;
}

export function useAgentGUIComposerCapabilities(
  input: UseAgentGUIComposerCapabilitiesInput
) {
  const retainedUsageBySessionIdRef = useRef(
    new Map<string, AgentActivityUsage>()
  );
  const composerTargetData = composerTargetDataForConversation({
    activeConversationId: input.activeConversationId,
    activeSessionTarget: input.activeEngineSession,
    data: input.data,
    optimisticTarget: null,
    selectedTarget: input.selectedComposerTargetData
  });
  const composerTargetKey = composerTargetData.agentTargetId?.trim() ?? "";
  const providerComposerOptions = useEngineSelector(
    input.sessionEngine,
    (state) => selectComposerOptions(state, composerTargetKey)
  );
  const composerOptionsLoadStatus = useEngineSelector(
    input.sessionEngine,
    (state) => selectComposerOptionsLoadStatus(state, composerTargetKey)
  );
  const capabilitiesLoadStatus = useEngineSelector(
    input.sessionEngine,
    (state) =>
      selectComposerOptionsSectionLoadStatus(
        state,
        composerTargetKey,
        "capabilities"
      )
  );
  const connectorsLoadStatus = useEngineSelector(input.sessionEngine, (state) =>
    selectComposerOptionsSectionLoadStatus(
      state,
      composerTargetKey,
      "connectors"
    )
  );
  const composerOptionsLoading = Boolean(
    composerTargetKey &&
    (capabilitiesLoadStatus === "loading" ||
      (!providerComposerOptions && composerOptionsLoadStatus === "loading"))
  );
  const connectorOptionsLoading = Boolean(
    composerTargetKey && connectorsLoadStatus === "loading"
  );
  const defaultReasoningEffort: AgentSessionReasoningEffort | null = "high";
  const sessionCapabilities = input.activeEngineSession?.capabilities ?? null;
  const resolvedPromptImagesSupported =
    sessionCapabilities?.imageInput ??
    resolveAgentActivityCapability("imageInput", {
      composerOptions: providerComposerOptions,
      sessionCapabilities
    });
  const selectedModelForPromptImages =
    resolvePromptImageSelectedModel({
      activeConversationId: input.activeConversationId,
      activeSessionRuntimeContext: null,
      activeSessionSettings: input.activeSessionState?.settings ?? null,
      activeSessionPermissionModeId: input.activeSessionState?.permissionModeId,
      data: input.data,
      defaultReasoningEffort,
      draftSettingsBySessionId: input.draftSettingsBySessionId,
      providerComposerOptions,
      selectedComposerTargetData: input.selectedComposerTargetData
    }) ??
    normalizeOptionalText(providerComposerOptions?.effectiveSettings?.model);
  const modelImageInputRequired = Boolean(
    resolveAgentActivityCapability("modelImageInputRequired", {
      composerOptions: providerComposerOptions,
      sessionCapabilities
    })
  );
  const selectedModelImageInputSupported = !modelImageInputRequired
    ? true
    : selectedModelForPromptImages !== null &&
      (providerComposerOptions?.models.find(
        (option) => option.value === selectedModelForPromptImages
      )?.supportsImageInput ??
        false);
  const composerSupport = useMemo(() => {
    const fallback = composerSettingsSupportFromOptions(
      providerComposerOptions,
      sessionCapabilities
    );
    const targetSupport = composerSettingsSupportFromOptions(
      providerComposerOptions,
      null
    );
    return {
      ...fallback,
      browser:
        sessionCapabilities?.browserUse === true || targetSupport.browser,
      computer:
        sessionCapabilities?.computerUse === true || targetSupport.computer,
      permissionModeChangeDeferred:
        sessionCapabilities?.permissionModeChangeDeferred ??
        fallback.permissionModeChangeDeferred,
      permissionModeChangeDuringTurn:
        sessionCapabilities?.permissionModeChangeDuringTurn ??
        fallback.permissionModeChangeDuringTurn,
      plan: sessionCapabilities?.planMode ?? fallback.plan,
      planImplementation:
        sessionCapabilities?.planImplementation ?? fallback.planImplementation
    };
  }, [providerComposerOptions, sessionCapabilities]);

  const usageSource = input.activeEngineSession?.usage ?? null;
  const usage = useMemo(() => {
    const agentSessionId =
      input.activeEngineSession?.agentSessionId.trim() ?? "";
    if (!agentSessionId) {
      return null;
    }
    const resolved = resolveAgentActivityUsage({
      sessionUsage: usageSource
    });
    if (resolved) {
      retainedUsageBySessionIdRef.current.set(agentSessionId, resolved);
      return resolved;
    }
    return retainedUsageBySessionIdRef.current.get(agentSessionId) ?? null;
  }, [input.activeEngineSession?.agentSessionId, usageSource]);

  return {
    compactSupported:
      sessionCapabilities?.compact ??
      resolveAgentActivityCapability("compact", {
        composerOptions: providerComposerOptions,
        sessionCapabilities
      }),
    composerSupport,
    composerOptionsLoadStatus,
    composerOptionsLoading,
    connectorOptionsLoading,
    composerTargetData,
    defaultReasoningEffort,
    goalPauseSupported:
      resolveAgentActivityCapability("goalPause", {
        composerOptions: providerComposerOptions,
        sessionCapabilities
      }) ?? false,
    promptImagesSupported:
      (resolvedPromptImagesSupported ?? true) &&
      selectedModelImageInputSupported,
    providerComposerOptions,
    usage
  };
}
