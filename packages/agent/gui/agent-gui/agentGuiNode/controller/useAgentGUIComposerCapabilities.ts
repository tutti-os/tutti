import {
  resolveAgentActivityCapability,
  resolveAgentActivityUsage,
  type AgentActivitySnapshot,
  type CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import { useMemo } from "react";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";
import {
  composerOptionsForTarget,
  composerOptionsLoadFailedForTarget,
  composerOptionsLoadingForTarget
} from "./agentGuiController.providerHelpers";
import {
  composerTargetDataForConversation,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import { resolvePromptImageSelectedModel } from "./agentGuiController.draftMessageHelpers";

interface UseAgentGUIComposerCapabilitiesInput {
  activeConversationId: string | null;
  activeEngineSession: CanonicalAgentSession | null;
  activeSessionState: AgentSessionState | null;
  agentActivitySnapshot: AgentActivitySnapshot;
  data: AgentGUINodeData;
  draftSettingsBySessionId: Record<string, AgentSessionComposerSettings>;
  selectedComposerTargetData: AgentGUIComposerTargetData;
}

export function useAgentGUIComposerCapabilities(
  input: UseAgentGUIComposerCapabilitiesInput
) {
  const composerTargetData = composerTargetDataForConversation({
    activeConversationId: input.activeConversationId,
    data: input.data,
    optimisticTarget: null,
    selectedTarget: input.selectedComposerTargetData
  });
  const providerComposerOptions = composerOptionsForTarget({
    snapshot: input.agentActivitySnapshot,
    target: composerTargetData
  });
  const composerOptionsLoading = composerOptionsLoadingForTarget({
    snapshot: input.agentActivitySnapshot,
    target: composerTargetData
  });
  const composerOptionsLoadFailed = composerOptionsLoadFailedForTarget({
    snapshot: input.agentActivitySnapshot,
    target: composerTargetData
  });
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
    return {
      ...fallback,
      browser: sessionCapabilities?.browserUse ?? fallback.browser,
      computer: sessionCapabilities?.computerUse ?? fallback.computer,
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
  const usage = useMemo(
    () => resolveAgentActivityUsage({ sessionUsage: usageSource }),
    [usageSource]
  );

  return {
    compactSupported:
      sessionCapabilities?.compact ??
      resolveAgentActivityCapability("compact", {
        composerOptions: providerComposerOptions,
        sessionCapabilities
      }),
    composerSupport,
    composerOptionsLoading,
    composerOptionsLoadFailed,
    composerTargetData,
    defaultReasoningEffort,
    goalPauseSupported:
      sessionCapabilities?.goalPause ??
      resolveAgentActivityCapability("goalPause", {
        composerOptions: providerComposerOptions,
        sessionCapabilities
      }) ??
      false,
    promptImagesSupported:
      (resolvedPromptImagesSupported ?? true) &&
      selectedModelImageInputSupported,
    providerComposerOptions,
    usage
  };
}
