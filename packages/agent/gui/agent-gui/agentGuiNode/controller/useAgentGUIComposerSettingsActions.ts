import {
  selectEngineSession,
  selectEngineSessionSettingsUpdate,
  type AgentActivityTurn,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useRef } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import {
  normalizePlanIssueBudgetPreset,
  planIssueBudgetPresetsEqual,
  type PlanIssueBudgetPreset
} from "../../../shared/agentConversation/planImplementationPresentation";
import {
  cloneComposerSettings,
  nodeDataFromComposerSettings,
  nodeDefaultDraftKey,
  normalizePermissionModeId,
  pairedComposerSettingsPatch,
  readNodeDefaultDraftSettings,
  resolveEffectiveComposerSettings
} from "./agentGuiController.composerHelpers";
import { shouldRetrySessionSettingsUpdate } from "../model/composerModeSelection";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import {
  acknowledgeAgentGUIComposerDefaultsMutation,
  createAgentGUIComposerDefaultsLedger,
  prepareAcknowledgedComposerDefaultsAuthorityRead,
  registerAgentGUIComposerDefaultsMutation,
  removeRetiredComposerDefaults,
  retireAcknowledgedComposerDefaultsForRead,
  type AgentGUIComposerDefaultsLedger,
  type AgentGUIComposerDefaultsAuthorityReconciler,
  type AgentGUIComposerDefaultsAuthorityReadReceipt,
  type AgentGUIComposerDefaultsMutation,
  type AgentGUIRetiredComposerDefault
} from "./agentGuiComposerDefaultsReconciliation";
import {
  normalizeOptionalText,
  createAgentGUIConversationId
} from "./agentGuiController.promptHelpers";
import {
  composerDefaultsPatchFromSettings,
  composerOptionsForTarget,
  rememberComposerDefaultsFields,
  type AgentGUIRememberComposerDefaultsInput,
  type AgentGUIRememberComposerDefaultsResult,
  sessionComposerSettingsPersistence
} from "./agentGuiController.providerHelpers";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import { useStableControllerEventCallback } from "./agentGuiController.stableHelpers";

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
  isMountedRef: RefObject<boolean>;
  loadDraftComposerOptions(options?: { force?: boolean }): void;
  onDataChangeRef: RefObject<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  onComposerDefaultsAuthorityReloadedRef: RefObject<AgentGUIComposerDefaultsAuthorityReconciler>;
  onRememberComposerDefaultsRef: RefObject<
    | ((
        input: AgentGUIRememberComposerDefaultsInput
      ) => void | Promise<AgentGUIRememberComposerDefaultsResult>)
    | undefined
  >;
  onShowMessageRef: RefObject<
    ((message: string, tone?: "info" | "warning" | "error") => void) | undefined
  >;
  reloadComposerOptionsForTarget(input: {
    settings: AgentSessionComposerSettings;
    target: AgentGUIComposerTargetData;
  }): Promise<void>;
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
    isMountedRef,
    loadDraftComposerOptions,
    onDataChangeRef,
    onComposerDefaultsAuthorityReloadedRef,
    onRememberComposerDefaultsRef,
    onShowMessageRef,
    reloadComposerOptionsForTarget,
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
  const composerDefaultsLedgerRef = useRef(
    createAgentGUIComposerDefaultsLedger()
  );
  const retireAcknowledgedDefaultsForRead = useCallback(
    (receipt: AgentGUIComposerDefaultsAuthorityReadReceipt | null) => {
      if (!isMountedRef.current || !receipt) return;
      const currentDraft =
        draftSettingsBySessionIdRef.current[receipt.draftKey];
      if (!currentDraft) return;
      const retired = retireAcknowledgedComposerDefaultsForRead(
        composerDefaultsLedgerRef.current,
        receipt,
        currentDraft
      );
      if (retired.length === 0) return;
      draftSettingsBySessionIdRef.current = reconcileRetiredDraftMap(
        draftSettingsBySessionIdRef.current,
        receipt.draftKey,
        retired
      );
      setDraftSettingsBySessionId((current) =>
        reconcileRetiredDraftMap(current, receipt.draftKey, retired)
      );
    },
    [draftSettingsBySessionIdRef, isMountedRef, setDraftSettingsBySessionId]
  );
  const prepareComposerDefaultsAuthorityRead = useCallback(
    (
      target: AgentGUIComposerTargetData,
      settings: AgentSessionComposerSettings
    ) =>
      prepareAcknowledgedComposerDefaultsAuthorityRead(
        composerDefaultsLedgerRef.current,
        nodeDefaultDraftKey(target.provider, target.agentTargetId),
        settings
      ),
    []
  );
  onComposerDefaultsAuthorityReloadedRef.current = {
    prepareRead: prepareComposerDefaultsAuthorityRead,
    reloaded: retireAcknowledgedDefaultsForRead
  };
  const updateComposerSettings = useCallback(
    (nextSettings: Partial<AgentSessionComposerSettings>) => {
      // Values pass through unclamped: the toggle visibility is capability
      // gated and the daemon clamps persisted settings per provider. Model
      // patches are normalized to full {model, modelPlanId} pairs first.
      const supportedNextSettings: Partial<AgentSessionComposerSettings> =
        pairedComposerSettingsPatch({
          ...nextSettings
        });
      // Persistent selections only originate from rendered menu values. A
      // transient empty select value during options refresh is not a user
      // intent and must not clear either the optimistic draft or defaults.
      for (const field of rememberComposerDefaultsFields) {
        if (
          supportedNextSettings[field] !== undefined &&
          normalizeOptionalText(supportedNextSettings[field]) === null
        ) {
          delete supportedNextSettings[field];
        }
      }
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId) {
        const targetData = selectedComposerTargetDataRef.current;
        const defaultDraftKey = nodeDefaultDraftKey(
          targetData.provider,
          targetData.agentTargetId
        );
        const storedIntent = readNodeDefaultDraftSettings({
          data: targetData.data,
          defaultReasoningEffort,
          drafts: draftSettingsBySessionIdRef.current
        });
        const previousSettings = resolveEffectiveComposerSettings({
          settings: storedIntent
        });
        const mergedIntent: AgentSessionComposerSettings = {
          ...storedIntent,
          ...supportedNextSettings
        };
        for (const field of rememberComposerDefaultsFields) {
          if (supportedNextSettings[field] !== undefined) {
            Object.assign(mergedIntent, {
              [field]: normalizeOptionalText(supportedNextSettings[field])
            });
          }
        }
        const snapshotComposerOptions = composerOptionsForTarget({
          snapshot: agentActivityRuntime.getSnapshot(workspaceId),
          target: targetData
        });
        draftSettingsBySessionIdRef.current = {
          ...draftSettingsBySessionIdRef.current,
          [defaultDraftKey]: mergedIntent
        };
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [defaultDraftKey]: mergedIntent
        }));
        const rememberedDefaultsPatch = composerDefaultsPatchFromSettings(
          supportedNextSettings,
          mergedIntent
        );
        if (rememberedDefaultsPatch) {
          const mutation = registerAgentGUIComposerDefaultsMutation(
            composerDefaultsLedgerRef.current,
            defaultDraftKey,
            rememberedDefaultsPatch
          );
          const acknowledgement = invokeRememberComposerDefaults(
            onRememberComposerDefaultsRef.current,
            {
              agentTargetId: targetData.agentTargetId,
              provider: targetData.provider,
              defaults: rememberedDefaultsPatch
            }
          );
          if (targetData.agentTargetId && acknowledgement) {
            void reconcileAcknowledgedHomeDefaults({
              acknowledgement,
              draftKey: defaultDraftKey,
              draftSettingsBySessionIdRef,
              isMountedRef,
              ledger: composerDefaultsLedgerRef.current,
              mutation,
              reloadComposerOptionsForTarget,
              target: targetData
            }).catch(() => undefined);
          }
        }
        void agentActivityRuntime.trackDraftComposerSettingsChange?.({
          workspaceId,
          provider: targetData.provider,
          previousSettings,
          nextSettings: resolveEffectiveComposerSettings({
            settings: mergedIntent
          })
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
      const requestedModelPlanId =
        supportedNextSettings.modelPlanId !== undefined
          ? normalizeOptionalText(supportedNextSettings.modelPlanId)
          : undefined;
      const currentModelPlanId = normalizeOptionalText(
        sessionSettings?.modelPlanId
      );
      if (
        requestedModelPlanId !== undefined &&
        requestedModelPlanId !== currentModelPlanId &&
        canonicalSession !== null
      ) {
        const stagedSettings = resolveEffectiveComposerSettings({
          settings: {
            ...(sessionSettings ?? activeCanonicalComposerSettings),
            ...supportedNextSettings,
            modelPlanId: requestedModelPlanId
          }
        });
        draftSettingsBySessionIdRef.current = {
          ...draftSettingsBySessionIdRef.current,
          [agentSessionId]: stagedSettings
        };
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [agentSessionId]: stagedSettings
        }));
        onShowMessageRef.current?.(
          translate("agentHost.agentGui.composerModelSwitchNewSessionHint"),
          "info"
        );
        return;
      }
      if (
        requestedModelPlanId !== undefined &&
        requestedModelPlanId === currentModelPlanId &&
        draftSettingsBySessionIdRef.current[agentSessionId]
      ) {
        const restoredSettings = resolveEffectiveComposerSettings({
          settings: {
            ...(sessionSettings ?? activeCanonicalComposerSettings),
            ...supportedNextSettings,
            modelPlanId: currentModelPlanId
          }
        });
        draftSettingsBySessionIdRef.current = {
          ...draftSettingsBySessionIdRef.current,
          [agentSessionId]: restoredSettings
        };
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [agentSessionId]: restoredSettings
        }));
      }
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

      const rememberedDefaultsPatch = composerDefaultsPatchFromSettings(
        supportedNextSettings,
        supportedNextSettings as AgentSessionComposerSettings
      );
      if (rememberedDefaultsPatch) {
        const defaultAgentTargetId =
          normalizeOptionalText(canonicalSession?.agentTargetId) ??
          normalizeOptionalText(dataRef.current.agentTargetId);
        const defaultProvider =
          canonicalSession?.provider ?? dataRef.current.provider;
        const saving = invokeRememberComposerDefaults(
          onRememberComposerDefaultsRef.current,
          {
            agentTargetId: defaultAgentTargetId,
            provider: defaultProvider,
            defaults: rememberedDefaultsPatch
          }
        );
        if (saving) {
          // Defaults persistence is independent from the active-session
          // command and must remain silent on both sync and async failures.
          void saving.catch(() => undefined);
        }
      }
      if (
        isPreActivationSession &&
        requestedModelPlanId !== undefined &&
        requestedModelPlanId !== currentModelPlanId
      ) {
        sessionSettingsPatch.modelPlanId = requestedModelPlanId;
      }

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
        // null tombstones. The session's effective plan binding rides along:
        // plan-scoped models are excluded from the (plan-blind) remembered
        // defaults, and node defaults always receive the model together with
        // its plan binding so no cross-plan pair can be assembled by merging.
        const persistence = sessionComposerSettingsPersistence({
          currentModelPlanId,
          sessionSettingsPatch,
          storedNodeDefaults: readNodeDefaultDraftSettings({
            data: dataRef.current,
            defaultReasoningEffort,
            drafts: draftSettingsBySessionIdRef.current
          })
        });
        void onRememberComposerDefaultsRef.current?.({
          agentTargetId: normalizeOptionalText(dataRef.current.agentTargetId),
          provider: dataRef.current.provider,
          defaults: persistence.rememberedDefaults
        });
        // The node-level default drafts take precedence over the remembered
        // preferences on the read path, so sync the durable fields into them
        // as well or this node's next composer would keep showing its stale
        // draft.
        if (persistence.nodeDefaults) {
          const nextNodeDefaults = persistence.nodeDefaults;
          const defaultDraftKey = nodeDefaultDraftKey(
            dataRef.current.provider,
            dataRef.current.agentTargetId
          );
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
          const settingsUpdate = selectEngineSessionSettingsUpdate(
            sessionEngine.getSnapshot(),
            agentSessionId
          );
          sessionEngine.dispatch({
            agentSessionId,
            commandId: `settings:${createAgentGUIConversationId()}`,
            retry: shouldRetrySessionSettingsUpdate(settingsUpdate?.status),
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
      reloadComposerOptionsForTarget,
      sessionEngine,
      workspaceId
    ]
  );
  updateComposerSettingsRef.current = updateComposerSettings;

  const updatePlanIssueBudgetPreset = useStableControllerEventCallback(
    (preset: PlanIssueBudgetPreset) => {
      const normalized = normalizePlanIssueBudgetPreset(preset);
      if (!normalized) return;
      onDataChangeRef.current((current) =>
        planIssueBudgetPresetsEqual(current.planIssueBudgetPreset, normalized)
          ? current
          : { ...current, planIssueBudgetPreset: normalized }
      );
    }
  );

  // Recovery entry for the composer-options terminal error state: re-issues
  // the draft options load (the engine grants a fresh retry budget per
  // user-driven request).
  const retryComposerOptions = useStableControllerEventCallback(() => {
    loadDraftComposerOptions({ force: true });
  });

  return {
    retryComposerOptions,
    updateComposerSettings,
    updatePlanIssueBudgetPreset
  };
}

function invokeRememberComposerDefaults(
  callback:
    | ((
        input: AgentGUIRememberComposerDefaultsInput
      ) => void | Promise<AgentGUIRememberComposerDefaultsResult>)
    | undefined,
  input: AgentGUIRememberComposerDefaultsInput
): Promise<AgentGUIRememberComposerDefaultsResult> | undefined {
  if (!callback) return undefined;
  try {
    const result = callback(input);
    return result === undefined ? undefined : Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}

async function reconcileAcknowledgedHomeDefaults(input: {
  acknowledgement: Promise<AgentGUIRememberComposerDefaultsResult>;
  draftKey: string;
  draftSettingsBySessionIdRef: RefObject<
    Record<string, AgentSessionComposerSettings>
  >;
  isMountedRef: RefObject<boolean>;
  ledger: AgentGUIComposerDefaultsLedger;
  mutation: AgentGUIComposerDefaultsMutation;
  reloadComposerOptionsForTarget(input: {
    settings: AgentSessionComposerSettings;
    target: AgentGUIComposerTargetData;
  }): Promise<void>;
  target: AgentGUIComposerTargetData;
}): Promise<void> {
  const result = await input.acknowledgement;
  if (!input.isMountedRef.current) return;

  const currentDraft =
    input.draftSettingsBySessionIdRef.current[input.draftKey];
  if (!currentDraft) {
    return;
  }
  if (
    !acknowledgeAgentGUIComposerDefaultsMutation(
      input.ledger,
      input.mutation,
      result
    )
  ) {
    return;
  }
  await input.reloadComposerOptionsForTarget({
    settings: currentDraft,
    target: input.target
  });
}

function reconcileRetiredDraftMap(
  current: Record<string, AgentSessionComposerSettings>,
  draftKey: string,
  retired: readonly AgentGUIRetiredComposerDefault[]
): Record<string, AgentSessionComposerSettings> {
  const draft = current[draftKey];
  if (!draft) return current;
  const nextDraft = removeRetiredComposerDefaults(draft, retired);
  if (Object.keys(draft).length === Object.keys(nextDraft).length)
    return current;
  const next = { ...current };
  if (Object.keys(nextDraft).length === 0) {
    delete next[draftKey];
  } else {
    next[draftKey] = nextDraft;
  }
  return next;
}
