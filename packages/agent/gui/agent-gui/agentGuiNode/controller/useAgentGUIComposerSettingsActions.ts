import {
  selectEngineSession,
  type AgentActivityTurn,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import {
  cloneComposerSettings,
  nodeDataFromComposerSettings,
  nodeDefaultDraftKey,
  normalizePermissionModeId,
  readNodeDefaultDraftSettings,
  resolveEffectiveComposerSettings
} from "./agentGuiController.composerHelpers";
import {
  sanitizeComposerSettingsForTarget,
  type AgentGUIComposerTargetData
} from "./agentGuiController.composerPresentation";
import {
  normalizeOptionalText,
  createAgentGUIConversationId
} from "./agentGuiController.promptHelpers";
import {
  composerDefaultsPatchFromSettings,
  composerOptionsForTarget,
  rememberComposerDefaultsFields,
  type AgentGUIRememberComposerDefaultsInput
} from "./agentGuiController.providerHelpers";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";

interface UseAgentGUIComposerSettingsActionsInput {
  activation: ReturnType<typeof useAgentGUIActivation>;
  activeCanonicalComposerSettings: AgentSessionComposerSettings;
  activeConversationIdRef: RefObject<string | null>;
  activeEngineActiveTurn: AgentActivityTurn | null;
  agentActivityRuntime: AgentActivityRuntime;
  composerSupportPermissionModeChangeDeferred: boolean;
  dataRef: RefObject<AgentGUINodeData>;
  defaultReasoningEffort: AgentSessionReasoningEffort | null;
  draftSettingsBySessionIdRef: RefObject<
    Record<string, AgentSessionComposerSettings>
  >;
  loadDraftComposerOptions(options?: { force?: boolean }): void;
  onDataChangeRef: RefObject<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  onRememberComposerDefaultsRef: RefObject<
    | ((input: AgentGUIRememberComposerDefaultsInput) => void | Promise<void>)
    | undefined
  >;
  onShowMessageRef: RefObject<
    ((message: string, tone?: "info" | "warning" | "error") => void) | undefined
  >;
  selectedComposerTargetDataRef: RefObject<AgentGUIComposerTargetData>;
  sessionEngine: AgentSessionEngine;
  setDraftSettingsBySessionId: Dispatch<
    SetStateAction<Record<string, AgentSessionComposerSettings>>
  >;
  updateComposerSettingsRef: RefObject<
    (settings: Partial<AgentSessionComposerSettings>) => void
  >;
  workspaceId: string;
}

export function useAgentGUIComposerSettingsActions(
  input: UseAgentGUIComposerSettingsActionsInput
) {
  const {
    activation,
    activeCanonicalComposerSettings,
    activeConversationIdRef,
    activeEngineActiveTurn,
    agentActivityRuntime,
    dataRef,
    defaultReasoningEffort,
    draftSettingsBySessionIdRef,
    loadDraftComposerOptions,
    onDataChangeRef,
    onRememberComposerDefaultsRef,
    onShowMessageRef,
    selectedComposerTargetDataRef,
    sessionEngine,
    setDraftSettingsBySessionId,
    updateComposerSettingsRef,
    workspaceId
  } = input;
  const composerSupport = {
    permissionModeChangeDeferred:
      input.composerSupportPermissionModeChangeDeferred
  };
  const updateComposerSettings = useCallback(
    (nextSettings: Partial<AgentSessionComposerSettings>) => {
      // Values pass through unclamped: the toggle visibility is capability
      // gated and the daemon clamps persisted settings per provider.
      const supportedNextSettings: Partial<AgentSessionComposerSettings> = {
        ...nextSettings
      };
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId) {
        const targetData = selectedComposerTargetDataRef.current;
        const defaultDraftKey = nodeDefaultDraftKey(
          targetData.provider,
          targetData.agentTargetId
        );
        const storedDefaults = readNodeDefaultDraftSettings({
          data: targetData.data,
          defaultReasoningEffort,
          drafts: draftSettingsBySessionIdRef.current
        });
        const previousSettings = resolveEffectiveComposerSettings({
          settings: storedDefaults
        });
        const merged = {
          ...previousSettings,
          ...supportedNextSettings,
          planMode: supportedNextSettings.planMode ?? previousSettings.planMode,
          browserUse:
            supportedNextSettings.browserUse ?? previousSettings.browserUse,
          computerUse:
            supportedNextSettings.computerUse ?? previousSettings.computerUse
        };
        const snapshotComposerOptions = composerOptionsForTarget({
          snapshot: agentActivityRuntime.getSnapshot(workspaceId),
          target: targetData
        });
        const targetSafeMerged = sanitizeComposerSettingsForTarget({
          settings: merged,
          target: targetData,
          options: snapshotComposerOptions
        });
        draftSettingsBySessionIdRef.current = {
          ...draftSettingsBySessionIdRef.current,
          [defaultDraftKey]: targetSafeMerged
        };
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [defaultDraftKey]: targetSafeMerged
        }));
        onDataChangeRef.current((current) =>
          nodeDataFromComposerSettings(
            {
              ...current,
              provider: targetData.provider,
              agentTargetId: targetData.agentTargetId
            },
            targetSafeMerged
          )
        );
        void onRememberComposerDefaultsRef.current?.({
          agentTargetId: targetData.agentTargetId,
          provider: targetData.provider,
          defaults: composerDefaultsPatchFromSettings(
            supportedNextSettings,
            targetSafeMerged
          )
        });
        void agentActivityRuntime.trackDraftComposerSettingsChange?.({
          workspaceId,
          provider: targetData.provider,
          previousSettings,
          nextSettings: targetSafeMerged
        });
        loadDraftComposerOptions(
          snapshotComposerOptions?.behavior
            ?.refreshModelOptionsAfterSettings === true
            ? { force: true }
            : undefined
        );
        return;
      }
      const canonicalSession = selectEngineSession(
        sessionEngine.getSnapshot(),
        agentSessionId
      );
      // The optimistic pre-activation window (see startConversation): the id
      // is already the active conversation but the backend session has not
      // attached yet, so there is no control state to read settings from or
      // send an update RPC against. Composer changes here are still applied
      // to the local view (so the control reflects the click immediately)
      // and queued for the flush once activation resolves.
      const isPreActivationSession =
        canonicalSession === null &&
        activation.stateFor(agentSessionId) === "activating";
      const sessionSettings = cloneComposerSettings(
        canonicalSession ? activeCanonicalComposerSettings : null
      );
      const nextPermission =
        supportedNextSettings.permissionModeId !== undefined
          ? normalizeOptionalText(supportedNextSettings.permissionModeId)
          : undefined;
      const currentPermission = normalizeOptionalText(
        sessionSettings?.permissionModeId
      );
      const nextModel =
        supportedNextSettings.model !== undefined
          ? normalizeOptionalText(supportedNextSettings.model)
          : undefined;
      const currentModel = normalizeOptionalText(sessionSettings?.model);
      const nextReasoningEffort =
        supportedNextSettings.reasoningEffort !== undefined
          ? (supportedNextSettings.reasoningEffort ?? null)
          : undefined;
      const currentReasoningEffort = sessionSettings?.reasoningEffort ?? null;
      const nextSpeed =
        supportedNextSettings.speed !== undefined
          ? (supportedNextSettings.speed ?? null)
          : undefined;
      const currentSpeed = sessionSettings?.speed ?? null;
      const nextPlanMode = supportedNextSettings.planMode;
      const currentPlanMode = sessionSettings?.planMode ?? false;
      const nextBrowserUse = supportedNextSettings.browserUse;
      const currentBrowserUse = sessionSettings?.browserUse ?? true;
      const nextComputerUse = supportedNextSettings.computerUse;
      const currentComputerUse = sessionSettings?.computerUse ?? true;
      const sessionSettingsPatch: AgentSessionComposerSettings = {};

      if (nextModel !== undefined && nextModel !== currentModel) {
        sessionSettingsPatch.model = nextModel;
      }
      if (
        nextReasoningEffort !== undefined &&
        nextReasoningEffort !== currentReasoningEffort
      ) {
        sessionSettingsPatch.reasoningEffort = nextReasoningEffort;
      }
      if (nextSpeed !== undefined && nextSpeed !== currentSpeed) {
        sessionSettingsPatch.speed = nextSpeed;
      }
      if (nextPlanMode !== undefined && nextPlanMode !== currentPlanMode) {
        sessionSettingsPatch.planMode = nextPlanMode;
      }
      if (
        nextBrowserUse !== undefined &&
        nextBrowserUse !== currentBrowserUse
      ) {
        sessionSettingsPatch.browserUse = nextBrowserUse;
      }
      if (
        nextComputerUse !== undefined &&
        nextComputerUse !== currentComputerUse
      ) {
        sessionSettingsPatch.computerUse = nextComputerUse;
      }
      if (
        nextPermission !== undefined &&
        nextPermission &&
        nextPermission !== currentPermission &&
        (canonicalSession !== null || isPreActivationSession)
      ) {
        sessionSettingsPatch.permissionModeId =
          normalizePermissionModeId(nextPermission);
        // Descriptor capability data decides whether an in-flight change is
        // deferred until the next turn. Pre-activation has no turn to defer.
        const turnPhase = activeEngineActiveTurn?.phase;
        const isTurnInFlight =
          turnPhase === "running" || turnPhase === "submitted";
        if (composerSupport.permissionModeChangeDeferred && isTurnInFlight) {
          onShowMessageRef.current?.(
            translate("messages.agentPermissionModeAppliesNextTurn"),
            "info"
          );
        }
      }
      if (
        Object.keys(sessionSettingsPatch).length > 0 &&
        (canonicalSession !== null || isPreActivationSession)
      ) {
        // A switch inside an active session also becomes the remembered
        // default for this agent target. Only the fields the user changed
        // are passed; the consumer merges them field-wise so untouched
        // remembered fields stay intact, and explicit clears propagate as
        // null tombstones.
        void onRememberComposerDefaultsRef.current?.({
          agentTargetId: normalizeOptionalText(dataRef.current.agentTargetId),
          provider: dataRef.current.provider,
          defaults: composerDefaultsPatchFromSettings(
            sessionSettingsPatch,
            sessionSettingsPatch
          )
        });
        // The node-level default drafts take precedence over the remembered
        // preferences on the read path, so sync the durable fields into them
        // as well or this node's next composer would keep showing its stale
        // draft.
        const durableNodeDefaultsPatch: Partial<AgentSessionComposerSettings> =
          {};
        for (const field of rememberComposerDefaultsFields) {
          if (sessionSettingsPatch[field] !== undefined) {
            durableNodeDefaultsPatch[field] = sessionSettingsPatch[field];
          }
        }
        if (Object.keys(durableNodeDefaultsPatch).length > 0) {
          const defaultDraftKey = nodeDefaultDraftKey(
            dataRef.current.provider,
            dataRef.current.agentTargetId
          );
          const storedNodeDefaults = readNodeDefaultDraftSettings({
            data: dataRef.current,
            defaultReasoningEffort,
            drafts: draftSettingsBySessionIdRef.current
          });
          const nextNodeDefaults = {
            ...storedNodeDefaults,
            ...durableNodeDefaultsPatch
          };
          draftSettingsBySessionIdRef.current = {
            ...draftSettingsBySessionIdRef.current,
            [defaultDraftKey]: nextNodeDefaults
          };
          setDraftSettingsBySessionId((current) => ({
            ...current,
            [defaultDraftKey]: nextNodeDefaults
          }));
          onDataChangeRef.current((current) =>
            nodeDataFromComposerSettings(current, nextNodeDefaults)
          );
        }
        if (isPreActivationSession) {
          sessionEngine.dispatch({
            type: "activation/settingsPatched",
            agentSessionId,
            settings: { ...sessionSettingsPatch }
          });
        } else {
          sessionEngine.dispatch({
            agentSessionId,
            commandId: `settings:${createAgentGUIConversationId()}`,
            settings: { ...sessionSettingsPatch },
            timeoutMs: 30_000,
            type: "session/settingsUpdateRequested",
            workspaceId
          });
        }
        return;
      }
    },
    [
      activation,
      activeCanonicalComposerSettings,
      defaultReasoningEffort,
      composerSupport.permissionModeChangeDeferred,
      loadDraftComposerOptions,
      sessionEngine,
      workspaceId
    ]
  );
  updateComposerSettingsRef.current = updateComposerSettings;

  return { updateComposerSettings };
}
