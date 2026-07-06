import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import { debounce } from "lodash";
import { toast } from "@tutti-os/ui-system";
import { translate } from "../../../i18n/index";
import {
  useAgentActivityRuntime,
  useAgentActivitySnapshot,
  type AgentActivityRuntime
} from "../../../agentActivityRuntime";
import {
  useAgentQueuedPromptRuntime,
  useAgentQueuedPromptSessionSnapshot
} from "../../../agentQueuedPromptRuntime";
import { useAgentHostApi } from "../../../agentActivityHost";
import {
  resolveSubmitAvailability,
  resolveAgentActivityCapability,
  resolveAgentActivityUsage,
  selectSessionDisplayStatuses
} from "@tutti-os/agent-activity-core";
import type {
  AgentActivityCancelSessionResult,
  AgentActivityComposerOptions,
  AgentActivityGoalControlAction,
  AgentActivityDisplayStatus,
  AgentActivitySession,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type {
  AppErrorCode,
  AgentPromptContentBlock,
  AgentProviderId
} from "../../../shared/contracts/dto";
import type {
  AgentModelCatalogInvalidatedEvent,
  AgentActivityStreamEvent,
  AgentActivityMessageUpdate,
  AgentSession,
  AgentSessionCommand,
  AgentSessionComposerSettings,
  AgentSessionPermissionConfig,
  AgentSessionPermissionModeOption,
  AgentSessionReasoningEffort,
  AgentSessionSpeed,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import { AGENT_PROVIDER_LABEL } from "../../../contexts/settings/domain/agentSettings";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderTarget
} from "../../../types";
import {
  agentGUIProviderTargetRefsEqual,
  normalizeAgentGUIProviderTargets,
  resolveAgentGUIProviderTarget
} from "../../../providerTargets";
import {
  AGENT_GUI_RUNTIME_SESSION_ORIGIN,
  buildAgentGUIConversationModels,
  conversationSummaryFromAgentSession,
  applyAgentGUIConversationProjects,
  mergeAgentGUITimelineItems,
  resolveAgentGUIConversationProject,
  resolveAgentGUIConversationTitleFromTimelineItems,
  selectAgentGUIConversationId,
  type AgentGUIApprovalRequest,
  type AgentGUIConversationProjectionSource,
  type AgentGUIInteractivePrompt,
  type AgentGUIInteractiveQuestion,
  type AgentGUIConversationSummary
} from "../model/agentGuiConversationModel";
import {
  createAgentGUIConversationFilterState,
  filterAgentGUIConversationSummaries,
  normalizeAgentGUIConversationFilter,
  type AgentGUIConversationFilter
} from "../model/agentGuiConversationFilter";
import type {
  AgentHostUserProject,
  AgentHostUserProjectsApi
} from "../../../host/agentHostApi";
import type {
  AgentComposerDraft,
  AgentGUIComposerSettingOption,
  AgentGUIComposerSettingsVM,
  AgentGUIProviderSkillOption,
  AgentGUIProjectConversationDeleteTarget,
  AgentGUIQueuedPromptVM,
  AgentGUISessionChrome,
  OpenclawGatewayViewState
} from "../model/agentGuiNodeTypes";
import {
  agentPromptContentDisplayText,
  agentPromptContentHasImage,
  agentPromptContentToComposerDraft,
  emptyAgentComposerDraft,
  normalizeAgentPromptContentBlocks,
  textPromptContent
} from "../model/agentComposerDraft";
import type { AgentApprovalItemVM } from "../../../shared/agentConversation/contracts/agentApprovalItemVM";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { WorkspaceAgentActivityCard } from "../../../shared/workspaceAgentActivityListViewModel";
import type { WorkspaceAgentSessionDetailViewModel } from "../../../shared/workspaceAgentSessionDetailViewModel";
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import { projectCoreSessionStatus } from "../../../shared/agentActivitySnapshotProjection";
import { isWorkspaceAgentUntitledTask } from "../../../shared/workspaceAgentLatestActivitySummary";
import { projectWorkspaceAgentMessagesToTimelineItems } from "../../../shared/agentConversation/projection/workspaceAgentMessageProjection";
import { mergeWorkspaceAgentMessages } from "../../../host/workspaceAgentSessionMessages";
import {
  isWorkspaceAgentActivityOptimisticMessage,
  selectWorkspaceAgentActivityOverlayMessages,
  type WorkspaceAgentActivityMessage,
  type WorkspaceAgentActivityStatePatch,
  type WorkspaceAgentActivitySyncState,
  type WorkspaceAgentActivityTimelineItem
} from "../../../shared/workspaceAgentActivityTypes";
import { useAccountStore } from "../../../host/agentHostAccountStore";
import { subscribeCoalesced } from "../../../host/agentHostEventBus";
import { getAppErrorCode } from "../../../shared/errors/appError";
import {
  deleteAgentSessionView,
  getAgentSessionView,
  mergeAgentSessionViewDetailMessages,
  mergeAgentSessionViewOverlayMessages,
  resetAgentSessionViewDetailMessages,
  setAgentSessionViewError,
  setAgentSessionViewControlState,
  setAgentSessionViewControlStateLoading,
  setAgentSessionViewDetailMessages,
  setAgentSessionViewOverlayMessages,
  setAgentSessionViewMessagesLoading,
  setAgentSessionViewOlderMessagesLoading,
  updateAgentSessionViewControlState,
  type AgentSessionViewRef
} from "../../../contexts/workspace/presentation/renderer/agentSessions/agentSessionViewStore";
import {
  useAgentSessionView,
  useWatchAgentSession,
  useWatchAgentSessions
} from "../../../contexts/workspace/presentation/renderer/agentSessions/useAgentSessionView";
import {
  clearAgentGUIConversationCreatePending,
  clearAgentGUIConversationSubmitPending,
  clearAgentGUIConversationUnreadCompletion,
  createAgentGUIConversationListQueryKey,
  ensureAgentGUIConversationListQuery,
  getAgentGUIConversationCreatePending,
  getAgentGUIConversationSubmitPending,
  markAgentGUIConversationCompletionObserved,
  markAgentGUIConversationCreatePending,
  markAgentGUIConversationSubmitPending,
  markLocalDeletedAgentGUIConversation,
  patchAgentGUIConversationSummary,
  removeAgentGUIConversationSummaries,
  scheduleAgentGUIConversationListProjection,
  seedAgentGUIConversationListConversationsIfEmpty,
  setAgentGUIConversationListActiveConversation,
  subscribeAgentGUIConversationListStore,
  upsertLocalCreatedAgentGUIConversation,
  isAgentGUIConversationListRefreshing,
  type AgentGUIConversationListQuery
} from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore";
import { useAgentGuiConversationList } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { createOptimisticPromptMessage } from "./agentGuiController.promptHelpers";
import { useAgentGUIActivation } from "./useAgentGUIActivation";
import { pendingInterruptActionForDisplayStatus } from "./pendingInterrupt";
import {
  formatAgentMentionMarkdown,
  normalizeAgentSessionMentionTitle
} from "../agentRichText/agentFileMentionExtension";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import { resolveAgentGUIExplicitConversationTitle } from "../model/agentGuiProviderIdentity";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import {
  buildNodeDefaultComposerSettings,
  cloneComposerSettings,
  composerOptionsMissingLiveModelValues,
  composerSupportForProvider,
  liveModelOptionValuesFromRuntimeContext,
  mergeRuntimeContextComposerSettings,
  nodeDataFromComposerSettings,
  normalizeConfigOptionValue,
  normalizePermissionModeId,
  resolveEffectiveComposerSettings,
  sameComposerSettings
} from "./agentGuiController.composerHelpers";
import { mergeAgentSessionControlStateSnapshot } from "./agentGuiController.sessionHelpers";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP,
  latestPlanTurnId,
  planDecisionOps,
  planImplementationPromptFromPlanTurn
} from "../../../shared/agentConversation/planImplementation";
const EMPTY_AGENT_GUI_MESSAGES: readonly WorkspaceAgentActivityMessage[] = [];
const EMPTY_AGENT_GUI_AVAILABLE_COMMANDS: AgentSessionCommand[] = [];
const ACTIVITY_STREAM_STATE_RELOAD_DEBOUNCE_MS = 150;
const AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE = 100;
const AGENT_GUI_DETAIL_MISSING_USER_BACKFILL_PAGE_LIMIT = 3;
const AGENT_GUI_SUBMIT_RETARGET_EARLY_MESSAGE_TOLERANCE_MS = 5_000;

function mergeAgentModelCatalogInvalidationEvents(
  events: AgentModelCatalogInvalidatedEvent[]
): AgentModelCatalogInvalidatedEvent {
  const providers = new Set<AgentProviderId>();
  let occurredAtUnixMs = 0;
  for (const event of events) {
    occurredAtUnixMs = Math.max(occurredAtUnixMs, event.occurredAtUnixMs);
    for (const provider of event.providers) {
      providers.add(provider);
    }
  }
  const lastEvent = events[events.length - 1]!;
  return {
    ...lastEvent,
    providers: [...providers],
    occurredAtUnixMs: occurredAtUnixMs || lastEvent.occurredAtUnixMs
  };
}

const AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR =
  "agent.provider_session_not_found";
const AGENT_RESUME_SESSION_NOT_LOCAL_ERROR = "agent.resume_session_not_local";
const AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR =
  "agent.settings_require_new_session";
const AGENT_SESSION_NOT_FOUND_ERROR = "session.not_found";
const AGENT_PROVIDER_SESSION_NOT_FOUND_FALLBACK_MESSAGE =
  "The previous agent session can no longer be restored.";
const AGENT_RESUME_SESSION_NOT_LOCAL_FALLBACK_MESSAGE =
  "The previous agent session is not available on this machine.";
const AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT = 4000;
const SELECTED_SESSION_NOT_FOUND_RETRY_DELAY_MS = 150;

type AgentGUIRuntimeErrorPhase =
  | "create_conversation"
  | "interrupt_current_turn"
  | "load_session_messages"
  | "load_session_state"
  | "retry_activation"
  | "send_prompt"
  | "submit_interactive"
  | "toggle_conversation_pinned"
  | "delete_conversation"
  | "update_session_settings"
  | "warmup_openclaw_gateway";

interface QueuedComposerSettingsUpdate {
  sessionSettingsPatch: AgentSessionComposerSettings;
}

interface ACPConfigOptionSelection {
  options: AgentGUIComposerSettingOption[];
  currentValue: string | null;
}

interface AgentGUIComposerTargetData {
  agentTargetId: string | null;
  data: AgentGUINodeData;
  provider: AgentGUIProvider;
  providerTargetId: string | null;
  providerTargetRef: AgentGUINodeData["providerTargetRef"];
  targetId: string;
}

// Patch semantics: a missing field was not touched by this switch, null
// clears the remembered value, a string replaces it.
export interface AgentGUIComposerDefaults {
  model?: string | null;
  permissionModeId?: string | null;
  reasoningEffort?: string | null;
  speed?: string | null;
}

export interface AgentGUIRememberComposerDefaultsInput {
  agentTargetId: string | null;
  provider: AgentGUINodeData["provider"];
  defaults: AgentGUIComposerDefaults | null;
}

const rememberComposerDefaultsFields = [
  "model",
  "permissionModeId",
  "reasoningEffort",
  "speed"
] as const;

// Builds the remember patch for one user switch. Only fields present in
// `touched` are recorded: an explicit user clear (touched value empty)
// becomes a null tombstone, while a value that sanitization dropped
// (touched value set, final value empty) is skipped so the remembered
// default survives transient invalid states.
function composerDefaultsPatchFromSettings(
  touched: Partial<AgentSessionComposerSettings>,
  finalSettings: AgentSessionComposerSettings
): AgentGUIComposerDefaults | null {
  const patch: AgentGUIComposerDefaults = {};
  for (const field of rememberComposerDefaultsFields) {
    if (touched[field] === undefined) {
      continue;
    }
    const touchedValue = normalizeOptionalText(touched[field]);
    const finalValue = normalizeOptionalText(finalSettings[field]);
    if (touchedValue !== null && finalValue === null) {
      continue;
    }
    patch[field] = finalValue;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function composerTargetDataFromProviderTarget(input: {
  current: AgentGUINodeData;
  isExplicit: boolean;
  target: AgentGUIProviderTarget;
}): AgentGUIComposerTargetData {
  const agentTargetId = normalizeOptionalText(input.target.agentTargetId);
  const useLegacyProviderTargetRef = !agentTargetId && input.isExplicit;
  const providerTargetId = useLegacyProviderTargetRef
    ? input.target.targetId
    : null;
  const providerTargetRef = useLegacyProviderTargetRef
    ? input.target.ref
    : null;
  const currentAgentTargetId = normalizeOptionalText(
    input.current.agentTargetId
  );
  const currentProviderTargetId = normalizeOptionalText(
    input.current.providerTargetId
  );
  const canPromoteLegacyComposerOverrides =
    agentTargetId !== null &&
    currentAgentTargetId === null &&
    currentProviderTargetId === null &&
    input.current.providerTargetRef == null &&
    input.current.provider === input.target.provider &&
    input.current.composerOverrides != null &&
    !input.current.composerOverridesByAgentTargetId?.[agentTargetId];
  const composerOverridesByAgentTargetId = canPromoteLegacyComposerOverrides
    ? {
        ...(input.current.composerOverridesByAgentTargetId ?? {}),
        [agentTargetId]: input.current.composerOverrides!
      }
    : input.current.composerOverridesByAgentTargetId;
  const currentTargetIdentityChanged =
    input.current.provider !== input.target.provider ||
    (currentAgentTargetId !== null && currentAgentTargetId !== agentTargetId) ||
    (currentProviderTargetId !== null &&
      currentProviderTargetId !== providerTargetId) ||
    (input.current.providerTargetRef != null &&
      !agentGUIProviderTargetRefsEqual(
        input.current.providerTargetRef,
        providerTargetRef
      ));
  return {
    agentTargetId,
    provider: input.target.provider,
    providerTargetId,
    providerTargetRef,
    targetId: input.target.targetId,
    data: {
      ...input.current,
      provider: input.target.provider,
      agentTargetId,
      providerTargetId,
      providerTargetRef,
      composerOverrides: canPromoteLegacyComposerOverrides
        ? null
        : currentTargetIdentityChanged
          ? null
          : input.current.composerOverrides,
      composerOverridesByAgentTargetId
    }
  };
}

function composerTargetDataFromNodeData(
  data: AgentGUINodeData
): AgentGUIComposerTargetData {
  const agentTargetId = normalizeOptionalText(data.agentTargetId);
  const providerTargetId = data.providerTargetId ?? null;
  return {
    agentTargetId,
    provider: data.provider,
    providerTargetId,
    providerTargetRef: data.providerTargetRef ?? null,
    targetId: agentTargetId ?? providerTargetId ?? `local:${data.provider}`,
    data
  };
}

function agentGUINodeDataHasComposerTarget(data: AgentGUINodeData): boolean {
  return (
    normalizeOptionalText(data.agentTargetId) !== null ||
    normalizeOptionalText(data.providerTargetId) !== null ||
    data.providerTargetRef != null
  );
}

function composerOptionsForTarget(input: {
  snapshot: AgentActivitySnapshot;
  target: AgentGUIComposerTargetData;
}): AgentActivityComposerOptions | null {
  if (input.target.agentTargetId) {
    const targetOptions =
      input.snapshot.composerOptionsByAgentTargetId?.[
        input.target.agentTargetId
      ] ?? null;
    if (targetOptions) {
      return targetOptions;
    }
    return null;
  }
  return (
    input.snapshot.composerOptionsByProvider?.[input.target.provider] ?? null
  );
}

function composerOptionValues(
  options: readonly { value: string }[]
): Set<string> {
  return new Set(options.map((option) => option.value));
}

function sanitizeComposerSettingsForOptions(
  settings: AgentSessionComposerSettings,
  options: AgentActivityComposerOptions | null
): AgentSessionComposerSettings {
  if (!options) {
    return settings;
  }
  const modelValues = composerOptionValues(options.models);
  const reasoningValues = composerOptionValues(options.reasoningEfforts);
  const speedValues = composerOptionValues(options.speeds ?? []);
  const permissionValues = new Set(
    options.permissionConfig?.modes.map((mode) => mode.id) ?? []
  );
  const model = normalizeOptionalText(settings.model);
  const reasoningEffort = normalizeOptionalText(settings.reasoningEffort);
  const speed = normalizeOptionalText(settings.speed);
  const permissionModeId = normalizePermissionModeId(settings.permissionModeId);
  const modelOptionsAreAuthoritative = options.provider === "claude-code";
  return {
    ...settings,
    model:
      modelOptionsAreAuthoritative &&
      model &&
      modelValues.size > 0 &&
      !modelValues.has(model)
        ? null
        : model,
    reasoningEffort:
      reasoningEffort &&
      reasoningValues.size > 0 &&
      !reasoningValues.has(reasoningEffort)
        ? null
        : (reasoningEffort as AgentSessionReasoningEffort | null),
    speed:
      speed && speedValues.size > 0 && !speedValues.has(speed)
        ? null
        : (speed as AgentSessionSpeed | null),
    permissionModeId:
      permissionModeId &&
      permissionValues.size > 0 &&
      !permissionValues.has(permissionModeId)
        ? null
        : permissionModeId
  };
}

function sanitizeComposerSettingsForTarget(input: {
  settings: AgentSessionComposerSettings;
  target: AgentGUIComposerTargetData;
  options: AgentActivityComposerOptions | null;
}): AgentSessionComposerSettings {
  if (!input.target.agentTargetId) {
    return input.settings;
  }
  return sanitizeComposerSettingsForOptions(input.settings, input.options);
}

function agentGUIProviderTargetsEqual(
  left: AgentGUIProviderTarget,
  right: AgentGUIProviderTarget
): boolean {
  return (
    left.provider === right.provider &&
    left.targetId === right.targetId &&
    (left.agentTargetId ?? null) === (right.agentTargetId ?? null) &&
    agentGUIProviderTargetRefsEqual(left.ref, right.ref)
  );
}

type AgentSubmitTraceState = {
  agentSessionId: string;
  blockCount: number;
  clientSubmitId: string;
  hasImage: boolean;
  promptLength: number;
  queued: boolean;
  startedAtUnixMs: number;
  turnId: string | null;
};

function reportAgentGUIRuntimeError(input: {
  agentSessionId?: string | null;
  context?: Record<string, unknown>;
  error: unknown;
  phase: AgentGUIRuntimeErrorPhase;
  provider?: string | null;
  requestId?: number | string | null;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  const details: Record<string, unknown> = {
    error: normalizeAgentGUIDiagnosticError(input.error),
    errorCode: getAgentGUIErrorCode(input.error),
    phase: input.phase,
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.requestId !== undefined && input.requestId !== null
      ? { requestId: input.requestId }
      : {}),
    ...(input.context ?? {})
  };
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details,
        event: "agent.gui.caught_error",
        level: "error",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect the Agent GUI recovery path.
  }
}

function reportAgentGUIConversationFilterTargetUnresolved(input: {
  provider: string;
  providerTargetId: string | null;
  providerTargetCount: number;
  reason: "disabled" | "unresolved";
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          provider: input.provider,
          providerTargetCount: input.providerTargetCount,
          providerTargetId: input.providerTargetId,
          reason: input.reason
        },
        event: "agent.gui.conversation_filter.target_unresolved",
        level: "warn",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect conversation filter selection.
  }
}

function reportAgentGUIMessagePageDiagnostic(input: {
  agentSessionId: string;
  details?: Record<string, unknown>;
  event: string;
  level?: "debug" | "info" | "warn";
  messages?: readonly WorkspaceAgentActivityMessage[];
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  const versions = (input.messages ?? [])
    .map((message) => message.version)
    .filter((version) => Number.isFinite(version));
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          agentSessionId: input.agentSessionId,
          ...(input.messages
            ? {
                firstVersion: versions.length ? Math.min(...versions) : null,
                lastVersion: versions.length ? Math.max(...versions) : null,
                messageCount: input.messages.length
              }
            : {}),
          ...(input.details ?? {})
        },
        event: input.event,
        level: input.level ?? "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect message loading.
  }
}

function reportAgentGUIRenderStateDiagnostic(input: {
  activeActivityDisplayStatus: AgentActivityDisplayStatus | null;
  activeConversation: AgentGUIConversationSummary | null;
  activeConversationBusy: boolean;
  activeConversationId: string | null;
  activeHasPendingSubmittedTurn: boolean;
  activeLiveState: "inactive" | "activating" | "active" | "failed";
  activeRuntimeSession: AgentActivitySession | null;
  activeSessionState: AgentSessionState | null;
  activeSubmitBlocked: boolean;
  canQueueWhileBusy: boolean;
  canSubmit: boolean;
  conversation: AgentConversationVM | null;
  isCreatingConversation: boolean;
  isLoadingMessages: boolean;
  isSubmitting: boolean;
  pendingApproval: AgentGUIApprovalRequest | null;
  pendingInteractivePrompt: AgentGUIInteractivePrompt | null;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          activeActivityDisplayStatus: input.activeActivityDisplayStatus,
          activeConversationBusy: input.activeConversationBusy,
          activeConversationId: input.activeConversationId,
          activeConversationStatus: input.activeConversation?.status ?? null,
          activeHasPendingSubmittedTurn: input.activeHasPendingSubmittedTurn,
          activeLiveState: input.activeLiveState,
          activeSubmitBlocked: input.activeSubmitBlocked,
          canQueueWhileBusy: input.canQueueWhileBusy,
          canSubmit: input.canSubmit,
          conversation: agentGUIConversationDiagnosticDetails(
            input.conversation
          ),
          isCreatingConversation: input.isCreatingConversation,
          isLoadingMessages: input.isLoadingMessages,
          isSubmitting: input.isSubmitting,
          pendingApprovalRequestId: input.pendingApproval?.requestId ?? null,
          pendingInteractivePromptKind:
            input.pendingInteractivePrompt?.kind ?? null,
          pendingInteractivePromptRequestId: promptRequestId(
            input.pendingInteractivePrompt
          ),
          runtimeSession: agentGUIRuntimeSessionDiagnosticDetails(
            input.activeRuntimeSession
          ),
          sessionState: agentGUISessionStateDiagnosticDetails(
            input.activeSessionState
          )
        },
        event: "agent.gui.node.render_state_changed",
        level: "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect Agent GUI rendering.
  }
}

function reportAgentGUIActiveConversationCleared(input: {
  details?: Record<string, unknown>;
  previousAgentSessionId: string | null;
  reason: string;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          previousAgentSessionId: input.previousAgentSessionId,
          reason: input.reason,
          ...(input.details ?? {})
        },
        event: "agent.gui.active_conversation.cleared",
        level: "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect active conversation routing.
  }
}

function reportAgentGUIConversationListProjectionSkipped(input: {
  activeConversationId: string | null;
  currentUserIdPresent: boolean;
  dataLastActiveAgentSessionId: string | null;
  isComposerHome: boolean;
  provider: string | null;
  reason: string;
  runtime: AgentActivityRuntime;
  workspaceId: string;
  workspaceIdPresent: boolean;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          activeConversationId: input.activeConversationId,
          currentUserIdPresent: input.currentUserIdPresent,
          dataLastActiveAgentSessionId: input.dataLastActiveAgentSessionId,
          isComposerHome: input.isComposerHome,
          provider: input.provider,
          reason: input.reason,
          workspaceIdPresent: input.workspaceIdPresent
        },
        event: "agent.gui.conversation_list_projection.skipped",
        level: "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect active conversation routing.
  }
}

function reportAgentGUISubmitWithoutActiveConversation(input: {
  blockCount: number;
  conversationCount: number;
  conversationListQueryReady: boolean;
  dataLastActiveAgentSessionId: string | null;
  isComposerHome: boolean;
  promptLength: number;
  provider: string | null;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          blockCount: input.blockCount,
          conversationCount: input.conversationCount,
          conversationListQueryReady: input.conversationListQueryReady,
          dataLastActiveAgentSessionId: input.dataLastActiveAgentSessionId,
          isComposerHome: input.isComposerHome,
          promptLength: input.promptLength,
          provider: input.provider
        },
        event: "agent.gui.submit.without_active_conversation",
        level: "warn",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect active conversation routing.
  }
}

function reportAgentGUISubmitRecoveredActiveConversation(input: {
  blockCount: number;
  conversationCount: number;
  conversationListQueryReady: boolean;
  promptLength: number;
  provider: string | null;
  recoveredAgentSessionId: string;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          blockCount: input.blockCount,
          conversationCount: input.conversationCount,
          conversationListQueryReady: input.conversationListQueryReady,
          promptLength: input.promptLength,
          provider: input.provider,
          recoveredAgentSessionId: input.recoveredAgentSessionId
        },
        event: "agent.gui.submit.recovered_active_conversation",
        level: "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect active conversation routing.
  }
}

function reportAgentGUICancelDiagnostic(input: {
  agentSessionId: string;
  busySource?: string | null;
  currentSessionStatus?: string | null;
  phase: "interrupt_current_turn";
  provider?: string | null;
  result: AgentActivityCancelSessionResult;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  if (input.result.canceled) {
    return;
  }
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          agentSessionId: input.agentSessionId,
          busySource: input.busySource ?? "unknown",
          canceled: input.result.canceled,
          cancelReason: input.result.reason,
          currentSessionStatus: input.currentSessionStatus ?? null,
          phase: input.phase,
          provider: input.provider ?? null,
          returnedSessionNonBusy: cancelResultSessionStatusIsNonBusy(
            input.result
          ),
          returnedSessionStatus: input.result.session.status
        },
        event: "agent.gui.cancel.noop",
        level: "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect the Agent GUI recovery path.
  }
}

function reportAgentSubmitTraceDiagnostic(input: {
  event: string;
  runtime: AgentActivityRuntime;
  trace: AgentSubmitTraceState;
  workspaceId: string;
  fields?: Record<string, unknown>;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  const nowUnixMs = Date.now();
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          agentSessionId: input.trace.agentSessionId,
          blockCount: input.trace.blockCount,
          clientSubmitId: input.trace.clientSubmitId,
          elapsedMs: Math.max(0, nowUnixMs - input.trace.startedAtUnixMs),
          hasImage: input.trace.hasImage,
          promptLength: input.trace.promptLength,
          queued: input.trace.queued,
          startedAtUnixMs: input.trace.startedAtUnixMs,
          traceEvent: input.event,
          turnId: input.trace.turnId,
          ...(input.fields ?? {})
        },
        event: "agent.submit.trace",
        level: "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect the Agent GUI submit path.
  }
}

function scheduleAgentSubmitTracePaint(input: {
  event?: string;
  runtime: AgentActivityRuntime;
  trace: AgentSubmitTraceState;
  workspaceId: string;
}): void {
  const logPaint = () =>
    reportAgentSubmitTraceDiagnostic({
      event: input.event ?? "optimistic_user_message_painted",
      runtime: input.runtime,
      trace: input.trace,
      workspaceId: input.workspaceId
    });
  const requestFrame = globalThis.requestAnimationFrame;
  if (typeof requestFrame !== "function") {
    setTimeout(logPaint, 0);
    return;
  }
  requestFrame(() => requestFrame(logPaint));
}

function createAgentSubmitTraceState(input: {
  agentSessionId: string;
  content: readonly AgentPromptContentBlock[];
  prompt: string;
  queued: boolean;
  startedAtUnixMs: number;
}): AgentSubmitTraceState {
  return {
    agentSessionId: input.agentSessionId,
    blockCount: input.content.length,
    clientSubmitId: createAgentSubmitTraceId(),
    hasImage: agentPromptContentHasImage(input.content),
    promptLength: input.prompt.length,
    queued: input.queued,
    startedAtUnixMs: input.startedAtUnixMs,
    turnId: null
  };
}

function agentSubmitTraceMetadata(
  trace: AgentSubmitTraceState
): Record<string, unknown> {
  return {
    clientSubmitId: trace.clientSubmitId,
    clientSubmittedAtUnixMs: trace.startedAtUnixMs,
    promptBlockCount: trace.blockCount,
    promptHasImage: trace.hasImage,
    promptLength: trace.promptLength,
    queued: trace.queued,
    source: "agent-gui"
  };
}

function createAgentSubmitTraceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `submit-${Date.now().toString(36)}-${fallbackHex.slice(0, 12)}`;
}

function cancelResultSessionStatusIsNonBusy(
  result: AgentActivityCancelSessionResult
): boolean {
  const status = normalizeOptionalWorkspaceAgentStatus({
    currentPhase: result.session.currentPhase,
    status: projectCoreSessionStatus(result.session.status)
  });
  return (
    status !== null && status.kind !== "working" && status.kind !== "waiting"
  );
}

function shouldClearSubmittedDraft(input: {
  currentDraft: AgentComposerDraft | undefined;
  submittedContent: readonly AgentPromptContentBlock[];
}): boolean {
  const currentDraft = input.currentDraft;
  if (!currentDraft) {
    return false;
  }
  const submittedPrompt = agentPromptContentDisplayText(
    input.submittedContent
  ).trim();
  if (currentDraft.prompt.trim() !== submittedPrompt) {
    return false;
  }
  const submittedImages = input.submittedContent.filter(
    (block): block is AgentPromptContentBlock & { type: "image" } =>
      block.type === "image"
  );
  if (currentDraft.images.length !== submittedImages.length) {
    return false;
  }
  const imagesMatch = currentDraft.images.every((image, index) => {
    const submittedImage = submittedImages[index];
    if (!submittedImage || image.mimeType !== submittedImage.mimeType) {
      return false;
    }
    const draftPath = image.path?.trim() ?? "";
    const submittedPath = submittedImage.path?.trim() ?? "";
    const draftData = image.data?.trim() ?? "";
    const submittedData = submittedImage.data?.trim() ?? "";
    const draftName = image.name.trim();
    const submittedName = submittedImage.name?.trim() ?? "";
    return (
      draftPath === submittedPath &&
      draftData === submittedData &&
      draftName === submittedName
    );
  });
  if (!imagesMatch) {
    return false;
  }
  const currentFiles = currentDraft.files ?? [];
  const submittedFiles = input.submittedContent.filter(
    (block): block is AgentPromptContentBlock & { type: "file" } =>
      block.type === "file"
  );
  if (currentFiles.length !== submittedFiles.length) {
    return false;
  }
  return currentFiles.every((file, index) => {
    const submittedFile = submittedFiles[index];
    if (!submittedFile) {
      return false;
    }
    const draftPath = file.path?.trim() ?? "";
    const submittedPath = submittedFile.path?.trim() ?? "";
    const draftHostPath = file.hostPath?.trim() ?? "";
    const submittedHostPath = submittedFile.hostPath?.trim() ?? "";
    const draftAssetId = file.assetId?.trim() ?? "";
    const submittedAssetId = submittedFile.assetId?.trim() ?? "";
    const draftMimeType = file.mimeType?.trim() ?? "";
    const submittedMimeType = submittedFile.mimeType?.trim() ?? "";
    const draftName = file.name.trim();
    const submittedName = submittedFile.name?.trim() ?? "";
    return (
      draftPath === submittedPath &&
      draftHostPath === submittedHostPath &&
      draftAssetId === submittedAssetId &&
      draftMimeType === submittedMimeType &&
      draftName === submittedName &&
      file.sizeBytes === submittedFile.sizeBytes
    );
  });
}

function cancelBusySource(input: {
  conversationStatus?: string | null;
  hasActivePrompt?: boolean;
  runtimeSessionStatus?: string | null;
  sessionStateStatus?: string | null;
}): string {
  if (input.hasActivePrompt) {
    return "interactive_prompt";
  }
  if (
    agentSessionStatusBusy({
      status: input.conversationStatus ?? undefined
    })
  ) {
    return "conversation_status";
  }
  if (
    agentSessionStatusBusy({
      status: input.runtimeSessionStatus ?? undefined
    })
  ) {
    return "runtime_session";
  }
  if (
    agentSessionStatusBusy({
      status: input.sessionStateStatus ?? undefined
    })
  ) {
    return "session_state";
  }
  return "unknown";
}

function normalizeAgentGUIDiagnosticError(
  error: unknown
): Record<string, unknown> {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const appErrorCode = getAgentGUIErrorCode(error);
  const explicitCode = typeof record?.code === "string" ? record.code : null;
  const hasStructuredCode = appErrorCode !== null || explicitCode !== null;
  const nativeRuntimeError =
    error instanceof Error && isNativeRuntimeError(error);
  const base: Record<string, unknown> = {
    ...(error instanceof Error ? { name: error.name } : {}),
    ...(explicitCode ? { code: explicitCode } : {}),
    ...(typeof record?.statusCode === "number"
      ? { statusCode: record.statusCode }
      : {}),
    ...(typeof record?.correlationId === "string"
      ? { correlationId: record.correlationId }
      : {}),
    ...(typeof record?.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record?.retryable === "boolean"
      ? { retryable: record.retryable }
      : {})
  };
  if (nativeRuntimeError) {
    return {
      ...base,
      message: error.message,
      ...(error.stack ? { stack: limitDiagnosticText(error.stack) } : {})
    };
  }
  if (record) {
    return {
      ...base,
      ...(typeof record.name === "string" && !("name" in base)
        ? { name: record.name }
        : {}),
      ...(typeof record.message === "string"
        ? { messageLength: record.message.length }
        : {}),
      ...(typeof record.debugMessage === "string"
        ? { debugMessageLength: record.debugMessage.length }
        : {})
    };
  }
  const rawMessage = getAgentGUIRawErrorMessage(error);
  return {
    ...(hasStructuredCode ? {} : { messageLength: rawMessage?.length ?? 0 }),
    type: typeof error
  };
}

function isNativeRuntimeError(error: Error): boolean {
  return (
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    error instanceof URIError
  );
}

function limitDiagnosticText(value: string): string {
  if (value.length <= AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT) {
    return value;
  }
  return `${value.slice(0, AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT)}...`;
}

function getAgentGUIErrorCode(error: unknown): AppErrorCode | null {
  return (
    getAppErrorCode(error) ??
    inferAgentGUIErrorCodeFromMessage(getAgentGUIRawErrorMessage(error))
  );
}

function inferAgentGUIErrorCodeFromMessage(
  message: string | null
): AppErrorCode | null {
  if (!message) {
    return null;
  }
  switch (message.trim()) {
    case AGENT_PROVIDER_SESSION_NOT_FOUND_FALLBACK_MESSAGE:
      return AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR as AppErrorCode;
    case AGENT_RESUME_SESSION_NOT_LOCAL_FALLBACK_MESSAGE:
      return AGENT_RESUME_SESSION_NOT_LOCAL_ERROR as AppErrorCode;
    default:
      return null;
  }
}

function isProviderSessionNotFoundErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR;
}

function isResumeSessionNotLocalErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_RESUME_SESSION_NOT_LOCAL_ERROR;
}

function isNonRetryableResumeErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return (
    isProviderSessionNotFoundErrorCode(code) ||
    isResumeSessionNotLocalErrorCode(code)
  );
}

function isSessionNotFoundErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_SESSION_NOT_FOUND_ERROR;
}

const WORKSPACE_AGENT_SESSION_NOT_READY_REASON =
  "workspace_agent_session_not_found";

// True when a cancel raced session startup: the workspace agent session is not
// registered in the runtime yet (its thread/start is still in flight), so the
// daemon reports "workspace agent session not found". This is transient — the
// session is connecting — so it must not surface as a hard error.
function isAgentSessionNotReadyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const reason = (error as { reason?: unknown }).reason;
    if (reason === WORKSPACE_AGENT_SESSION_NOT_READY_REASON) {
      return true;
    }
  }
  return (
    getAgentGUIRawErrorMessage(error)?.trim() ===
    "workspace agent session not found"
  );
}

function isSettingsRequireNewSessionErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR;
}

function buildProviderSessionNotFoundActivationError(message?: string | null): {
  code: AppErrorCode;
  message: string;
  debugMessage?: string;
} {
  const localizedMessage = translate("messages.agentProviderSessionNotFound");
  const normalizedMessage =
    typeof message === "string" && message.trim() ? message.trim() : null;
  return {
    code: AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR,
    message: localizedMessage,
    ...(normalizedMessage ? { debugMessage: normalizedMessage } : {})
  };
}

function buildResumeSessionNotLocalActivationError(message?: string | null): {
  code: AppErrorCode;
  message: string;
  debugMessage?: string;
} {
  const localizedMessage = translate("messages.agentResumeSessionNotLocal");
  const normalizedMessage =
    typeof message === "string" && message.trim() ? message.trim() : null;
  return {
    code: AGENT_RESUME_SESSION_NOT_LOCAL_ERROR,
    message: localizedMessage,
    ...(normalizedMessage ? { debugMessage: normalizedMessage } : {})
  };
}

function getAgentGUIErrorMessage(error: unknown): string {
  if (isProviderSessionNotFoundErrorCode(getAgentGUIErrorCode(error))) {
    return translate("messages.agentProviderSessionNotFound");
  }
  if (isResumeSessionNotLocalErrorCode(getAgentGUIErrorCode(error))) {
    return translate("messages.agentResumeSessionNotLocal");
  }
  if (isSettingsRequireNewSessionErrorCode(getAgentGUIErrorCode(error))) {
    return translate("messages.agentSettingsRequireNewSession");
  }
  if (error && typeof error === "object") {
    const debugMessage = (error as { debugMessage?: unknown }).debugMessage;
    if (typeof debugMessage === "string" && debugMessage.trim()) {
      return debugMessage.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function getAgentGUIRawErrorMessage(error: unknown): string | null {
  if (error && typeof error === "object") {
    const debugMessage = (error as { debugMessage?: unknown }).debugMessage;
    if (typeof debugMessage === "string" && debugMessage.trim()) {
      return debugMessage.trim();
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return null;
}

function buildContinueInNewConversationPrompt(input: {
  workspaceId: string;
  agentSessionId: string;
  conversationUserId?: string | null;
  currentUserId?: string | null;
  userProfilesByUserId: Record<string, { name?: string | null }>;
  provider: string;
  conversationTitle: string;
  existingDraftPrompt: string;
}): string {
  const providerLabelFromCatalog =
    AGENT_PROVIDER_LABEL[input.provider as keyof typeof AGENT_PROVIDER_LABEL] ??
    null;
  const providerLabel =
    providerLabelFromCatalog || input.provider.trim() || "Agent";
  const normalizedTitle = normalizeAgentSessionMentionTitle(
    input.conversationTitle
  );
  const normalizedConversationUserId = input.conversationUserId?.trim() ?? "";
  const normalizedCurrentUserId = input.currentUserId?.trim() ?? "";
  const initiatorName =
    (normalizedConversationUserId &&
      input.userProfilesByUserId[normalizedConversationUserId]?.name?.trim()) ||
    (normalizedCurrentUserId &&
      input.userProfilesByUserId[normalizedCurrentUserId]?.name?.trim()) ||
    normalizedConversationUserId ||
    normalizedCurrentUserId ||
    translate("messages.agentThisSessionMentionLabel").trim();
  const mentionLabel = `${initiatorName} & ${providerLabel}${
    normalizedTitle ? ` ${normalizedTitle}` : ""
  }`.trim();
  const href = createRichTextMentionHref({
    providerId: "agent-session",
    entityId: input.agentSessionId,
    label: mentionLabel,
    scope: { workspaceId: input.workspaceId }
  });
  const mention = formatAgentMentionMarkdown({
    kind: "session",
    href,
    workspaceId: input.workspaceId,
    targetId: input.agentSessionId,
    name: mentionLabel,
    title: normalizedTitle || providerLabel,
    scope: "my_sessions",
    initiatorName,
    agentName: providerLabel
  });
  const existingDraftPrompt = input.existingDraftPrompt.trim();
  if (!existingDraftPrompt) {
    return `${mention} `;
  }
  if (existingDraftPrompt.includes(href)) {
    return existingDraftPrompt;
  }
  return `${mention} ${existingDraftPrompt}`;
}

export function resolveConversationUpdatedAtUnixMsFromSessionState(input: {
  currentUpdatedAtUnixMs: number;
  snapshotUpdatedAtUnixMs?: number;
  source?: "conversation-selected" | "activity-stream" | "settings-update";
}): number {
  if (input.source === "conversation-selected") {
    return input.currentUpdatedAtUnixMs;
  }
  const updatedAtUnixMs = input.snapshotUpdatedAtUnixMs ?? Date.now();
  return Math.max(input.currentUpdatedAtUnixMs, updatedAtUnixMs);
}

type ConversationIntent =
  | { tag: "home" }
  | { tag: "requested"; id: string }
  | { tag: "resolving"; id: string }
  | { tag: "active"; id: string };

function resolveConversationSummaryById(
  conversations: readonly AgentGUIConversationSummary[],
  conversationId: string | null | undefined,
  transientConversation: AgentGUIConversationSummary | null
): AgentGUIConversationSummary | null {
  const normalized = conversationId?.trim() ?? "";
  if (!normalized) {
    return null;
  }
  return (
    conversations.find((conversation) => conversation.id === normalized) ??
    (transientConversation?.id === normalized ? transientConversation : null)
  );
}

function mergeVisibleConversations(
  conversations: readonly AgentGUIConversationSummary[],
  transientConversation: AgentGUIConversationSummary | null
): AgentGUIConversationSummary[] {
  if (!transientConversation) {
    return [...conversations];
  }
  if (
    conversations.some(
      (conversation) => conversation.id === transientConversation.id
    )
  ) {
    return [...conversations];
  }
  return [transientConversation, ...conversations];
}

function stableConversationSummaryList(
  previous: readonly AgentGUIConversationSummary[] | null,
  next: AgentGUIConversationSummary[]
): AgentGUIConversationSummary[] {
  if (previous?.length !== next.length) {
    const previousById = new Map(
      (previous ?? []).map((conversation) => [conversation.id, conversation])
    );
    return next.map((conversation) => {
      const previousConversation = previousById.get(conversation.id);
      return previousConversation &&
        conversationSummariesRenderEqual(previousConversation, conversation)
        ? previousConversation
        : conversation;
    });
  }
  let hasRenderChange = false;
  const stable = next.map((conversation, index) => {
    const previousConversation = previous[index];
    if (
      previousConversation &&
      conversationSummariesRenderEqual(previousConversation, conversation)
    ) {
      return previousConversation;
    }
    hasRenderChange = true;
    return conversation;
  });
  return hasRenderChange ? stable : (previous as AgentGUIConversationSummary[]);
}

function useStableConversationDetail(
  detail: WorkspaceAgentSessionDetailViewModel | null
): WorkspaceAgentSessionDetailViewModel | null {
  const detailRef = useRef<WorkspaceAgentSessionDetailViewModel | null>(null);
  detailRef.current = stabilizeConversationDetail(detailRef.current, detail);
  return detailRef.current;
}

function stabilizeConversationDetail(
  previous: WorkspaceAgentSessionDetailViewModel | null,
  next: WorkspaceAgentSessionDetailViewModel | null
): WorkspaceAgentSessionDetailViewModel | null {
  if (!previous || !next) {
    return next;
  }
  const session = conversationDetailSessionsEqual(
    previous.session,
    next.session
  )
    ? previous.session
    : next.session;
  const activity = stabilizeConversationDetailActivity(
    previous.activity,
    next.activity
  );
  if (
    previous.cwd === next.cwd &&
    previous.workspaceRoot === next.workspaceRoot &&
    previous.showProcessingIndicator === next.showProcessingIndicator &&
    previous.turns === next.turns &&
    previous.session === session &&
    previous.activity === activity
  ) {
    return previous;
  }
  return {
    ...next,
    activity,
    session
  };
}

function stabilizeConversationDetailActivity(
  previous: WorkspaceAgentActivityCard,
  next: WorkspaceAgentActivityCard
): WorkspaceAgentActivityCard {
  const changedFiles = conversationDetailChangedFilesEqual(
    previous.changedFiles,
    next.changedFiles
  )
    ? previous.changedFiles
    : next.changedFiles;
  if (
    previous.id === next.id &&
    previous.sessionId === next.sessionId &&
    previous.userId === next.userId &&
    previous.userName === next.userName &&
    previous.userAvatarUrl === next.userAvatarUrl &&
    previous.agentProvider === next.agentProvider &&
    previous.agentName === next.agentName &&
    previous.title === next.title &&
    previous.status === next.status &&
    previous.latestActivitySummary === next.latestActivitySummary &&
    previous.conversationPreview === next.conversationPreview &&
    previous.latestActivityActorName === next.latestActivityActorName &&
    previous.toolCalls === next.toolCalls &&
    previous.changedFiles === changedFiles &&
    previous.sortTimeUnixMs === next.sortTimeUnixMs &&
    previous.readTimeUnixMs === next.readTimeUnixMs
  ) {
    return previous;
  }
  return {
    ...next,
    changedFiles
  };
}

function conversationDetailChangedFilesEqual(
  left: WorkspaceAgentActivityCard["changedFiles"],
  right: WorkspaceAgentActivityCard["changedFiles"]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.path === right[index]?.path && file.label === right[index]?.label
    )
  );
}

function conversationDetailSessionsEqual(
  left: WorkspaceAgentSessionDetailViewModel["session"],
  right: WorkspaceAgentSessionDetailViewModel["session"]
): boolean {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.agentSessionId === right.agentSessionId &&
    left.presenceId === right.presenceId &&
    left.userId === right.userId &&
    left.provider === right.provider &&
    left.providerSessionId === right.providerSessionId &&
    left.resumable === right.resumable &&
    left.sessionOrigin === right.sessionOrigin &&
    left.lifecycleStatus === right.lifecycleStatus &&
    left.turnPhase === right.turnPhase &&
    left.endedAtUnixMs === right.endedAtUnixMs &&
    left.effectiveStatus === right.effectiveStatus &&
    left.status === right.status &&
    left.title === right.title &&
    left.pinnedAtUnixMs === right.pinnedAtUnixMs &&
    left.createdAtUnixMs === right.createdAtUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.cwd === right.cwd &&
    conversationSyncStatesEqual(left.syncState, right.syncState)
  );
}

function conversationSummariesRenderEqual(
  left: AgentGUIConversationSummary,
  right: AgentGUIConversationSummary
): boolean {
  return (
    left.id === right.id &&
    left.userId === right.userId &&
    left.provider === right.provider &&
    left.title === right.title &&
    conversationTitleFallbacksRenderEqual(
      left.titleFallback,
      right.titleFallback
    ) &&
    left.status === right.status &&
    left.cwd === right.cwd &&
    left.pinnedAtUnixMs === right.pinnedAtUnixMs &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.isImported === right.isImported &&
    left.hasUnreadCompletion === right.hasUnreadCompletion &&
    left.unreadCompletionKey === right.unreadCompletionKey &&
    conversationProjectsRenderEqual(left.project, right.project) &&
    conversationSyncStatesEqual(left.syncState, right.syncState)
  );
}

function conversationTitleFallbacksRenderEqual(
  left: AgentGUIConversationSummary["titleFallback"],
  right: AgentGUIConversationSummary["titleFallback"]
): boolean {
  return (
    left === right ||
    JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  );
}

function conversationProjectsRenderEqual(
  left: AgentGUIConversationSummary["project"],
  right: AgentGUIConversationSummary["project"]
): boolean {
  return (
    left === right ||
    (!left || !right
      ? !left && !right
      : left.id === right.id &&
        left.path === right.path &&
        left.label === right.label &&
        left.createdAtUnixMs === right.createdAtUnixMs &&
        left.updatedAtUnixMs === right.updatedAtUnixMs &&
        left.lastUsedAtUnixMs === right.lastUsedAtUnixMs)
  );
}

function mergeConversationTitleUpdateFields(
  current: AgentGUIConversationSummary,
  incomingTitle: string,
  provider?: AgentProviderId
): Pick<AgentGUIConversationSummary, "title" | "titleFallback"> {
  const title = incomingTitle.trim();
  if (!title) {
    return {
      title: current.title,
      titleFallback: current.titleFallback
    };
  }
  const currentHasPromptTitle = hasPromptConversationTitle(current);
  if (currentHasPromptTitle) {
    return {
      title: current.title,
      titleFallback: current.titleFallback
    };
  }
  if (
    provider &&
    shouldPreserveExistingConversationTitle(current, title, provider)
  ) {
    return {
      title: current.title,
      titleFallback: current.titleFallback
    };
  }
  return {
    title,
    titleFallback: null
  };
}

function shouldPreserveExistingConversationTitle(
  current: AgentGUIConversationSummary,
  incomingTitle: string,
  provider: AgentProviderId
): boolean {
  const normalizedIncoming = incomingTitle.trim();
  if (!normalizedIncoming || !current.title.trim()) {
    return false;
  }
  if (isWorkspaceAgentUntitledTask(normalizedIncoming)) {
    return true;
  }
  const providerLabel =
    AGENT_PROVIDER_LABEL[provider as keyof typeof AGENT_PROVIDER_LABEL] ??
    provider;
  return (
    normalizedIncoming === provider || normalizedIncoming === providerLabel
  );
}

function sessionHasRenderableMessages(input: {
  agentSessionId: string;
  hasLoadedInitialMessages?: boolean;
  sessionViewRef: (agentSessionId: string | null) => AgentSessionViewRef;
  snapshotMessagesById: Record<string, WorkspaceAgentActivityMessage[]>;
}): boolean {
  const normalizedAgentSessionId = input.agentSessionId.trim();
  if (!normalizedAgentSessionId) {
    return false;
  }
  const sessionView = getAgentSessionView(
    input.sessionViewRef(normalizedAgentSessionId)
  );
  if (
    sessionViewHasUnhydratedOlderDetailMessages({
      agentSessionId: normalizedAgentSessionId,
      detailMessages: sessionView?.detailMessages ?? [],
      hasLoadedInitialMessages: input.hasLoadedInitialMessages === true,
      hasOlderMessages: sessionView?.hasOlderMessages ?? false,
      oldestLoadedVersion: sessionView?.oldestLoadedVersion ?? null,
      snapshotMessagesById: input.snapshotMessagesById
    })
  ) {
    return false;
  }
  return (
    (sessionView?.detailMessages?.length ?? 0) > 0 ||
    (sessionView?.overlayMessages?.length ?? 0) > 0
  );
}

function sessionViewHasUnhydratedOlderDetailMessages(input: {
  agentSessionId: string;
  detailMessages: readonly WorkspaceAgentActivityMessage[];
  hasLoadedInitialMessages: boolean;
  hasOlderMessages: boolean;
  oldestLoadedVersion: number | null;
  snapshotMessagesById: Record<string, WorkspaceAgentActivityMessage[]>;
}): boolean {
  if (
    input.hasLoadedInitialMessages ||
    input.hasOlderMessages ||
    input.detailMessages.length === 0
  ) {
    return false;
  }
  const oldestLoadedVersion =
    input.oldestLoadedVersion ?? minFiniteMessageVersion(input.detailMessages);
  if (oldestLoadedVersion === null) {
    return false;
  }
  const snapshotOldestVersion = minFiniteMessageVersion(
    input.snapshotMessagesById[input.agentSessionId] ?? []
  );
  return (
    oldestLoadedVersion > 1 ||
    (snapshotOldestVersion !== null &&
      snapshotOldestVersion < oldestLoadedVersion)
  );
}

function filterMessagesForDetailWindowOverlay(input: {
  detailMessages: readonly WorkspaceAgentActivityMessage[];
  durableMessages: readonly WorkspaceAgentActivityMessage[];
  localMessages: readonly WorkspaceAgentActivityMessage[];
}): WorkspaceAgentActivityMessage[] {
  if (input.localMessages.length === 0) {
    return [];
  }
  if (input.detailMessages.length === 0) {
    if (input.durableMessages.length <= AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE) {
      return [...input.localMessages];
    }
    const newestDurableVersion = maxFiniteMessageVersion(input.durableMessages);
    return input.localMessages.filter((message) => {
      if (isWorkspaceAgentActivityOptimisticMessage(message)) {
        return true;
      }
      return (
        newestDurableVersion !== null &&
        Number.isFinite(message.version) &&
        message.version >= newestDurableVersion
      );
    });
  }

  const boundedDetailMessages = input.detailMessages.filter(
    (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
  );
  const oldestDetailVersion = minFiniteMessageVersion(boundedDetailMessages);
  const newestDetailVersion = maxFiniteMessageVersion(boundedDetailMessages);
  if (oldestDetailVersion === null && newestDetailVersion === null) {
    const optimisticWindowMessages = filterMessagesForOptimisticDetailWindow({
      detailMessages: input.detailMessages,
      localMessages: input.localMessages
    });
    return optimisticWindowMessages.length > 0 ||
      input.detailMessages.some(isWorkspaceAgentActivityOptimisticMessage)
      ? optimisticWindowMessages
      : [...input.localMessages];
  }
  return input.localMessages.filter((message) => {
    if (isWorkspaceAgentActivityOptimisticMessage(message)) {
      return true;
    }
    if (!Number.isFinite(message.version)) {
      return true;
    }
    if (newestDetailVersion !== null && message.version > newestDetailVersion) {
      return true;
    }
    return (
      oldestDetailVersion !== null && message.version >= oldestDetailVersion
    );
  });
}

function filterMessagesForOptimisticDetailWindow(input: {
  detailMessages: readonly WorkspaceAgentActivityMessage[];
  localMessages: readonly WorkspaceAgentActivityMessage[];
}): WorkspaceAgentActivityMessage[] {
  const optimisticTurnIds = new Set(
    input.detailMessages
      .filter(isWorkspaceAgentActivityOptimisticMessage)
      .map((message) => message.turnId?.trim() ?? "")
      .filter(Boolean)
  );
  if (optimisticTurnIds.size === 0) {
    return [];
  }
  return input.localMessages.filter((message) => {
    if (isWorkspaceAgentActivityOptimisticMessage(message)) {
      return true;
    }
    const turnId = message.turnId?.trim() ?? "";
    return turnId !== "" && optimisticTurnIds.has(turnId);
  });
}

function retargetOptimisticPromptMessages(
  messages: readonly WorkspaceAgentActivityMessage[],
  input: { clientSubmitId: string; turnId: string }
): { changed: boolean; messages: WorkspaceAgentActivityMessage[] } {
  const clientSubmitId = input.clientSubmitId.trim();
  const turnId = input.turnId.trim();
  if (!clientSubmitId || !turnId || messages.length === 0) {
    return { changed: false, messages: [...messages] };
  }
  const pendingTurnId = createPendingOptimisticTurnId(clientSubmitId);
  let changed = false;
  const retargeted = messages.map((message) => {
    if (
      !isWorkspaceAgentActivityOptimisticMessage(message) ||
      message.turnId?.trim() !== pendingTurnId
    ) {
      return message;
    }
    const messageClientSubmitId = message.payload?.clientSubmitId;
    if (
      typeof messageClientSubmitId === "string" &&
      messageClientSubmitId.trim() &&
      messageClientSubmitId.trim() !== clientSubmitId
    ) {
      return message;
    }
    changed = true;
    return { ...message, turnId };
  });
  return { changed, messages: retargeted };
}

function removeOptimisticPromptMessagesByClientSubmitId(
  messages: readonly WorkspaceAgentActivityMessage[],
  clientSubmitId: string
): { changed: boolean; messages: WorkspaceAgentActivityMessage[] } {
  const normalizedClientSubmitId = clientSubmitId.trim();
  if (!normalizedClientSubmitId || messages.length === 0) {
    return { changed: false, messages: [...messages] };
  }
  const filtered = messages.filter((message) => {
    if (!isWorkspaceAgentActivityOptimisticMessage(message)) {
      return true;
    }
    const messageClientSubmitId = message.payload?.clientSubmitId;
    return (
      typeof messageClientSubmitId !== "string" ||
      messageClientSubmitId.trim() !== normalizedClientSubmitId
    );
  });
  return {
    changed: filtered.length !== messages.length,
    messages: filtered
  };
}

function shouldRetargetOptimisticPromptFromMessage(
  message: WorkspaceAgentActivityMessage,
  trace: AgentSubmitTraceState
): boolean {
  const turnId = message.turnId?.trim() ?? "";
  if (!turnId || trace.turnId) {
    return false;
  }
  const clientSubmitId = stringPayloadValue(message.payload, "clientSubmitId");
  if (clientSubmitId?.trim()) {
    return clientSubmitId.trim() === trace.clientSubmitId;
  }
  if (message.role.trim().toLowerCase() === "user") {
    return false;
  }
  const messageTimeUnixMs = messageActivityTimeUnixMs(message);
  return (
    messageTimeUnixMs === null ||
    messageTimeUnixMs >=
      trace.startedAtUnixMs -
        AGENT_GUI_SUBMIT_RETARGET_EARLY_MESSAGE_TOLERANCE_MS
  );
}

function messageActivityTimeUnixMs(
  message: WorkspaceAgentActivityMessage
): number | null {
  for (const value of [
    message.occurredAtUnixMs,
    message.startedAtUnixMs,
    message.completedAtUnixMs
  ]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function minFiniteMessageVersion(
  messages: readonly WorkspaceAgentActivityMessage[]
): number | null {
  let result: number | null = null;
  for (const message of messages) {
    // Optimistic echoes live outside the durable version domain (version 0)
    // and must never feed a paging cursor.
    if (
      !Number.isFinite(message.version) ||
      isWorkspaceAgentActivityOptimisticMessage(message)
    ) {
      continue;
    }
    result =
      result === null ? message.version : Math.min(result, message.version);
  }
  return result;
}

function isUserTextMessage(message: WorkspaceAgentActivityMessage): boolean {
  return (
    message.kind.trim().toLowerCase() === "text" &&
    message.role.trim().toLowerCase() === "user" &&
    workspaceAgentActivityMessageText(message).trim() !== ""
  );
}

// The initial-load backfill target: a turn inside the paged window whose user
// prompt has not been loaded yet. Checking for "any user text message" is not
// enough - under rapid-fire submits the newest page can contain a later
// turn's prompt while an earlier turn's prompt is still buried below the
// window (the "user message disappears after reload" shape). Turns whose rows
// all sit ABOVE the newest paged version are the live tail: their user row
// arrives over the stream, not from older pages, so they must not trigger a
// backfill.
function windowHasTurnMissingUserPrompt(
  messages: readonly WorkspaceAgentActivityMessage[],
  newestPagedVersion: number | null
): boolean {
  if (newestPagedVersion === null) {
    return messages.length > 0 && !messages.some(isUserTextMessage);
  }
  const turnIdsWithUserPrompt = new Set<string>();
  const pagedTurnIds = new Set<string>();
  for (const message of messages) {
    if (isWorkspaceAgentActivityOptimisticMessage(message)) {
      continue;
    }
    const turnId = message.turnId?.trim() ?? "";
    if (!turnId) {
      continue;
    }
    if (
      Number.isFinite(message.version) &&
      message.version <= newestPagedVersion
    ) {
      pagedTurnIds.add(turnId);
    }
    if (isUserTextMessage(message)) {
      turnIdsWithUserPrompt.add(turnId);
    }
  }
  if (pagedTurnIds.size === 0) {
    return false;
  }
  for (const turnId of pagedTurnIds) {
    if (!turnIdsWithUserPrompt.has(turnId)) {
      return true;
    }
  }
  return false;
}

function workspaceAgentActivityMessageText(
  message: WorkspaceAgentActivityMessage
): string {
  const payload = message.payload;
  const displayPrompt = stringPayloadValue(payload, "displayPrompt");
  if (displayPrompt?.trim()) {
    return displayPrompt;
  }
  const text = stringPayloadValue(payload, "text");
  if (text?.trim()) {
    return text;
  }
  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          return "";
        }
        const textBlock = (block as { text?: unknown }).text;
        return typeof textBlock === "string" ? textBlock : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function maxFiniteMessageVersion(
  messages: readonly WorkspaceAgentActivityMessage[]
): number | null {
  let result: number | null = null;
  for (const message of messages) {
    if (
      !Number.isFinite(message.version) ||
      isWorkspaceAgentActivityOptimisticMessage(message)
    ) {
      continue;
    }
    result =
      result === null ? message.version : Math.max(result, message.version);
  }
  return result;
}

function hasPromptConversationTitle(
  conversation: AgentGUIConversationSummary
): boolean {
  return resolveAgentGUIExplicitConversationTitle(conversation) !== null;
}

function syncStateUpdatedAtUnixMs(
  syncState: WorkspaceAgentActivitySyncState | null | undefined
): number | null {
  const updatedAtUnixMs = syncState?.updatedAtUnixMs;
  return typeof updatedAtUnixMs === "number" && Number.isFinite(updatedAtUnixMs)
    ? updatedAtUnixMs
    : null;
}

function shouldApplySyncState(
  currentSyncState: WorkspaceAgentActivitySyncState | null | undefined,
  nextSyncState: WorkspaceAgentActivitySyncState
): boolean {
  const currentUpdatedAtUnixMs = syncStateUpdatedAtUnixMs(currentSyncState);
  const nextUpdatedAtUnixMs = syncStateUpdatedAtUnixMs(nextSyncState);
  return !(
    currentUpdatedAtUnixMs !== null &&
    nextUpdatedAtUnixMs !== null &&
    nextUpdatedAtUnixMs < currentUpdatedAtUnixMs
  );
}

function hasPendingSyncReplay(
  syncState: WorkspaceAgentActivitySyncState | null | undefined
): boolean {
  const status = syncState?.status.trim().toLowerCase() ?? "";
  return (
    status === "pending" ||
    (syncState?.pendingTimelineItemCount ?? 0) > 0 ||
    (syncState?.pendingStatePatchCount ?? 0) > 0
  );
}

function hasSettledTimelineEvidence(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): boolean {
  if (timelineItems.length === 0) {
    return false;
  }
  let latestTurnId: string | null = null;
  let latestTurnTime = -1;
  for (const item of timelineItems) {
    const turnId = item.turnId?.trim();
    if (!turnId) {
      continue;
    }
    const occurredAtUnixMs = timelineItemTime(item);
    if (occurredAtUnixMs >= latestTurnTime) {
      latestTurnTime = occurredAtUnixMs;
      latestTurnId = turnId;
    }
  }
  const relevantItems = latestTurnId
    ? timelineItems.filter((item) => item.turnId?.trim() === latestTurnId)
    : timelineItems;
  if (
    relevantItems.length === 0 ||
    conversationStatusFromTimelineItems(relevantItems) !== null
  ) {
    return false;
  }
  return relevantItems.some((item) => {
    const normalizedStatus = normalizeOptionalWorkspaceAgentStatus({
      status: item.status ?? stringPayloadValue(item.payload, "status")
    })?.kind;
    return (
      item.role === "assistant" ||
      normalizedStatus === "completed" ||
      normalizedStatus === "ready" ||
      normalizedStatus === "failed" ||
      normalizedStatus === "canceled"
    );
  });
}

function canSettleBusyConversationFromSessionState(input: {
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
  syncState: WorkspaceAgentActivitySyncState | null | undefined;
}): boolean {
  return (
    !hasPendingSyncReplay(input.syncState) &&
    (input.syncState !== null && input.syncState !== undefined
      ? true
      : hasSettledTimelineEvidence(input.timelineItems))
  );
}

function isSettledConversationStatus(
  status: AgentGUIConversationSummary["status"]
): status is Exclude<
  AgentGUIConversationSummary["status"],
  "working" | "waiting"
> {
  return !conversationBusyStatus(status);
}

function settledConversationStatusFromSessionState(input: {
  currentStatus: AgentGUIConversationSummary["status"];
  sessionState: AgentSessionState | null | undefined;
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
}): Exclude<
  AgentGUIConversationSummary["status"],
  "working" | "waiting"
> | null {
  if (!conversationBusyStatus(input.currentStatus) || !input.sessionState) {
    return null;
  }
  const sessionStatus = conversationStatusFromSessionState(input.sessionState);
  if (!sessionStatus || !isSettledConversationStatus(sessionStatus)) {
    return null;
  }
  return hasSettledTimelineEvidence(input.timelineItems) ? sessionStatus : null;
}

function resolveConversationStatusFromTimelineEvidence(input: {
  status: AgentGUIConversationSummary["status"];
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
}): AgentGUIConversationSummary["status"] {
  if (
    input.status === "canceled" &&
    hasRejectedApprovalDecision(input.timelineItems)
  ) {
    return "completed";
  }
  return input.status;
}

function hasRejectedApprovalDecision(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): boolean {
  return timelineItems.some((item) => {
    const payload = item.payload ?? {};
    const callType = (
      item.callType ??
      stringPayloadValue(payload, "callType") ??
      ""
    )
      .trim()
      .toLowerCase();
    const toolName = (stringPayloadValue(payload, "toolName") ?? "")
      .trim()
      .toLowerCase();
    if (callType !== "approval" && toolName !== "approval") {
      return false;
    }
    const status = normalizeOptionalWorkspaceAgentStatus({
      status: item.status ?? stringPayloadValue(payload, "status")
    })?.kind;
    if (status !== "completed") {
      return false;
    }
    const output = recordValue(payload.output);
    return isRejectedApprovalDecision(output);
  });
}

function isRejectedApprovalDecision(
  output: Record<string, unknown> | null | undefined
): boolean {
  const selectedId = stringPayloadValue(output ?? undefined, "selectedId");
  if (!selectedId) {
    return false;
  }
  switch (normalizeApprovalDecisionToken(selectedId)) {
    case "deny":
    case "denied":
    case "disallow":
    case "reject":
    case "rejected":
    case "rejectonce":
    case "decline":
    case "declined":
    case "no":
      return true;
    default:
      return false;
  }
}

function normalizeApprovalDecisionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function resolveConversationStatusAfterTimelineUpdate(input: {
  currentStatus: AgentGUIConversationSummary["status"];
  incomingTimelineStatus: Extract<
    AgentGUIConversationSummary["status"],
    "working" | "waiting"
  > | null;
  sessionState: AgentSessionState | null | undefined;
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
}): AgentGUIConversationSummary["status"] {
  const projectedStatus = input.incomingTimelineStatus ?? input.currentStatus;
  if (!hasSettledTimelineEvidence(input.timelineItems)) {
    return resolveConversationStatusFromTimelineEvidence({
      status: projectedStatus,
      timelineItems: input.timelineItems
    });
  }
  const settledStatus =
    settledConversationStatusFromSessionState({
      currentStatus: projectedStatus,
      sessionState: input.sessionState,
      timelineItems: input.timelineItems
    }) ?? projectedStatus;
  return resolveConversationStatusFromTimelineEvidence({
    status: settledStatus,
    timelineItems: input.timelineItems
  });
}

export function syncStateRenderFieldsEqual(
  currentSyncState: WorkspaceAgentActivitySyncState | null | undefined,
  nextSyncState: WorkspaceAgentActivitySyncState
): boolean {
  if (!currentSyncState) {
    return false;
  }
  return (
    (currentSyncState.agentSessionId?.trim() ?? "") ===
      (nextSyncState.agentSessionId?.trim() ?? "") &&
    (currentSyncState.status?.trim() ?? "") ===
      (nextSyncState.status?.trim() ?? "") &&
    (currentSyncState.lastError?.trim() ?? "") ===
      (nextSyncState.lastError?.trim() ?? "") &&
    (currentSyncState.pendingTimelineItemCount ?? 0) ===
      (nextSyncState.pendingTimelineItemCount ?? 0) &&
    (currentSyncState.pendingStatePatchCount ?? 0) ===
      (nextSyncState.pendingStatePatchCount ?? 0)
  );
}

function conversationSyncStatesEqual(
  currentSyncState: WorkspaceAgentActivitySyncState | null | undefined,
  nextSyncState: WorkspaceAgentActivitySyncState | null | undefined
): boolean {
  if (!currentSyncState || !nextSyncState) {
    return currentSyncState === nextSyncState;
  }
  return (
    syncStateRenderFieldsEqual(currentSyncState, nextSyncState) &&
    syncStateUpdatedAtUnixMs(currentSyncState) ===
      syncStateUpdatedAtUnixMs(nextSyncState)
  );
}

function mergeConversationSummaryWithRuntimeSession(input: {
  conversation: AgentGUIConversationSummary;
  runtimeSyncState: WorkspaceAgentActivitySyncState | null | undefined;
}): AgentGUIConversationSummary {
  if (
    conversationSyncStatesEqual(
      input.conversation.syncState,
      input.runtimeSyncState
    )
  ) {
    return input.conversation;
  }
  return {
    ...input.conversation,
    syncState: input.runtimeSyncState ?? undefined
  };
}

function runtimeSessionSyncState(
  session: unknown
): WorkspaceAgentActivitySyncState | null | undefined {
  if (!session || typeof session !== "object") {
    return undefined;
  }
  const syncState = (session as { syncState?: unknown }).syncState;
  if (!syncState || typeof syncState !== "object") {
    return undefined;
  }
  return syncState as WorkspaceAgentActivitySyncState;
}

function stringPayloadValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" ? nested : undefined;
}

function createAgentGUIConversationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}

function createPendingOptimisticTurnId(clientSubmitId: string): string {
  return `pending:${clientSubmitId}`;
}

function projectAgentGUIMessagesToTimelineItems(
  messages: readonly WorkspaceAgentActivityMessage[]
): WorkspaceAgentActivityTimelineItem[] {
  return mergeAgentGUITimelineItems(
    [],
    projectWorkspaceAgentMessagesToTimelineItems(messages)
  );
}

function normalizeOptionalText(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveSameProviderActiveSessionModel(input: {
  activeProvider?: string | null;
  agentSessionId?: string | null;
  provider: string;
  runtime: AgentActivityRuntime;
  sessionState?: { settings?: AgentSessionComposerSettings | null } | null;
  workspaceId: string;
}): string | null {
  const agentSessionId = normalizeOptionalText(input.agentSessionId);
  if (agentSessionId === null) {
    return null;
  }
  const runtimeSession =
    input.runtime
      .getSnapshot(input.workspaceId)
      .sessions.find(
        (candidate) => candidate.agentSessionId.trim() === agentSessionId
      ) ?? null;
  const activeProvider =
    normalizeOptionalText(runtimeSession?.provider) ??
    normalizeOptionalText(input.activeProvider);
  if (activeProvider !== input.provider) {
    return null;
  }
  return (
    normalizeOptionalText(input.sessionState?.settings?.model) ??
    normalizeOptionalText(runtimeSession?.model)
  );
}

function normalizeOptionalPrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAgentGUIOpenSessionRequest(
  request: AgentGUIOpenSessionRequest | null | undefined
): AgentGUIOpenSessionRequest | null {
  const agentSessionId = request?.agentSessionId.trim() ?? "";
  if (!agentSessionId || typeof request?.sequence !== "number") {
    return null;
  }
  return {
    agentSessionId,
    sequence: request.sequence
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function activeBackgroundAgentCount(
  runtimeContext: Record<string, unknown> | null | undefined
): number {
  const backgroundAgents = recordValue(runtimeContext?.backgroundAgents);
  if (!backgroundAgents) {
    return 0;
  }
  const items = Array.isArray(backgroundAgents.items)
    ? backgroundAgents.items
    : [];
  if (items.length === 0) {
    const count = numberValue(backgroundAgents.count);
    return count === null ? 0 : Math.max(0, Math.floor(count));
  }
  return items.filter((item) => {
    const record = recordValue(item);
    if (!record) {
      return false;
    }
    const status = String(record.status ?? "")
      .trim()
      .toLowerCase();
    return ![
      "completed",
      "failed",
      "cancelled",
      "canceled",
      "stopped"
    ].includes(status);
  }).length;
}

function appServerStartupMetadata(
  runtimeContext: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  return recordValue(runtimeContext?.appServerStartup);
}

function isAppServerStartupLoading(
  runtimeContext: Record<string, unknown> | null | undefined,
  key: "models" | "rateLimits"
): boolean {
  return appServerStartupMetadata(runtimeContext)?.[key] === "loading";
}

function draftAgentSessionIdFromComposerOptions(
  options: AgentActivityComposerOptions | null | undefined
): string | null {
  return normalizeConfigOptionValue(
    options?.runtimeContext?.draftAgentSessionId
  );
}

function composerSettingOptionsFromActivity(
  options: readonly AgentActivityComposerOptions["models"][number][]
): AgentGUIComposerSettingOption[] {
  return options.map((option) => ({ ...option }));
}

function modelSelectionFromComposerOptions(
  options: AgentActivityComposerOptions | null,
  currentValue: string | null
): ACPConfigOptionSelection | null {
  if (!options) {
    return null;
  }
  return {
    options: composerSettingOptionsFromActivity(options.models),
    currentValue
  };
}

function configOptionCurrentValue(
  runtimeContext: Record<string, unknown> | null | undefined,
  ids: readonly string[]
): string | null {
  const rawConfigOptions = Array.isArray(runtimeContext?.configOptions)
    ? runtimeContext.configOptions
    : [];
  const idSet = new Set(ids);
  for (const rawOption of rawConfigOptions) {
    const option = recordValue(rawOption);
    if (!option) {
      continue;
    }
    const id = normalizeOptionalText(option.id as string | null | undefined);
    if (!id || !idSet.has(id)) {
      continue;
    }
    return normalizeOptionalText(
      (option.currentValue ?? option.current_value) as string | null | undefined
    );
  }
  return null;
}

function reasoningSelectionFromComposerOptions(
  options: AgentActivityComposerOptions | null,
  currentValue: AgentSessionReasoningEffort | null
): ACPConfigOptionSelection | null {
  if (!options) {
    return null;
  }
  return {
    options: composerSettingOptionsFromActivity(options.reasoningEfforts),
    currentValue
  };
}

function speedSelectionFromComposerOptions(
  options: AgentActivityComposerOptions | null,
  currentValue: AgentSessionSpeed | null
): ACPConfigOptionSelection | null {
  if (!options) {
    return null;
  }
  return {
    options: composerSettingOptionsFromActivity(options.speeds ?? []),
    currentValue
  };
}

function providerSkillsFromComposerOptions(
  options: AgentActivityComposerOptions | null
): AgentGUIProviderSkillOption[] {
  if (!options) {
    return [];
  }
  return dedupeProviderSkills([
    ...options.skills.map((skill) => ({ ...skill })),
    ...(options.capabilityCatalog ?? [])
      .filter(
        (capability) =>
          capability.invocation === "promptItem" &&
          (capability.kind === "skill" || capability.kind === "connector") &&
          capability.status === "available" &&
          Boolean(capability.trigger) &&
          Boolean(capability.path)
      )
      .map((capability): AgentGUIProviderSkillOption => {
        const isConnector = capability.kind === "connector";
        return {
          name: isConnector ? capability.label : capability.name,
          trigger: capability.trigger!,
          sourceKind: isConnector ? "connector" : "plugin",
          kind: isConnector ? "connector" : "skill",
          ...(capability.description
            ? { description: capability.description }
            : {}),
          ...(capability.pluginName
            ? { pluginName: capability.pluginName }
            : {}),
          ...(capability.path ? { path: capability.path } : {})
        };
      })
  ]);
}

function areProviderSkillOptionsEqual(
  left: AgentGUIProviderSkillOption,
  right: AgentGUIProviderSkillOption
): boolean {
  return (
    left.name === right.name &&
    left.trigger === right.trigger &&
    left.sourceKind === right.sourceKind &&
    left.description === right.description &&
    left.pluginName === right.pluginName &&
    left.path === right.path &&
    left.kind === right.kind
  );
}

function areProviderSkillOptionListsEqual(
  left: readonly AgentGUIProviderSkillOption[],
  right: readonly AgentGUIProviderSkillOption[]
): boolean {
  return (
    left.length === right.length &&
    left.every((skill, index) =>
      areProviderSkillOptionsEqual(skill, right[index]!)
    )
  );
}

function dedupeProviderSkills(
  skills: readonly AgentGUIProviderSkillOption[]
): AgentGUIProviderSkillOption[] {
  const seen = new Set<string>();
  const result: AgentGUIProviderSkillOption[] = [];
  for (const skill of skills) {
    const key = skill.trigger || `${skill.kind ?? "skill"}:${skill.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(skill);
  }
  return result;
}

function areComposerSettingOptionsEqual(
  left: AgentGUIComposerSettingOption,
  right: AgentGUIComposerSettingOption
): boolean {
  return (
    left.value === right.value &&
    left.label === right.label &&
    left.description === right.description
  );
}

function areComposerSettingOptionListsEqual(
  left: readonly AgentGUIComposerSettingOption[] | null | undefined,
  right: readonly AgentGUIComposerSettingOption[] | null | undefined
): boolean {
  const leftOptions = left ?? [];
  const rightOptions = right ?? [];
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every((option, index) =>
      areComposerSettingOptionsEqual(option, rightOptions[index]!)
    )
  );
}

function permissionConfigFromComposerOptions(
  options: AgentActivityComposerOptions | null
): AgentSessionPermissionConfig | null {
  const config = options?.permissionConfig;
  if (!config) {
    return null;
  }
  const defaultValue = normalizePermissionModeId(config.defaultValue);
  return {
    configurable: config.configurable,
    ...(defaultValue ? { defaultValue } : {}),
    modes: config.modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      semantic: normalizePermissionModeSemantic(mode.semantic)
    }))
  };
}

function normalizePermissionModeSemantic(
  value: string | undefined
): AgentSessionPermissionModeOption["semantic"] {
  switch (value) {
    case "ask-before-write":
    case "accept-edits":
    case "locked-down":
    case "auto":
    case "full-access":
    case "unconfigurable":
      return value;
    default:
      return (normalizeOptionalText(value) ??
        "unconfigurable") as AgentSessionPermissionModeOption["semantic"];
  }
}

function useStableComposerSettings(
  settings: AgentSessionComposerSettings
): AgentSessionComposerSettings;
function useStableComposerSettings(
  settings: AgentSessionComposerSettings | null
): AgentSessionComposerSettings | null;
function useStableComposerSettings(
  settings: AgentSessionComposerSettings | null
): AgentSessionComposerSettings | null {
  const settingsRef = useRef<{
    value: AgentSessionComposerSettings | null;
  } | null>(null);
  if (
    settingsRef.current === null ||
    !sameComposerSettings(settingsRef.current.value, settings)
  ) {
    settingsRef.current = { value: settings };
  }
  return settingsRef.current.value;
}

function useStableProviderSkillOptions(
  skills: AgentGUIProviderSkillOption[]
): AgentGUIProviderSkillOption[] {
  const skillsRef = useRef<AgentGUIProviderSkillOption[] | null>(null);
  if (
    skillsRef.current === null ||
    !areProviderSkillOptionListsEqual(skillsRef.current, skills)
  ) {
    skillsRef.current = skills;
  }
  return skillsRef.current;
}

function areComposerSettingsDraftsEqual(
  left: AgentGUIComposerSettingsVM["draftSettings"],
  right: AgentGUIComposerSettingsVM["draftSettings"]
): boolean {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.speed === right.speed &&
    left.planMode === right.planMode &&
    (left.browserUse ?? true) === (right.browserUse ?? true) &&
    (left.computerUse ?? true) === (right.computerUse ?? true) &&
    (left.permissionModeId ?? null) === (right.permissionModeId ?? null)
  );
}

function arePermissionModeOptionsEqual(
  left: AgentSessionPermissionModeOption,
  right: AgentSessionPermissionModeOption
): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.description === right.description &&
    left.semantic === right.semantic
  );
}

function arePermissionConfigsEqual(
  left: AgentSessionPermissionConfig | null | undefined,
  right: AgentSessionPermissionConfig | null | undefined
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.configurable === right.configurable &&
    (left.defaultValue ?? null) === (right.defaultValue ?? null) &&
    left.modes.length === right.modes.length &&
    left.modes.every((mode, index) =>
      arePermissionModeOptionsEqual(mode, right.modes[index]!)
    )
  );
}

function areComposerSettingsVMsEqual(
  left: AgentGUIComposerSettingsVM,
  right: AgentGUIComposerSettingsVM
): boolean {
  return (
    sameComposerSettings(left.sessionSettings, right.sessionSettings) &&
    areComposerSettingsDraftsEqual(left.draftSettings, right.draftSettings) &&
    left.supportsModel === right.supportsModel &&
    left.supportsReasoningEffort === right.supportsReasoningEffort &&
    left.supportsSpeed === right.supportsSpeed &&
    (left.supportsPermissionMode ?? false) ===
      (right.supportsPermissionMode ?? false) &&
    left.supportsPlanMode === right.supportsPlanMode &&
    (left.supportsBrowser ?? false) === (right.supportsBrowser ?? false) &&
    (left.supportsComputerUse ?? false) ===
      (right.supportsComputerUse ?? false) &&
    left.isSettingsLoading === right.isSettingsLoading &&
    Boolean(left.isModelOptionsLoading) ===
      Boolean(right.isModelOptionsLoading) &&
    left.modelUnavailable === right.modelUnavailable &&
    left.reasoningUnavailable === right.reasoningUnavailable &&
    left.speedUnavailable === right.speedUnavailable &&
    (left.permissionModeUnavailable ?? false) ===
      (right.permissionModeUnavailable ?? false) &&
    (left.planExclusiveWithPermissionMode ?? false) ===
      (right.planExclusiveWithPermissionMode ?? false) &&
    (left.selectedModelValue ?? null) === (right.selectedModelValue ?? null) &&
    (left.selectedReasoningEffortValue ?? null) ===
      (right.selectedReasoningEffortValue ?? null) &&
    (left.selectedSpeedValue ?? null) === (right.selectedSpeedValue ?? null) &&
    (left.selectedPermissionModeValue ?? null) ===
      (right.selectedPermissionModeValue ?? null) &&
    arePermissionConfigsEqual(left.permissionConfig, right.permissionConfig) &&
    (left.selectedProjectPath ?? null) ===
      (right.selectedProjectPath ?? null) &&
    Boolean(left.projectLocked) === Boolean(right.projectLocked) &&
    Boolean(left.modelListCollapsedToLatest) ===
      Boolean(right.modelListCollapsedToLatest) &&
    areComposerSettingOptionListsEqual(
      left.availableModels,
      right.availableModels
    ) &&
    areComposerSettingOptionListsEqual(
      left.availableReasoningEfforts,
      right.availableReasoningEfforts
    ) &&
    areComposerSettingOptionListsEqual(
      left.availableSpeeds,
      right.availableSpeeds
    ) &&
    areComposerSettingOptionListsEqual(
      left.availablePermissionModes,
      right.availablePermissionModes
    )
  );
}

function useStableComposerSettingsVM(
  settings: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM {
  const settingsRef = useRef<AgentGUIComposerSettingsVM | null>(null);
  settingsRef.current = stabilizeComposerSettingsVM(
    settingsRef.current,
    settings
  );
  return settingsRef.current;
}

function stabilizeComposerSettingsVM(
  previous: AgentGUIComposerSettingsVM | null,
  next: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM {
  if (!previous) {
    return next;
  }
  if (areComposerSettingsVMsEqual(previous, next)) {
    return previous;
  }

  const sessionSettings = sameComposerSettings(
    previous.sessionSettings,
    next.sessionSettings
  )
    ? previous.sessionSettings
    : next.sessionSettings;
  const draftSettings = areComposerSettingsDraftsEqual(
    previous.draftSettings,
    next.draftSettings
  )
    ? previous.draftSettings
    : next.draftSettings;
  const permissionConfig = arePermissionConfigsEqual(
    previous.permissionConfig,
    next.permissionConfig
  )
    ? previous.permissionConfig
    : next.permissionConfig;
  const availableModels = areComposerSettingOptionListsEqual(
    previous.availableModels,
    next.availableModels
  )
    ? previous.availableModels
    : next.availableModels;
  const availableReasoningEfforts = areComposerSettingOptionListsEqual(
    previous.availableReasoningEfforts,
    next.availableReasoningEfforts
  )
    ? previous.availableReasoningEfforts
    : next.availableReasoningEfforts;
  const availableSpeeds = areComposerSettingOptionListsEqual(
    previous.availableSpeeds,
    next.availableSpeeds
  )
    ? previous.availableSpeeds
    : next.availableSpeeds;
  const availablePermissionModes = areComposerSettingOptionListsEqual(
    previous.availablePermissionModes ?? [],
    next.availablePermissionModes ?? []
  )
    ? previous.availablePermissionModes
    : next.availablePermissionModes;

  return {
    ...next,
    sessionSettings,
    draftSettings,
    permissionConfig,
    availableModels,
    availableReasoningEfforts,
    availableSpeeds,
    availablePermissionModes
  };
}

function useStableControllerEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

function promptRequestId(
  prompt: { requestId?: string | null } | null | undefined
): string | null {
  const requestId = prompt?.requestId?.trim() ?? "";
  return requestId || null;
}

function agentGUIConversationDiagnosticDetails(
  conversation: AgentConversationVM | null
): Record<string, unknown> | null {
  if (!conversation) {
    return null;
  }
  const processingRows = conversation.rows.filter(
    (row) => row.kind === "processing"
  );
  const toolCalls = conversation.rows.flatMap((row) =>
    row.kind === "tool-group" ? row.calls : []
  );
  const waitingToolCalls = toolCalls.filter((call) =>
    agentGUIToolCallStatusIsWaiting(call.status)
  );
  return {
    activityStatus: conversation.activity.status,
    pendingApprovalRequestId: conversation.pendingApproval?.requestId ?? null,
    pendingInteractivePromptKind:
      conversation.pendingInteractivePrompt?.kind ?? null,
    pendingInteractivePromptRequestId: promptRequestId(
      conversation.pendingInteractivePrompt
    ),
    processingRowCount: processingRows.length,
    processingTurnIds: processingRows
      .map((row) => row.turnId)
      .filter((turnId): turnId is string => Boolean(turnId)),
    rowCount: conversation.rows.length,
    toolCallCount: toolCalls.length,
    turnCount: conversation.sourceDetail.turns.length,
    waitingToolCallCount: waitingToolCalls.length,
    waitingToolCalls: waitingToolCalls.slice(-5).map((call) => ({
      callType: call.callType,
      id: call.id,
      name: call.name,
      rendererKind: call.rendererKind,
      status: call.status,
      statusKind: call.statusKind,
      toolName: call.toolName,
      turnId: call.turnId
    }))
  };
}

function agentGUIToolCallStatusIsWaiting(status: string | null): boolean {
  return (
    status === "waiting" ||
    status === "waiting_approval" ||
    status === "pending" ||
    status === "in_progress" ||
    status === "running"
  );
}

function agentGUIRuntimeSessionDiagnosticDetails(
  session: AgentActivitySession | null
): Record<string, unknown> | null {
  if (!session) {
    return null;
  }
  return {
    activeTurnId: session.turnLifecycle?.activeTurnId ?? null,
    agentSessionId: session.agentSessionId,
    currentPhase: session.currentPhase ?? null,
    lastError: session.lastError ?? null,
    lastEventUnixMs: session.lastEventUnixMs ?? null,
    messageVersion: session.messageVersion ?? null,
    outcome: session.turnLifecycle?.outcome ?? null,
    provider: session.provider,
    status: session.status ?? null,
    submitAvailabilityReason: session.submitAvailability?.reason ?? null,
    submitAvailabilityState: session.submitAvailability?.state ?? null,
    turnPhase: session.turnLifecycle?.phase ?? null,
    updatedAtUnixMs: session.updatedAtUnixMs ?? null
  };
}

function agentGUISessionStateDiagnosticDetails(
  state: AgentSessionState | null
): Record<string, unknown> | null {
  if (!state) {
    return null;
  }
  return {
    activeTurnId: state.turnLifecycle?.activeTurnId ?? null,
    authState: normalizeOptionalText(state.authState),
    pendingInteractiveKind: state.pendingInteractive?.kind ?? null,
    pendingInteractiveRequestId: promptRequestId(state.pendingInteractive),
    provider: state.provider,
    resumable: state.resumable ?? null,
    status: state.status,
    submitAvailabilityReason: state.submitAvailability?.reason ?? null,
    submitAvailabilityState: state.submitAvailability?.state ?? null,
    turnOutcome: state.turnLifecycle?.outcome ?? null,
    turnPhase: state.turnLifecycle?.phase ?? null,
    updatedAtUnixMs: state.updatedAtUnixMs ?? null
  };
}

function conversationBusyStatus(
  status: AgentGUIConversationSummary["status"] | null
): boolean {
  return status === "working" || status === "waiting";
}

function stringArraysEqual(
  first: string[] | null | undefined,
  second: string[] | null | undefined
): boolean {
  if (!first || !second) {
    return first === second;
  }
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function useStableStringArrayByValue(values: string[]): string[] {
  const valuesRef = useRef<string[] | null>(null);
  const currentValues = valuesRef.current;
  if (!stringArraysEqual(currentValues, values)) {
    valuesRef.current = values;
    return values;
  }
  return currentValues ?? values;
}

function agentSessionStatusBusy(input: {
  lifecycleStatus?: string;
  effectiveStatus?: string;
  status?: string;
  turnPhase?: string;
  currentPhase?: string;
}): boolean {
  const normalized = normalizeOptionalWorkspaceAgentStatus(input);
  return normalized?.kind === "working" || normalized?.kind === "waiting";
}

function agentActivityDisplayStatusBusy(
  status: AgentActivityDisplayStatus | null | undefined
): boolean {
  return status === "working" || status === "waiting";
}

function conversationBusyStatusFromAgentActivityDisplayStatus(
  status: AgentActivityDisplayStatus | null | undefined
): "working" | "waiting" | null {
  if (status === "working" || status === "waiting") {
    return status;
  }
  return null;
}

function reuseAgentActivityDisplayStatusesIfUnchanged(
  previous: ReadonlyMap<string, AgentActivityDisplayStatus> | null,
  next: Map<string, AgentActivityDisplayStatus>
): Map<string, AgentActivityDisplayStatus> {
  if (!previous || previous.size !== next.size) {
    return next;
  }
  for (const [sessionId, status] of next) {
    if (previous.get(sessionId) !== status) {
      return next;
    }
  }
  return previous as Map<string, AgentActivityDisplayStatus>;
}

function permissionModeOptions(
  provider: AgentGUINodeData["provider"],
  permissionConfig: AgentSessionPermissionConfig | null | undefined
): AgentGUIComposerSettingOption[] {
  if (!permissionConfig?.configurable) {
    return [];
  }
  return permissionConfig.modes.map((mode) => ({
    value: mode.id,
    label: permissionModeLabel(provider, mode),
    description: permissionModeDescription(provider, mode)
  }));
}

function permissionModeLabel(
  provider: AgentGUINodeData["provider"],
  option: AgentSessionPermissionModeOption
): string {
  const providerKey = `agentHost.agentGui.permissionModes.${provider}.${option.id}.label`;
  const providerLabel = translate(providerKey);
  if (providerLabel !== providerKey) {
    return providerLabel;
  }
  const semanticKey = `agentHost.agentGui.permissionSemantics.${option.semantic}.label`;
  const semanticLabel = translate(semanticKey);
  if (semanticLabel !== semanticKey) {
    return semanticLabel;
  }
  const contractLabel = normalizeOptionalText(option.label);
  if (contractLabel) {
    return contractLabel;
  }
  return option.id;
}

function permissionModeDescription(
  provider: AgentGUINodeData["provider"],
  option: AgentSessionPermissionModeOption
): string | undefined {
  const providerKey = `agentHost.agentGui.permissionModes.${provider}.${option.id}.description`;
  const providerLabel = translate(providerKey);
  if (providerLabel !== providerKey) {
    return providerLabel;
  }
  const semanticKey = `agentHost.agentGui.permissionSemantics.${option.semantic}.description`;
  const semanticLabel = translate(semanticKey);
  if (semanticLabel !== semanticKey) {
    return semanticLabel;
  }
  const contractDescription = normalizeOptionalText(option.description);
  if (contractDescription) {
    return contractDescription;
  }
  return undefined;
}

const NODE_DEFAULT_DRAFT_KEY = "__agent_gui_node_defaults__";
const EMPTY_AGENT_COMPOSER_DRAFT = emptyAgentComposerDraft();
const EMPTY_QUEUED_PROMPTS: readonly AgentGUIQueuedPromptVM[] = Object.freeze(
  []
);

function areAgentComposerDraftsEqual(
  left: AgentComposerDraft,
  right: AgentComposerDraft
): boolean {
  const leftFiles = left.files ?? [];
  const rightFiles = right.files ?? [];
  return (
    left.prompt === right.prompt &&
    left.images.length === right.images.length &&
    left.images.every((image, index) => {
      const other = right.images[index];
      if (!other) {
        return false;
      }
      return (
        image.id === other.id &&
        image.name === other.name &&
        image.mimeType === other.mimeType &&
        image.data === other.data &&
        image.path === other.path &&
        image.previewUrl === other.previewUrl &&
        image.uploading === other.uploading &&
        image.uploadError === other.uploadError
      );
    }) &&
    leftFiles.length === rightFiles.length &&
    leftFiles.every((file, index) => {
      const other = rightFiles[index];
      if (!other) {
        return false;
      }
      return (
        file.id === other.id &&
        file.name === other.name &&
        file.mimeType === other.mimeType &&
        file.path === other.path &&
        file.hostPath === other.hostPath &&
        file.assetId === other.assetId &&
        file.sizeBytes === other.sizeBytes &&
        file.uploading === other.uploading &&
        file.uploadError === other.uploadError
      );
    })
  );
}

function nodeDefaultDraftKey(
  agentProvider: AgentGUINodeData["provider"],
  agentTargetId?: string | null
): string {
  const normalizedAgentTargetId = normalizeOptionalText(agentTargetId);
  if (normalizedAgentTargetId) {
    return `${NODE_DEFAULT_DRAFT_KEY}:target:${normalizedAgentTargetId}`;
  }
  return `${NODE_DEFAULT_DRAFT_KEY}:${agentProvider}`;
}

function nodeDefaultDraftContentKey(
  agentProvider: AgentGUINodeData["provider"],
  agentTargetId?: string | null
): string {
  return nodeDefaultDraftKey(agentProvider, agentTargetId);
}

function normalizeProjectDraftPath(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized ? normalized : null;
}

function readNodeDefaultDraftContent(input: {
  data: AgentGUINodeData;
  drafts: Record<string, AgentComposerDraft>;
}): AgentComposerDraft {
  return (
    input.drafts[
      nodeDefaultDraftContentKey(input.data.provider, input.data.agentTargetId)
    ] ??
    input.drafts[nodeDefaultDraftContentKey(input.data.provider)] ??
    input.drafts[NODE_DEFAULT_DRAFT_KEY] ??
    EMPTY_AGENT_COMPOSER_DRAFT
  );
}

function readNodeDefaultDraftSettings(input: {
  data: AgentGUINodeData;
  defaultReasoningEffort?: AgentSessionReasoningEffort | null;
  drafts: Record<string, AgentSessionComposerSettings>;
}): AgentSessionComposerSettings {
  const agentTargetId = normalizeOptionalText(input.data.agentTargetId);
  if (agentTargetId) {
    return (
      input.drafts[nodeDefaultDraftKey(input.data.provider, agentTargetId)] ??
      buildNodeDefaultComposerSettings(input.data, {
        defaultReasoningEffort: input.defaultReasoningEffort
      })
    );
  }
  return (
    input.drafts[nodeDefaultDraftKey(input.data.provider)] ??
    input.drafts[NODE_DEFAULT_DRAFT_KEY] ??
    buildNodeDefaultComposerSettings(input.data, {
      defaultReasoningEffort: input.defaultReasoningEffort
    })
  );
}

function conversationStatusFromStatePatch(
  patch: WorkspaceAgentActivityStatePatch
): AgentGUIConversationSummary["status"] | null {
  const turnPhase = patch.turn?.phase?.trim() ?? "";
  if (turnPhase === "settled") {
    switch (patch.turn?.outcome?.trim()) {
      case "failed":
        return "failed";
      case "canceled":
      case "interrupted":
        return "canceled";
      case "completed":
      default:
        return "completed";
    }
  }
  switch (turnPhase) {
    case "submitted":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    default:
      break;
  }
  const normalized = normalizeOptionalWorkspaceAgentStatus({
    lifecycleStatus: patch.lifecycleStatus,
    currentPhase: patch.currentPhase,
    turnPhase: patch.turn?.phase
  });
  switch (normalized?.kind) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "completed":
      return "completed";
    case "waiting":
      return "waiting";
    case "working":
      return "working";
    case "ready":
      return "ready";
    default:
      return null;
  }
}

function completionKeyFromStatePatch(
  agentSessionId: string,
  patch: WorkspaceAgentActivityStatePatch
): string | null {
  const turnId = patch.turn?.turnId?.trim() ?? "";
  if (turnId && isCompletedOutcomeToken(patch.turn?.outcome)) {
    return `turn:${agentSessionId}:${turnId}:completed`;
  }
  return conversationStatusFromStatePatch(patch) === "completed"
    ? `session:${agentSessionId}:completed`
    : null;
}

function completionKeyFromSessionState(
  agentSessionId: string,
  state: AgentSessionState
): string | null {
  return conversationStatusFromSessionState(state) === "completed"
    ? `session:${agentSessionId}:completed`
    : null;
}

function completionKeyFromMessage(
  message: WorkspaceAgentActivityMessage
): string | null {
  const agentSessionId = message.agentSessionId.trim();
  if (!agentSessionId) {
    return null;
  }
  if ((message.role ?? "").trim().toLowerCase() !== "assistant") {
    return null;
  }
  const kind = (message.kind ?? "").trim().toLowerCase();
  if (kind !== "message" && kind !== "text") {
    return null;
  }
  const payload =
    message.payload && typeof message.payload === "object"
      ? message.payload
      : {};
  const status =
    message.status?.trim().toLowerCase() ||
    (stringPayloadValue(payload, "status") ?? "").toLowerCase();
  if (!isCompletedOutcomeToken(status)) {
    return null;
  }
  const subject = message.turnId?.trim() || message.messageId.trim();
  return subject ? `turn:${agentSessionId}:${subject}:completed` : null;
}

function isCompletedOutcomeToken(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === "completed";
}

function hasSessionControlStatePatch(
  patch: WorkspaceAgentActivityStatePatch
): boolean {
  return (
    normalizeOptionalText(patch.permissionModeId) !== null ||
    patch.settings !== undefined ||
    patch.runtimeContext !== undefined ||
    patch.submitAvailability !== undefined ||
    patch.pendingInteractive !== undefined ||
    patch.turn?.submitAvailability !== undefined ||
    patch.turn?.phase !== undefined
  );
}

function mergeSessionControlStatePatch(
  current: AgentSessionState | null,
  patch: WorkspaceAgentActivityStatePatch
): AgentSessionState | null {
  if (!current || !hasSessionControlStatePatch(patch)) {
    return current;
  }
  let changed = false;
  const next: AgentSessionState = { ...current };
  const patchPermissionMode = normalizePermissionModeId(patch.permissionModeId);
  if (
    normalizeOptionalText(patch.permissionModeId) !== null &&
    patchPermissionMode !== (current.permissionModeId ?? null)
  ) {
    next.permissionModeId = patchPermissionMode ?? undefined;
    changed = true;
  }

  if (patch.settings !== undefined) {
    const currentSettings = current.settings ?? {};
    const nextSettings: AgentSessionComposerSettings = { ...currentSettings };
    if (patch.settings.model !== undefined) {
      nextSettings.model = normalizeOptionalText(patch.settings.model);
    }
    if (patch.settings.reasoningEffort !== undefined) {
      nextSettings.reasoningEffort = normalizeOptionalText(
        patch.settings.reasoningEffort
      ) as AgentSessionReasoningEffort | null;
    }
    if (patch.settings.speed !== undefined) {
      nextSettings.speed = normalizeOptionalText(
        patch.settings.speed
      ) as AgentSessionSpeed | null;
    }
    if (patch.settings.planMode !== undefined) {
      nextSettings.planMode = Boolean(patch.settings.planMode);
    }
    if (patch.settings.permissionModeId !== undefined) {
      nextSettings.permissionModeId = normalizePermissionModeId(
        patch.settings.permissionModeId
      );
      if (nextSettings.permissionModeId !== (next.permissionModeId ?? null)) {
        next.permissionModeId = nextSettings.permissionModeId ?? undefined;
      }
    }
    if (!sameComposerSettings(current.settings ?? null, nextSettings)) {
      next.settings = nextSettings;
      changed = true;
    }
  }

  if (patch.runtimeContext !== undefined) {
    next.runtimeContext = {
      ...(current.runtimeContext ?? {}),
      ...patch.runtimeContext
    };
    changed = true;
  }
  const effectivePermissionMode = next.permissionModeId ?? null;
  if (effectivePermissionMode) {
    next.runtimeContext = {
      ...(next.runtimeContext ?? current.runtimeContext ?? {}),
      permissionModeId: effectivePermissionMode
    };
  }
  const submitAvailability =
    patch.submitAvailability ?? patch.turn?.submitAvailability;
  if (submitAvailability !== undefined) {
    next.submitAvailability = submitAvailability;
    changed = true;
  }
  if (
    patch.pendingInteractive !== undefined &&
    !sameJSONValue(current.pendingInteractive ?? null, patch.pendingInteractive)
  ) {
    next.pendingInteractive = patch.pendingInteractive;
    changed = true;
  }
  if (patch.turn?.phase) {
    next.turnLifecycle = {
      activeTurnId:
        patch.turn.activeTurnId !== undefined
          ? patch.turn.activeTurnId
          : patch.turn.phase === "settled"
            ? null
            : patch.turn.turnId,
      phase: patch.turn.phase,
      settling: patch.turn.settling,
      outcome: patch.turn.outcome ?? null,
      completedCommand: patch.turn.completedCommand ?? null
    };
    changed = true;
  }
  if (
    patch.occurredAtUnixMs !== undefined &&
    Number.isFinite(patch.occurredAtUnixMs)
  ) {
    next.updatedAtUnixMs = patch.occurredAtUnixMs;
    changed = true;
  }
  return changed ? next : current;
}

function sameJSONValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function conversationStatusFromSessionState(
  state: AgentSessionState
): AgentGUIConversationSummary["status"] | null {
  if (state.turnLifecycle?.phase) {
    return conversationStatusFromStatePatch({
      agentSessionId: state.agentSessionId,
      turn: {
        turnId: state.turnLifecycle.activeTurnId ?? "",
        activeTurnId: state.turnLifecycle.activeTurnId,
        phase: state.turnLifecycle.phase,
        outcome: state.turnLifecycle.outcome ?? undefined,
        settling: state.turnLifecycle.settling,
        completedCommand: state.turnLifecycle.completedCommand ?? undefined
      }
    });
  }
  return conversationStatusFromStatusValue(state.status);
}

function conversationStatusFromStatusValue(
  value: string | null | undefined
): AgentGUIConversationSummary["status"] | null {
  return normalizeOptionalWorkspaceAgentStatus({ status: value })?.kind ?? null;
}

function conversationStatusFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): Extract<
  AgentGUIConversationSummary["status"],
  "working" | "waiting"
> | null {
  let hasWorking = false;
  let hasWaiting = false;
  const latestByCallId = new Map<string, WorkspaceAgentActivityTimelineItem>();
  for (const item of timelineItems) {
    const callId = item.callId?.trim();
    if (!callId) {
      continue;
    }
    const previous = latestByCallId.get(callId);
    if (!previous || timelineItemTime(item) >= timelineItemTime(previous)) {
      latestByCallId.set(callId, item);
    }
  }
  for (const item of latestByCallId.values()) {
    const status = normalizeTimelineStatus(
      item.status ?? stringPayloadValue(item.payload, "status")
    );
    if (status === "working") {
      hasWorking = true;
    } else if (status === "waiting") {
      hasWaiting = true;
    }
  }
  if (hasWaiting) {
    return "waiting";
  }
  if (hasWorking) {
    return "working";
  }
  return null;
}

function normalizeTimelineStatus(
  value: string | null | undefined
): "working" | "waiting" | null {
  const normalized = normalizeOptionalWorkspaceAgentStatus({
    status: value ?? undefined
  });
  if (normalized?.kind === "working" || normalized?.kind === "waiting") {
    return normalized.kind;
  }
  switch (value?.trim().toLowerCase()) {
    case "active":
    case "in_progress":
      return "working";
    case "pending":
      return "waiting";
    default:
      return null;
  }
}

function messageFromMessageUpdate(
  update: AgentActivityMessageUpdate
): WorkspaceAgentActivityMessage {
  const payload = update.payload ?? {};
  const normalizedKind = update.kind.trim().toLowerCase();
  const normalizedRole = update.role.trim().toLowerCase();
  const id =
    normalizedPositiveNumber(update.seq) ??
    normalizedPositiveNumber(update.occurredAtUnixMs) ??
    0;
  const isToolCall = normalizedKind === "tool_call";
  const kind = isToolCall
    ? "tool_call"
    : normalizedKind === "reasoning"
      ? "reasoning"
      : "text";
  const role = normalizedRole === "user" ? "user" : "assistant";
  return {
    id,
    workspaceId: update.workspaceId?.trim() || "",
    agentSessionId: update.agentSessionId,
    messageId: update.messageId.trim() || `message:${id}`,
    version: id,
    turnId: update.turnId.trim(),
    role,
    kind,
    status: update.status,
    payload: {
      ...payload,
      ...(isToolCall && update.callId?.trim()
        ? { callId: update.callId.trim() }
        : {}),
      ...(isToolCall && update.title?.trim()
        ? { title: update.title.trim() }
        : {})
    },
    occurredAtUnixMs: update.occurredAtUnixMs,
    ...(update.startedAtUnixMs !== undefined
      ? { startedAtUnixMs: update.startedAtUnixMs }
      : {}),
    ...(update.completedAtUnixMs !== undefined
      ? { completedAtUnixMs: update.completedAtUnixMs }
      : {})
  };
}

function normalizedPositiveNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function timelineItemTime(item: WorkspaceAgentActivityTimelineItem): number {
  return item.occurredAtUnixMs ?? item.createdAtUnixMs ?? 0;
}

const emptyComingSoonProviders: readonly AgentGUIProvider[] = [];

// Gated providers stay visible but behave like the built-in coming-soon
// placeholders (hermes/openclaw/...): unclickable composer, coming-soon gate.
function applyComingSoonProviderTargets(
  targets: AgentGUIProviderTarget[],
  comingSoonProviders: readonly AgentGUIProvider[]
): AgentGUIProviderTarget[] {
  if (comingSoonProviders.length === 0) {
    return targets;
  }
  const comingSoon = new Set(comingSoonProviders);
  return targets.map((target) =>
    comingSoon.has(target.provider) && target.disabled !== true
      ? { ...target, disabled: true }
      : target
  );
}

interface UseAgentGUINodeControllerInput {
  nodeId?: string;
  workspaceId: string;
  currentUserId?: string | null;
  workspacePath: string;
  avoidGroupingEdits: boolean;
  data: AgentGUINodeData;
  providerTargets?: readonly AgentGUIProviderTarget[];
  providerTargetsLoading?: boolean;
  /** Providers gated by the host (feature-gated) — rendered as coming-soon placeholders. */
  comingSoonProviders?: readonly AgentGUIProvider[];
  providerReadinessGates?: Partial<
    Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>
  > | null;
  defaultProviderTargetId?: string | null;
  openSessionRequest?: AgentGUIOpenSessionRequest | null;
  prefillPromptRequest?: AgentGUIPrefillPromptRequest | null;
  previewMode?: boolean;
  onDataChange: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
  onRememberComposerDefaults?: (
    input: AgentGUIRememberComposerDefaultsInput
  ) => void | Promise<void>;
  onShowMessage?: (
    message: string,
    tone?: "info" | "warning" | "error"
  ) => void;
}

export interface AgentGUIOpenSessionRequest {
  agentSessionId: string;
  sequence: number;
}

export interface AgentGUIPrefillPromptRequest {
  agentTargetId?: string | null;
  autoSubmit?: boolean;
  draftPrompt: string;
  provider?: AgentGUIProvider;
  sequence: number;
  userProjectPath?: string | null;
}

export function useAgentGUINodeController({
  nodeId,
  workspaceId,
  currentUserId,
  workspacePath,
  avoidGroupingEdits,
  data,
  providerTargets,
  providerTargetsLoading = false,
  comingSoonProviders,
  providerReadinessGates = null,
  defaultProviderTargetId = null,
  openSessionRequest = null,
  prefillPromptRequest = null,
  previewMode = false,
  onDataChange,
  onRememberComposerDefaults,
  onShowMessage
}: UseAgentGUINodeControllerInput) {
  const agentActivityRuntime = useAgentActivityRuntime();
  const agentQueuedPromptRuntime = useAgentQueuedPromptRuntime();
  const agentHostApi = useAgentHostApi();
  const agentActivitySnapshot = useAgentActivitySnapshot(workspaceId);
  const normalizedComingSoonProviders = useMemo(
    () =>
      comingSoonProviders && comingSoonProviders.length > 0
        ? ([...comingSoonProviders] as readonly AgentGUIProvider[])
        : emptyComingSoonProviders,
    [comingSoonProviders]
  );
  const normalizedExplicitProviderTargets = useMemo(
    () =>
      applyComingSoonProviderTargets(
        normalizeAgentGUIProviderTargets(providerTargets, {
          includeDisabledPlaceholders: true,
          useStaticCatalog: false
        }),
        normalizedComingSoonProviders
      ),
    [normalizedComingSoonProviders, providerTargets]
  );
  const normalizedProviderTargets = useMemo(() => {
    if (providerTargetsLoading) {
      return [];
    }
    if (
      providerTargets === undefined ||
      normalizedExplicitProviderTargets.length === 0
    ) {
      return applyComingSoonProviderTargets(
        normalizeAgentGUIProviderTargets(null, {
          includeDisabledPlaceholders: true
        }),
        normalizedComingSoonProviders
      );
    }
    return normalizedExplicitProviderTargets;
  }, [
    normalizedExplicitProviderTargets,
    normalizedComingSoonProviders,
    providerTargets,
    providerTargetsLoading
  ]);
  const shouldUseStaticProviderTargets =
    !providerTargetsLoading &&
    (providerTargets === undefined ||
      normalizedExplicitProviderTargets.length === 0);
  const selectedProviderTarget = useMemo(() => {
    const resolved = resolveAgentGUIProviderTarget({
      agentTargetId: data.agentTargetId,
      defaultProviderTargetId,
      provider: data.provider,
      providerTargetId: data.providerTargetId,
      providerTargets: normalizedProviderTargets,
      useStaticCatalog: shouldUseStaticProviderTargets
    });
    return (
      resolved ?? {
        targetId: data.agentTargetId ?? "__loading__",
        provider: data.provider,
        ref: {
          kind: "loading",
          provider: data.provider
        },
        label: data.provider,
        disabled: true
      }
    );
  }, [
    data.agentTargetId,
    data.provider,
    data.providerTargetId,
    defaultProviderTargetId,
    normalizedProviderTargets,
    shouldUseStaticProviderTargets
  ]);
  const selectedProviderTargetIsExplicit = useMemo(
    () =>
      normalizedExplicitProviderTargets.some(
        (target) =>
          target.provider === selectedProviderTarget.provider &&
          target.targetId === selectedProviderTarget.targetId &&
          agentGUIProviderTargetRefsEqual(
            target.ref,
            selectedProviderTarget.ref
          )
      ),
    [normalizedExplicitProviderTargets, selectedProviderTarget]
  );
  const [homeComposerTargetOverride, setHomeComposerTargetOverride] =
    useState<AgentGUIProviderTarget | null>(null);
  const homeComposerTargetOverrideIsExplicit = useMemo(
    () =>
      homeComposerTargetOverride
        ? normalizedExplicitProviderTargets.some(
            (target) =>
              target.provider === homeComposerTargetOverride.provider &&
              target.targetId === homeComposerTargetOverride.targetId &&
              agentGUIProviderTargetRefsEqual(
                target.ref,
                homeComposerTargetOverride.ref
              )
          )
        : false,
    [homeComposerTargetOverride, normalizedExplicitProviderTargets]
  );
  const effectiveSelectedProviderTarget =
    homeComposerTargetOverride ?? selectedProviderTarget;
  const effectiveSelectedProviderTargetIsExplicit = homeComposerTargetOverride
    ? homeComposerTargetOverrideIsExplicit
    : selectedProviderTargetIsExplicit;
  const nodeComposerTargetResolvedByProviderTarget =
    agentGUINodeDataHasComposerTarget(data) &&
    ((normalizeOptionalText(data.agentTargetId) !== null &&
      selectedProviderTarget.agentTargetId ===
        normalizeOptionalText(data.agentTargetId)) ||
      (normalizeOptionalText(data.providerTargetId) !== null &&
        selectedProviderTarget.targetId ===
          normalizeOptionalText(data.providerTargetId)) ||
      (data.providerTargetRef != null &&
        agentGUIProviderTargetRefsEqual(
          selectedProviderTarget.ref,
          data.providerTargetRef
        )));
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
              isExplicit: selectedProviderTargetIsExplicit,
              target: selectedProviderTarget
            })
          : agentGUINodeDataHasComposerTarget(data)
            ? composerTargetDataFromNodeData(data)
            : composerTargetDataFromProviderTarget({
                current: data,
                isExplicit: selectedProviderTargetIsExplicit,
                target: selectedProviderTarget
              }),
    [
      data,
      homeComposerTargetOverride,
      homeComposerTargetOverrideIsExplicit,
      nodeComposerTargetResolvedByProviderTarget,
      selectedProviderTarget,
      selectedProviderTargetIsExplicit
    ]
  );
  useEffect(() => {
    if (!homeComposerTargetOverride) {
      return;
    }
    if (
      agentGUIProviderTargetsEqual(
        homeComposerTargetOverride,
        selectedProviderTarget
      )
    ) {
      setHomeComposerTargetOverride(null);
    }
  }, [homeComposerTargetOverride, selectedProviderTarget]);
  const agentActivityDisplayStatusesRef = useRef<Map<
    string,
    AgentActivityDisplayStatus
  > | null>(null);
  const agentActivityDisplayStatuses = useMemo(() => {
    const next = selectSessionDisplayStatuses(agentActivitySnapshot);
    const stable = reuseAgentActivityDisplayStatusesIfUnchanged(
      agentActivityDisplayStatusesRef.current,
      next
    );
    agentActivityDisplayStatusesRef.current = stable;
    return stable;
  }, [agentActivitySnapshot]);
  const generatedControllerOwnerKey = useId();
  const [conversationFilter, setConversationFilter] =
    useState<AgentGUIConversationFilter>(
      () => createAgentGUIConversationFilterState().filter
    );
  const conversationFilterRef = useRef(conversationFilter);
  conversationFilterRef.current = conversationFilter;
  const conversationListQuery =
    useMemo<AgentGUIConversationListQuery | null>(() => {
      const userId = currentUserId?.trim() ?? "";
      const provider = data.provider?.trim() ?? "";
      if (!workspaceId.trim() || !userId || !provider) {
        return null;
      }
      return {
        conversationFilter,
        workspaceId,
        userId,
        provider: data.provider,
        sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN
      };
    }, [currentUserId, data.provider, conversationFilter, workspaceId]);
  const conversationListState = useAgentGuiConversationList(
    conversationListQuery
  );
  const pendingCreateOwnerKey = nodeId?.trim() ?? "";
  const conversationListActiveOwnerKey =
    pendingCreateOwnerKey || generatedControllerOwnerKey;
  const resolvePendingCreateConversationId = useCallback(
    () =>
      conversationListQuery && pendingCreateOwnerKey
        ? getAgentGUIConversationCreatePending({
            query: conversationListQuery,
            ownerKey: pendingCreateOwnerKey
          })
        : null,
    [conversationListQuery, pendingCreateOwnerKey]
  );
  const [pendingCreateConversationId, setPendingCreateConversationId] =
    useState(resolvePendingCreateConversationId);
  const conversations = conversationListState?.conversations ?? [];
  const [userProjects, setUserProjects] = useState<AgentHostUserProject[]>(() =>
    readAgentGUIUserProjectSnapshot(agentHostApi.userProjects)
  );
  const isNoProjectPath = agentHostApi.userProjects?.isNoProjectPath;
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(data.lastActiveAgentSessionId);
  const [intent, setIntent] = useState<ConversationIntent>(() =>
    data.lastActiveAgentSessionId
      ? { tag: "requested", id: data.lastActiveAgentSessionId }
      : { tag: "home" }
  );
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(
    null
  );
  const [isComposerHome, setIsComposerHome] = useState(
    data.lastActiveAgentSessionId === null
  );
  const [draftBySessionId, setDraftBySessionId] = useState<
    Record<string, AgentComposerDraft>
  >({});
  const draftBySessionIdRef = useRef(draftBySessionId);
  const [draftSettingsBySessionId, setDraftSettingsBySessionId] = useState<
    Record<string, AgentSessionComposerSettings>
  >({});
  const hasLoadedConversations = conversationListState?.initialized ?? false;
  const isLoadingConversations = conversationListState?.isLoading ?? false;
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [localIsCreatingConversation, setLocalIsCreatingConversation] =
    useState(false);
  const isCreatingConversation =
    localIsCreatingConversation || pendingCreateConversationId !== null;
  const isCreatingConversationRef = useRef(isCreatingConversation);
  const resolvePendingSubmit = useCallback(
    () =>
      conversationListQuery
        ? getAgentGUIConversationSubmitPending({
            query: conversationListQuery,
            conversationId: activeConversationId
          })
        : false,
    [activeConversationId, conversationListQuery]
  );
  const [isPendingSubmit, setIsPendingSubmit] = useState(resolvePendingSubmit);
  const [localIsSubmitting, setLocalIsSubmitting] = useState(false);
  const isSubmitting = localIsSubmitting || isPendingSubmit;
  const activeQueuedPromptSnapshot = useAgentQueuedPromptSessionSnapshot({
    workspaceId,
    agentSessionId: activeConversationId
  });
  const activeQueuedPrompts =
    activeQueuedPromptSnapshot?.prompts ?? EMPTY_QUEUED_PROMPTS;
  const activeQueuedPromptClaim = activeQueuedPromptSnapshot?.claim ?? null;
  const [interruptingSessionIds, setInterruptingSessionIds] = useState<
    Record<string, boolean>
  >({});
  // Sessions whose cancel raced startup; the interrupt is retried once the
  // session connects and its turn goes live.
  const [pendingInterruptSessionIds, setPendingInterruptSessionIds] = useState<
    Record<string, boolean>
  >({});
  const [
    suppressedPromptRequestIdsBySessionId,
    setSuppressedPromptRequestIdsBySessionId
  ] = useState<Record<string, string>>({});
  const activePendingPromptRef = useRef<{
    sessionId: string;
    requestId: string;
    kind: string | null;
  } | null>(null);
  // Bridges submitInteractivePrompt (defined earlier) to
  // updateComposerSettings (defined later); assigned right after the
  // callback's definition.
  const updateComposerSettingsRef = useRef<
    (nextSettings: Partial<AgentSessionComposerSettings>) => void
  >(() => {});
  // Bridges submitInteractivePrompt (defined earlier) to the client-side plan
  // decision handlers (defined later); assigned after those callbacks.
  const planActionsRef = useRef<{
    implement: () => void;
    feedback: (text: string) => void;
    skip: () => void;
  }>({ implement: () => {}, feedback: () => {}, skip: () => {} });
  const [isRespondingApproval, setIsRespondingApproval] = useState(false);
  const [isDeletingConversation, setIsDeletingConversation] = useState(false);
  const [isDeletingProjectConversations, setIsDeletingProjectConversations] =
    useState(false);
  const updatingSessionSettingsIdsRef = useRef<Record<string, boolean>>({});
  const queuedComposerSettingsUpdatesRef = useRef<
    Record<string, QueuedComposerSettingsUpdate>
  >({});
  // Composer settings changed while a session is still mid-activation (the
  // optimistic pre-activation window: activeConversationId is set but no
  // backend session exists yet, so there is nothing to send an
  // updateSessionSettings RPC to). Held here and flushed once activation
  // resolves into a real session; dropped if activation fails or is
  // superseded, since there is then nothing left to apply the patch to.
  const pendingActivationComposerSettingsPatchRef = useRef<
    Record<string, AgentSessionComposerSettings>
  >({});
  // Indirection so startConversation (declared above
  // flushQueuedComposerSettingsUpdate in this file) can flush a settings
  // patch queued during the pre-activation window once the real session
  // attaches, without reordering the two useCallback declarations.
  const flushQueuedComposerSettingsUpdateRef = useRef<
    | ((
        input: QueuedComposerSettingsUpdate & { agentSessionId: string }
      ) => void)
    | null
  >(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] =
    useState<AgentGUIConversationSummary | null>(null);
  const [
    pendingDeleteProjectConversations,
    setPendingDeleteProjectConversations
  ] = useState<AgentGUIProjectConversationDeleteTarget | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [statePatchErrorBySessionId, setStatePatchErrorBySessionId] = useState<
    Record<string, string>
  >({});
  const [openclawGateway, setOpenclawGateway] =
    useState<OpenclawGatewayViewState | null>(() =>
      data.provider === "openclaw" ? { status: "starting", error: null } : null
    );
  const sessionViewRef = useCallback(
    (agentSessionId: string | null | undefined) => ({
      workspaceId,
      agentSessionId
    }),
    [workspaceId]
  );
  const activeSessionView = useAgentSessionView(
    sessionViewRef(activeConversationId)
  );
  const activeSessionState = activeSessionView?.controlState ?? null;
  const composerTargetData =
    activeConversationId === null
      ? selectedComposerTargetData
      : composerTargetDataFromNodeData(data);
  const providerComposerOptions = composerOptionsForTarget({
    snapshot: agentActivitySnapshot,
    target: composerTargetData
  });
  const resolvedPromptImagesSupported = resolveAgentActivityCapability(
    "imageInput",
    {
      composerOptions: providerComposerOptions,
      sessionRuntimeContext: activeSessionState?.runtimeContext
    }
  );
  const promptImagesSupported = resolvedPromptImagesSupported ?? true;
  const compactSupported = resolveAgentActivityCapability("compact", {
    composerOptions: providerComposerOptions,
    sessionRuntimeContext: activeSessionState?.runtimeContext
  });
  const goalPauseSupported =
    resolveAgentActivityCapability("goalPause", {
      composerOptions: providerComposerOptions,
      sessionRuntimeContext: activeSessionState?.runtimeContext
    }) ?? false;
  const activeSessionRuntimeContext = activeSessionState?.runtimeContext;
  const backgroundAgentCount = useMemo(
    () => activeBackgroundAgentCount(activeSessionRuntimeContext),
    [activeSessionRuntimeContext]
  );
  const composerSupport = useMemo(
    () =>
      composerSettingsSupportFromOptions(
        providerComposerOptions,
        activeSessionRuntimeContext ?? null
      ),
    [providerComposerOptions, activeSessionRuntimeContext]
  );
  // Provider-static capability flags used to gate composer-options effects
  // (the options-derived `composerSupport` above can be empty before options
  // load). Kept from the upstream refactor that those effects depend on.
  const supports = composerSupportForProvider(composerTargetData.provider);
  const usage = useMemo(
    () =>
      resolveAgentActivityUsage({
        sessionRuntimeContext: activeSessionRuntimeContext
      }),
    [activeSessionRuntimeContext]
  );
  // Maps a session to the plan turn id whose implement-plan offer was
  // dismissed, so a given plan is offered once while a fresh plan turn
  // (different turn id) re-arms the offer.
  const [dismissedPlanTurnIdBySessionId, setDismissedPlanTurnIdBySessionId] =
    useState<Record<string, string>>({});
  const planImplementationTurnIdRef = useRef<string | null>(null);
  const dismissPlanImplementation = useCallback(() => {
    const agentSessionId = activeConversationIdRef.current;
    const planTurnId = planImplementationTurnIdRef.current;
    if (!agentSessionId || !planTurnId) {
      return;
    }
    setDismissedPlanTurnIdBySessionId((current) =>
      current[agentSessionId] === planTurnId
        ? current
        : { ...current, [agentSessionId]: planTurnId }
    );
  }, []);
  const stableRuntimeSyncStateBySessionIdRef = useRef<
    Record<string, WorkspaceAgentActivitySyncState | undefined>
  >({});
  const latestRuntimeSyncStateBySessionIdRef = useRef<
    Record<string, WorkspaceAgentActivitySyncState | undefined>
  >({});
  const resolveSessionMessages = useCallback(
    (agentSessionId: string | null | undefined) => {
      const normalizedAgentSessionId = agentSessionId?.trim() ?? "";
      if (!normalizedAgentSessionId) {
        return EMPTY_AGENT_GUI_MESSAGES;
      }
      const sessionView = getAgentSessionView(
        sessionViewRef(normalizedAgentSessionId)
      );
      return mergeWorkspaceAgentMessages(
        sessionView?.detailMessages ?? EMPTY_AGENT_GUI_MESSAGES,
        sessionView?.overlayMessages ?? EMPTY_AGENT_GUI_MESSAGES
      );
    },
    [sessionViewRef]
  );
  const activeMessages = useMemo(() => {
    return activeConversationId
      ? resolveSessionMessages(activeConversationId)
      : (activeSessionView?.overlayMessages ?? EMPTY_AGENT_GUI_MESSAGES);
  }, [
    activeConversationId,
    activeSessionView?.detailMessages,
    activeSessionView?.overlayMessages,
    resolveSessionMessages
  ]);
  const activeTimelineItems = useMemo(
    () => projectAgentGUIMessagesToTimelineItems(activeMessages),
    [activeMessages]
  );
  const runtimeSessionsBySessionId = useMemo(
    () =>
      new Map(
        agentActivitySnapshot.sessions.map((session) => [
          session.agentSessionId.trim(),
          session
        ])
      ),
    [agentActivitySnapshot.sessions]
  );
  const stableRuntimeSyncStateBySessionId = useMemo(() => {
    const current = stableRuntimeSyncStateBySessionIdRef.current;
    let next = current;
    let changed = false;
    const mutableNext = () => {
      if (!changed) {
        next = { ...current };
        changed = true;
      }
      return next;
    };
    const activeSessionIds = new Set<string>();
    for (const session of agentActivitySnapshot.sessions) {
      const agentSessionId = session.agentSessionId.trim();
      if (!agentSessionId) {
        continue;
      }
      activeSessionIds.add(agentSessionId);
      const nextSyncState = runtimeSessionSyncState(session);
      if (!nextSyncState) {
        if (current[agentSessionId] !== undefined) {
          delete mutableNext()[agentSessionId];
        }
        delete latestRuntimeSyncStateBySessionIdRef.current[agentSessionId];
        continue;
      }
      const latestSyncState =
        latestRuntimeSyncStateBySessionIdRef.current[agentSessionId];
      if (
        latestSyncState &&
        !shouldApplySyncState(latestSyncState, nextSyncState)
      ) {
        continue;
      }
      latestRuntimeSyncStateBySessionIdRef.current = {
        ...latestRuntimeSyncStateBySessionIdRef.current,
        [agentSessionId]: nextSyncState
      };
      const currentSyncState = next[agentSessionId];
      if (
        !currentSyncState ||
        !syncStateRenderFieldsEqual(currentSyncState, nextSyncState)
      ) {
        mutableNext()[agentSessionId] = nextSyncState;
      }
    }
    for (const agentSessionId of Object.keys(next)) {
      if (!activeSessionIds.has(agentSessionId)) {
        delete mutableNext()[agentSessionId];
        delete latestRuntimeSyncStateBySessionIdRef.current[agentSessionId];
      }
    }
    if (changed) {
      stableRuntimeSyncStateBySessionIdRef.current = next;
    }
    return next;
  }, [agentActivitySnapshot.sessions]);
  const markSessionSettingsRequestState = useCallback(
    (agentSessionId: string, isUpdating: boolean) => {
      if (isUpdating) {
        updatingSessionSettingsIdsRef.current = {
          ...updatingSessionSettingsIdsRef.current,
          [agentSessionId]: true
        };
        return;
      }
      if (!updatingSessionSettingsIdsRef.current[agentSessionId]) {
        return;
      }
      const nextRef = { ...updatingSessionSettingsIdsRef.current };
      delete nextRef[agentSessionId];
      updatingSessionSettingsIdsRef.current = nextRef;
    },
    []
  );
  const projectedBackgroundBusyConversationIds = useMemo(
    () =>
      conversations
        .filter(
          (conversation) =>
            conversation.id !== activeConversationId &&
            conversationBusyStatus(conversation.status)
        )
        .map((conversation) => conversation.id)
        .sort(),
    [activeConversationId, conversations]
  );
  const backgroundBusyConversationIds = useStableStringArrayByValue(
    projectedBackgroundBusyConversationIds
  );
  const projectedReleasedBackgroundConversationIds = useMemo(
    () =>
      conversations
        .filter(
          (conversation) =>
            conversation.id === activeConversationId ||
            conversation.status === "completed" ||
            conversation.status === "failed" ||
            conversation.status === "canceled"
        )
        .map((conversation) => conversation.id)
        .sort(),
    [activeConversationId, conversations]
  );
  const releasedBackgroundConversationIds = useStableStringArrayByValue(
    projectedReleasedBackgroundConversationIds
  );
  const [
    retainedBackgroundConversationIds,
    setRetainedBackgroundConversationIds
  ] = useState<string[]>([]);
  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (
      backgroundBusyConversationIds.length === 0 &&
      releasedBackgroundConversationIds.length === 0
    ) {
      return;
    }
    setRetainedBackgroundConversationIds((current) => {
      const next = new Set(current);
      for (const conversationId of backgroundBusyConversationIds) {
        next.add(conversationId);
      }
      for (const conversationId of releasedBackgroundConversationIds) {
        next.delete(conversationId);
      }
      const nextIds = [...next].sort();
      return stringArraysEqual(nextIds, current) ? current : nextIds;
    });
  }, [
    backgroundBusyConversationIds,
    previewMode,
    releasedBackgroundConversationIds
  ]);
  const backgroundWatchedConversationIds = useMemo(
    () =>
      previewMode
        ? []
        : [
            ...new Set([
              ...backgroundBusyConversationIds,
              ...retainedBackgroundConversationIds
            ])
          ].sort(),
    [
      backgroundBusyConversationIds,
      previewMode,
      retainedBackgroundConversationIds
    ]
  );
  const accountProfilesByUserId = useAccountStore(
    (state) => state.profilesByUserId
  );
  const ensureAccountProfiles = useAccountStore(
    (state) => state.ensureProfiles
  );
  const activeConversationIdRef = useRef(activeConversationId);
  const selectedProjectPathRef = useRef(selectedProjectPath);
  const userProjectsRef = useRef(userProjects);
  const isNoProjectPathRef = useRef(isNoProjectPath);
  const userProjectsLoadSeqRef = useRef(0);
  const composerOptionsProjectKeyRef = useRef<string | null>(null);
  const conversationsRef = useRef(conversations);
  const isMountedRef = useRef(true);
  const agentActivitySnapshotRef = useRef<AgentActivitySnapshot>(
    agentActivitySnapshot
  );
  const dataRef = useRef(data);
  const selectedProviderTargetRef = useRef(effectiveSelectedProviderTarget);
  selectedProviderTargetRef.current = effectiveSelectedProviderTarget;
  const selectedProviderTargetIsExplicitRef = useRef(
    effectiveSelectedProviderTargetIsExplicit
  );
  selectedProviderTargetIsExplicitRef.current =
    effectiveSelectedProviderTargetIsExplicit;
  const selectedComposerTargetDataRef = useRef(selectedComposerTargetData);
  selectedComposerTargetDataRef.current = selectedComposerTargetData;
  const draftSettingsBySessionIdRef = useRef(draftSettingsBySessionId);
  const onDataChangeRef = useRef(onDataChange);
  const onRememberComposerDefaultsRef = useRef(onRememberComposerDefaults);
  const onShowMessageRef = useRef(onShowMessage);
  const handledPrefillPromptSequenceRef = useRef<number | null>(null);
  const pendingAutoSubmitPromptRef = useRef<string | null>(null);
  const [transientConversation, setTransientConversationState] =
    useState<AgentGUIConversationSummary | null>(null);
  const transientConversationRef = useRef<AgentGUIConversationSummary | null>(
    transientConversation
  );
  const startingConversationIdRef = useRef<string | null>(null);
  // Stashes the error message from a failed first-message create so the
  // activeConversationId-null effect (which otherwise clears detailError on
  // every home transition) can surface it on the home composer instead of
  // wiping it out during the optimistic-entry revert.
  const pendingHomeErrorRef = useRef<string | null>(null);
  const activatedConversationIdsRef = useRef(new Set<string>());
  const failedNewConversationIdsRef = useRef(new Set<string>());
  const lastActiveModelByProviderRef = useRef<Record<string, string>>({});
  const pendingTurnIdBySessionIdRef = useRef<Record<string, string>>({});
  const submitTraceBySessionIdRef = useRef<
    Record<string, AgentSubmitTraceState>
  >({});
  const conversationIdsRef = useRef(
    new Set(conversations.map((conversation) => conversation.id))
  );
  const previousConversationListSnapshotRef = useRef<{
    query: AgentGUIConversationListQuery | null;
    conversations: AgentGUIConversationSummary[];
  }>({
    query: null,
    conversations: []
  });
  const selectedConversationMessageLoadSeqRef = useRef(0);
  const selectedConversationOlderMessageLoadSeqRef = useRef(0);
  const failedOlderMessageCursorBySessionIdRef = useRef<Map<string, number>>(
    new Map()
  );
  const lastConversationProjectionDiagnosticKeyRef = useRef<string | null>(
    null
  );
  const lastRenderStateDiagnosticKeyRef = useRef<string | null>(null);
  const selectedConversationPendingMessageLoadIdsRef = useRef(
    new Set<string>()
  );
  const selectedConversationInitialStateLoadedIdsRef = useRef(
    new Set<string>()
  );
  const selectedConversationInitialMessagesLoadedIdsRef = useRef(
    new Set<string>()
  );
  const handledOpenSessionSequenceRef = useRef<number | null>(null);
  const pendingOpenSessionRequestRef =
    useRef<AgentGUIOpenSessionRequest | null>(null);
  const explicitlyOpenedConversationIdsRef = useRef(new Set<string>());
  const railPinnedTransientConversationIdsRef = useRef(new Set<string>());
  const selectedConversationNotFoundRetryIdsRef = useRef(new Set<string>());
  const selectedConversationNotFoundRetryTimerRef = useRef<number | null>(null);
  const sessionStateSnapshotCauseBySessionIdRef = useRef<
    Record<
      string,
      | {
          source:
            | "conversation-selected"
            | "activity-stream"
            | "settings-update";
        }
      | undefined
    >
  >({});
  const blockedActivityStreamStateReloadSessionIdsRef = useRef(
    new Set<string>()
  );
  const blockedAutomaticSessionStateLoadSessionIdsRef = useRef(
    new Set<string>()
  );
  const openclawGatewayRequestIdRef = useRef(0);
  const executePromptRef = useRef<
    (
      agentSessionId: string,
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: { guidance?: boolean }
    ) => void
  >(() => {});
  const reloadSelectedConversationRef = useRef<
    (
      agentSessionId: string,
      options: { reloadConversations: boolean; reloadDetail: boolean }
    ) => void
  >(() => {});
  const isComposerHomeRef = useRef(isComposerHome);
  const activation = useAgentGUIActivation({
    workspaceId,
    getErrorMessage: getAgentGUIErrorMessage,
    getErrorCode: getAgentGUIErrorCode
  });
  const activeConversationLiveState = activation.stateFor(activeConversationId);
  const unactivateRef = useRef(activation.unactivate);
  // Daemon clamps reasoning for providers without settings support, so the
  // draft default no longer needs a provider gate here.
  const defaultReasoningEffort: AgentSessionReasoningEffort | null = "high";
  const markFailedLiveState = activation.markFailed;
  const clearFailedLiveState = activation.clearFailure;

  // Constrained store-write helpers. The controller can only patch a single
  // conversation by id or remove conversations by id — it can no longer pass an
  // arbitrary `(current[]) => next[]` updater, which is what allowed the old
  // per-window project writeback to bulk-rewrite shared store conversations.
  const patchConversation = useCallback(
    (
      conversationId: string,
      patch:
        | Partial<Omit<AgentGUIConversationSummary, "project">>
        | ((
            conversation: AgentGUIConversationSummary
          ) => Partial<Omit<AgentGUIConversationSummary, "project">> | null)
    ) => {
      if (!conversationListQuery) {
        return;
      }
      patchAgentGUIConversationSummary({
        query: conversationListQuery,
        conversationId,
        patch
      });
    },
    [conversationListQuery]
  );
  const removeConversations = useCallback(
    (conversationIds: readonly string[]) => {
      if (!conversationListQuery) {
        return;
      }
      removeAgentGUIConversationSummaries({
        query: conversationListQuery,
        conversationIds
      });
    },
    [conversationListQuery]
  );

  const setUserProjectsSnapshot = useCallback(
    (projects: readonly AgentHostUserProject[]) => {
      setUserProjects((current) =>
        areAgentGUIUserProjectsEqual(current, projects)
          ? current
          : [...projects]
      );
    },
    []
  );

  useEffect(() => {
    const api = agentHostApi.userProjects;
    let disposed = false;
    setUserProjectsSnapshot(readAgentGUIUserProjectSnapshot(api));
    const loadUserProjects = async () => {
      const requestSeq = ++userProjectsLoadSeqRef.current;
      if (!api) {
        if (!disposed && requestSeq === userProjectsLoadSeqRef.current) {
          setUserProjectsSnapshot([]);
        }
        return;
      }
      try {
        const result = await api.list();
        if (!disposed && requestSeq === userProjectsLoadSeqRef.current) {
          setUserProjectsSnapshot(result.projects);
        }
      } catch {
        if (!disposed && requestSeq === userProjectsLoadSeqRef.current) {
          setUserProjectsSnapshot([]);
        }
      }
    };
    void loadUserProjects();
    const unsubscribe = previewMode
      ? undefined
      : api?.subscribe?.(() => {
          void loadUserProjects();
        });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [agentHostApi.userProjects, previewMode, setUserProjectsSnapshot]);

  const setTransientConversation = useCallback(
    (
      value:
        | AgentGUIConversationSummary
        | null
        | ((
            current: AgentGUIConversationSummary | null
          ) => AgentGUIConversationSummary | null)
    ): void => {
      const next =
        typeof value === "function"
          ? (
              value as (
                current: AgentGUIConversationSummary | null
              ) => AgentGUIConversationSummary | null
            )(transientConversationRef.current)
          : value;
      if (next === transientConversationRef.current) {
        return;
      }
      transientConversationRef.current = next;
      setTransientConversationState(next);
    },
    []
  );

  const conversationSummaryFromRuntimeSession = useCallback(
    (session: AgentActivitySession): AgentGUIConversationSummary => {
      const updatedAtUnixMs = session.updatedAtUnixMs ?? Date.now();
      const projectedSession: AgentSession = {
        workspaceId: session.workspaceId,
        agentSessionId: session.agentSessionId,
        agentTargetId: session.agentTargetId ?? null,
        provider: session.provider as AgentSession["provider"],
        providerSessionId: session.providerSessionId ?? session.agentSessionId,
        resumable: session.resumable,
        cwd: session.cwd,
        status: session.status,
        title: session.title,
        pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
        createdAtUnixMs: session.createdAtUnixMs ?? updatedAtUnixMs,
        updatedAtUnixMs
      };
      return conversationSummaryFromAgentSession(projectedSession, {
        isNoProjectPath: isNoProjectPathRef.current,
        userProjects: userProjectsRef.current
      });
    },
    []
  );

  const ensureTransientOpenSessionConversation = useCallback(
    (agentSessionId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId) {
        return;
      }
      if (
        resolveConversationSummaryById(
          conversationsRef.current,
          normalizedAgentSessionId,
          transientConversationRef.current
        )
      ) {
        return;
      }
      const snapshotSession = agentActivitySnapshotRef.current.sessions.find(
        (session) =>
          session.agentSessionId.trim() === normalizedAgentSessionId &&
          session.visible !== false
      );
      if (snapshotSession) {
        setTransientConversation(
          conversationSummaryFromRuntimeSession(snapshotSession)
        );
        return;
      }
      void agentActivityRuntime
        .getSession(workspaceId, normalizedAgentSessionId)
        .then((session) => {
          const shouldKeepTransient =
            explicitlyOpenedConversationIdsRef.current.has(
              normalizedAgentSessionId
            ) ||
            railPinnedTransientConversationIdsRef.current.has(
              normalizedAgentSessionId
            );
          if (
            !isMountedRef.current ||
            activeConversationIdRef.current !== normalizedAgentSessionId ||
            !shouldKeepTransient ||
            resolveConversationSummaryById(
              conversationsRef.current,
              normalizedAgentSessionId,
              transientConversationRef.current
            )
          ) {
            return;
          }
          setTransientConversation(
            conversationSummaryFromRuntimeSession(session)
          );
        })
        .catch(() => {});
    },
    [
      agentActivityRuntime,
      conversationSummaryFromRuntimeSession,
      setTransientConversation,
      workspaceId
    ]
  );

  // NOTE: project metadata is intentionally NOT written back into the shared
  // conversation store. `conversation.project` is a per-window JOIN of cwd ×
  // userProjects; deriving it here and persisting it caused cross-window update
  // storms. It is now derived in the view layer (groupConversations) instead.

  const ensureOpenclawGateway = useCallback(() => {
    if (dataRef.current.provider !== "openclaw") {
      setOpenclawGateway(null);
      return;
    }
    const requestId = ++openclawGatewayRequestIdRef.current;
    const warmup = agentActivityRuntime.warmupOpenclawGateway;
    setOpenclawGateway({ status: "starting", error: null });
    if (typeof warmup !== "function") {
      setOpenclawGateway({
        status: "failed",
        error: null
      });
      return;
    }
    void warmup()
      .then(() => {
        if (
          !isMountedRef.current ||
          requestId !== openclawGatewayRequestIdRef.current
        ) {
          return;
        }
        setOpenclawGateway({ status: "ready", error: null });
      })
      .catch((error: unknown) => {
        if (
          !isMountedRef.current ||
          requestId !== openclawGatewayRequestIdRef.current
        ) {
          return;
        }
        setOpenclawGateway({
          status: "failed",
          error: getAgentGUIErrorMessage(error)
        });
        reportAgentGUIRuntimeError({
          error,
          phase: "warmup_openclaw_gateway",
          provider: dataRef.current.provider,
          runtime: agentActivityRuntime,
          workspaceId
        });
      });
  }, [agentActivityRuntime, workspaceId]);

  useEffect(() => {
    agentActivitySnapshotRef.current = agentActivitySnapshot;
  }, [agentActivitySnapshot]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Respond to external data changes (e.g. workbench switching to a different
  // session from outside the controller). Skips no-op updates and self-echos.
  useEffect(() => {
    const externalId = data.lastActiveAgentSessionId?.trim() ?? "";
    // If our activeConversationIdRef already reflects this id, this is either
    // our own write echoing back or we're already here — no work needed.
    if (externalId === (activeConversationIdRef.current ?? "")) return;
    if (!externalId) {
      const previous = activeConversationIdRef.current;
      if (!previous && isComposerHomeRef.current && intent.tag === "home") {
        return;
      }
      reportAgentGUIActiveConversationCleared({
        details: {
          dataLastActiveAgentSessionId: data.lastActiveAgentSessionId ?? null,
          intent: intent.tag,
          isComposerHome: isComposerHomeRef.current
        },
        previousAgentSessionId: previous,
        reason: "external_last_active_empty",
        runtime: agentActivityRuntime,
        workspaceId
      });
      if (previous) {
        void activation.unactivate(previous);
      }
      setIntent({ tag: "home" });
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      setIsLoadingMessages(false);
      setDetailError(null);
      loadDraftComposerOptions();
      return;
    }
    setIntent((current) => {
      if (
        (current.tag === "active" || current.tag === "requested") &&
        current.id === externalId
      ) {
        return current; // already routing to this id
      }
      if (current.tag === "requested" || current.tag === "resolving") {
        return current; // mid-routing: local intent wins
      }
      return { tag: "requested", id: externalId };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.lastActiveAgentSessionId]);

  useEffect(() => {
    isComposerHomeRef.current = isComposerHome;
  }, [isComposerHome]);

  useEffect(() => {
    if (activeConversationId === null && isComposerHome) {
      return;
    }
    setHomeComposerTargetOverride(null);
  }, [activeConversationId, isComposerHome]);

  useEffect(() => {
    isCreatingConversationRef.current = isCreatingConversation;
  }, [isCreatingConversation]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    setPendingCreateConversationId(resolvePendingCreateConversationId());
    if (!conversationListQuery || !pendingCreateOwnerKey) {
      return;
    }
    return subscribeAgentGUIConversationListStore(() => {
      setPendingCreateConversationId(resolvePendingCreateConversationId());
    });
  }, [
    conversationListQuery,
    pendingCreateOwnerKey,
    previewMode,
    resolvePendingCreateConversationId
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    setIsPendingSubmit(resolvePendingSubmit());
    if (!conversationListQuery || activeConversationId === null) {
      return;
    }
    return subscribeAgentGUIConversationListStore(() => {
      setIsPendingSubmit(resolvePendingSubmit());
    });
  }, [
    activeConversationId,
    conversationListQuery,
    previewMode,
    resolvePendingSubmit
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    ensureOpenclawGateway();
  }, [data.provider, ensureOpenclawGateway, previewMode]);

  useEffect(() => {
    onDataChangeRef.current = onDataChange;
  }, [onDataChange]);

  useEffect(() => {
    onRememberComposerDefaultsRef.current = onRememberComposerDefaults;
  }, [onRememberComposerDefaults]);

  useEffect(() => {
    onShowMessageRef.current = onShowMessage;
  }, [onShowMessage]);

  useEffect(() => {
    draftBySessionIdRef.current = draftBySessionId;
  }, [draftBySessionId]);

  useEffect(() => {
    draftSettingsBySessionIdRef.current = draftSettingsBySessionId;
  }, [draftSettingsBySessionId]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    if (previewMode || !conversationListQuery) {
      return undefined;
    }
    setAgentGUIConversationListActiveConversation({
      query: conversationListQuery,
      ownerKey: conversationListActiveOwnerKey,
      conversationId: activeConversationId
    });
    return () => {
      setAgentGUIConversationListActiveConversation({
        query: conversationListQuery,
        ownerKey: conversationListActiveOwnerKey,
        conversationId: null
      });
    };
  }, [
    activeConversationId,
    conversationListActiveOwnerKey,
    conversationListQuery,
    previewMode
  ]);

  useEffect(() => {
    selectedProjectPathRef.current = selectedProjectPath;
  }, [selectedProjectPath]);

  useEffect(() => {
    userProjectsRef.current = userProjects;
  }, [userProjects]);

  useEffect(() => {
    isNoProjectPathRef.current = isNoProjectPath;
  }, [isNoProjectPath]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    unactivateRef.current = activation.unactivate;
  }, [activation.unactivate]);

  useEffect(() => {
    conversationIdsRef.current = new Set(
      conversations.map((conversation) => conversation.id)
    );
  }, [conversations]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    // Carry the previous query's conversations across a query-key (userId) switch
    // so the list (and local working status/titles) survives the transition until
    // the new query refreshes. This is a one-shot seed gated on an empty new slot
    // and a changed query key — NOT a per-render derived writeback, so it is not a
    // cross-window storm source (unlike the project writeback, which was removed).
    const previousSnapshot = previousConversationListSnapshotRef.current;
    const previousQuery = previousSnapshot.query;
    const previousQueryKey = previousQuery
      ? createAgentGUIConversationListQueryKey(previousQuery)
      : null;
    const nextQueryKey = conversationListQuery
      ? createAgentGUIConversationListQueryKey(conversationListQuery)
      : null;
    const previousHasExplicitFilter = previousQuery?.conversationFilter != null;
    const nextHasExplicitFilter =
      conversationListQuery?.conversationFilter != null;
    const previousFilterKey = previousQuery
      ? JSON.stringify(
          normalizeAgentGUIConversationFilter(previousQuery.conversationFilter)
        )
      : "";
    const nextFilterKey = conversationListQuery
      ? JSON.stringify(
          normalizeAgentGUIConversationFilter(
            conversationListQuery.conversationFilter
          )
        )
      : "";
    if (
      previousQuery &&
      conversationListQuery &&
      previousQueryKey !== nextQueryKey &&
      previousQuery.workspaceId === conversationListQuery.workspaceId &&
      previousQuery.provider === conversationListQuery.provider &&
      previousHasExplicitFilter === nextHasExplicitFilter &&
      previousFilterKey === nextFilterKey &&
      previousQuery.sessionOrigin === conversationListQuery.sessionOrigin &&
      previousSnapshot.conversations.length > 0
    ) {
      ensureAgentGUIConversationListQuery(conversationListQuery);
      seedAgentGUIConversationListConversationsIfEmpty({
        query: conversationListQuery,
        conversations: previousSnapshot.conversations
      });
    }
    previousConversationListSnapshotRef.current = {
      query: conversationListQuery,
      conversations
    };
  }, [conversationListQuery, conversations, previewMode]);
  const persistActiveConversation = useCallback(
    (agentSessionId: string | null) => {
      onDataChangeRef.current((current) =>
        current.lastActiveAgentSessionId === agentSessionId
          ? current
          : { ...current, lastActiveAgentSessionId: agentSessionId }
      );
    },
    []
  );
  const clearSelectedConversationNotFoundRetry = useCallback(() => {
    if (selectedConversationNotFoundRetryTimerRef.current !== null) {
      window.clearTimeout(selectedConversationNotFoundRetryTimerRef.current);
      selectedConversationNotFoundRetryTimerRef.current = null;
    }
  }, []);
  const clearSelectedConversationNotFoundRetryWhenInitialLoadsSettled =
    useCallback((agentSessionId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (
        normalizedAgentSessionId &&
        selectedConversationInitialStateLoadedIdsRef.current.has(
          normalizedAgentSessionId
        ) &&
        selectedConversationInitialMessagesLoadedIdsRef.current.has(
          normalizedAgentSessionId
        )
      ) {
        selectedConversationNotFoundRetryIdsRef.current.delete(
          normalizedAgentSessionId
        );
        selectedConversationInitialStateLoadedIdsRef.current.delete(
          normalizedAgentSessionId
        );
        selectedConversationInitialMessagesLoadedIdsRef.current.delete(
          normalizedAgentSessionId
        );
      }
    }, []);
  const markSelectedConversationDetailPending = useCallback(
    (agentSessionId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId) {
        return null;
      }
      clearSelectedConversationNotFoundRetry();
      selectedConversationNotFoundRetryIdsRef.current.add(
        normalizedAgentSessionId
      );
      selectedConversationInitialStateLoadedIdsRef.current.delete(
        normalizedAgentSessionId
      );
      selectedConversationInitialMessagesLoadedIdsRef.current.delete(
        normalizedAgentSessionId
      );
      selectedConversationPendingMessageLoadIdsRef.current.add(
        normalizedAgentSessionId
      );
      resetAgentSessionViewDetailMessages(
        sessionViewRef(normalizedAgentSessionId)
      );
      setIsLoadingMessages(true);
      setAgentSessionViewMessagesLoading(
        sessionViewRef(normalizedAgentSessionId),
        true
      );
      return normalizedAgentSessionId;
    },
    [clearSelectedConversationNotFoundRetry, sessionViewRef]
  );
  const updateSelectedProjectPath = useCallback(
    (
      path: string | null,
      metadata?: {
        action: "clear" | "create_new" | "select_existing";
        project?: {
          id: string;
          path: string;
          label: string;
          createdAtUnixMs?: number;
          updatedAtUnixMs?: number;
          lastUsedAtUnixMs?: number | null;
        };
      }
    ) => {
      const normalizedPath = normalizeProjectDraftPath(path);
      const project = metadata?.project;
      if (project && normalizedPath && project.path === normalizedPath) {
        const nextProjects = upsertAgentGUIUserProject(
          userProjectsRef.current,
          project
        );
        userProjectsRef.current = nextProjects;
        setUserProjectsSnapshot(nextProjects);
      }
      selectedProjectPathRef.current = normalizedPath;
      setSelectedProjectPath(normalizedPath);
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId || !metadata) {
        return;
      }
      const tracking = agentActivityRuntime.trackSettingsProjectChange?.({
        action: metadata.action,
        agentSessionId,
        provider: dataRef.current.provider,
        workspaceId
      });
      void tracking?.catch(() => {});
    },
    [agentActivityRuntime, workspaceId]
  );

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!hasLoadedConversations) {
      return;
    }
    const nextConversationCount = mergeVisibleConversations(
      conversations,
      transientConversationRef.current
    ).length;
    onDataChangeRef.current((current) =>
      current.conversationCount === nextConversationCount
        ? current
        : { ...current, conversationCount: nextConversationCount }
    );
  }, [
    conversations.length,
    hasLoadedConversations,
    previewMode,
    transientConversation
  ]);

  const isCurrentConversation = useCallback((agentSessionId: string) => {
    return (
      isMountedRef.current &&
      activeConversationIdRef.current === agentSessionId.trim()
    );
  }, []);

  const unactivateIfStale = useCallback(
    (agentSessionId: string) => {
      const normalized = agentSessionId.trim();
      if (!normalized || isCurrentConversation(normalized)) {
        return false;
      }
      void activation.unactivate(normalized);
      return true;
    },
    [activation, isCurrentConversation]
  );

  const selectConversation = useCallback(
    (agentSessionId: string, options?: { reloadConversations?: boolean }) => {
      const normalized = agentSessionId.trim();
      if (!normalized) {
        return;
      }
      const previous = activeConversationIdRef.current;
      isComposerHomeRef.current = false;
      setIsComposerHome(false);
      const pendingNewConversationId = startingConversationIdRef.current;
      if (previous && previous !== normalized) {
        activatedConversationIdsRef.current.delete(previous);
        void activation.unactivate(previous);
      }
      if (previous !== normalized) {
        const hasCachedMessages = sessionHasRenderableMessages({
          agentSessionId: normalized,
          hasLoadedInitialMessages:
            selectedConversationInitialMessagesLoadedIdsRef.current.has(
              normalized
            ),
          sessionViewRef,
          snapshotMessagesById:
            agentActivitySnapshotRef.current.sessionMessagesById
        });
        if (hasCachedMessages) {
          clearSelectedConversationNotFoundRetry();
          setIsLoadingMessages(false);
        } else {
          markSelectedConversationDetailPending(normalized);
        }
      }
      if (pendingNewConversationId && pendingNewConversationId !== normalized) {
        activatedConversationIdsRef.current.delete(pendingNewConversationId);
        void activation.unactivate(pendingNewConversationId);
      }
      const shouldReloadConversations =
        options?.reloadConversations !== false &&
        conversationIdsRef.current.has(normalized);
      setIntent({ tag: "active", id: normalized });
      activeConversationIdRef.current = normalized;
      setActiveConversationId(normalized);
      setDetailError(null);
      if (previous !== normalized && shouldReloadConversations) {
        reloadSelectedConversationRef.current(normalized, {
          reloadConversations: true,
          reloadDetail: false
        });
      } else if (previous === normalized) {
        reloadSelectedConversationRef.current(normalized, {
          reloadConversations: shouldReloadConversations,
          reloadDetail: true
        });
      }
      if (conversationListQuery) {
        clearAgentGUIConversationUnreadCompletion({
          query: conversationListQuery,
          conversationId: normalized
        });
      }
      if (transientConversationRef.current?.id === normalized) {
        setTransientConversation((current) =>
          current?.id === normalized
            ? { ...current, hasUnreadCompletion: false }
            : current
        );
      } else if (transientConversationRef.current) {
        setTransientConversation(null);
      }
      persistActiveConversation(normalized);
    },
    [
      activation,
      clearSelectedConversationNotFoundRetry,
      conversationListQuery,
      markSelectedConversationDetailPending,
      persistActiveConversation,
      setTransientConversation
    ]
  );

  const syncConversationListProjection = useCallback(
    async (_preferredSessionId?: string | null) => {
      if (!conversationListQuery) {
        const previous = activeConversationIdRef.current;
        const workspaceIdPresent = Boolean(workspaceId.trim());
        const currentUserIdPresent = Boolean(currentUserId?.trim());
        reportAgentGUIConversationListProjectionSkipped({
          activeConversationId: previous,
          currentUserIdPresent,
          dataLastActiveAgentSessionId:
            dataRef.current.lastActiveAgentSessionId ?? null,
          isComposerHome: isComposerHomeRef.current,
          provider: dataRef.current.provider,
          reason: "conversation_list_query_missing",
          runtime: agentActivityRuntime,
          workspaceId,
          workspaceIdPresent
        });
        reportAgentGUIActiveConversationCleared({
          details: {
            currentUserIdPresent,
            dataLastActiveAgentSessionId:
              dataRef.current.lastActiveAgentSessionId ?? null,
            isComposerHome: isComposerHomeRef.current,
            provider: dataRef.current.provider,
            workspaceIdPresent
          },
          previousAgentSessionId: previous,
          reason: "conversation_list_query_missing",
          runtime: agentActivityRuntime,
          workspaceId
        });
        if (previous) {
          void activation.unactivate(previous);
        }
        setIntent({ tag: "home" });
        isComposerHomeRef.current = true;
        setIsComposerHome(true);
        activeConversationIdRef.current = null;
        setActiveConversationId(null);
        setIsLoadingMessages(false);
        setDetailError(null);
        persistActiveConversation(null);
        return;
      }
      ensureAgentGUIConversationListQuery(conversationListQuery);
      scheduleAgentGUIConversationListProjection(
        conversationListQuery,
        "projection-sync"
      );
    },
    [
      activation,
      agentQueuedPromptRuntime,
      agentActivityRuntime,
      conversationListQuery,
      currentUserId,
      persistActiveConversation,
      workspaceId
    ]
  );

  const scheduleSelectedConversationNotFoundRetry = useCallback(
    (agentSessionId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (
        !normalizedAgentSessionId ||
        !selectedConversationNotFoundRetryIdsRef.current.has(
          normalizedAgentSessionId
        )
      ) {
        return false;
      }
      setAgentSessionViewError(sessionViewRef(normalizedAgentSessionId), null);
      setAgentSessionViewMessagesLoading(
        sessionViewRef(normalizedAgentSessionId),
        true
      );
      if (activeConversationIdRef.current === normalizedAgentSessionId) {
        setIsLoadingMessages(true);
      }
      if (conversationListQuery) {
        scheduleAgentGUIConversationListProjection(
          conversationListQuery,
          "projection-sync"
        );
      }
      selectedConversationPendingMessageLoadIdsRef.current.add(
        normalizedAgentSessionId
      );
      clearSelectedConversationNotFoundRetry();
      selectedConversationNotFoundRetryTimerRef.current = window.setTimeout(
        () => {
          selectedConversationNotFoundRetryTimerRef.current = null;
          selectedConversationNotFoundRetryIdsRef.current.delete(
            normalizedAgentSessionId
          );
          selectedConversationInitialStateLoadedIdsRef.current.delete(
            normalizedAgentSessionId
          );
          selectedConversationInitialMessagesLoadedIdsRef.current.delete(
            normalizedAgentSessionId
          );
          if (
            !isMountedRef.current ||
            activeConversationIdRef.current !== normalizedAgentSessionId
          ) {
            return;
          }
          reloadSelectedConversationRef.current(normalizedAgentSessionId, {
            reloadConversations: false,
            reloadDetail: true
          });
        },
        SELECTED_SESSION_NOT_FOUND_RETRY_DELAY_MS
      );
      return true;
    },
    [
      clearSelectedConversationNotFoundRetry,
      conversationListQuery,
      sessionViewRef
    ]
  );

  useEffect(() => {
    // Track open session request sequence (unchanged logic)
    const normalizedOpenSessionRequest =
      normalizeAgentGUIOpenSessionRequest(openSessionRequest);
    if (
      !previewMode &&
      normalizedOpenSessionRequest &&
      handledOpenSessionSequenceRef.current !==
        normalizedOpenSessionRequest.sequence
    ) {
      handledOpenSessionSequenceRef.current =
        normalizedOpenSessionRequest.sequence;
      pendingOpenSessionRequestRef.current = normalizedOpenSessionRequest;
    }
    const pendingOpenSessionRequest = pendingOpenSessionRequestRef.current;
    const hasExplicitOpenSessionRequest = Boolean(
      pendingOpenSessionRequest?.agentSessionId?.trim()
    );

    const resolveId = (id: string) =>
      resolveConversationSummaryById(
        conversations,
        id,
        transientConversationRef.current
      ) !== null;
    const resolveCanonicalId = (id: string) =>
      resolveConversationSummaryById(conversations, id, null) !== null;

    const inSnapshot = (id: string) =>
      agentActivitySnapshotRef.current.sessions.some(
        (s) => s.agentSessionId.trim() === id && s.visible !== false
      );

    // Open session request takes highest priority
    if (hasExplicitOpenSessionRequest) {
      const requestedId = pendingOpenSessionRequest!.agentSessionId.trim();
      if (!hasLoadedConversations) return;
      explicitlyOpenedConversationIdsRef.current.add(requestedId);
      railPinnedTransientConversationIdsRef.current.add(requestedId);
      pendingOpenSessionRequestRef.current = null;
      selectConversation(requestedId, { reloadConversations: false });
      ensureTransientOpenSessionConversation(requestedId);
      return;
    }

    // Intent-based routing (replaces 4-ref guard chain)
    switch (intent.tag) {
      case "home":
        return;

      case "active":
        // Only demote when list is fully loaded, to avoid races during reload.
        if (resolveCanonicalId(intent.id)) {
          explicitlyOpenedConversationIdsRef.current.delete(intent.id);
          railPinnedTransientConversationIdsRef.current.delete(intent.id);
          return;
        }
        if (resolveId(intent.id)) {
          return;
        }
        if (!hasLoadedConversations) return;
        if (
          inSnapshot(intent.id) &&
          activeConversationIdRef.current === intent.id
        ) {
          railPinnedTransientConversationIdsRef.current.add(intent.id);
          ensureTransientOpenSessionConversation(intent.id);
          return;
        }
        if (
          explicitlyOpenedConversationIdsRef.current.has(intent.id) &&
          activeConversationIdRef.current === intent.id
        ) {
          return;
        }
        // Session was removed from list after load — re-check
        setIntent({ tag: "requested", id: intent.id });
        return;

      case "requested": {
        if (!hasLoadedConversations) return;
        if (resolveId(intent.id)) {
          if (activeConversationIdRef.current === intent.id) {
            // Already active (e.g. restored from data on mount) — skip selectConversation
            // to avoid a double loadSessionState; the activeConversationId effect handles it.
            setIntent({ tag: "active", id: intent.id });
            return;
          }
          selectConversation(intent.id, { reloadConversations: false });
          return;
        }
        if (inSnapshot(intent.id)) {
          if (activeConversationIdRef.current === intent.id) {
            railPinnedTransientConversationIdsRef.current.add(intent.id);
            ensureTransientOpenSessionConversation(intent.id);
            setIntent({ tag: "active", id: intent.id });
          }
          return;
        }
        setIntent({ tag: "resolving", id: intent.id });
        void syncConversationListProjection(intent.id);
        return;
      }

      case "resolving": {
        if (resolveId(intent.id)) {
          selectConversation(intent.id, { reloadConversations: false });
          return;
        }
        if (isAgentGUIConversationListRefreshing(conversationListQuery)) return;
        const fallback = selectAgentGUIConversationId(
          conversations,
          activeConversationIdRef.current
        );
        if (fallback) {
          selectConversation(fallback, { reloadConversations: false });
        } else {
          setIntent({ tag: "home" });
        }
        return;
      }
    }
  }, [
    intent,
    conversations,
    hasLoadedConversations,
    ensureTransientOpenSessionConversation,
    openSessionRequest,
    previewMode,
    syncConversationListProjection,
    selectConversation,
    conversationListQuery,
    transientConversation
  ]);

  const refreshMessagesFromSnapshot = useCallback(
    (agentSessionId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId) {
        return;
      }
      setDetailError(null);
      setAgentSessionViewError(sessionViewRef(normalizedAgentSessionId), null);
      const durableMessages = mergeWorkspaceAgentMessages(
        [],
        agentActivitySnapshotRef.current.sessionMessagesById[
          normalizedAgentSessionId
        ] ?? []
      );
      const durableItems =
        projectAgentGUIMessagesToTimelineItems(durableMessages);
      const pendingTurnId =
        pendingTurnIdBySessionIdRef.current[normalizedAgentSessionId];
      if (
        pendingTurnId &&
        durableItems.some(
          (item) =>
            item.role === "user" && item.turnId?.trim() === pendingTurnId
        )
      ) {
        const nextPending = { ...pendingTurnIdBySessionIdRef.current };
        delete nextPending[normalizedAgentSessionId];
        pendingTurnIdBySessionIdRef.current = nextPending;
      }
      const localMessages =
        getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
          ?.overlayMessages ?? [];
      const detailMessages =
        getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
          ?.detailMessages ?? [];
      const durableTailMessages =
        detailMessages.length > 0
          ? filterMessagesForDetailWindowOverlay({
              detailMessages,
              durableMessages,
              localMessages: durableMessages
            })
          : [];
      const baseMessages =
        detailMessages.length > 0
          ? mergeWorkspaceAgentMessages(detailMessages, durableTailMessages)
          : durableMessages;
      if (durableTailMessages.length > 0) {
        mergeAgentSessionViewDetailMessages(
          sessionViewRef(normalizedAgentSessionId),
          durableTailMessages
        );
      }
      const windowLocalMessages = filterMessagesForDetailWindowOverlay({
        detailMessages: baseMessages,
        durableMessages,
        localMessages
      });
      const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
        durableMessages: baseMessages,
        localMessages: windowLocalMessages
      });
      const mergedMessages = mergeWorkspaceAgentMessages(
        baseMessages,
        overlayMessages
      );
      const mergedItems =
        projectAgentGUIMessagesToTimelineItems(mergedMessages);
      setAgentSessionViewOverlayMessages(
        sessionViewRef(normalizedAgentSessionId),
        overlayMessages
      );
      const sessionState =
        getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
          ?.controlState ?? null;
      const incomingTimelineStatus =
        conversationStatusFromTimelineItems(durableItems);
      const mergedTimelineStatus = incomingTimelineStatus
        ? conversationStatusFromTimelineItems([...mergedItems])
        : null;
      patchConversation(normalizedAgentSessionId, (previous) => {
        const title = resolveAgentGUIConversationTitleFromTimelineItems({
          timelineItems: mergedItems,
          conversation: previous
        });
        const settledStatus = resolveConversationStatusAfterTimelineUpdate({
          currentStatus: previous.status,
          incomingTimelineStatus: mergedTimelineStatus,
          sessionState,
          timelineItems: mergedItems
        });
        if (
          (!title || title.title === previous.title) &&
          settledStatus === previous.status
        ) {
          return null;
        }
        return {
          ...(title
            ? {
                title: title.title,
                titleFallback: title.titleFallback
              }
            : {}),
          status: settledStatus
        };
      });
      if (activeConversationIdRef.current === normalizedAgentSessionId) {
        setIsLoadingMessages(false);
      }
      setAgentSessionViewMessagesLoading(
        sessionViewRef(normalizedAgentSessionId),
        false
      );
    },
    [sessionViewRef, patchConversation]
  );

  const applySessionStateSnapshot = useCallback(
    (
      snapshot: AgentSessionState,
      cause?: {
        source: "conversation-selected" | "activity-stream" | "settings-update";
      }
    ) => {
      const agentSessionId = snapshot.agentSessionId.trim();
      if (!agentSessionId) {
        return;
      }
      const nextStatus = conversationStatusFromSessionState(snapshot);
      const runtimeTitle =
        snapshot.runtimeContext &&
        typeof snapshot.runtimeContext === "object" &&
        "title" in snapshot.runtimeContext
          ? (snapshot.runtimeContext as { title?: unknown }).title
          : undefined;
      const title = typeof runtimeTitle === "string" ? runtimeTitle.trim() : "";
      const updatedAtUnixMs = snapshot.updatedAtUnixMs ?? Date.now();
      const shouldAdvanceConversationUpdatedAt =
        cause?.source !== "conversation-selected";
      if (!nextStatus && !title) {
        return;
      }
      const completionKey = completionKeyFromSessionState(
        agentSessionId,
        snapshot
      );
      patchConversation(agentSessionId, (conversation) => {
        const timelineItems = projectAgentGUIMessagesToTimelineItems(
          resolveSessionMessages(agentSessionId)
        );
        const canSettleBusyStatus = canSettleBusyConversationFromSessionState({
          timelineItems,
          syncState: conversation.syncState
        });
        const incomingWouldSettleBusyStatus =
          nextStatus !== null &&
          conversationBusyStatus(conversation.status) &&
          !conversationBusyStatus(nextStatus);
        const shouldKeepCurrentStatus =
          nextStatus !== null &&
          conversation.updatedAtUnixMs > updatedAtUnixMs &&
          (!incomingWouldSettleBusyStatus || !canSettleBusyStatus);
        const candidateStatus = shouldKeepCurrentStatus
          ? conversation.status
          : (nextStatus ?? conversation.status);
        const status = resolveConversationStatusFromTimelineEvidence({
          status: candidateStatus,
          timelineItems
        });
        const titleFields = mergeConversationTitleUpdateFields(
          conversation,
          title
        );
        return {
          ...titleFields,
          status,
          updatedAtUnixMs: resolveConversationUpdatedAtUnixMsFromSessionState({
            currentUpdatedAtUnixMs: conversation.updatedAtUnixMs,
            snapshotUpdatedAtUnixMs: shouldAdvanceConversationUpdatedAt
              ? snapshot.updatedAtUnixMs
              : undefined,
            source: cause?.source
          }),
          hasUnreadCompletion:
            status === "completed"
              ? (conversation.hasUnreadCompletion ?? false)
              : false,
          unreadCompletionKey:
            status === "completed"
              ? (conversation.unreadCompletionKey ?? completionKey)
              : null
        };
      });
      if (completionKey && conversationListQuery) {
        markAgentGUIConversationCompletionObserved({
          query: conversationListQuery,
          conversationId: agentSessionId,
          completionKey
        });
      }
      const transient = transientConversationRef.current;
      if (transient?.id === agentSessionId) {
        const timelineItems = projectAgentGUIMessagesToTimelineItems(
          resolveSessionMessages(agentSessionId)
        );
        const canSettleBusyStatus = canSettleBusyConversationFromSessionState({
          timelineItems,
          syncState: transient.syncState
        });
        const incomingWouldSettleBusyStatus =
          nextStatus !== null &&
          conversationBusyStatus(transient.status) &&
          !conversationBusyStatus(nextStatus);
        const candidateTransientStatus =
          nextStatus !== null &&
          transient.updatedAtUnixMs > updatedAtUnixMs &&
          (!incomingWouldSettleBusyStatus || !canSettleBusyStatus)
            ? transient.status
            : (nextStatus ?? transient.status);
        const transientStatus = resolveConversationStatusFromTimelineEvidence({
          status: candidateTransientStatus,
          timelineItems
        });
        const transientTitleFields = mergeConversationTitleUpdateFields(
          transient,
          title
        );
        setTransientConversation({
          ...transient,
          ...transientTitleFields,
          status: transientStatus,
          updatedAtUnixMs: resolveConversationUpdatedAtUnixMsFromSessionState({
            currentUpdatedAtUnixMs: transient.updatedAtUnixMs,
            snapshotUpdatedAtUnixMs: shouldAdvanceConversationUpdatedAt
              ? snapshot.updatedAtUnixMs
              : undefined,
            source: cause?.source
          }),
          hasUnreadCompletion:
            transientStatus === "completed" &&
            activeConversationIdRef.current !== agentSessionId,
          unreadCompletionKey:
            transientStatus === "completed"
              ? (transient.unreadCompletionKey ?? completionKey)
              : null
        });
      }
    },
    // resolveSessionMessages is intentionally NOT listed: it changes whenever the
    // activity snapshot's sessionMessagesById changes, and this callback feeds an
    // effect that would then re-fire on every snapshot tick (pre-existing design;
    // adding it regresses ~50 tests). The session-message read is best-effort here
    // and the timeline projection drives detail freshness regardless.
    [
      conversationListQuery,
      patchConversation,
      sessionViewRef,
      setTransientConversation
    ]
  );

  useEffect(() => {
    const snapshot = activeSessionView?.controlState ?? null;
    const agentSessionId = activeConversationId?.trim();
    if (
      !snapshot ||
      !agentSessionId ||
      snapshot.agentSessionId.trim() !== agentSessionId
    ) {
      return;
    }
    const cause =
      sessionStateSnapshotCauseBySessionIdRef.current[agentSessionId];
    if (cause) {
      const next = { ...sessionStateSnapshotCauseBySessionIdRef.current };
      delete next[agentSessionId];
      sessionStateSnapshotCauseBySessionIdRef.current = next;
      applySessionStateSnapshot(snapshot, cause);
      return;
    }
    applySessionStateSnapshot(snapshot);
  }, [
    activeConversationId,
    activeSessionView?.controlState,
    applySessionStateSnapshot
  ]);

  const loadSessionState = useCallback(
    async (
      agentSessionId: string,
      cause?: {
        source: "conversation-selected" | "activity-stream" | "settings-update";
        eventType?: string;
        requestId?: number;
        force?: boolean;
        allowInactive?: boolean;
      }
    ) => {
      if (
        blockedAutomaticSessionStateLoadSessionIdsRef.current.has(
          agentSessionId
        ) &&
        cause?.force !== true
      ) {
        return;
      }
      if (
        getAgentSessionView(sessionViewRef(agentSessionId))
          ?.isLoadingControlState &&
        cause?.force !== true
      ) {
        return;
      }
      try {
        setAgentSessionViewControlStateLoading(
          sessionViewRef(agentSessionId),
          true
        );
        setAgentSessionViewError(sessionViewRef(agentSessionId), null);
        const snapshot = await agentActivityRuntime.getSessionControlState({
          workspaceId,
          agentSessionId
        });
        if (
          !isMountedRef.current ||
          (cause?.allowInactive !== true &&
            activeConversationIdRef.current !== agentSessionId)
        ) {
          return;
        }
        clearFailedLiveState(agentSessionId);
        selectedConversationInitialStateLoadedIdsRef.current.add(
          agentSessionId
        );
        clearSelectedConversationNotFoundRetryWhenInitialLoadsSettled(
          agentSessionId
        );
        blockedActivityStreamStateReloadSessionIdsRef.current.delete(
          agentSessionId
        );
        blockedAutomaticSessionStateLoadSessionIdsRef.current.delete(
          agentSessionId
        );
        sessionStateSnapshotCauseBySessionIdRef.current = {
          ...sessionStateSnapshotCauseBySessionIdRef.current,
          [agentSessionId]: cause ? { source: cause.source } : undefined
        };
        updateAgentSessionViewControlState(
          sessionViewRef(agentSessionId),
          (current) => mergeAgentSessionControlStateSnapshot(current, snapshot)
        );
      } catch (error) {
        if (
          !isMountedRef.current ||
          (cause?.allowInactive !== true &&
            activeConversationIdRef.current !== agentSessionId)
        ) {
          return;
        }
        const errorCode = getAgentGUIErrorCode(error);
        if (
          isSessionNotFoundErrorCode(errorCode) &&
          cause?.source === "conversation-selected" &&
          scheduleSelectedConversationNotFoundRetry(agentSessionId)
        ) {
          return;
        }
        if (cause?.source === "conversation-selected") {
          selectedConversationNotFoundRetryIdsRef.current.delete(
            agentSessionId
          );
        }
        reportAgentGUIRuntimeError({
          agentSessionId,
          context: {
            cause: cause?.source ?? null,
            eventType: cause?.eventType ?? null,
            force: cause?.force === true
          },
          error,
          phase: "load_session_state",
          provider: dataRef.current.provider,
          requestId: cause?.requestId ?? null,
          runtime: agentActivityRuntime,
          workspaceId
        });
        setAgentSessionViewError(
          sessionViewRef(agentSessionId),
          getAgentGUIErrorMessage(error)
        );
        if (isNonRetryableResumeErrorCode(errorCode)) {
          markFailedLiveState(agentSessionId, error);
          blockedActivityStreamStateReloadSessionIdsRef.current.add(
            agentSessionId
          );
        }
        if (isResumeSessionNotLocalErrorCode(errorCode)) {
          blockedAutomaticSessionStateLoadSessionIdsRef.current.add(
            agentSessionId
          );
        }
        if (isSessionNotFoundErrorCode(errorCode)) {
          blockedActivityStreamStateReloadSessionIdsRef.current.add(
            agentSessionId
          );
          blockedAutomaticSessionStateLoadSessionIdsRef.current.add(
            agentSessionId
          );
          if (conversationListQuery) {
            markLocalDeletedAgentGUIConversation({
              query: conversationListQuery,
              agentSessionId
            });
            scheduleAgentGUIConversationListProjection(
              conversationListQuery,
              "local-delete"
            );
          }
          agentQueuedPromptRuntime.cleanupSession({
            workspaceId,
            agentSessionId
          });
          deleteAgentSessionView(sessionViewRef(agentSessionId));
          reportAgentGUIActiveConversationCleared({
            details: {
              cause: cause?.source ?? null,
              errorCode: errorCode ?? null,
              eventType: cause?.eventType ?? null,
              isComposerHome: isComposerHomeRef.current
            },
            previousAgentSessionId: activeConversationIdRef.current,
            reason: "load_session_state_not_found",
            runtime: agentActivityRuntime,
            workspaceId
          });
          setIntent({ tag: "home" });
          isComposerHomeRef.current = true;
          setIsComposerHome(true);
          activeConversationIdRef.current = null;
          setActiveConversationId(null);
          setIsLoadingMessages(false);
          setDetailError(null);
          persistActiveConversation(null);
          removeConversations([agentSessionId]);
        }
        if (isSessionNotFoundErrorCode(errorCode)) {
          setAgentSessionViewControlState(sessionViewRef(agentSessionId), null);
        }
      } finally {
        setAgentSessionViewControlStateLoading(
          sessionViewRef(agentSessionId),
          false
        );
      }
    },
    [
      agentQueuedPromptRuntime,
      agentActivityRuntime,
      applySessionStateSnapshot,
      clearFailedLiveState,
      clearSelectedConversationNotFoundRetryWhenInitialLoadsSettled,
      markFailedLiveState,
      persistActiveConversation,
      removeConversations,
      scheduleSelectedConversationNotFoundRetry,
      workspaceId,
      conversationListQuery,
      sessionViewRef
    ]
  );

  const loadSelectedConversationMessages = useCallback(
    async (agentSessionId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId) {
        return;
      }
      const requestId = ++selectedConversationMessageLoadSeqRef.current;
      setDetailError(null);
      setAgentSessionViewError(sessionViewRef(normalizedAgentSessionId), null);
      setAgentSessionViewMessagesLoading(
        sessionViewRef(normalizedAgentSessionId),
        true
      );
      if (activeConversationIdRef.current === normalizedAgentSessionId) {
        setIsLoadingMessages(true);
      }
      try {
        resetAgentSessionViewDetailMessages(
          sessionViewRef(normalizedAgentSessionId)
        );
        reportAgentGUIMessagePageDiagnostic({
          agentSessionId: normalizedAgentSessionId,
          details: {
            limit: AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE,
            order: "desc",
            requestId
          },
          event: "agent.gui.messages.initial.requested",
          runtime: agentActivityRuntime,
          workspaceId
        });
        const page = await agentActivityRuntime.listSessionMessages({
          workspaceId,
          agentSessionId: normalizedAgentSessionId,
          cache: false,
          limit: AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE,
          order: "desc"
        });
        if (
          !isMountedRef.current ||
          activeConversationIdRef.current !== normalizedAgentSessionId ||
          selectedConversationMessageLoadSeqRef.current !== requestId
        ) {
          return;
        }
        selectedConversationInitialMessagesLoadedIdsRef.current.add(
          normalizedAgentSessionId
        );
        reportAgentGUIMessagePageDiagnostic({
          agentSessionId: normalizedAgentSessionId,
          details: {
            hasMore: page.hasMore,
            latestVersion: page.latestVersion,
            requestId
          },
          event: "agent.gui.messages.initial.resolved",
          messages: page.messages,
          runtime: agentActivityRuntime,
          workspaceId
        });
        clearSelectedConversationNotFoundRetryWhenInitialLoadsSettled(
          normalizedAgentSessionId
        );
        const currentDetailMessages =
          getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
            ?.detailMessages ?? [];
        let detailMessages = mergeWorkspaceAgentMessages(
          currentDetailMessages,
          page.messages
        );
        let hasOlderMessages = page.hasMore && page.messages.length > 0;
        let oldestLoadedVersion = minFiniteMessageVersion(detailMessages);
        for (
          let backfillPageIndex = 0;
          hasOlderMessages &&
          windowHasTurnMissingUserPrompt(
            detailMessages,
            maxFiniteMessageVersion(page.messages)
          ) &&
          oldestLoadedVersion !== null &&
          backfillPageIndex < AGENT_GUI_DETAIL_MISSING_USER_BACKFILL_PAGE_LIMIT;
          backfillPageIndex += 1
        ) {
          reportAgentGUIMessagePageDiagnostic({
            agentSessionId: normalizedAgentSessionId,
            details: {
              beforeVersion: oldestLoadedVersion,
              limit: AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE,
              order: "desc",
              requestId,
              reason: "missing_user_prompt"
            },
            event: "agent.gui.messages.initial_backfill.requested",
            runtime: agentActivityRuntime,
            workspaceId
          });
          const olderPage = await agentActivityRuntime.listSessionMessages({
            workspaceId,
            agentSessionId: normalizedAgentSessionId,
            beforeVersion: oldestLoadedVersion,
            cache: false,
            limit: AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE,
            order: "desc"
          });
          if (
            !isMountedRef.current ||
            activeConversationIdRef.current !== normalizedAgentSessionId ||
            selectedConversationMessageLoadSeqRef.current !== requestId
          ) {
            return;
          }
          reportAgentGUIMessagePageDiagnostic({
            agentSessionId: normalizedAgentSessionId,
            details: {
              beforeVersion: oldestLoadedVersion,
              hasMore: olderPage.hasMore,
              latestVersion: olderPage.latestVersion,
              requestId,
              reason: "missing_user_prompt"
            },
            event: "agent.gui.messages.initial_backfill.resolved",
            messages: olderPage.messages,
            runtime: agentActivityRuntime,
            workspaceId
          });
          if (olderPage.messages.length === 0) {
            hasOlderMessages = false;
            break;
          }
          detailMessages = mergeWorkspaceAgentMessages(
            detailMessages,
            olderPage.messages
          );
          hasOlderMessages = olderPage.hasMore;
          oldestLoadedVersion = minFiniteMessageVersion(detailMessages);
        }
        const currentOverlayMessages =
          getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
            ?.overlayMessages ?? [];
        const windowOverlayMessages = filterMessagesForDetailWindowOverlay({
          detailMessages,
          durableMessages: page.messages,
          localMessages: currentOverlayMessages
        });
        const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
          durableMessages: detailMessages,
          localMessages: windowOverlayMessages
        });
        failedOlderMessageCursorBySessionIdRef.current.delete(
          normalizedAgentSessionId
        );
        setAgentSessionViewDetailMessages(
          sessionViewRef(normalizedAgentSessionId),
          detailMessages,
          {
            hasOlderMessages,
            isLoadingOlderMessages: false
          }
        );
        setAgentSessionViewOverlayMessages(
          sessionViewRef(normalizedAgentSessionId),
          overlayMessages
        );
        setAgentSessionViewMessagesLoading(
          sessionViewRef(normalizedAgentSessionId),
          false
        );
        setIsLoadingMessages(false);
      } catch (error) {
        if (
          !isMountedRef.current ||
          activeConversationIdRef.current !== normalizedAgentSessionId ||
          selectedConversationMessageLoadSeqRef.current !== requestId
        ) {
          return;
        }
        const errorCode = getAgentGUIErrorCode(error);
        if (
          isSessionNotFoundErrorCode(errorCode) &&
          scheduleSelectedConversationNotFoundRetry(normalizedAgentSessionId)
        ) {
          return;
        }
        selectedConversationNotFoundRetryIdsRef.current.delete(
          normalizedAgentSessionId
        );
        reportAgentGUIRuntimeError({
          agentSessionId: normalizedAgentSessionId,
          error,
          phase: "load_session_messages",
          provider: dataRef.current.provider,
          runtime: agentActivityRuntime,
          workspaceId
        });
        setAgentSessionViewMessagesLoading(
          sessionViewRef(normalizedAgentSessionId),
          false
        );
        setIsLoadingMessages(false);
      }
    },
    [
      agentActivityRuntime,
      clearSelectedConversationNotFoundRetryWhenInitialLoadsSettled,
      scheduleSelectedConversationNotFoundRetry,
      sessionViewRef,
      workspaceId
    ]
  );

  const loadOlderConversationMessages = useCallback(
    async (agentSessionId?: string | null) => {
      const normalizedAgentSessionId = (
        agentSessionId ??
        activeConversationIdRef.current ??
        ""
      ).trim();
      if (!normalizedAgentSessionId) {
        return;
      }
      const currentView = getAgentSessionView(
        sessionViewRef(normalizedAgentSessionId)
      );
      if (
        !currentView?.hasOlderMessages ||
        currentView.isLoadingOlderMessages ||
        currentView.oldestLoadedVersion === null ||
        activeConversationIdRef.current !== normalizedAgentSessionId
      ) {
        reportAgentGUIMessagePageDiagnostic({
          agentSessionId: normalizedAgentSessionId,
          details: {
            activeConversationId: activeConversationIdRef.current,
            hasOlderMessages: currentView?.hasOlderMessages ?? null,
            isLoadingOlderMessages: currentView?.isLoadingOlderMessages ?? null,
            oldestLoadedVersion: currentView?.oldestLoadedVersion ?? null
          },
          event: "agent.gui.messages.older.skipped",
          level: "debug",
          runtime: agentActivityRuntime,
          workspaceId
        });
        return;
      }
      const beforeVersion = currentView.oldestLoadedVersion;
      if (
        failedOlderMessageCursorBySessionIdRef.current.get(
          normalizedAgentSessionId
        ) === beforeVersion
      ) {
        reportAgentGUIMessagePageDiagnostic({
          agentSessionId: normalizedAgentSessionId,
          details: {
            beforeVersion,
            reason: "previous_cursor_error"
          },
          event: "agent.gui.messages.older.suppressed_after_error",
          level: "warn",
          runtime: agentActivityRuntime,
          workspaceId
        });
        return;
      }
      const requestId = ++selectedConversationOlderMessageLoadSeqRef.current;
      setAgentSessionViewOlderMessagesLoading(
        sessionViewRef(normalizedAgentSessionId),
        true
      );
      try {
        reportAgentGUIMessagePageDiagnostic({
          agentSessionId: normalizedAgentSessionId,
          details: {
            beforeVersion,
            limit: AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE,
            order: "desc",
            requestId
          },
          event: "agent.gui.messages.older.requested",
          runtime: agentActivityRuntime,
          workspaceId
        });
        const page = await agentActivityRuntime.listSessionMessages({
          workspaceId,
          agentSessionId: normalizedAgentSessionId,
          beforeVersion,
          cache: false,
          limit: AGENT_GUI_DETAIL_MESSAGES_PAGE_SIZE,
          order: "desc"
        });
        if (
          !isMountedRef.current ||
          activeConversationIdRef.current !== normalizedAgentSessionId ||
          selectedConversationOlderMessageLoadSeqRef.current !== requestId
        ) {
          setAgentSessionViewOlderMessagesLoading(
            sessionViewRef(normalizedAgentSessionId),
            false
          );
          return;
        }
        reportAgentGUIMessagePageDiagnostic({
          agentSessionId: normalizedAgentSessionId,
          details: {
            beforeVersion,
            hasMore: page.hasMore,
            latestVersion: page.latestVersion,
            requestId
          },
          event: "agent.gui.messages.older.resolved",
          messages: page.messages,
          runtime: agentActivityRuntime,
          workspaceId
        });
        failedOlderMessageCursorBySessionIdRef.current.delete(
          normalizedAgentSessionId
        );
        const nextDetailMessages = mergeWorkspaceAgentMessages(
          currentView.detailMessages,
          page.messages
        );
        const currentOverlayMessages =
          getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
            ?.overlayMessages ?? [];
        const windowOverlayMessages = filterMessagesForDetailWindowOverlay({
          detailMessages: nextDetailMessages,
          durableMessages: page.messages,
          localMessages: currentOverlayMessages
        });
        const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
          durableMessages: nextDetailMessages,
          localMessages: windowOverlayMessages
        });
        mergeAgentSessionViewDetailMessages(
          sessionViewRef(normalizedAgentSessionId),
          page.messages,
          {
            hasOlderMessages: page.hasMore && page.messages.length > 0,
            isLoadingOlderMessages: false
          }
        );
        setAgentSessionViewOverlayMessages(
          sessionViewRef(normalizedAgentSessionId),
          overlayMessages
        );
      } catch (error) {
        if (
          !isMountedRef.current ||
          activeConversationIdRef.current !== normalizedAgentSessionId ||
          selectedConversationOlderMessageLoadSeqRef.current !== requestId
        ) {
          setAgentSessionViewOlderMessagesLoading(
            sessionViewRef(normalizedAgentSessionId),
            false
          );
          return;
        }
        failedOlderMessageCursorBySessionIdRef.current.set(
          normalizedAgentSessionId,
          beforeVersion
        );
        reportAgentGUIRuntimeError({
          agentSessionId: normalizedAgentSessionId,
          context: {
            beforeVersion,
            requestId
          },
          error,
          phase: "load_session_messages",
          provider: dataRef.current.provider,
          runtime: agentActivityRuntime,
          workspaceId
        });
        setAgentSessionViewOlderMessagesLoading(
          sessionViewRef(normalizedAgentSessionId),
          false
        );
      }
    },
    [agentActivityRuntime, sessionViewRef, workspaceId]
  );

  const reloadSelectedConversation = useCallback(
    (
      agentSessionId: string,
      options: { reloadConversations: boolean; reloadDetail: boolean }
    ) => {
      if (!agentSessionId) {
        return;
      }
      if (failedNewConversationIdsRef.current.has(agentSessionId)) {
        return;
      }
      if (startingConversationIdRef.current === agentSessionId) {
        return;
      }
      if (options.reloadConversations) {
        void syncConversationListProjection(agentSessionId);
      }
      if (options.reloadDetail) {
        const normalizedAgentSessionId = agentSessionId.trim();
        const hadPendingMessageLoad =
          selectedConversationPendingMessageLoadIdsRef.current.delete(
            normalizedAgentSessionId
          );
        const hasRenderableMessages = sessionHasRenderableMessages({
          agentSessionId: normalizedAgentSessionId,
          hasLoadedInitialMessages:
            selectedConversationInitialMessagesLoadedIdsRef.current.has(
              normalizedAgentSessionId
            ),
          sessionViewRef,
          snapshotMessagesById:
            agentActivitySnapshotRef.current.sessionMessagesById
        });
        if (hadPendingMessageLoad || !hasRenderableMessages) {
          void loadSelectedConversationMessages(normalizedAgentSessionId);
        } else {
          void refreshMessagesFromSnapshot(normalizedAgentSessionId);
        }
        void loadSessionState(agentSessionId, {
          source: "conversation-selected"
        });
      }
    },
    [
      syncConversationListProjection,
      loadSelectedConversationMessages,
      refreshMessagesFromSnapshot,
      loadSessionState
    ]
  );

  useEffect(() => {
    reloadSelectedConversationRef.current = reloadSelectedConversation;
  }, [reloadSelectedConversation]);

  const loadComposerOptionsForTarget = useCallback(
    (
      targetData: AgentGUIComposerTargetData,
      options?: { force?: boolean }
    ): void => {
      // Composer options are loaded for every provider: besides settings they
      // carry the capabilities fallback and the skills list.
      const provider = targetData.provider;
      const agentTargetId = targetData.agentTargetId;
      if (isCreatingConversationRef.current) {
        return;
      }
      const settings = readNodeDefaultDraftSettings({
        data: targetData.data,
        defaultReasoningEffort,
        drafts: draftSettingsBySessionIdRef.current
      });
      const composerOptionsCwd =
        selectedProjectPathRef.current?.trim() || workspacePath.trim() || "";
      void Promise.resolve(
        agentActivityRuntime.getComposerOptions({
          workspaceId,
          cwd: composerOptionsCwd,
          force: options?.force,
          provider,
          agentTargetId,
          settings
        })
      ).catch(() => undefined);
    },
    [agentActivityRuntime, defaultReasoningEffort, workspaceId, workspacePath]
  );
  const loadDraftComposerOptions = useCallback(
    (options?: { force?: boolean }): void => {
      const targetData =
        activeConversationIdRef.current === null
          ? selectedComposerTargetDataRef.current
          : composerTargetDataFromNodeData(dataRef.current);
      loadComposerOptionsForTarget(targetData, options);
    },
    [loadComposerOptionsForTarget]
  );

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!supports.model && !supports.reasoning && !supports.permission) {
      return;
    }
    const projectKey = `${composerTargetData.agentTargetId ?? composerTargetData.provider}\0${selectedProjectPath ?? ""}`;
    const previousProjectKey = composerOptionsProjectKeyRef.current;
    composerOptionsProjectKeyRef.current = projectKey;
    if (previousProjectKey === null || previousProjectKey === projectKey) {
      return;
    }
    loadDraftComposerOptions({ force: true });
  }, [
    composerTargetData.agentTargetId,
    composerTargetData.provider,
    loadDraftComposerOptions,
    previewMode,
    selectedProjectPath,
    supports.model,
    supports.permission,
    supports.reasoning
  ]);

  // Providers such as Cursor only expose their model list through the live
  // session's advertised config options — there is no static catalog, so the
  // composer options fetched before the session existed carry only the
  // currently selected model. When the live session advertises models the
  // loaded options lack, force one refetch: the daemon merges the live list
  // (GetComposerOptions live-model discovery) and the condition quiesces.
  const liveModelOptionValuesKey = useMemo(
    () =>
      liveModelOptionValuesFromRuntimeContext(activeSessionRuntimeContext).join(
        "\u0000"
      ),
    [activeSessionRuntimeContext]
  );
  const liveModelRefreshRequestedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (previewMode || liveModelOptionValuesKey === "") {
      return;
    }
    const liveValues = liveModelOptionValuesKey.split("\u0000");
    if (
      !composerOptionsMissingLiveModelValues(
        providerComposerOptions,
        liveValues
      )
    ) {
      return;
    }
    if (liveModelRefreshRequestedKeyRef.current === liveModelOptionValuesKey) {
      return;
    }
    liveModelRefreshRequestedKeyRef.current = liveModelOptionValuesKey;
    loadDraftComposerOptions({ force: true });
  }, [
    liveModelOptionValuesKey,
    loadDraftComposerOptions,
    previewMode,
    providerComposerOptions
  ]);

  useEffect(() => {
    if (previewMode) {
      return undefined;
    }
    if (!supports.model && !supports.reasoning && !supports.permission) {
      return undefined;
    }
    return subscribeCoalesced(
      "agent-model-catalog-invalidated",
      {
        delayMs: 150,
        key: () => "agent-model-catalog-invalidated",
        merge: mergeAgentModelCatalogInvalidationEvents
      },
      (event) => {
        const provider =
          activeConversationIdRef.current === null
            ? selectedComposerTargetDataRef.current.provider
            : dataRef.current.provider;
        const currentActiveConversationId = activeConversationIdRef.current;
        if (!event.providers.includes(provider)) {
          return;
        }
        loadDraftComposerOptions({ force: true });
        if (currentActiveConversationId === null && isComposerHomeRef.current) {
          return;
        }
        if (!currentActiveConversationId) {
          return;
        }
        void loadSessionState(currentActiveConversationId, {
          source: "settings-update",
          force: true
        });
      }
    );
  }, [
    loadDraftComposerOptions,
    loadSessionState,
    previewMode,
    workspaceId,
    supports.model,
    supports.permission,
    supports.reasoning
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    loadDraftComposerOptions(
      composerTargetData.provider === "claude-code" && isComposerHome
        ? { force: true }
        : undefined
    );
  }, [
    activeConversationId,
    composerTargetData.agentTargetId,
    composerTargetData.provider,
    isComposerHome,
    loadDraftComposerOptions,
    previewMode
  ]);

  const scheduleActivityStreamStateReload = useMemo(
    () =>
      debounce(
        (
          agentSessionId: string,
          cause: { source: "activity-stream"; eventType?: string }
        ) => {
          if (
            blockedActivityStreamStateReloadSessionIdsRef.current.has(
              agentSessionId
            ) ||
            activeConversationIdRef.current !== agentSessionId ||
            !isMountedRef.current
          ) {
            return;
          }
          void loadSessionState(agentSessionId, cause);
        },
        ACTIVITY_STREAM_STATE_RELOAD_DEBOUNCE_MS
      ),
    [loadSessionState]
  );
  const scheduleActivityStreamStateReloadRef = useRef(
    scheduleActivityStreamStateReload
  );
  const clearSelectedConversationNotFoundRetryRef = useRef(
    clearSelectedConversationNotFoundRetry
  );
  useEffect(() => {
    scheduleActivityStreamStateReloadRef.current =
      scheduleActivityStreamStateReload;
  }, [scheduleActivityStreamStateReload]);
  useEffect(() => {
    clearSelectedConversationNotFoundRetryRef.current =
      clearSelectedConversationNotFoundRetry;
  }, [clearSelectedConversationNotFoundRetry]);

  const applyTimelineProjectionUpdate = useCallback(
    (
      agentSessionId: string,
      nextItems: readonly WorkspaceAgentActivityTimelineItem[],
      mergedItems?: readonly WorkspaceAgentActivityTimelineItem[]
    ) => {
      if (nextItems.length === 0) {
        return;
      }
      const merged =
        mergedItems ??
        projectAgentGUIMessagesToTimelineItems(
          resolveSessionMessages(agentSessionId)
        ) ??
        mergeAgentGUITimelineItems([], nextItems);
      const sessionState =
        getAgentSessionView(sessionViewRef(agentSessionId))?.controlState ??
        null;
      const incomingStatus = conversationStatusFromTimelineItems(nextItems);
      const nextStatus = incomingStatus
        ? conversationStatusFromTimelineItems([...merged])
        : null;
      if (nextStatus || sessionState) {
        const updatedAtUnixMs = Math.max(...nextItems.map(timelineItemTime));
        patchConversation(agentSessionId, (conversation) => {
          const status = resolveConversationStatusAfterTimelineUpdate({
            currentStatus: conversation.status,
            incomingTimelineStatus: nextStatus,
            sessionState,
            timelineItems: merged
          });
          return {
            status,
            updatedAtUnixMs: Math.max(
              conversation.updatedAtUnixMs,
              updatedAtUnixMs
            ),
            hasUnreadCompletion: false
          };
        });
        const transient = transientConversationRef.current;
        if (transient?.id === agentSessionId) {
          const status = resolveConversationStatusAfterTimelineUpdate({
            currentStatus: transient.status,
            incomingTimelineStatus: nextStatus,
            sessionState,
            timelineItems: merged
          });
          setTransientConversation({
            ...transient,
            status,
            updatedAtUnixMs: Math.max(
              transient.updatedAtUnixMs,
              updatedAtUnixMs
            ),
            hasUnreadCompletion: false
          });
        }
      }
    },
    [
      patchConversation,
      resolveSessionMessages,
      sessionViewRef,
      setTransientConversation
    ]
  );

  const applyBackgroundTimelineStatusUpdate = useCallback(
    (
      agentSessionId: string,
      nextItems: readonly WorkspaceAgentActivityTimelineItem[]
    ) => {
      if (nextItems.length === 0) {
        return;
      }
      const incomingStatus = conversationStatusFromTimelineItems(nextItems);
      if (!incomingStatus) {
        return;
      }
      const updatedAtUnixMs = Math.max(...nextItems.map(timelineItemTime));
      patchConversation(agentSessionId, (conversation) => {
        const status = incomingStatus;
        const nextUpdatedAtUnixMs = Math.max(
          conversation.updatedAtUnixMs,
          updatedAtUnixMs
        );
        if (
          status === conversation.status &&
          nextUpdatedAtUnixMs === conversation.updatedAtUnixMs &&
          conversation.hasUnreadCompletion !== true
        ) {
          return null;
        }
        return {
          status,
          updatedAtUnixMs: nextUpdatedAtUnixMs,
          hasUnreadCompletion: false
        };
      });
      const transient = transientConversationRef.current;
      if (transient?.id === agentSessionId) {
        setTransientConversation({
          ...transient,
          status: incomingStatus,
          updatedAtUnixMs: Math.max(transient.updatedAtUnixMs, updatedAtUnixMs),
          hasUnreadCompletion: false
        });
      }
    },
    [setTransientConversation, patchConversation]
  );

  const recordLocalMessages = useCallback(
    (
      agentSessionId: string,
      nextMessages: readonly WorkspaceAgentActivityMessage[]
    ) => {
      if (nextMessages.length === 0) {
        return;
      }
      const currentView = getAgentSessionView(sessionViewRef(agentSessionId));
      const currentMessages = currentView?.overlayMessages ?? [];
      const currentDetailMessages = currentView?.detailMessages ?? [];
      const currentDurableDetailMessages = currentDetailMessages.filter(
        (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
      );
      const detailWindowScopeMessages =
        currentMessages.length > 0
          ? mergeWorkspaceAgentMessages(
              currentDurableDetailMessages,
              currentMessages
            )
          : currentDurableDetailMessages;
      const durableSnapshotMessages =
        agentActivitySnapshot.sessionMessagesById[agentSessionId] ?? [];
      const detailWindowMessages = filterMessagesForDetailWindowOverlay({
        detailMessages: detailWindowScopeMessages,
        durableMessages: durableSnapshotMessages,
        localMessages: nextMessages
      });
      const durableDetailWindowMessages = detailWindowMessages.filter(
        (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
      );
      const nextDetailMessages =
        durableDetailWindowMessages.length > 0
          ? mergeWorkspaceAgentMessages(
              currentDurableDetailMessages,
              durableDetailWindowMessages
            )
          : currentDurableDetailMessages;
      if (durableDetailWindowMessages.length > 0) {
        mergeAgentSessionViewDetailMessages(
          sessionViewRef(agentSessionId),
          durableDetailWindowMessages,
          {
            hasOlderMessages:
              currentView?.hasOlderMessages === true ||
              sessionViewHasUnhydratedOlderDetailMessages({
                agentSessionId,
                detailMessages: nextDetailMessages,
                hasLoadedInitialMessages:
                  selectedConversationInitialMessagesLoadedIdsRef.current.has(
                    agentSessionId
                  ),
                hasOlderMessages: currentView?.hasOlderMessages ?? false,
                oldestLoadedVersion:
                  minFiniteMessageVersion(nextDetailMessages),
                snapshotMessagesById: agentActivitySnapshot.sessionMessagesById
              })
          }
        );
      }
      const durableMessages =
        nextDetailMessages.length > 0
          ? nextDetailMessages
          : durableSnapshotMessages;
      const nextLocalMessages = filterMessagesForDetailWindowOverlay({
        detailMessages: nextDetailMessages,
        durableMessages: durableSnapshotMessages,
        localMessages: mergeWorkspaceAgentMessages(
          currentMessages,
          nextMessages
        )
      });
      const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
        durableMessages,
        localMessages: nextLocalMessages
      });
      const mergedMessages = mergeWorkspaceAgentMessages(
        durableMessages,
        overlayMessages
      );
      const nextItems = projectAgentGUIMessagesToTimelineItems(nextMessages);
      const mergedItems =
        projectAgentGUIMessagesToTimelineItems(mergedMessages);
      setAgentSessionViewOverlayMessages(
        sessionViewRef(agentSessionId),
        overlayMessages
      );
      if (conversationListQuery) {
        scheduleAgentGUIConversationListProjection(
          conversationListQuery,
          "session-overlay-update",
          { dirtySessionIds: [agentSessionId] }
        );
      }
      applyTimelineProjectionUpdate(agentSessionId, nextItems, mergedItems);
    },
    [
      agentActivitySnapshot.sessionMessagesById,
      applyTimelineProjectionUpdate,
      conversationListQuery,
      sessionViewRef
    ]
  );

  const retargetOptimisticPromptTurn = useCallback(
    (agentSessionId: string, clientSubmitId: string, turnId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      const normalizedTurnId = turnId.trim();
      if (
        !normalizedAgentSessionId ||
        !clientSubmitId.trim() ||
        !normalizedTurnId
      ) {
        return;
      }
      const sessionView = getAgentSessionView(
        sessionViewRef(normalizedAgentSessionId)
      );
      if (!sessionView) {
        return;
      }
      const detail = retargetOptimisticPromptMessages(
        sessionView.detailMessages,
        { clientSubmitId, turnId: normalizedTurnId }
      );
      if (detail.changed) {
        setAgentSessionViewDetailMessages(
          sessionViewRef(normalizedAgentSessionId),
          detail.messages
        );
      }
      const overlay = retargetOptimisticPromptMessages(
        sessionView.overlayMessages,
        { clientSubmitId, turnId: normalizedTurnId }
      );
      if (overlay.changed) {
        setAgentSessionViewOverlayMessages(
          sessionViewRef(normalizedAgentSessionId),
          overlay.messages
        );
      }
    },
    [sessionViewRef]
  );

  const removeOptimisticPrompt = useCallback(
    (agentSessionId: string, clientSubmitId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId || !clientSubmitId.trim()) {
        return;
      }
      const sessionView = getAgentSessionView(
        sessionViewRef(normalizedAgentSessionId)
      );
      if (!sessionView) {
        return;
      }
      const detail = removeOptimisticPromptMessagesByClientSubmitId(
        sessionView.detailMessages,
        clientSubmitId
      );
      if (detail.changed) {
        setAgentSessionViewDetailMessages(
          sessionViewRef(normalizedAgentSessionId),
          detail.messages
        );
      }
      const overlay = removeOptimisticPromptMessagesByClientSubmitId(
        sessionView.overlayMessages,
        clientSubmitId
      );
      if (overlay.changed) {
        setAgentSessionViewOverlayMessages(
          sessionViewRef(normalizedAgentSessionId),
          overlay.messages
        );
      }
    },
    [sessionViewRef]
  );

  const applyStatePatch = useCallback(
    (patch: WorkspaceAgentActivityStatePatch) => {
      const agentSessionId = patch.agentSessionId.trim();
      if (!agentSessionId) {
        return;
      }
      const normalizedLastError = patch.lastError?.trim() ?? "";
      const nextStatus = conversationStatusFromStatePatch(patch);
      const completionKey = completionKeyFromStatePatch(agentSessionId, patch);
      const hasStructuredTurnLifecycle = Boolean(patch.turn?.phase?.trim());
      const hasControlStatePatch = hasSessionControlStatePatch(patch);
      const pendingTurnId =
        pendingTurnIdBySessionIdRef.current[agentSessionId]?.trim() ?? "";
      const patchTurnId = patch.turn?.turnId?.trim() ?? "";
      const patchActiveTurnId = patch.turn?.activeTurnId?.trim() ?? "";
      const structuredTurnPhase = patch.turn?.phase?.trim() ?? "";
      const submitTrace = submitTraceBySessionIdRef.current[agentSessionId];
      if (submitTrace && structuredTurnPhase) {
        const matchesTraceTurn =
          Boolean(submitTrace.turnId) &&
          (patchTurnId === submitTrace.turnId ||
            patchActiveTurnId === submitTrace.turnId);
        if (matchesTraceTurn) {
          reportAgentSubmitTraceDiagnostic({
            event: `lifecycle.${structuredTurnPhase}`,
            runtime: agentActivityRuntime,
            trace: submitTrace,
            workspaceId,
            fields: {
              outcome: patch.turn?.outcome ?? null,
              submitAvailability: patch.turn?.submitAvailability ?? null
            }
          });
          if (structuredTurnPhase === "settled") {
            const next = { ...submitTraceBySessionIdRef.current };
            delete next[agentSessionId];
            submitTraceBySessionIdRef.current = next;
          }
        }
      }
      const clearedPendingSubmittedTurn = Boolean(
        pendingTurnId &&
        ((patchTurnId && patchTurnId === pendingTurnId) ||
          (nextStatus !== null && !conversationBusyStatus(nextStatus)))
      );
      if (clearedPendingSubmittedTurn) {
        const nextPending = { ...pendingTurnIdBySessionIdRef.current };
        delete nextPending[agentSessionId];
        pendingTurnIdBySessionIdRef.current = nextPending;
      }
      if (
        !nextStatus &&
        !completionKey &&
        !patch.title?.trim() &&
        normalizedLastError === "" &&
        !hasControlStatePatch &&
        !clearedPendingSubmittedTurn
      ) {
        return;
      }
      if (hasControlStatePatch) {
        updateAgentSessionViewControlState(
          sessionViewRef(agentSessionId),
          (current) => mergeSessionControlStatePatch(current, patch)
        );
      }
      const patchTitle = patch.title?.trim() ?? "";
      const previousStatePatchError =
        statePatchErrorBySessionId[agentSessionId] ?? null;
      if (normalizedLastError !== "") {
        const nextErrors = {
          ...statePatchErrorBySessionId,
          [agentSessionId]: normalizedLastError
        };
        setStatePatchErrorBySessionId(nextErrors);
      } else if (
        nextStatus &&
        nextStatus !== "failed" &&
        previousStatePatchError !== null
      ) {
        const nextErrors = { ...statePatchErrorBySessionId };
        delete nextErrors[agentSessionId];
        setStatePatchErrorBySessionId(nextErrors);
      }
      if (activeConversationIdRef.current === agentSessionId) {
        if (normalizedLastError !== "") {
          setDetailError(normalizedLastError);
        } else if (
          nextStatus &&
          nextStatus !== "failed" &&
          previousStatePatchError !== null
        ) {
          setDetailError((current) =>
            current === previousStatePatchError ? null : current
          );
        }
      }
      patchConversation(agentSessionId, (conversation) => {
        const titleFields = mergeConversationTitleUpdateFields(
          conversation,
          patchTitle
        );
        const timelineItems = projectAgentGUIMessagesToTimelineItems(
          resolveSessionMessages(agentSessionId)
        );
        const status = hasStructuredTurnLifecycle
          ? (nextStatus ?? conversation.status)
          : resolveConversationStatusFromTimelineEvidence({
              status: nextStatus ?? conversation.status,
              timelineItems
            });
        const hasUnreadCompletion =
          status === "completed"
            ? (conversation.hasUnreadCompletion ?? false)
            : false;
        if (
          titleFields.title === conversation.title &&
          titleFields.titleFallback === conversation.titleFallback &&
          status === conversation.status &&
          hasUnreadCompletion === conversation.hasUnreadCompletion &&
          (!completionKey ||
            conversation.unreadCompletionKey === completionKey) &&
          !clearedPendingSubmittedTurn
        ) {
          return null;
        }
        return {
          ...titleFields,
          status,
          hasUnreadCompletion,
          unreadCompletionKey:
            status === "completed" || completionKey
              ? (conversation.unreadCompletionKey ?? completionKey)
              : null
        };
      });
      if (completionKey && conversationListQuery) {
        markAgentGUIConversationCompletionObserved({
          query: conversationListQuery,
          conversationId: agentSessionId,
          completionKey,
          allowReadyStatus: nextStatus !== "completed"
        });
      }
      const transient = transientConversationRef.current;
      if (transient?.id === agentSessionId) {
        const transientTitleFields = mergeConversationTitleUpdateFields(
          transient,
          patchTitle
        );
        const timelineItems = projectAgentGUIMessagesToTimelineItems(
          resolveSessionMessages(agentSessionId)
        );
        const transientStatus = hasStructuredTurnLifecycle
          ? (nextStatus ?? transient.status)
          : resolveConversationStatusFromTimelineEvidence({
              status: nextStatus ?? transient.status,
              timelineItems
            });
        setTransientConversation({
          ...transient,
          ...transientTitleFields,
          status: transientStatus,
          hasUnreadCompletion:
            Boolean(completionKey) &&
            activeConversationIdRef.current !== agentSessionId,
          unreadCompletionKey:
            transientStatus === "completed" || completionKey
              ? (transient.unreadCompletionKey ?? completionKey)
              : null
        });
      }
    },
    [
      patchConversation,
      resolveSessionMessages,
      retargetOptimisticPromptTurn,
      sessionViewRef,
      setTransientConversation,
      statePatchErrorBySessionId,
      agentActivityRuntime,
      conversationListQuery,
      workspaceId
    ]
  );
  const handleActivityStreamEvents = useCallback(
    (events: readonly AgentActivityStreamEvent[]) => {
      const pendingMessagesBySessionId = new Map<
        string,
        WorkspaceAgentActivityMessage[]
      >();
      const pendingCompletionKeysBySessionId = new Map<string, string>();
      const flushPendingMessages = () => {
        for (const [agentSessionId, messages] of pendingMessagesBySessionId) {
          recordLocalMessages(agentSessionId, messages);
          applyBackgroundTimelineStatusUpdate(
            agentSessionId,
            projectAgentGUIMessagesToTimelineItems(messages)
          );
          const completionKey =
            pendingCompletionKeysBySessionId.get(agentSessionId);
          if (completionKey && conversationListQuery) {
            markAgentGUIConversationCompletionObserved({
              query: conversationListQuery,
              conversationId: agentSessionId,
              completionKey,
              allowReadyStatus: true
            });
          }
        }
        pendingMessagesBySessionId.clear();
        pendingCompletionKeysBySessionId.clear();
      };
      for (const event of events) {
        if (event.eventType === "available_commands_update") {
          continue;
        }
        if (event.eventType === "message_update") {
          const message = messageFromMessageUpdate(event.data);
          const agentSessionId = message.agentSessionId.trim();
          if (!agentSessionId) {
            continue;
          }
          const submitTrace = submitTraceBySessionIdRef.current[agentSessionId];
          const messageTurnId = message.turnId?.trim() ?? "";
          if (
            submitTrace &&
            messageTurnId &&
            shouldRetargetOptimisticPromptFromMessage(message, submitTrace)
          ) {
            submitTrace.turnId = messageTurnId;
            retargetOptimisticPromptTurn(
              agentSessionId,
              submitTrace.clientSubmitId,
              messageTurnId
            );
          }
          const completionKey = completionKeyFromMessage(message);
          if (completionKey) {
            pendingCompletionKeysBySessionId.set(agentSessionId, completionKey);
          }
          const messages = pendingMessagesBySessionId.get(agentSessionId);
          if (messages) {
            messages.push(message);
          } else {
            pendingMessagesBySessionId.set(agentSessionId, [message]);
          }
          continue;
        }
        flushPendingMessages();
        if (event.eventType === "state_patch") {
          applyStatePatch(event.data);
        }
      }
      flushPendingMessages();
    },
    [
      applyStatePatch,
      applyBackgroundTimelineStatusUpdate,
      conversationListQuery,
      recordLocalMessages,
      retargetOptimisticPromptTurn
    ]
  );
  const handleBackgroundActivityStreamEvents = useCallback(
    (events: readonly AgentActivityStreamEvent[]) => {
      handleActivityStreamEvents(events);
    },
    [handleActivityStreamEvents]
  );

  useEffect(() => {
    if (previewMode) {
      return;
    }
    void syncConversationListProjection(
      dataRef.current.lastActiveAgentSessionId
    );
  }, [
    currentUserId,
    data.provider,
    previewMode,
    syncConversationListProjection
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!activeConversationId) {
      // When a failed first-message create reverts to the home composer, the
      // pending error should be surfaced there instead of being cleared.
      const pendingHomeError = pendingHomeErrorRef.current;
      pendingHomeErrorRef.current = null;
      setDetailError(pendingHomeError ?? null);
      return;
    }
    if (failedNewConversationIdsRef.current.has(activeConversationId)) {
      return;
    }
    if (startingConversationIdRef.current === activeConversationId) {
      return;
    }
    reloadSelectedConversation(activeConversationId, {
      reloadConversations: false,
      reloadDetail: true
    });
  }, [activeConversationId, previewMode, reloadSelectedConversation]);

  useWatchAgentSession({
    workspaceId,
    agentSessionId: activeConversationId,
    enabled: !previewMode && activeConversationId !== null,
    onSubscribe: () => {
      if (!activeConversationId) {
        return;
      }
    },
    onEvents: (events) => {
      if (!activeConversationId) {
        return;
      }
      handleActivityStreamEvents(events);
      for (const event of events) {
        const eventSessionId =
          event.data.agentSessionId?.trim() || activeConversationId;
        if (
          activeConversationIdRef.current !== activeConversationId ||
          activeConversationIdRef.current !== eventSessionId
        ) {
          continue;
        }
        if (
          event.eventType === "message_update" ||
          event.eventType === "available_commands_update"
        ) {
          continue;
        }
        scheduleActivityStreamStateReload(activeConversationId, {
          source: "activity-stream",
          eventType: event.eventType
        });
      }
    },
    onCleanup: () => {
      if (!activeConversationId) {
        return;
      }
    }
  });

  useWatchAgentSessions({
    workspaceId,
    agentSessionIds: backgroundWatchedConversationIds,
    enabled: backgroundWatchedConversationIds.length > 0,
    onEvents: (events) => {
      handleBackgroundActivityStreamEvents(events);
    }
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      scheduleActivityStreamStateReloadRef.current.cancel();
      clearSelectedConversationNotFoundRetryRef.current();
      const current = activeConversationIdRef.current;
      const pendingNewConversationId = startingConversationIdRef.current;
      isMountedRef.current = false;
      activeConversationIdRef.current = null;
      if (current) {
        activatedConversationIdsRef.current.delete(current);
        void unactivateRef.current(current);
      }
      if (pendingNewConversationId && pendingNewConversationId !== current) {
        activatedConversationIdsRef.current.delete(pendingNewConversationId);
        void unactivateRef.current(pendingNewConversationId);
      }
    };
  }, []);

  const startConversation = useCallback(
    (initialContentInput?: unknown, displayPrompt?: string) => {
      const target = selectedProviderTargetRef.current;
      const targetData = selectedComposerTargetDataRef.current;
      if (
        isCreatingConversation ||
        target.disabled === true ||
        (targetData.provider === "openclaw" &&
          openclawGateway?.status !== "ready")
      ) {
        return;
      }
      const agentTargetId = targetData.agentTargetId ?? "";
      if (!agentTargetId && selectedProviderTargetIsExplicitRef.current) {
        setDetailError(translate("agentHost.agentGui.agentTargetRequired"));
        return;
      }
      const normalizedInitialContent = Array.isArray(initialContentInput)
        ? normalizeAgentPromptContentBlocks(
            initialContentInput as AgentPromptContentBlock[]
          )
        : textPromptContent(normalizeOptionalPrompt(initialContentInput));
      const initialDisplayPrompt =
        displayPrompt && displayPrompt.trim() ? displayPrompt : undefined;
      // bundle 折叠时,标题/回显用 displayPrompt(单 chip),而非展开后的文件列表。
      const normalizedInitialPrompt =
        initialDisplayPrompt ??
        agentPromptContentDisplayText(normalizedInitialContent);
      const initialConversationTitle =
        normalizedInitialPrompt || AGENT_PROVIDER_LABEL[targetData.provider];
      const submittedHomeDraftKey = nodeDefaultDraftContentKey(
        targetData.provider,
        targetData.agentTargetId
      );
      const submittedHomeDraft =
        draftBySessionIdRef.current[submittedHomeDraftKey] ??
        EMPTY_AGENT_COMPOSER_DRAFT;
      isCreatingConversationRef.current = true;
      setLocalIsCreatingConversation(true);
      setDetailError(null);
      let pendingCreateAgentSessionId: string | null = null;
      let pendingOptimisticConversation: AgentGUIConversationSummary | null =
        null;
      void (async () => {
        const provider = targetData.provider;
        const agentTargetId = targetData.agentTargetId ?? "";
        onDataChangeRef.current((current) =>
          current.provider === provider &&
          (current.agentTargetId ?? null) === (agentTargetId || null) &&
          (current.providerTargetId ?? null) === targetData.providerTargetId &&
          agentGUIProviderTargetRefsEqual(
            current.providerTargetRef,
            targetData.providerTargetRef
          )
            ? current
            : {
                ...current,
                provider,
                agentTargetId: agentTargetId || null,
                providerTargetId: targetData.providerTargetId,
                providerTargetRef: targetData.providerTargetRef
              }
        );
        const selectedProjectPath = selectedProjectPathRef.current;
        const initialNodeSettings = readNodeDefaultDraftSettings({
          data: targetData.data,
          defaultReasoningEffort,
          drafts: draftSettingsBySessionIdRef.current
        });
        const snapshotComposerOptions = composerOptionsForTarget({
          snapshot: agentActivityRuntime.getSnapshot(workspaceId),
          target: targetData
        });
        const targetSafeInitialNodeSettings = sanitizeComposerSettingsForTarget(
          {
            settings: initialNodeSettings,
            target: targetData,
            options: snapshotComposerOptions
          }
        );
        const initialSettings = resolveEffectiveComposerSettings({
          settings: targetSafeInitialNodeSettings
        });
        const currentActiveConversationId = activeConversationIdRef.current;
        const currentActiveConversation = currentActiveConversationId
          ? resolveConversationSummaryById(
              conversationsRef.current,
              currentActiveConversationId,
              transientConversationRef.current
            )
          : null;
        const inheritedModel =
          normalizeOptionalText(targetSafeInitialNodeSettings.model) === null
            ? (resolveSameProviderActiveSessionModel({
                activeProvider: currentActiveConversation?.provider ?? null,
                agentSessionId: currentActiveConversationId,
                provider,
                runtime: agentActivityRuntime,
                sessionState: activeSessionState,
                workspaceId
              }) ??
              normalizeOptionalText(
                lastActiveModelByProviderRef.current[provider]
              ))
            : null;
        const effectiveInitialSettings =
          inheritedModel === null
            ? initialSettings
            : { ...initialSettings, model: inheritedModel };
        const targetSafeEffectiveInitialSettings =
          sanitizeComposerSettingsForTarget({
            settings: effectiveInitialSettings,
            target: targetData,
            options: snapshotComposerOptions
          });
        const snapshotDraftAgentSessionId =
          normalizedInitialContent.length > 0 && provider === "claude-code"
            ? draftAgentSessionIdFromComposerOptions(snapshotComposerOptions)
            : null;
        // Only reuse a pre-warmed draft that has not already been consumed by a
        // previous create. Once a draft is promoted it becomes a real (running)
        // session, so reusing its id would collide on the server and re-create
        // the session working directory. The composer-options snapshot can keep
        // exposing a just-consumed id until it reloads, so guard against it.
        const draftAgentSessionId =
          snapshotDraftAgentSessionId &&
          !activatedConversationIdsRef.current.has(
            snapshotDraftAgentSessionId
          ) &&
          !failedNewConversationIdsRef.current.has(snapshotDraftAgentSessionId)
            ? snapshotDraftAgentSessionId
            : null;
        const agentSessionId =
          draftAgentSessionId ?? createAgentGUIConversationId();
        pendingCreateAgentSessionId = agentSessionId;
        const createdAtUnixMs = Date.now();
        const submitTrace = createAgentSubmitTraceState({
          agentSessionId,
          content: normalizedInitialContent,
          prompt: normalizedInitialPrompt,
          queued: false,
          startedAtUnixMs: createdAtUnixMs
        });
        submitTraceBySessionIdRef.current = {
          ...submitTraceBySessionIdRef.current,
          [agentSessionId]: submitTrace
        };
        reportAgentSubmitTraceDiagnostic({
          event: "submit.begin",
          runtime: agentActivityRuntime,
          trace: submitTrace,
          workspaceId,
          fields: {
            activeConversationId: currentActiveConversationId,
            activeConversationKnown: currentActiveConversation !== null,
            activeConversationStatus: currentActiveConversation?.status ?? null,
            conversationCount: conversationsRef.current.length,
            conversationListQueryReady: conversationListQuery !== null,
            dataLastActiveAgentSessionId:
              dataRef.current.lastActiveAgentSessionId ?? null,
            draftAgentSessionId,
            isComposerHome: isComposerHomeRef.current,
            targetMode: "new"
          }
        });
        const optimisticConversation: AgentGUIConversationSummary = {
          id: agentSessionId,
          userId: currentUserId?.trim() ?? "",
          provider,
          title: initialConversationTitle,
          titleFallback: null,
          status: "working",
          cwd: selectedProjectPath ?? "",
          project: resolveAgentGUIConversationProject(
            selectedProjectPath,
            userProjectsRef.current,
            { isNoProjectPath: isNoProjectPathRef.current }
          ),
          sortTimeUnixMs: createdAtUnixMs,
          updatedAtUnixMs: createdAtUnixMs
        };
        pendingOptimisticConversation = optimisticConversation;
        if (conversationListQuery) {
          markAgentGUIConversationCreatePending({
            query: conversationListQuery,
            ownerKey: pendingCreateOwnerKey,
            conversationId: agentSessionId
          });
        }
        startingConversationIdRef.current = agentSessionId;
        draftSettingsBySessionIdRef.current = {
          ...draftSettingsBySessionIdRef.current,
          [agentSessionId]: targetSafeEffectiveInitialSettings
        };
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [agentSessionId]: targetSafeEffectiveInitialSettings
        }));
        const optimisticPromptMessage = createOptimisticPromptMessage({
          workspaceId,
          agentSessionId,
          turnId: createPendingOptimisticTurnId(submitTrace.clientSubmitId),
          clientSubmitId: submitTrace.clientSubmitId,
          userId: currentUserId?.trim() || "user",
          prompt: normalizedInitialPrompt,
          content: [...normalizedInitialContent],
          occurredAtUnixMs: createdAtUnixMs
        });
        mergeAgentSessionViewOverlayMessages(sessionViewRef(agentSessionId), [
          optimisticPromptMessage
        ]);
        reportAgentSubmitTraceDiagnostic({
          event: "optimistic_user_message_recorded",
          runtime: agentActivityRuntime,
          trace: submitTrace,
          workspaceId,
          fields: { mode: "new" }
        });
        // Enter the conversation surface immediately so the user sees their
        // message without waiting for the backend session-creation round-trip.
        // The home draft is intentionally left intact so a failed activation
        // can revert to the composer with the user's input preserved. The
        // activation promise below still owns durable session state and the
        // clientSubmitId reconciliation once the real turn arrives.
        setTransientConversation(optimisticConversation);
        setDraftBySessionId((current) => ({
          ...current,
          [agentSessionId]: emptyAgentComposerDraft()
        }));
        isComposerHomeRef.current = false;
        setIsComposerHome(false);
        activeConversationIdRef.current = agentSessionId;
        setActiveConversationId(agentSessionId);
        setIntent({ tag: "active", id: agentSessionId });
        persistActiveConversation(agentSessionId);
        reportAgentSubmitTraceDiagnostic({
          event: "activation.requested",
          runtime: agentActivityRuntime,
          trace: submitTrace,
          workspaceId,
          fields: { mode: "new" }
        });
        return activation.activate({
          mode: "new",
          agentSessionId,
          agentTargetId: agentTargetId || null,
          provider,
          providerTargetRef: targetData.providerTargetRef,
          cwd: selectedProjectPath ?? "",
          initialContent: normalizedInitialContent,
          initialDisplayPrompt,
          metadata: agentSubmitTraceMetadata(submitTrace),
          title: initialConversationTitle,
          settings: targetSafeEffectiveInitialSettings,
          openclawGatewayReady:
            provider === "openclaw"
              ? openclawGateway?.status === "ready"
              : undefined
        });
      })()
        .then((result) => {
          const agentSessionId = result.session.agentSessionId;
          const submitTrace = submitTraceBySessionIdRef.current[agentSessionId];
          if (submitTrace) {
            reportAgentSubmitTraceDiagnostic({
              event: "activation.resolved",
              runtime: agentActivityRuntime,
              trace: submitTrace,
              workspaceId,
              fields: {
                mode: "new",
                sessionStatus: result.session.status
              }
            });
            reportAgentSubmitTraceDiagnostic({
              event: "submit.accepted",
              runtime: agentActivityRuntime,
              trace: submitTrace,
              workspaceId,
              fields: {
                mode: "new",
                sessionStatus: result.session.status
              }
            });
          }
          const activationFailed =
            result.activation.status === "failed" ||
            result.session.status === "failed";
          if (conversationListQuery) {
            clearAgentGUIConversationCreatePending({
              query: conversationListQuery,
              ownerKey: pendingCreateOwnerKey,
              conversationId: agentSessionId
            });
          }
          if (activationFailed) {
            failedNewConversationIdsRef.current.add(agentSessionId);
            // There is no session for a queued pre-activation settings patch
            // to apply to; drop it rather than leaking it to a future
            // session that happens to reuse this id.
            delete pendingActivationComposerSettingsPatchRef.current[
              agentSessionId
            ];
            resetAgentSessionViewDetailMessages(sessionViewRef(agentSessionId));
            setAgentSessionViewOverlayMessages(
              sessionViewRef(agentSessionId),
              []
            );
            if (startingConversationIdRef.current === agentSessionId) {
              startingConversationIdRef.current = null;
            }
            const shouldRevertToHome =
              isMountedRef.current &&
              (isCurrentConversation(agentSessionId) ||
                (activeConversationIdRef.current === null &&
                  isComposerHomeRef.current));
            if (shouldRevertToHome) {
              const homeErrorMessage =
                result.error?.message?.trim() || "Session activation failed.";
              if (isCurrentConversation(agentSessionId)) {
                // Stash the error so the activeConversationId-null effect
                // surfaces it on the home composer instead of clearing it.
                pendingHomeErrorRef.current = homeErrorMessage;
                // Undo the optimistic entry: send the user back to the home
                // composer. The home draft was never cleared, so their input
                // is preserved; only the error is surfaced there.
                isComposerHomeRef.current = true;
                setIsComposerHome(true);
                activeConversationIdRef.current = null;
                setActiveConversationId(null);
                setIntent({ tag: "home" });
                persistActiveConversation(null);
                setTransientConversation(null);
              }
              setIsLoadingMessages(false);
              setAgentSessionViewMessagesLoading(
                sessionViewRef(agentSessionId),
                false
              );
              setDetailError(homeErrorMessage);
            }
            return;
          }
          const projectedConversation = conversationSummaryFromAgentSession(
            result.session,
            {
              isNoProjectPath: isNoProjectPathRef.current,
              userProjects: userProjectsRef.current
            }
          );
          const conversation: AgentGUIConversationSummary = {
            ...projectedConversation,
            sortTimeUnixMs: Math.max(
              projectedConversation.sortTimeUnixMs ?? 0,
              pendingOptimisticConversation?.sortTimeUnixMs ?? 0
            )
          };
          failedNewConversationIdsRef.current.delete(conversation.id);
          const isPendingCreatedConversation =
            startingConversationIdRef.current === agentSessionId;
          if (!isMountedRef.current) {
            void activation.unactivate(conversation.id);
            delete pendingActivationComposerSettingsPatchRef.current[
              conversation.id
            ];
            if (isPendingCreatedConversation) {
              startingConversationIdRef.current = null;
            }
            return;
          }
          const shouldAttachCreatedConversation =
            activeConversationIdRef.current === null &&
            isComposerHomeRef.current &&
            isPendingCreatedConversation;
          if (
            !shouldAttachCreatedConversation &&
            unactivateIfStale(conversation.id)
          ) {
            if (isPendingCreatedConversation) {
              startingConversationIdRef.current = null;
            }
            // The user navigated away from the optimistic create before it
            // resolved. Drop the optimistic messages recorded for it: the
            // optimistic user prompt keeps a pending turn id that retarget
            // never rewrote (the session wasn't watched), so if it lingered
            // it would reappear as a duplicate when the session is later
            // reopened from the conversation list and reloaded from durable
            // history.
            resetAgentSessionViewDetailMessages(
              sessionViewRef(conversation.id)
            );
            setAgentSessionViewOverlayMessages(
              sessionViewRef(conversation.id),
              []
            );
            if (transientConversationRef.current?.id === conversation.id) {
              setTransientConversation(null);
            }
            delete pendingActivationComposerSettingsPatchRef.current[
              conversation.id
            ];
            return;
          }
          if (isPendingCreatedConversation) {
            startingConversationIdRef.current = null;
          }
          activatedConversationIdsRef.current.add(conversation.id);
          // The real session now exists: flush any composer settings the
          // user changed while this conversation was still in the
          // pre-activation window (updateComposerSettings queued them here
          // instead of sending an RPC the daemon had no session for yet).
          const pendingComposerSettingsPatch =
            pendingActivationComposerSettingsPatchRef.current[conversation.id];
          if (pendingComposerSettingsPatch) {
            delete pendingActivationComposerSettingsPatchRef.current[
              conversation.id
            ];
            markSessionSettingsRequestState(conversation.id, true);
            flushQueuedComposerSettingsUpdateRef.current?.({
              agentSessionId: conversation.id,
              sessionSettingsPatch: pendingComposerSettingsPatch
            });
          }
          setTransientConversation(conversation);
          if (conversationListQuery) {
            // A conversation must never stay pinned in a tab it does not
            // belong to: when the current agent-target filter excludes the
            // created conversation, pin it under its own target tab's query
            // and move the filter there.
            const createdAgentTargetId =
              normalizeOptionalText(conversation.agentTargetId) ??
              targetData.agentTargetId;
            const currentQueryFilter = conversationListQuery.conversationFilter;
            const filterExcludesCreatedConversation =
              currentQueryFilter?.kind === "agentTarget" &&
              currentQueryFilter.agentTargetId !== (createdAgentTargetId ?? "");
            const createdConversationFilter: AgentGUIConversationFilter =
              createdAgentTargetId
                ? { kind: "agentTarget", agentTargetId: createdAgentTargetId }
                : { kind: "all" };
            const createdConversationQuery = filterExcludesCreatedConversation
              ? {
                  ...conversationListQuery,
                  conversationFilter: createdConversationFilter
                }
              : conversationListQuery;
            upsertLocalCreatedAgentGUIConversation({
              query: createdConversationQuery,
              conversation
            });
            scheduleAgentGUIConversationListProjection(
              createdConversationQuery,
              "local-create"
            );
            if (filterExcludesCreatedConversation) {
              setConversationFilter(createdConversationFilter);
            }
          }
          setAgentSessionViewMessagesLoading(
            sessionViewRef(conversation.id),
            true
          );
          if (submitTrace) {
            reportAgentSubmitTraceDiagnostic({
              event: "optimistic_state_applied",
              runtime: agentActivityRuntime,
              trace: submitTrace,
              workspaceId,
              fields: { mode: "new" }
            });
            scheduleAgentSubmitTracePaint({
              runtime: agentActivityRuntime,
              trace: submitTrace,
              workspaceId
            });
          }
          isComposerHomeRef.current = false;
          setIsComposerHome(false);
          activeConversationIdRef.current = conversation.id;
          setActiveConversationId(conversation.id);
          setIntent({ tag: "active", id: conversation.id });
          setDraftBySessionId((current) => {
            const currentHomeDraft =
              current[submittedHomeDraftKey] ?? EMPTY_AGENT_COMPOSER_DRAFT;
            const shouldClearHomeDraft = areAgentComposerDraftsEqual(
              currentHomeDraft,
              submittedHomeDraft
            );
            return {
              ...current,
              ...(shouldClearHomeDraft
                ? { [submittedHomeDraftKey]: emptyAgentComposerDraft() }
                : {}),
              [conversation.id]: emptyAgentComposerDraft()
            };
          });
          persistActiveConversation(conversation.id);
          setIsLoadingMessages(true);
          void loadSelectedConversationMessages(conversation.id);
          void loadSessionState(conversation.id);
          void syncConversationListProjection(conversation.id);
        })
        .catch((error) => {
          // Identify the failed create by the id captured when this submission
          // started, not by re-reading the mutable startingConversationIdRef
          // (a concurrent create may have overwritten or cleared it, which
          // would misattribute the failure and skip loading teardown).
          const agentSessionId =
            pendingCreateAgentSessionId ?? createAgentGUIConversationId();
          if (conversationListQuery) {
            clearAgentGUIConversationCreatePending({
              query: conversationListQuery,
              ownerKey: pendingCreateOwnerKey,
              conversationId: pendingCreateAgentSessionId ?? agentSessionId
            });
          }
          // The create failed outright: there is no session for a queued
          // pre-activation settings patch to apply to.
          delete pendingActivationComposerSettingsPatchRef.current[
            agentSessionId
          ];
          // Surface the failure only on the failed create's own surface —
          // either the user is still on it (the optimistic entry), or
          // they're back at the home composer where the create started. If
          // they navigated to another conversation, the error must not leak
          // onto that conversation; the create is cleaned up silently below.
          const shouldShowErrorOnHome =
            isCurrentConversation(agentSessionId) ||
            (activeConversationIdRef.current === null &&
              isComposerHomeRef.current);
          const submitTrace = submitTraceBySessionIdRef.current[agentSessionId];
          if (submitTrace) {
            const nextTraces = { ...submitTraceBySessionIdRef.current };
            delete nextTraces[agentSessionId];
            submitTraceBySessionIdRef.current = nextTraces;
            reportAgentSubmitTraceDiagnostic({
              event: "submit.failed",
              runtime: agentActivityRuntime,
              trace: submitTrace,
              workspaceId,
              fields: {
                errorCode: getAgentGUIErrorCode(error) ?? "unknown",
                mode: "new"
              }
            });
          }
          if (
            !shouldShowErrorOnHome &&
            !isCurrentConversation(agentSessionId)
          ) {
            resetAgentSessionViewDetailMessages(sessionViewRef(agentSessionId));
            setAgentSessionViewOverlayMessages(
              sessionViewRef(agentSessionId),
              []
            );
            setAgentSessionViewMessagesLoading(
              sessionViewRef(agentSessionId),
              false
            );
            if (startingConversationIdRef.current === agentSessionId) {
              startingConversationIdRef.current = null;
            }
            if (transientConversationRef.current?.id === agentSessionId) {
              setTransientConversation(null);
            }
            return;
          }
          const message = getAgentGUIErrorMessage(error);
          resetAgentSessionViewDetailMessages(sessionViewRef(agentSessionId));
          setAgentSessionViewOverlayMessages(
            sessionViewRef(agentSessionId),
            []
          );
          reportAgentGUIRuntimeError({
            agentSessionId,
            error,
            phase: "create_conversation",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId
          });
          failedNewConversationIdsRef.current.add(agentSessionId);
          if (startingConversationIdRef.current === agentSessionId) {
            startingConversationIdRef.current = null;
          }
          if (isCurrentConversation(agentSessionId)) {
            // Stash the error so the activeConversationId-null effect
            // surfaces it on the home composer instead of clearing it.
            pendingHomeErrorRef.current = message;
            // Undo the optimistic entry: send the user back to the home
            // composer. The home draft was never cleared, so their input is
            // preserved; only the error is surfaced there.
            isComposerHomeRef.current = true;
            setIsComposerHome(true);
            activeConversationIdRef.current = null;
            setActiveConversationId(null);
            setIntent({ tag: "home" });
            persistActiveConversation(null);
          }
          if (transientConversationRef.current?.id === agentSessionId) {
            setTransientConversation(null);
          }
          setIsLoadingMessages(false);
          setAgentSessionViewMessagesLoading(
            sessionViewRef(agentSessionId),
            false
          );
          setDetailError(message);
        })
        .finally(() => {
          isCreatingConversationRef.current = false;
          setLocalIsCreatingConversation(false);
        });
    },
    [
      activeSessionState,
      currentUserId,
      data,
      defaultReasoningEffort,
      isCreatingConversation,
      openclawGateway?.status,
      syncConversationListProjection,
      loadSelectedConversationMessages,
      loadSessionState,
      refreshMessagesFromSnapshot,
      persistActiveConversation,
      activation,
      conversationListQuery,
      isCurrentConversation,
      agentActivityRuntime,
      markSessionSettingsRequestState,
      pendingCreateOwnerKey,
      recordLocalMessages,
      unactivateIfStale,
      workspaceId
    ]
  );

  const createConversation = useCallback(
    (options?: { projectPath?: string | null; source?: string }) => {
      const source = options?.source ?? "controller";
      if (options && "projectPath" in options) {
        const projectPath = normalizeProjectDraftPath(options.projectPath);
        selectedProjectPathRef.current = projectPath;
        setSelectedProjectPath(projectPath);
      }
      const previous = activeConversationIdRef.current;
      reportAgentGUIActiveConversationCleared({
        details: {
          hasProjectPathOption: Boolean(options && "projectPath" in options),
          isComposerHome: isComposerHomeRef.current,
          projectPathPresent: Boolean(
            options &&
            "projectPath" in options &&
            normalizeProjectDraftPath(options.projectPath)
          ),
          source
        },
        previousAgentSessionId: previous,
        reason: "create_conversation",
        runtime: agentActivityRuntime,
        workspaceId
      });
      if (previous) {
        void activation.unactivate(previous);
      }
      setIntent({ tag: "home" });
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      setIsLoadingMessages(false);
      setDetailError(null);
      persistActiveConversation(null);
      // Starting a new conversation from a target tab should compose for that
      // tab's target, not for whatever target the node last remembered.
      const filter = conversationFilterRef.current;
      if (filter.kind === "agentTarget") {
        const filterTarget = resolveAgentGUIProviderTarget({
          agentTargetId: filter.agentTargetId,
          defaultProviderTargetId,
          provider: dataRef.current.provider,
          providerTargets: normalizedProviderTargets,
          useStaticCatalog: false
        });
        if (
          filterTarget &&
          filterTarget.disabled !== true &&
          (filterTarget.agentTargetId?.trim() ?? "") === filter.agentTargetId
        ) {
          setHomeComposerTargetOverride(filterTarget);
        }
      }
      loadDraftComposerOptions();
    },
    [
      activation,
      agentActivityRuntime,
      defaultProviderTargetId,
      loadDraftComposerOptions,
      normalizedProviderTargets,
      persistActiveConversation,
      workspaceId
    ]
  );

  useEffect(() => {
    if (previewMode || !prefillPromptRequest) {
      return;
    }
    if (
      handledPrefillPromptSequenceRef.current === prefillPromptRequest.sequence
    ) {
      return;
    }

    handledPrefillPromptSequenceRef.current = prefillPromptRequest.sequence;
    const draftPrompt = prefillPromptRequest.draftPrompt.trim();
    if (!draftPrompt) {
      return;
    }

    const projectPath = normalizeProjectDraftPath(
      prefillPromptRequest.userProjectPath
    );
    selectedProjectPathRef.current = projectPath;
    setSelectedProjectPath(projectPath);

    const previous = activeConversationIdRef.current;
    reportAgentGUIActiveConversationCleared({
      details: {
        autoSubmit: prefillPromptRequest.autoSubmit === true,
        sequence: prefillPromptRequest.sequence
      },
      previousAgentSessionId: previous,
      reason: "prefill_prompt",
      runtime: agentActivityRuntime,
      workspaceId
    });
    if (previous) {
      void activation.unactivate(previous);
    }
    setIntent({ tag: "home" });
    isComposerHomeRef.current = true;
    setIsComposerHome(true);
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setIsLoadingMessages(false);
    setDetailError(null);
    const selectedTargetData = selectedComposerTargetDataRef.current;
    const targetProvider =
      prefillPromptRequest.provider ?? selectedTargetData.provider;
    const targetAgentTargetId =
      prefillPromptRequest.agentTargetId ?? selectedTargetData.agentTargetId;
    setDraftBySessionId((current) => ({
      ...current,
      [nodeDefaultDraftContentKey(targetProvider, targetAgentTargetId)]: {
        ...emptyAgentComposerDraft(),
        prompt: draftPrompt
      }
    }));
    if (prefillPromptRequest.autoSubmit) {
      pendingAutoSubmitPromptRef.current = draftPrompt;
    }
    persistActiveConversation(null);
    loadDraftComposerOptions();
  }, [
    activation,
    agentActivityRuntime,
    loadDraftComposerOptions,
    persistActiveConversation,
    prefillPromptRequest,
    previewMode,
    workspaceId
  ]);

  const continueInNewConversation = useCallback(() => {
    const currentConversationId = activeConversationIdRef.current;
    if (!currentConversationId) {
      return;
    }
    const activeConversation = resolveConversationSummaryById(
      conversations,
      currentConversationId,
      transientConversationRef.current
    );
    if (!activeConversation) {
      createConversation();
      return;
    }
    const nextDraftPrompt = buildContinueInNewConversationPrompt({
      workspaceId,
      agentSessionId: activeConversation.id,
      conversationUserId: activeConversation.userId,
      currentUserId,
      userProfilesByUserId: accountProfilesByUserId,
      provider: activeConversation.provider,
      conversationTitle: activeConversation.title,
      existingDraftPrompt: draftBySessionId[currentConversationId]?.prompt ?? ""
    });
    const previous = activeConversationIdRef.current;
    reportAgentGUIActiveConversationCleared({
      details: {
        sourceConversationId: activeConversation.id
      },
      previousAgentSessionId: previous,
      reason: "continue_in_new_conversation",
      runtime: agentActivityRuntime,
      workspaceId
    });
    if (previous) {
      void activation.unactivate(previous);
    }
    setIntent({ tag: "home" });
    isComposerHomeRef.current = true;
    setIsComposerHome(true);
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setIsLoadingMessages(false);
    setDetailError(null);
    const targetData = selectedComposerTargetDataRef.current;
    setDraftBySessionId((current) => ({
      ...current,
      [nodeDefaultDraftContentKey(
        targetData.provider,
        targetData.agentTargetId
      )]: {
        prompt: nextDraftPrompt,
        images: []
      }
    }));
    persistActiveConversation(null);
    loadDraftComposerOptions();
  }, [
    accountProfilesByUserId,
    activation,
    agentActivityRuntime,
    conversations,
    createConversation,
    currentUserId,
    draftBySessionId,
    loadDraftComposerOptions,
    persistActiveConversation,
    workspaceId
  ]);

  const isSessionMarkedNonResumable = useCallback(
    (agentSessionId: string): boolean => {
      if (runtimeSessionsBySessionId.get(agentSessionId)?.resumable === false) {
        return true;
      }
      const conversation = resolveConversationSummaryById(
        conversationsRef.current,
        agentSessionId,
        transientConversationRef.current
      );
      return conversation?.resumable === false;
    },
    [runtimeSessionsBySessionId]
  );

  const retryActivation = useCallback(() => {
    const agentSessionId = activeConversationIdRef.current;
    if (!agentSessionId) {
      return;
    }
    if (isSessionMarkedNonResumable(agentSessionId)) {
      return;
    }
    if (isNonRetryableResumeErrorCode(activation.codeFor(agentSessionId))) {
      return;
    }
    failedNewConversationIdsRef.current.delete(agentSessionId);
    setDetailError(null);
    const existingMessages = resolveSessionMessages(agentSessionId);
    if (existingMessages.length === 0) {
      applyStatePatch({
        agentSessionId,
        currentPhase: "working",
        occurredAtUnixMs: Date.now()
      });
    }
    void activation
      .activate({ mode: "existing", agentSessionId })
      .then(() => {
        if (!isCurrentConversation(agentSessionId)) {
          return;
        }
        activatedConversationIdsRef.current.add(agentSessionId);
      })
      .catch((error) => {
        if (!isCurrentConversation(agentSessionId)) {
          return;
        }
        reportAgentGUIRuntimeError({
          agentSessionId,
          error,
          phase: "retry_activation",
          provider: dataRef.current.provider,
          runtime: agentActivityRuntime,
          workspaceId
        });
      });
  }, [
    agentActivityRuntime,
    activation,
    applyStatePatch,
    isCurrentConversation,
    isSessionMarkedNonResumable,
    resolveSessionMessages,
    workspaceId
  ]);

  const executePrompt = useCallback(
    (
      agentSessionId: string,
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: { guidance?: boolean }
    ) => {
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (!agentSessionId || normalizedContent.length === 0) {
        return;
      }
      const targetIsActiveConversation =
        activeConversationIdRef.current === agentSessionId;
      // displayPrompt(如 bundle 折叠成单 chip)优先用于回显;否则回退到 content 派生文本。
      const submittedPromptText =
        displayPrompt && displayPrompt.trim()
          ? displayPrompt
          : agentPromptContentDisplayText(normalizedContent);
      const submittedAtUnixMs = Date.now();
      const submitTrace = createAgentSubmitTraceState({
        agentSessionId,
        content: normalizedContent,
        prompt: submittedPromptText,
        queued: false,
        startedAtUnixMs: submittedAtUnixMs
      });
      const targetConversation = resolveConversationSummaryById(
        conversationsRef.current,
        agentSessionId,
        transientConversationRef.current
      );
      const previousConversationStatus = targetConversation?.status ?? null;
      submitTraceBySessionIdRef.current = {
        ...submitTraceBySessionIdRef.current,
        [agentSessionId]: submitTrace
      };
      reportAgentSubmitTraceDiagnostic({
        event: "submit.begin",
        runtime: agentActivityRuntime,
        trace: submitTrace,
        workspaceId,
        fields: {
          activeConversationId: activeConversationIdRef.current,
          conversationKnown: targetConversation !== null,
          conversationStatus: previousConversationStatus,
          isComposerHome: isComposerHomeRef.current,
          targetIsActiveConversation,
          targetMode: "existing"
        }
      });
      if (conversationListQuery) {
        markAgentGUIConversationSubmitPending({
          query: conversationListQuery,
          conversationId: agentSessionId
        });
      }
      setLocalIsSubmitting(true);
      setDetailError(null);
      patchConversation(agentSessionId, (conversation) => ({
        status: "working",
        sortTimeUnixMs: Math.max(
          conversation.sortTimeUnixMs ?? 0,
          submittedAtUnixMs
        ),
        updatedAtUnixMs: Math.max(
          conversation.updatedAtUnixMs,
          submittedAtUnixMs
        )
      }));
      setTransientConversation((current) =>
        current?.id === agentSessionId
          ? {
              ...current,
              status: "working",
              sortTimeUnixMs: Math.max(
                current.sortTimeUnixMs ?? 0,
                submittedAtUnixMs
              ),
              updatedAtUnixMs: Math.max(
                current.updatedAtUnixMs,
                submittedAtUnixMs
              )
            }
          : current
      );
      const pendingOptimisticTurnId = createPendingOptimisticTurnId(
        submitTrace.clientSubmitId
      );
      pendingTurnIdBySessionIdRef.current = {
        ...pendingTurnIdBySessionIdRef.current,
        [agentSessionId]: pendingOptimisticTurnId
      };
      applyStatePatch({
        agentSessionId,
        currentPhase: "working",
        occurredAtUnixMs: submittedAtUnixMs
      });
      reportAgentSubmitTraceDiagnostic({
        event: "optimistic_state_applied",
        runtime: agentActivityRuntime,
        trace: submitTrace,
        workspaceId
      });
      recordLocalMessages(agentSessionId, [
        createOptimisticPromptMessage({
          workspaceId,
          agentSessionId,
          turnId: pendingOptimisticTurnId,
          clientSubmitId: submitTrace.clientSubmitId,
          userId: currentUserId?.trim() || "user",
          prompt: submittedPromptText,
          content: normalizedContent,
          occurredAtUnixMs: submittedAtUnixMs
        })
      ]);
      reportAgentSubmitTraceDiagnostic({
        event: "optimistic_user_message_recorded",
        runtime: agentActivityRuntime,
        trace: submitTrace,
        workspaceId
      });
      void Promise.resolve()
        .then(() => {
          reportAgentSubmitTraceDiagnostic({
            event: "send_input.requested",
            runtime: agentActivityRuntime,
            trace: submitTrace,
            workspaceId
          });
          return agentActivityRuntime.sendInput({
            workspaceId,
            agentSessionId,
            content: normalizedContent,
            displayPrompt:
              displayPrompt && displayPrompt.trim() ? displayPrompt : null,
            ...(options?.guidance === true ? { guidance: true } : {}),
            metadata: agentSubmitTraceMetadata(submitTrace)
          });
        })
        .then((result) => {
          if (!result) {
            return;
          }
          submitTrace.turnId = result.turnId.trim() || null;
          reportAgentSubmitTraceDiagnostic({
            event: "send_input.resolved",
            runtime: agentActivityRuntime,
            trace: submitTrace,
            workspaceId,
            fields: {
              submitAvailability: result.submitAvailability,
              turnLifecycle: result.turnLifecycle
            }
          });
          reportAgentSubmitTraceDiagnostic({
            event: "submit.accepted",
            runtime: agentActivityRuntime,
            trace: submitTrace,
            workspaceId,
            fields: {
              submitAvailability: result.submitAvailability,
              turnLifecycle: result.turnLifecycle
            }
          });
          const submittedStatus =
            conversationStatusFromStatePatch({
              agentSessionId,
              turn: {
                turnId: result.turnId,
                phase: result.turnLifecycle.phase,
                outcome: result.turnLifecycle.outcome ?? undefined,
                activeTurnId: result.turnLifecycle.activeTurnId,
                settling: result.turnLifecycle.settling,
                completedCommand:
                  result.turnLifecycle.completedCommand ?? undefined,
                submitAvailability: result.submitAvailability
              }
            }) ??
            conversationStatusFromStatusValue(
              projectCoreSessionStatus(result.session.status)
            );
          if (submittedStatus && submittedStatus !== "ready") {
            patchConversation(agentSessionId, {
              status: submittedStatus,
              updatedAtUnixMs: Date.now()
            });
          }
          setDraftBySessionId((current) => {
            const currentDraft = current[agentSessionId];
            if (
              !shouldClearSubmittedDraft({
                currentDraft,
                submittedContent: normalizedContent
              })
            ) {
              return current;
            }
            return {
              ...current,
              [agentSessionId]: emptyAgentComposerDraft()
            };
          });
          const submittedTurnId = result.turnId.trim();
          if (submittedTurnId) {
            pendingTurnIdBySessionIdRef.current = {
              ...pendingTurnIdBySessionIdRef.current,
              [agentSessionId]: submittedTurnId
            };
            retargetOptimisticPromptTurn(
              agentSessionId,
              submitTrace.clientSubmitId,
              submittedTurnId
            );
            scheduleAgentSubmitTracePaint({
              runtime: agentActivityRuntime,
              trace: submitTrace,
              workspaceId
            });
          }
          void refreshMessagesFromSnapshot(agentSessionId);
          if (
            !getAgentSessionView(sessionViewRef(agentSessionId))?.controlState
          ) {
            void loadSessionState(agentSessionId);
          }
          if (submittedStatus !== "working") {
            void syncConversationListProjection(agentSessionId);
          }
        })
        .catch((error) => {
          const nextTraces = { ...submitTraceBySessionIdRef.current };
          delete nextTraces[agentSessionId];
          submitTraceBySessionIdRef.current = nextTraces;
          removeOptimisticPrompt(agentSessionId, submitTrace.clientSubmitId);
          const nextPendingTurns = { ...pendingTurnIdBySessionIdRef.current };
          delete nextPendingTurns[agentSessionId];
          pendingTurnIdBySessionIdRef.current = nextPendingTurns;
          reportAgentSubmitTraceDiagnostic({
            event: "submit.failed",
            runtime: agentActivityRuntime,
            trace: submitTrace,
            workspaceId,
            fields: {
              errorCode: getAgentGUIErrorCode(error)
            }
          });
          if (
            previousConversationStatus &&
            previousConversationStatus !== "working"
          ) {
            patchConversation(agentSessionId, (conversation) =>
              conversation.status === "working"
                ? {
                    status: previousConversationStatus,
                    updatedAtUnixMs: Date.now()
                  }
                : null
            );
            const transient = transientConversationRef.current;
            if (
              transient?.id === agentSessionId &&
              transient.status === "working"
            ) {
              setTransientConversation({
                ...transient,
                status: previousConversationStatus,
                updatedAtUnixMs: Date.now()
              });
            }
          }
          if (isCurrentConversation(agentSessionId)) {
            reportAgentGUIRuntimeError({
              agentSessionId,
              error,
              phase: "send_prompt",
              provider: dataRef.current.provider,
              runtime: agentActivityRuntime,
              workspaceId
            });
            setDetailError(getAgentGUIErrorMessage(error));
          }
        })
        .finally(() => {
          if (conversationListQuery) {
            clearAgentGUIConversationSubmitPending({
              query: conversationListQuery,
              conversationId: agentSessionId
            });
          }
          setLocalIsSubmitting(false);
        });
    },
    [
      currentUserId,
      isCurrentConversation,
      applyStatePatch,
      conversationListQuery,
      syncConversationListProjection,
      loadSessionState,
      refreshMessagesFromSnapshot,
      recordLocalMessages,
      removeOptimisticPrompt,
      retargetOptimisticPromptTurn,
      sessionViewRef,
      setTransientConversation,
      patchConversation,
      workspaceId,
      agentActivityRuntime
    ]
  );

  useEffect(() => {
    executePromptRef.current = executePrompt;
  }, [executePrompt]);

  const queuePromptLocally = useCallback(
    (
      agentSessionId: string,
      content: readonly AgentPromptContentBlock[],
      displayPrompt?: string
    ) => {
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (!agentSessionId || normalizedContent.length === 0) {
        return;
      }
      const queuedPrompt: AgentGUIQueuedPromptVM = {
        id: `local-${createAgentGUIConversationId()}`,
        content: normalizedContent,
        ...(displayPrompt && displayPrompt.trim() ? { displayPrompt } : {}),
        createdAtUnixMs: Date.now()
      };
      agentQueuedPromptRuntime.enqueue({
        workspaceId,
        agentSessionId,
        prompt: queuedPrompt
      });
      setDraftBySessionId((current) => ({
        ...current,
        [agentSessionId]: emptyAgentComposerDraft()
      }));
      setDetailError(null);
    },
    [agentQueuedPromptRuntime, workspaceId]
  );

  const shouldQueuePromptLocally = useCallback(
    (agentSessionId: string): boolean => {
      if (isSubmitting || isRespondingApproval) {
        return true;
      }
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId) {
        return false;
      }
      if (pendingTurnIdBySessionIdRef.current[normalizedAgentSessionId]) {
        return true;
      }
      const sessionState =
        getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
          ?.controlState ?? null;
      if (sessionState?.pendingInteractive) {
        return true;
      }
      return agentActivityDisplayStatusBusy(
        agentActivityDisplayStatuses.get(normalizedAgentSessionId)
      );
    },
    [
      agentActivityDisplayStatuses,
      isRespondingApproval,
      isSubmitting,
      sessionViewRef
    ]
  );

  const submitExistingPrompt = useCallback(
    (
      agentSessionId: string,
      normalizedContent: AgentPromptContentBlock[],
      displayPromptText?: string,
      options?: { bypassLocalQueue?: boolean; guidance?: boolean }
    ) => {
      if (isSessionMarkedNonResumable(agentSessionId)) {
        setDetailError(
          getAgentGUIErrorMessage(buildResumeSessionNotLocalActivationError())
        );
        return;
      }
      if (isNonRetryableResumeErrorCode(activation.codeFor(agentSessionId))) {
        setDetailError(
          getAgentGUIErrorMessage(
            activation.codeFor(agentSessionId) ===
              AGENT_RESUME_SESSION_NOT_LOCAL_ERROR
              ? buildResumeSessionNotLocalActivationError(
                  activation.errorFor(agentSessionId)
                )
              : buildProviderSessionNotFoundActivationError(
                  activation.errorFor(agentSessionId)
                )
          )
        );
        return;
      }
      // Any explicit user send lifts a user-stop hold on the queue.
      agentQueuedPromptRuntime.resumeQueue({ workspaceId, agentSessionId });
      if (
        shouldQueuePromptLocally(agentSessionId) &&
        options?.bypassLocalQueue !== true
      ) {
        queuePromptLocally(
          agentSessionId,
          normalizedContent,
          displayPromptText
        );
        return;
      }
      executePrompt(agentSessionId, normalizedContent, displayPromptText, {
        guidance: options?.guidance === true
      });
    },
    [
      activation,
      agentQueuedPromptRuntime,
      executePrompt,
      isSessionMarkedNonResumable,
      queuePromptLocally,
      shouldQueuePromptLocally,
      workspaceId
    ]
  );

  // Goal control commands (/goal clear|paused|active) act on the running
  // thread immediately; the local prompt queue would defer them until the
  // turn ends, defeating their purpose (e.g. stopping a runaway goal).
  // Goal banner controls act directly on the session's goal (like the stop
  // button acts on the turn): a dedicated control API, no prompt, no queue,
  // no transcript entry — matching the codex desktop goal bar.
  const goalControl = useCallback(
    (action: AgentActivityGoalControlAction, objective?: string) => {
      if (previewMode) {
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId) {
        return;
      }
      setDetailError(null);
      void agentActivityRuntime
        .goalControl({
          workspaceId,
          agentSessionId,
          action,
          ...(objective !== undefined ? { objective } : {})
        })
        .catch((error: unknown) => {
          if (!isCurrentConversation(agentSessionId)) {
            return;
          }
          setDetailError(getAgentGUIErrorMessage(error));
        });
    },
    [
      agentActivityRuntime,
      isCurrentConversation,
      previewMode,
      setDetailError,
      workspaceId
    ]
  );

  const submitPrompt = useCallback(
    (content: AgentPromptContentBlock[], displayPrompt?: string) => {
      if (previewMode) {
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (normalizedContent.length === 0) {
        return;
      }
      const displayPromptText =
        displayPrompt && displayPrompt.trim() ? displayPrompt : undefined;
      if (
        resolvedPromptImagesSupported === false &&
        agentPromptContentHasImage(normalizedContent)
      ) {
        setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
        return;
      }
      if (!agentSessionId) {
        if (!isComposerHomeRef.current) {
          const promptLength =
            agentPromptContentDisplayText(normalizedContent).length;
          reportAgentGUISubmitWithoutActiveConversation({
            blockCount: normalizedContent.length,
            conversationCount: conversationsRef.current.length,
            conversationListQueryReady: conversationListQuery !== null,
            dataLastActiveAgentSessionId:
              dataRef.current.lastActiveAgentSessionId ?? null,
            isComposerHome: isComposerHomeRef.current,
            promptLength,
            provider: dataRef.current.provider ?? null,
            runtime: agentActivityRuntime,
            workspaceId
          });
          const recoveredAgentSessionId =
            dataRef.current.lastActiveAgentSessionId?.trim() ?? "";
          if (recoveredAgentSessionId) {
            reportAgentGUISubmitRecoveredActiveConversation({
              blockCount: normalizedContent.length,
              conversationCount: conversationsRef.current.length,
              conversationListQueryReady: conversationListQuery !== null,
              promptLength,
              provider: dataRef.current.provider ?? null,
              recoveredAgentSessionId,
              runtime: agentActivityRuntime,
              workspaceId
            });
            activeConversationIdRef.current = recoveredAgentSessionId;
            setActiveConversationId(recoveredAgentSessionId);
            setIntent({ tag: "active", id: recoveredAgentSessionId });
            persistActiveConversation(recoveredAgentSessionId);
            submitExistingPrompt(
              recoveredAgentSessionId,
              normalizedContent,
              displayPromptText
            );
            return;
          }
        }
        startConversation(normalizedContent, displayPromptText);
        return;
      }
      submitExistingPrompt(
        agentSessionId,
        normalizedContent,
        displayPromptText
      );
    },
    [
      agentActivityRuntime,
      conversationListQuery,
      previewMode,
      resolvedPromptImagesSupported,
      persistActiveConversation,
      startConversation,
      submitExistingPrompt,
      workspaceId
    ]
  );

  const submitGuidancePrompt = useCallback(
    (content: AgentPromptContentBlock[], displayPrompt?: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (!agentSessionId || normalizedContent.length === 0) {
        return;
      }
      if (
        resolvedPromptImagesSupported === false &&
        agentPromptContentHasImage(normalizedContent)
      ) {
        setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
        return;
      }
      const activeTurnId =
        activeSessionState?.turnLifecycle?.activeTurnId?.trim() ?? "";
      if (activeTurnId === "") {
        return;
      }
      const displayPromptText =
        displayPrompt && displayPrompt.trim() ? displayPrompt : undefined;
      submitExistingPrompt(
        agentSessionId,
        normalizedContent,
        displayPromptText,
        { bypassLocalQueue: true, guidance: true }
      );
    },
    [
      activeSessionState,
      resolvedPromptImagesSupported,
      submitExistingPrompt,
      translate
    ]
  );

  useEffect(() => {
    if (previewMode) {
      return;
    }
    const prompt = pendingAutoSubmitPromptRef.current?.trim() ?? "";
    if (!prompt) {
      return;
    }
    pendingAutoSubmitPromptRef.current = null;
    submitPrompt(textPromptContent(prompt));
  }, [prefillPromptRequest?.sequence, previewMode, submitPrompt]);

  const showPromptImagesUnsupported = useCallback(() => {
    setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
  }, []);

  const submitInteractivePrompt = useCallback(
    (input: {
      requestId: string;
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
    }) => {
      // Codex plan-implementation actions are client-orchestrated (no server
      // submitInteractive); route them to the plan decision handlers.
      if (input.action === PLAN_IMPLEMENTATION_ACTION_IMPLEMENT) {
        planActionsRef.current.implement();
        return;
      }
      if (input.action === PLAN_IMPLEMENTATION_ACTION_FEEDBACK) {
        planActionsRef.current.feedback(
          typeof input.payload?.text === "string" ? input.payload.text : ""
        );
        return;
      }
      if (input.action === PLAN_IMPLEMENTATION_ACTION_SKIP) {
        planActionsRef.current.skip();
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      const normalizedRequestId = input.requestId.trim();
      const normalizedOptionId = input.optionId?.trim() ?? "";
      if (!agentSessionId || !normalizedRequestId || isRespondingApproval) {
        return;
      }
      setIsRespondingApproval(true);
      setDetailError(null);
      // Exit-plan mode changes are NOT mirrored optimistically here. The daemon
      // owns the session mode: on this submit it switches plan/permission mode
      // and publishes a state patch, which drives the composer reactively (see
      // syncClaudeCodeModeFromSelection in the runtime controller). A frontend
      // optimistic write would just race that authoritative patch.
      void Promise.resolve()
        .then(() => {
          if (!isCurrentConversation(agentSessionId)) {
            return null;
          }
          return agentActivityRuntime.submitInteractive({
            workspaceId,
            agentSessionId,
            requestId: normalizedRequestId,
            ...(input.action?.trim() ? { action: input.action.trim() } : {}),
            ...(normalizedOptionId ? { optionId: normalizedOptionId } : {}),
            ...(input.payload ? { payload: input.payload } : {})
          });
        })
        .then((result) => {
          if (!result || !isCurrentConversation(agentSessionId)) {
            return;
          }
          void refreshMessagesFromSnapshot(agentSessionId);
          void loadSessionState(agentSessionId);
          void syncConversationListProjection(agentSessionId);
        })
        .catch((error) => {
          if (isCurrentConversation(agentSessionId)) {
            reportAgentGUIRuntimeError({
              agentSessionId,
              error,
              phase: "submit_interactive",
              provider: dataRef.current.provider,
              requestId: normalizedRequestId,
              runtime: agentActivityRuntime,
              workspaceId
            });
            setDetailError(getAgentGUIErrorMessage(error));
          }
        })
        .finally(() => {
          setIsRespondingApproval(false);
        });
    },
    [
      isCurrentConversation,
      isRespondingApproval,
      syncConversationListProjection,
      loadSessionState,
      refreshMessagesFromSnapshot,
      workspaceId,
      agentActivityRuntime
    ]
  );

  const submitApprovalOption = useCallback(
    (requestId: string, optionId: string) => {
      void submitInteractivePrompt({ requestId, optionId });
    },
    [submitInteractivePrompt]
  );

  const interruptCurrentTurn = useCallback(
    (noRunningResponseMessage: string) => {
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId || interruptingSessionIds[agentSessionId]) {
        return;
      }
      void noRunningResponseMessage;
      const activePendingPrompt = activePendingPromptRef.current;
      if (activePendingPrompt?.sessionId === agentSessionId) {
        setSuppressedPromptRequestIdsBySessionId((current) => ({
          ...current,
          [agentSessionId]: activePendingPrompt.requestId
        }));
      }
      setInterruptingSessionIds((current) => ({
        ...current,
        [agentSessionId]: true
      }));
      // A user stop means "stop everything": hold the queued prompts instead
      // of letting the drainer fire the next one the moment the session
      // becomes available. An explicit user send (submit or send-now on a
      // queued item) lifts the hold.
      agentQueuedPromptRuntime.suspendQueue({
        workspaceId,
        agentSessionId,
        reason: "user_stop"
      });
      setDetailError(null);
      void Promise.resolve()
        .then(() => {
          if (!isCurrentConversation(agentSessionId)) {
            return null;
          }
          return agentActivityRuntime.cancelSession({
            workspaceId,
            agentSessionId
          });
        })
        .then((result) => {
          if (!result || !isCurrentConversation(agentSessionId)) {
            return;
          }
          const conversationStatus =
            resolveConversationSummaryById(
              conversations,
              agentSessionId,
              transientConversationRef.current
            )?.status ?? null;
          const runtimeSessionStatus =
            runtimeSessionsBySessionId.get(agentSessionId)?.status ?? null;
          reportAgentGUICancelDiagnostic({
            agentSessionId,
            busySource: cancelBusySource({
              conversationStatus,
              hasActivePrompt:
                activePendingPrompt?.sessionId === agentSessionId,
              runtimeSessionStatus,
              sessionStateStatus: activeSessionState?.status ?? null
            }),
            currentSessionStatus:
              activeSessionState?.status ?? runtimeSessionStatus,
            phase: "interrupt_current_turn",
            provider: dataRef.current.provider,
            result,
            runtime: agentActivityRuntime,
            workspaceId
          });
          void refreshMessagesFromSnapshot(agentSessionId);
          void loadSessionState(agentSessionId);
          void syncConversationListProjection(agentSessionId);
        })
        .catch((error) => {
          if (!isCurrentConversation(agentSessionId)) {
            return;
          }
          if (isAgentSessionNotReadyError(error)) {
            // The session is still connecting (its thread/start is in flight),
            // so there is no live turn to interrupt yet. Arm a retry for when
            // the turn goes live and suppress the transient "session not found"
            // banner instead of surfacing it as a hard error.
            setPendingInterruptSessionIds((current) => ({
              ...current,
              [agentSessionId]: true
            }));
            return;
          }
          reportAgentGUIRuntimeError({
            agentSessionId,
            error,
            phase: "interrupt_current_turn",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId
          });
          setSuppressedPromptRequestIdsBySessionId((current) => {
            if (current[agentSessionId] !== activePendingPrompt?.requestId) {
              return current;
            }
            const next = { ...current };
            delete next[agentSessionId];
            return next;
          });
          setDetailError(getAgentGUIErrorMessage(error));
        })
        .finally(() => {
          setInterruptingSessionIds((current) => {
            if (!current[agentSessionId]) {
              return current;
            }
            const next = { ...current };
            delete next[agentSessionId];
            return next;
          });
        });
    },
    [
      agentQueuedPromptRuntime,
      interruptingSessionIds,
      isCurrentConversation,
      syncConversationListProjection,
      loadSessionState,
      refreshMessagesFromSnapshot,
      conversations,
      runtimeSessionsBySessionId,
      activeSessionState,
      workspaceId,
      agentActivityRuntime
    ]
  );

  // A deferred cancel (armed when a cancel raced session startup) applies only
  // to that startup turn. Fire it once the turn goes live; drop it once the
  // session settles without a live turn, so it can never interrupt a later,
  // unrelated turn in the same session.
  useEffect(() => {
    const agentSessionId = activeConversationId;
    if (!agentSessionId || !pendingInterruptSessionIds[agentSessionId]) {
      return;
    }
    const status = agentActivityDisplayStatuses.get(agentSessionId) ?? null;
    const action = pendingInterruptActionForDisplayStatus(status);
    if (action === "wait") {
      return;
    }
    setPendingInterruptSessionIds((current) => {
      if (!current[agentSessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[agentSessionId];
      return next;
    });
    if (action === "fire") {
      interruptCurrentTurn("");
    }
  }, [
    activeConversationId,
    agentActivityDisplayStatuses,
    pendingInterruptSessionIds,
    interruptCurrentTurn
  ]);

  // Abandon a deferred cancel when the user switches away from its session, so
  // it cannot fire against a different conversation later.
  useEffect(() => {
    const activeId = activeConversationId;
    setPendingInterruptSessionIds((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0 || (ids.length === 1 && ids[0] === activeId)) {
        return current;
      }
      return activeId && current[activeId] ? { [activeId]: true } : {};
    });
  }, [activeConversationId]);

  const updateDraftContent = useCallback((draftContent: AgentComposerDraft) => {
    const agentSessionId = activeConversationIdRef.current;
    const targetData = selectedComposerTargetDataRef.current;
    const draftKey =
      agentSessionId ??
      nodeDefaultDraftContentKey(targetData.provider, targetData.agentTargetId);
    draftBySessionIdRef.current = {
      ...draftBySessionIdRef.current,
      [draftKey]: draftContent
    };
    setDraftBySessionId((current) => ({
      ...current,
      [draftKey]: draftContent
    }));
  }, []);

  const flushQueuedComposerSettingsUpdate = useCallback(
    (
      input: QueuedComposerSettingsUpdate & {
        agentSessionId: string;
      }
    ) => {
      const { agentSessionId, sessionSettingsPatch } = input;
      void agentActivityRuntime
        .updateSessionSettings({
          workspaceId,
          agentSessionId,
          settings: sessionSettingsPatch
        })
        .then((result) => {
          const queuedUpdate =
            queuedComposerSettingsUpdatesRef.current[agentSessionId] ?? null;
          const optimisticSettings = queuedUpdate?.sessionSettingsPatch ?? null;
          const pendingClaudeModelRefreshSettings =
            dataRef.current.provider === "claude-code" &&
            sessionSettingsPatch.model !== undefined
              ? { model: sessionSettingsPatch.model }
              : null;
          const nextAppliedSettings = {
            ...result.settings,
            ...(pendingClaudeModelRefreshSettings ?? {}),
            ...(optimisticSettings ?? {})
          };
          updateAgentSessionViewControlState(
            sessionViewRef(agentSessionId),
            (existing) =>
              existing
                ? {
                    ...existing,
                    permissionModeId:
                      nextAppliedSettings.permissionModeId ?? undefined,
                    runtimeContext: mergeRuntimeContextComposerSettings(
                      dataRef.current.provider,
                      existing.runtimeContext,
                      nextAppliedSettings
                    ),
                    settings: {
                      ...(existing.settings ?? {}),
                      ...nextAppliedSettings
                    }
                  }
                : existing
          );
          if (queuedUpdate === null) {
            if (
              sessionSettingsPatch.model !== undefined &&
              dataRef.current.provider === "claude-code"
            ) {
              void loadSessionState(agentSessionId, {
                source: "settings-update",
                force: true
              });
            }
          }
        })
        .catch((error) => {
          delete queuedComposerSettingsUpdatesRef.current[agentSessionId];
          void loadSessionState(agentSessionId, {
            source: "settings-update",
            force: true
          });
          const message = getAgentGUIErrorMessage(error);
          if (
            isSettingsRequireNewSessionErrorCode(getAgentGUIErrorCode(error))
          ) {
            onShowMessageRef.current?.(message, "warning");
          }
          if (isCurrentConversation(agentSessionId)) {
            reportAgentGUIRuntimeError({
              agentSessionId,
              error,
              phase: "update_session_settings",
              provider: dataRef.current.provider,
              runtime: agentActivityRuntime,
              workspaceId
            });
            setDetailError(message);
          }
        })
        .finally(() => {
          const queuedUpdate =
            queuedComposerSettingsUpdatesRef.current[agentSessionId] ?? null;
          if (queuedUpdate !== null) {
            delete queuedComposerSettingsUpdatesRef.current[agentSessionId];
            flushQueuedComposerSettingsUpdate({
              agentSessionId,
              sessionSettingsPatch: queuedUpdate.sessionSettingsPatch
            });
            return;
          }
          markSessionSettingsRequestState(agentSessionId, false);
        });
    },
    [
      agentActivityRuntime,
      isCurrentConversation,
      loadSessionState,
      markSessionSettingsRequestState,
      workspaceId,
      sessionViewRef
    ]
  );
  flushQueuedComposerSettingsUpdateRef.current =
    flushQueuedComposerSettingsUpdate;

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
              agentTargetId: targetData.agentTargetId,
              providerTargetId: targetData.providerTargetId,
              providerTargetRef: targetData.providerTargetRef
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
          targetData.provider === "claude-code" ? { force: true } : undefined
        );
        return;
      }
      const activeSessionState =
        getAgentSessionView(sessionViewRef(agentSessionId))?.controlState ??
        null;
      // The optimistic pre-activation window (see startConversation): the id
      // is already the active conversation but the backend session has not
      // attached yet, so there is no control state to read settings from or
      // send an update RPC against. Composer changes here are still applied
      // to the local view (so the control reflects the click immediately)
      // and queued for the flush once activation resolves.
      const isPreActivationSession =
        activeSessionState === null &&
        activation.stateFor(agentSessionId) === "activating";
      const sessionSettings = cloneComposerSettings(
        activeSessionState?.settings ?? null
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
        (activeSessionState !== null || isPreActivationSession)
      ) {
        sessionSettingsPatch.permissionModeId =
          normalizePermissionModeId(nextPermission);
        // Codex has no live mid-turn RPC for approval/sandbox policy: the
        // daemon only re-derives it fresh on the *next* turn/start call, so a
        // change made while a turn is actively running won't affect that
        // turn. Claude Code applies it immediately via query.setPermissionMode
        // even mid-turn, so no such gap exists there. Surface the deferral
        // honestly instead of letting the optimistic UI update imply the
        // change is already in effect. There is no turn at all yet during
        // the pre-activation window, so this deferral notice does not apply.
        const turnPhase = activeSessionState?.turnLifecycle?.phase;
        const isTurnInFlight =
          turnPhase === "running" || turnPhase === "submitted";
        if (dataRef.current.provider === "codex" && isTurnInFlight) {
          onShowMessageRef.current?.(
            translate("messages.agentPermissionModeAppliesNextTurn"),
            "info"
          );
        }
      }
      if (
        Object.keys(sessionSettingsPatch).length > 0 &&
        (activeSessionState !== null || isPreActivationSession)
      ) {
        updateAgentSessionViewControlState(
          sessionViewRef(agentSessionId),
          (existing) => {
            // Synthesize a minimal control-state entry when none exists yet
            // (the pre-activation window) so the composer reflects the change
            // immediately instead of waiting for the real session to attach.
            const base: AgentSessionState = existing ?? {
              workspaceId,
              agentSessionId,
              provider: dataRef.current.provider,
              status: "working",
              updatedAtUnixMs: Date.now(),
              settings: {}
            };
            const nextState = {
              ...base,
              permissionModeId:
                sessionSettingsPatch.permissionModeId ?? base.permissionModeId,
              runtimeContext: mergeRuntimeContextComposerSettings(
                dataRef.current.provider,
                base.runtimeContext,
                sessionSettingsPatch
              ),
              settings: {
                ...(base.settings ?? {}),
                ...sessionSettingsPatch
              }
            };
            return nextState;
          }
        );
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
          // No backend session exists yet: hold the patch until activation
          // resolves (flushed from startConversation's success handler) or
          // discard it if activation fails/is superseded, rather than firing
          // an updateSessionSettings RPC against a session id the daemon
          // does not know about yet.
          const pendingPatch =
            pendingActivationComposerSettingsPatchRef.current[agentSessionId];
          pendingActivationComposerSettingsPatchRef.current = {
            ...pendingActivationComposerSettingsPatchRef.current,
            [agentSessionId]: {
              ...(pendingPatch ?? {}),
              ...sessionSettingsPatch
            }
          };
        } else if (updatingSessionSettingsIdsRef.current[agentSessionId]) {
          const queuedUpdate =
            queuedComposerSettingsUpdatesRef.current[agentSessionId];
          queuedComposerSettingsUpdatesRef.current[agentSessionId] = {
            sessionSettingsPatch: {
              ...(queuedUpdate?.sessionSettingsPatch ?? {}),
              ...sessionSettingsPatch
            }
          };
        } else {
          markSessionSettingsRequestState(agentSessionId, true);
          flushQueuedComposerSettingsUpdate({
            agentSessionId,
            sessionSettingsPatch
          });
        }
        return;
      }
    },
    [
      activation,
      defaultReasoningEffort,
      activeTimelineItems,
      flushQueuedComposerSettingsUpdate,
      loadDraftComposerOptions,
      markSessionSettingsRequestState,
      workspaceId,
      sessionViewRef
    ]
  );
  updateComposerSettingsRef.current = updateComposerSettings;

  const implementPlan = useCallback(() => {
    const agentSessionId = activeConversationIdRef.current;
    if (!agentSessionId) {
      return;
    }
    // The implement sequence (turn plan mode off on the daemon, then submit
    // the literal coding message) is defined once in planDecisionOps; here we
    // execute those ops with the controller's runtime primitives and layer on
    // the node-local UI effects (dismiss the plan card + mirror plan mode in
    // the composer) that the shared op list intentionally omits.
    const ops = planDecisionOps({
      promptKind: "plan-implementation",
      action: PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
      requestId: agentSessionId
    });
    // Sequential for-await (mirrors the desktop service's op executor): the
    // daemon planMode:false must settle before the literal prompt is submitted.
    void (async () => {
      try {
        for (const op of ops) {
          if (!isCurrentConversation(agentSessionId)) {
            return;
          }
          if (op.type === "updateSettings") {
            await agentActivityRuntime.updateSessionSettings({
              workspaceId,
              agentSessionId,
              settings: op.settings
            });
            if (!isCurrentConversation(agentSessionId)) {
              return;
            }
            dismissPlanImplementation();
            updateComposerSettingsRef.current({ planMode: false });
          } else if (op.type === "sendInput") {
            submitPrompt(textPromptContent(op.text));
          }
        }
      } catch (error) {
        if (!isCurrentConversation(agentSessionId)) {
          return;
        }
        reportAgentGUIRuntimeError({
          agentSessionId,
          error,
          phase: "update_session_settings",
          provider: dataRef.current.provider,
          runtime: agentActivityRuntime,
          workspaceId
        });
        setDetailError(getAgentGUIErrorMessage(error));
      }
    })();
  }, [
    agentActivityRuntime,
    dismissPlanImplementation,
    isCurrentConversation,
    submitPrompt,
    workspaceId
  ]);

  const submitPlanFeedback = useCallback(
    (feedback: string) => {
      dismissPlanImplementation();
      const trimmed = feedback.trim();
      if (!trimmed) {
        return;
      }
      // Feedback keeps plan mode on so the agent refines the plan rather than
      // implementing it (mirrors the codex TUI's "tell it how to adjust").
      submitPrompt(textPromptContent(trimmed));
    },
    [dismissPlanImplementation, submitPrompt]
  );
  planActionsRef.current = {
    implement: implementPlan,
    feedback: submitPlanFeedback,
    skip: dismissPlanImplementation
  };

  const requestDeleteConversation = useCallback(
    (agentSessionId: string) => {
      const normalized = agentSessionId.trim();
      if (!normalized || isDeletingConversation) {
        return;
      }
      const conversation = conversations.find(
        (candidate) => candidate.id === normalized
      );
      if (!conversation) {
        return;
      }
      setPendingDeleteConversation(conversation);
      setDetailError(null);
    },
    [conversations, isDeletingConversation]
  );

  const cancelDeleteConversation = useCallback(() => {
    if (isDeletingConversation) {
      return;
    }
    setPendingDeleteConversation(null);
  }, [isDeletingConversation]);

  const removeQueuedPrompt = useCallback(
    (queuedPromptId: string) => {
      if (previewMode) {
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (!agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      agentQueuedPromptRuntime.removePrompt({
        workspaceId,
        agentSessionId,
        promptId: normalizedQueuedPromptId
      });
    },
    [agentQueuedPromptRuntime, previewMode, workspaceId]
  );

  const editQueuedPrompt = useCallback(
    (queuedPromptId: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (previewMode || !agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      const queuedPrompt = agentQueuedPromptRuntime.removePrompt({
        workspaceId,
        agentSessionId,
        promptId: normalizedQueuedPromptId
      });
      if (!queuedPrompt) {
        return;
      }
      setDraftBySessionId((current) => ({
        ...current,
        [agentSessionId]: agentPromptContentToComposerDraft(
          queuedPrompt.content,
          `restore-${queuedPrompt.id}`
        )
      }));
    },
    [agentQueuedPromptRuntime, previewMode, workspaceId]
  );

  const sendQueuedPromptNext = useCallback(
    (queuedPromptId: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (previewMode || !agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      agentQueuedPromptRuntime.promotePrompt({
        workspaceId,
        agentSessionId,
        promptId: normalizedQueuedPromptId
      });
    },
    [agentQueuedPromptRuntime, previewMode, workspaceId]
  );

  const removeProject = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      const remove = agentHostApi.userProjects?.remove;
      if (!normalizedPath || !remove) {
        return;
      }
      setListError(null);
      // Filter the visible list only after the backend confirms the delete
      // (mirroring registerProjectPath's "backend confirm -> local store
      // update" ordering). Filtering optimistically before the delete
      // resolves would flip userProjectPathKey early and race the runtime
      // rail sections refetch against the in-flight backend delete: if the
      // section list query lands before the delete commits, it still
      // reports the removed project's section, and nothing re-triggers a
      // refetch afterwards, so the row stays visible until an unrelated
      // remount forces a fresh fetch.
      const handleRemoveError = (error: unknown) => {
        const message = getAgentGUIErrorMessage(error);
        setListError(message);
        toast.error(message);
      };
      try {
        void Promise.resolve(remove({ path: normalizedPath }))
          .then(() => {
            setUserProjectsSnapshot(
              userProjectsRef.current.filter(
                (project) => project.path !== normalizedPath
              )
            );
          })
          .catch(handleRemoveError);
      } catch (error) {
        handleRemoveError(error);
      }
    },
    [agentHostApi.userProjects, setUserProjectsSnapshot]
  );

  const requestDeleteProjectConversations = useCallback(
    (path: string) => {
      const normalizedPath = normalizeProjectConversationPath(path);
      if (!normalizedPath || isDeletingProjectConversations) {
        return;
      }
      const targetConversations = conversationsRef.current.filter(
        (conversation) =>
          normalizeProjectConversationPath(
            resolveAgentGUIConversationProject(
              conversation.cwd,
              userProjectsRef.current,
              { isNoProjectPath: isNoProjectPathRef.current }
            )?.path
          ) === normalizedPath
      );
      if (targetConversations.length === 0) {
        return;
      }
      const project = userProjectsRef.current.find(
        (candidate) =>
          normalizeProjectConversationPath(candidate.path) === normalizedPath
      );
      setPendingDeleteProjectConversations({
        conversationCount: targetConversations.length,
        label: project?.label?.trim() || path,
        path: normalizedPath
      });
      setDetailError(null);
      setListError(null);
    },
    [isDeletingProjectConversations]
  );

  const cancelDeleteProjectConversations = useCallback(() => {
    if (isDeletingProjectConversations) {
      return;
    }
    setPendingDeleteProjectConversations(null);
  }, [isDeletingProjectConversations]);

  const confirmDeleteConversation = useCallback(() => {
    const target = pendingDeleteConversation;
    if (!target || isDeletingConversation) {
      return;
    }
    setIsDeletingConversation(true);
    setDetailError(null);
    if (activeConversationIdRef.current === target.id) {
      clearSelectedConversationNotFoundRetry();
      setIsLoadingMessages(true);
      setAgentSessionViewMessagesLoading(sessionViewRef(target.id), true);
    }
    void activation
      .unactivate(target.id)
      .then(() =>
        agentActivityRuntime.deleteSession({
          workspaceId,
          agentSessionId: target.id
        })
      )
      .then(() => {
        activatedConversationIdsRef.current.delete(target.id);
        if (conversationListQuery) {
          markLocalDeletedAgentGUIConversation({
            query: conversationListQuery,
            agentSessionId: target.id
          });
          scheduleAgentGUIConversationListProjection(
            conversationListQuery,
            "local-delete"
          );
        }
        setTransientConversation((current) =>
          current?.id === target.id ? null : current
        );
        setDraftBySessionId((current) => {
          const next = { ...current };
          delete next[target.id];
          return next;
        });
        agentQueuedPromptRuntime.cleanupSession({
          workspaceId,
          agentSessionId: target.id
        });
        deleteAgentSessionView(sessionViewRef(target.id));
        const currentConversations = conversationsRef.current;
        const targetIndex = currentConversations.findIndex(
          (conversation) => conversation.id === target.id
        );
        const nextConversations = currentConversations.filter(
          (conversation) => conversation.id !== target.id
        );
        if (activeConversationIdRef.current === target.id) {
          const nextActive =
            nextConversations[Math.max(0, targetIndex)]?.id ??
            nextConversations[Math.max(0, targetIndex - 1)]?.id ??
            null;
          if (nextActive) {
            markSelectedConversationDetailPending(nextActive);
            setIntent({ tag: "active", id: nextActive });
          } else {
            clearSelectedConversationNotFoundRetry();
            setIsLoadingMessages(false);
            setIntent({ tag: "home" });
          }
          activeConversationIdRef.current = nextActive;
          setActiveConversationId(nextActive);
          persistActiveConversation(nextActive);
        }
        removeConversations([target.id]);
        setPendingDeleteConversation(null);
      })
      .catch((error) => {
        const message = getAgentGUIErrorMessage(error);
        reportAgentGUIRuntimeError({
          agentSessionId: target.id,
          error,
          phase: "delete_conversation",
          provider: target.provider,
          runtime: agentActivityRuntime,
          workspaceId
        });
        toast.error(message);
        setDetailError(message);
        if (activeConversationIdRef.current === target.id) {
          setIsLoadingMessages(false);
          setAgentSessionViewMessagesLoading(sessionViewRef(target.id), false);
        }
      })
      .finally(() => {
        setIsDeletingConversation(false);
      });
  }, [
    activation,
    conversationListQuery,
    isDeletingConversation,
    pendingDeleteConversation,
    clearSelectedConversationNotFoundRetry,
    markSelectedConversationDetailPending,
    persistActiveConversation,
    workspaceId,
    sessionViewRef,
    agentActivityRuntime,
    agentQueuedPromptRuntime,
    removeConversations
  ]);

  // Shared local-state cleanup after a batch of conversations has been deleted
  // on the daemon. Used by both the per-project and per-conversations-section
  // batch delete so they stay behaviourally identical.
  const finalizeConversationBatchDeletion = useCallback(
    (targetIds: Set<string>) => {
      for (const id of targetIds) {
        activatedConversationIdsRef.current.delete(id);
        deleteAgentSessionView(sessionViewRef(id));
      }
      if (conversationListQuery) {
        for (const id of targetIds) {
          markLocalDeletedAgentGUIConversation({
            query: conversationListQuery,
            agentSessionId: id
          });
        }
        scheduleAgentGUIConversationListProjection(
          conversationListQuery,
          "local-delete"
        );
      }
      setTransientConversation((current) =>
        current && targetIds.has(current.id) ? null : current
      );
      setDraftBySessionId((current) =>
        omitConversationLocalState(current, targetIds)
      );
      for (const id of targetIds) {
        agentQueuedPromptRuntime.cleanupSession({
          workspaceId,
          agentSessionId: id
        });
      }
      const nextConversations = conversationsRef.current.filter(
        (conversation) => !targetIds.has(conversation.id)
      );
      const currentActiveId = activeConversationIdRef.current;
      if (currentActiveId && targetIds.has(currentActiveId)) {
        const nextActive = nextConversations[0]?.id ?? null;
        if (nextActive) {
          markSelectedConversationDetailPending(nextActive);
          setIntent({ tag: "active", id: nextActive });
        } else {
          clearSelectedConversationNotFoundRetry();
          setIsLoadingMessages(false);
          setIntent({ tag: "home" });
        }
        activeConversationIdRef.current = nextActive;
        setActiveConversationId(nextActive);
        persistActiveConversation(nextActive);
      }
      removeConversations([...targetIds]);
    },
    [
      conversationListQuery,
      clearSelectedConversationNotFoundRetry,
      markSelectedConversationDetailPending,
      persistActiveConversation,
      agentQueuedPromptRuntime,
      sessionViewRef,
      setTransientConversation,
      workspaceId,
      removeConversations
    ]
  );

  const confirmDeleteProjectConversations = useCallback(
    (path?: string) => {
      const normalizedPath = normalizeProjectConversationPath(path);
      const target =
        normalizedPath !== ""
          ? {
              conversationCount: conversationsRef.current.filter(
                (conversation) =>
                  normalizeProjectConversationPath(
                    resolveAgentGUIConversationProject(
                      conversation.cwd,
                      userProjectsRef.current,
                      { isNoProjectPath: isNoProjectPathRef.current }
                    )?.path
                  ) === normalizedPath
              ).length,
              label:
                userProjectsRef.current.find(
                  (project) =>
                    normalizeProjectConversationPath(project.path) ===
                    normalizedPath
                )?.label ??
                path ??
                normalizedPath,
              path: normalizedPath
            }
          : pendingDeleteProjectConversations;
      if (!target || isDeletingProjectConversations) {
        return;
      }
      const targetConversations = conversationsRef.current.filter(
        (conversation) =>
          normalizeProjectConversationPath(
            resolveAgentGUIConversationProject(
              conversation.cwd,
              userProjectsRef.current,
              { isNoProjectPath: isNoProjectPathRef.current }
            )?.path
          ) === target.path
      );
      if (targetConversations.length === 0) {
        setPendingDeleteProjectConversations(null);
        return;
      }
      const targetIds = new Set(
        targetConversations.map((conversation) => conversation.id)
      );
      setIsDeletingProjectConversations(true);
      setDetailError(null);
      setListError(null);
      const activeDeletedConversationId = activeConversationIdRef.current;
      if (
        activeDeletedConversationId &&
        targetIds.has(activeDeletedConversationId)
      ) {
        clearSelectedConversationNotFoundRetry();
        setIsLoadingMessages(true);
        setAgentSessionViewMessagesLoading(
          sessionViewRef(activeDeletedConversationId),
          true
        );
      }
      void Promise.all(
        targetConversations.map(async (conversation) => {
          await activation.unactivate(conversation.id);
          await agentActivityRuntime.deleteSession({
            workspaceId,
            agentSessionId: conversation.id
          });
        })
      )
        .then(() => {
          finalizeConversationBatchDeletion(targetIds);
          setPendingDeleteProjectConversations(null);
        })
        .catch((error) => {
          const message = getAgentGUIErrorMessage(error);
          reportAgentGUIRuntimeError({
            error,
            phase: "delete_conversation",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId,
            context: {
              projectPath: target.path,
              conversationCount: targetConversations.length
            }
          });
          setListError(message);
          toast.error(message);
          setDetailError(message);
          if (
            activeDeletedConversationId &&
            activeConversationIdRef.current === activeDeletedConversationId
          ) {
            setIsLoadingMessages(false);
            setAgentSessionViewMessagesLoading(
              sessionViewRef(activeDeletedConversationId),
              false
            );
          }
        })
        .finally(() => {
          setIsDeletingProjectConversations(false);
        });
    },
    [
      activation,
      agentActivityRuntime,
      conversationListQuery,
      clearSelectedConversationNotFoundRetry,
      finalizeConversationBatchDeletion,
      isDeletingProjectConversations,
      markSelectedConversationDetailPending,
      pendingDeleteProjectConversations,
      persistActiveConversation,
      sessionViewRef,
      setTransientConversation,
      removeConversations,
      workspaceId
    ]
  );

  // Batch-delete every conversation in the ungrouped "conversations" section,
  // mirroring the per-project batch delete. The view passes the section's
  // conversation ids; we map them to live conversation records, delete each on
  // the daemon, then reuse the shared local cleanup.
  const confirmDeleteConversations = useCallback(
    (agentSessionIds: string[]) => {
      if (isDeletingProjectConversations) {
        return;
      }
      const targetIds = new Set(
        agentSessionIds.map((id) => id.trim()).filter((id) => id !== "")
      );
      const targetConversations = conversationsRef.current.filter(
        (conversation) => targetIds.has(conversation.id)
      );
      if (targetConversations.length === 0) {
        return;
      }
      setIsDeletingProjectConversations(true);
      setDetailError(null);
      setListError(null);
      const activeDeletedConversationId = activeConversationIdRef.current;
      if (
        activeDeletedConversationId &&
        targetIds.has(activeDeletedConversationId)
      ) {
        clearSelectedConversationNotFoundRetry();
        setIsLoadingMessages(true);
        setAgentSessionViewMessagesLoading(
          sessionViewRef(activeDeletedConversationId),
          true
        );
      }
      void Promise.all(
        targetConversations.map(async (conversation) => {
          await activation.unactivate(conversation.id);
          await agentActivityRuntime.deleteSession({
            workspaceId,
            agentSessionId: conversation.id
          });
        })
      )
        .then(() => {
          finalizeConversationBatchDeletion(targetIds);
        })
        .catch((error) => {
          const message = getAgentGUIErrorMessage(error);
          reportAgentGUIRuntimeError({
            error,
            phase: "delete_conversation",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId,
            context: {
              conversationCount: targetConversations.length
            }
          });
          setListError(message);
          toast.error(message);
          setDetailError(message);
          if (
            activeDeletedConversationId &&
            activeConversationIdRef.current === activeDeletedConversationId
          ) {
            setIsLoadingMessages(false);
            setAgentSessionViewMessagesLoading(
              sessionViewRef(activeDeletedConversationId),
              false
            );
          }
        })
        .finally(() => {
          setIsDeletingProjectConversations(false);
        });
    },
    [
      activation,
      agentActivityRuntime,
      clearSelectedConversationNotFoundRetry,
      finalizeConversationBatchDeletion,
      isDeletingProjectConversations,
      sessionViewRef,
      workspaceId
    ]
  );

  const toggleConversationPinned = useCallback(
    (agentSessionId: string, pinned: boolean) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId) {
        return;
      }
      setDetailError(null);
      const previousConversations = conversationsRef.current;
      const optimisticPinnedAtUnixMs = pinned ? Date.now() : null;
      patchConversation(normalizedAgentSessionId, {
        pinnedAtUnixMs: optimisticPinnedAtUnixMs
      });
      setTransientConversation((current) =>
        current?.id === normalizedAgentSessionId
          ? { ...current, pinnedAtUnixMs: optimisticPinnedAtUnixMs }
          : current
      );
      void agentActivityRuntime
        .setSessionPinned({
          workspaceId,
          agentSessionId: normalizedAgentSessionId,
          pinned
        })
        .then((session) => {
          const pinnedAtUnixMs = session.pinnedAtUnixMs ?? null;
          patchConversation(normalizedAgentSessionId, { pinnedAtUnixMs });
          setTransientConversation((current) =>
            current?.id === normalizedAgentSessionId
              ? { ...current, pinnedAtUnixMs }
              : current
          );
        })
        .catch((error) => {
          const message = getAgentGUIErrorMessage(error);
          reportAgentGUIRuntimeError({
            agentSessionId: normalizedAgentSessionId,
            context: { pinned },
            error,
            phase: "toggle_conversation_pinned",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId
          });
          toast.error(message);
          setDetailError(message);
          // Targeted revert of just this conversation's pin (rather than the
          // whole-list restore the arbitrary updater allowed), so a concurrent
          // update to another conversation is not clobbered on pin failure.
          const previous = previousConversations.find(
            (conversation) => conversation.id === normalizedAgentSessionId
          );
          patchConversation(normalizedAgentSessionId, {
            pinnedAtUnixMs: previous?.pinnedAtUnixMs ?? null
          });
          setTransientConversation((current) =>
            current?.id === normalizedAgentSessionId && previous
              ? previous
              : current
          );
        });
    },
    [agentActivityRuntime, patchConversation, workspaceId]
  );

  const activeConversation = useMemo(() => {
    const resolved = resolveConversationSummaryById(
      conversations,
      activeConversationId,
      transientConversationRef.current
    );
    if (resolved) {
      const pendingTurnId = pendingTurnIdBySessionIdRef.current[resolved.id];
      const activityBusyStatus =
        conversationBusyStatusFromAgentActivityDisplayStatus(
          agentActivityDisplayStatuses.get(resolved.id)
        );
      const status =
        activityBusyStatus ??
        (resolved.status === "ready" && pendingTurnId
          ? ("working" as const)
          : resolved.status);
      const nextConversation =
        status === resolved.status ? resolved : { ...resolved, status };
      return mergeConversationSummaryWithRuntimeSession({
        conversation: nextConversation,
        runtimeSyncState: stableRuntimeSyncStateBySessionId[resolved.id]
      });
    }
    if (!activeConversationId) {
      return resolved;
    }
    const providerLabel =
      AGENT_PROVIDER_LABEL[data.provider] ?? data.provider ?? "Agent";
    const fallbackStatus =
      isSubmitting ||
      isCreatingConversation ||
      Object.prototype.hasOwnProperty.call(
        draftBySessionId,
        activeConversationId
      )
        ? ("working" as const)
        : ("ready" as const);
    const activityBusyStatus =
      conversationBusyStatusFromAgentActivityDisplayStatus(
        agentActivityDisplayStatuses.get(activeConversationId)
      );
    const fallbackUpdatedAtUnixMs = Date.now();
    return {
      id: activeConversationId,
      userId: currentUserId?.trim() || undefined,
      provider: data.provider,
      title: providerLabel,
      titleFallback: null,
      status: activityBusyStatus ?? fallbackStatus,
      cwd: workspacePath,
      project: resolveAgentGUIConversationProject(workspacePath, userProjects, {
        isNoProjectPath
      }),
      sortTimeUnixMs: fallbackUpdatedAtUnixMs,
      updatedAtUnixMs: fallbackUpdatedAtUnixMs,
      syncState: undefined
    };
  }, [
    activeConversationId,
    agentActivityDisplayStatuses,
    conversations,
    currentUserId,
    data.provider,
    draftBySessionId,
    isCreatingConversation,
    isSubmitting,
    isNoProjectPath,
    stableRuntimeSyncStateBySessionId,
    transientConversation,
    userProjects,
    workspacePath
  ]);
  // Keep the node-level composer target aligned with the conversation the user
  // activated: the composer chip must show the session's own provider/target,
  // not whatever target was last selected in the home composer.
  useEffect(() => {
    if (previewMode || providerTargetsLoading || !activeConversationId) {
      return;
    }
    const summary = resolveConversationSummaryById(
      conversations,
      activeConversationId,
      transientConversationRef.current
    );
    if (!summary || summary.provider === "unknown") {
      return;
    }
    const summaryAgentTargetId = normalizeOptionalText(summary.agentTargetId);
    const providerMismatch = dataRef.current.provider !== summary.provider;
    const agentTargetMismatch =
      summaryAgentTargetId !== null &&
      normalizeOptionalText(dataRef.current.agentTargetId) !==
        summaryAgentTargetId;
    if (!providerMismatch && !agentTargetMismatch) {
      return;
    }
    const sessionTarget = resolveAgentGUIProviderTarget({
      agentTargetId: summaryAgentTargetId,
      defaultProviderTargetId,
      provider: summary.provider,
      providerTargets: normalizedProviderTargets,
      useStaticCatalog: shouldUseStaticProviderTargets
    });
    if (!sessionTarget || sessionTarget.provider !== summary.provider) {
      return;
    }
    if (
      !providerMismatch &&
      summaryAgentTargetId !== null &&
      (sessionTarget.agentTargetId?.trim() ?? "") !== summaryAgentTargetId
    ) {
      // The session's own target is not resolvable and the provider already
      // matches — do not replace an explicit target with a guessed fallback.
      return;
    }
    setHomeComposerTargetOverride(null);
    const sessionTargetIsExplicit = normalizedExplicitProviderTargets.some(
      (target) =>
        target.provider === sessionTarget.provider &&
        target.targetId === sessionTarget.targetId &&
        agentGUIProviderTargetRefsEqual(target.ref, sessionTarget.ref)
    );
    onDataChangeRef.current((current) => {
      const targetData = composerTargetDataFromProviderTarget({
        current,
        isExplicit: sessionTargetIsExplicit,
        target: sessionTarget
      });
      if (
        current.provider === targetData.provider &&
        normalizeOptionalText(current.agentTargetId) ===
          targetData.agentTargetId &&
        (current.providerTargetId ?? null) === targetData.providerTargetId &&
        agentGUIProviderTargetRefsEqual(
          current.providerTargetRef,
          targetData.providerTargetRef
        )
      ) {
        return current;
      }
      dataRef.current = targetData.data;
      return targetData.data;
    });
  }, [
    activeConversationId,
    conversations,
    defaultProviderTargetId,
    normalizedExplicitProviderTargets,
    normalizedProviderTargets,
    previewMode,
    providerTargetsLoading,
    shouldUseStaticProviderTargets
  ]);
  const visibleConversationsRef = useRef<AgentGUIConversationSummary[] | null>(
    null
  );
  const visibleConversations = useMemo(() => {
    const transient = transientConversationRef.current;
    const source =
      transient &&
      (isLoadingConversations ||
        explicitlyOpenedConversationIdsRef.current.has(transient.id) ||
        railPinnedTransientConversationIdsRef.current.has(transient.id))
        ? mergeVisibleConversations(conversations, transient)
        : conversations;
    const mapped = source.map((conversation) => {
      const withRuntime = mergeConversationSummaryWithRuntimeSession({
        conversation,
        runtimeSyncState: stableRuntimeSyncStateBySessionId[conversation.id]
      });
      const activityBusyStatus =
        conversationBusyStatusFromAgentActivityDisplayStatus(
          agentActivityDisplayStatuses.get(conversation.id)
        );
      return activityBusyStatus && withRuntime.status !== activityBusyStatus
        ? { ...withRuntime, status: activityBusyStatus }
        : withRuntime;
    });
    // Derive project (cwd × userProjects) here in the per-window view-model
    // layer. This is the JOIN that previously got written back into the shared
    // conversation store (causing cross-window update storms); computing it in
    // this local useMemo keeps the canonical store project-free while exposing a
    // resolved `project` to the view and view-model consumers.
    const next = applyAgentGUIConversationProjects(mapped, userProjects, {
      isNoProjectPath
    });
    const stableNext = stableConversationSummaryList(
      visibleConversationsRef.current,
      next
    );
    visibleConversationsRef.current = stableNext;
    return stableNext;
  }, [
    agentActivityDisplayStatuses,
    conversations,
    isNoProjectPath,
    stableRuntimeSyncStateBySessionId,
    transientConversation,
    userProjects
  ]);
  const conversationUserIds = useMemo(
    () =>
      [
        ...new Set(
          conversations
            .map((conversation) => conversation.userId?.trim() ?? "")
            .filter(Boolean)
        )
      ].sort(),
    [conversations]
  );

  useEffect(() => {
    if (conversationUserIds.length === 0) {
      return;
    }
    ensureAccountProfiles({ userIds: conversationUserIds }).catch(
      () => undefined
    );
  }, [conversationUserIds, ensureAccountProfiles]);
  const projectionConversationRef =
    useRef<AgentGUIConversationProjectionSource | null>(null);
  const projectionConversation =
    useMemo<AgentGUIConversationProjectionSource | null>(() => {
      if (!activeConversation) {
        projectionConversationRef.current = null;
        return null;
      }
      const previous = projectionConversationRef.current;
      const turnLifecycle =
        activeSessionState?.agentSessionId === activeConversation.id
          ? (activeSessionState.turnLifecycle ?? null)
          : null;
      if (
        previous &&
        previous.id === activeConversation.id &&
        previous.userId === activeConversation.userId &&
        previous.provider === activeConversation.provider &&
        previous.title === activeConversation.title &&
        previous.titleFallback === activeConversation.titleFallback &&
        previous.status === activeConversation.status &&
        previous.cwd === activeConversation.cwd &&
        (previous.turnLifecycle?.activeTurnId ?? null) ===
          (turnLifecycle?.activeTurnId ?? null) &&
        (previous.turnLifecycle?.phase ?? null) ===
          (turnLifecycle?.phase ?? null) &&
        (previous.turnLifecycle?.settling ?? false) ===
          (turnLifecycle?.settling ?? false)
      ) {
        return previous;
      }
      const next = activeConversation
        ? {
            id: activeConversation.id,
            userId: activeConversation.userId,
            provider: activeConversation.provider,
            title: activeConversation.title,
            titleFallback: activeConversation.titleFallback,
            status: activeConversation.status,
            cwd: activeConversation.cwd,
            updatedAtUnixMs: activeConversation.updatedAtUnixMs,
            syncState: activeConversation.syncState,
            turnLifecycle
          }
        : null;
      projectionConversationRef.current = next;
      return next;
    }, [
      // Keep projection stable for summary-only sync/updatedAt patches; the timeline itself drives
      // detail freshness, and rebuilding the projection here was the hot idle path in long sessions.
      activeConversation?.cwd,
      activeConversation?.id,
      activeConversation?.provider,
      activeConversation?.status,
      activeConversation?.title,
      activeConversation?.titleFallback,
      activeConversation?.userId,
      activeSessionState?.agentSessionId,
      activeSessionState?.turnLifecycle?.activeTurnId,
      activeSessionState?.turnLifecycle?.phase,
      activeSessionState?.turnLifecycle?.settling
    ]);
  const draftContent = activeConversationId
    ? (draftBySessionId[activeConversationId] ?? EMPTY_AGENT_COMPOSER_DRAFT)
    : readNodeDefaultDraftContent({
        data: selectedComposerTargetData.data,
        drafts: draftBySessionId
      });
  const draftPrompt = draftContent.prompt;
  const availableCommands =
    activeSessionView?.controlCommands ?? EMPTY_AGENT_GUI_AVAILABLE_COMMANDS;
  const availableSkills = useStableProviderSkillOptions(
    useMemo(
      () => providerSkillsFromComposerOptions(providerComposerOptions),
      [providerComposerOptions]
    )
  );
  const conversationModels = useMemo(
    () =>
      projectionConversation
        ? buildAgentGUIConversationModels({
            timelineItems: activeTimelineItems,
            conversation: projectionConversation,
            workspaceRoot: workspacePath,
            avoidGroupingEdits
          })
        : { conversation: null, detail: null },
    [
      activeTimelineItems,
      avoidGroupingEdits,
      projectionConversation,
      workspacePath
    ]
  );
  const conversationDetail = useStableConversationDetail(
    conversationModels.detail
  );
  const conversation = useMemo<AgentConversationVM | null>(() => {
    if (!conversationModels.conversation) {
      return null;
    }
    if (
      conversationDetail &&
      (conversationModels.conversation.sourceDetail !== conversationDetail ||
        conversationModels.conversation.activity !==
          conversationDetail.activity)
    ) {
      return {
        ...conversationModels.conversation,
        activity: conversationDetail.activity,
        sourceDetail: conversationDetail
      };
    }
    return conversationModels.conversation;
  }, [conversationDetail, conversationModels.conversation]);
  useEffect(() => {
    if (!activeConversationId || !conversation) {
      lastConversationProjectionDiagnosticKeyRef.current = null;
      return;
    }
    const firstVersion = minFiniteMessageVersion(activeMessages);
    const lastVersion = maxFiniteMessageVersion(activeMessages);
    const diagnosticKey = [
      activeConversationId,
      activeMessages.length,
      activeTimelineItems.length,
      conversation.sourceDetail.turns.length,
      conversation.rows.length,
      firstVersion ?? "",
      lastVersion ?? "",
      activeSessionView?.hasOlderMessages === true ? "1" : "0",
      activeSessionView?.isLoadingOlderMessages === true ? "1" : "0"
    ].join(":");
    if (lastConversationProjectionDiagnosticKeyRef.current === diagnosticKey) {
      return;
    }
    lastConversationProjectionDiagnosticKeyRef.current = diagnosticKey;
    reportAgentGUIMessagePageDiagnostic({
      agentSessionId: activeConversationId,
      details: {
        detailMessageCount: activeSessionView?.detailMessages.length ?? 0,
        hasOlderMessages: activeSessionView?.hasOlderMessages ?? false,
        isLoadingOlderMessages:
          activeSessionView?.isLoadingOlderMessages ?? false,
        oldestLoadedVersion: activeSessionView?.oldestLoadedVersion ?? null,
        overlayMessageCount: activeSessionView?.overlayMessages.length ?? 0,
        rowCount: conversation.rows.length,
        timelineItemCount: activeTimelineItems.length,
        turnCount: conversation.sourceDetail.turns.length
      },
      event: "agent.gui.conversation.projection.resolved",
      level: "debug",
      messages: activeMessages,
      runtime: agentActivityRuntime,
      workspaceId
    });
  }, [
    activeConversationId,
    activeMessages,
    activeSessionView?.detailMessages.length,
    activeSessionView?.hasOlderMessages,
    activeSessionView?.isLoadingOlderMessages,
    activeSessionView?.oldestLoadedVersion,
    activeSessionView?.overlayMessages.length,
    activeTimelineItems,
    agentActivityRuntime,
    conversation,
    workspaceId
  ]);
  const activeLiveState = activeConversationLiveState;
  const activationError = activation.errorFor(activeConversationId);
  const activationErrorCode = activation.codeFor(activeConversationId);
  const hasProviderSessionNotFoundError =
    isNonRetryableResumeErrorCode(activationErrorCode);
  const activeStatePatchError =
    activeConversationId !== null
      ? (statePatchErrorBySessionId[activeConversationId] ?? null)
      : null;

  useEffect(() => {
    if (
      activeConversationId !== null &&
      activeConversation?.status === "failed" &&
      activeStatePatchError &&
      detailError === null
    ) {
      setDetailError(activeStatePatchError);
    }
  }, [
    activeConversation?.status,
    activeConversationId,
    activeStatePatchError,
    detailError
  ]);

  const rawPendingApproval = useMemo(
    () =>
      interactiveApprovalFromSessionState(activeSessionState) ??
      approvalRequestFromConversation(conversation),
    [activeSessionState, conversation]
  );
  const rawPendingInteractivePrompt = useMemo<AgentGUIInteractivePrompt | null>(
    () =>
      interactivePromptFromSessionState(activeSessionState) ??
      interactivePromptFromConversation(conversation),
    [activeSessionState, conversation]
  );
  const activeRawPromptRequestId =
    promptRequestId(rawPendingInteractivePrompt) ??
    promptRequestId(rawPendingApproval);
  const suppressedPromptRequestId =
    activeConversationId !== null
      ? (suppressedPromptRequestIdsBySessionId[activeConversationId] ?? null)
      : null;
  const isActivePromptSuppressed =
    activeRawPromptRequestId !== null &&
    activeRawPromptRequestId === suppressedPromptRequestId;

  useEffect(() => {
    activePendingPromptRef.current =
      activeConversationId !== null && activeRawPromptRequestId !== null
        ? {
            sessionId: activeConversationId,
            requestId: activeRawPromptRequestId,
            kind: rawPendingInteractivePrompt?.kind ?? null
          }
        : null;
  }, [
    activeConversationId,
    activeRawPromptRequestId,
    rawPendingInteractivePrompt
  ]);

  useEffect(() => {
    if (activeConversationId === null || suppressedPromptRequestId === null) {
      return;
    }
    if (activeRawPromptRequestId === suppressedPromptRequestId) {
      return;
    }
    setSuppressedPromptRequestIdsBySessionId((current) => {
      if (current[activeConversationId] !== suppressedPromptRequestId) {
        return current;
      }
      const next = { ...current };
      delete next[activeConversationId];
      return next;
    });
  }, [
    activeConversationId,
    activeRawPromptRequestId,
    suppressedPromptRequestId
  ]);

  const pendingApproval =
    hasProviderSessionNotFoundError || isActivePromptSuppressed
      ? null
      : rawPendingApproval;
  const serverInteractivePrompt =
    hasProviderSessionNotFoundError || isActivePromptSuppressed
      ? null
      : rawPendingInteractivePrompt;
  const isInterrupting =
    activeConversationId !== null &&
    Boolean(interruptingSessionIds[activeConversationId]);
  // A cancel was requested but raced session startup; it will fire once the
  // session connects. Surfaced so the connecting indicator can read "cancelling".
  const isCancelPending =
    activeConversationId !== null &&
    Boolean(pendingInterruptSessionIds[activeConversationId]);
  const queuedPrompts = activeConversationId ? [...activeQueuedPrompts] : [];
  const drainingQueuedPromptId = activeQueuedPromptClaim?.promptId ?? null;
  const sessionSettings = useStableComposerSettings(
    cloneComposerSettings(activeSessionState?.settings ?? null)
  );
  const storedNodeDefaultSettings = useStableComposerSettings(
    readNodeDefaultDraftSettings({
      data:
        activeConversationId === null ? selectedComposerTargetData.data : data,
      defaultReasoningEffort,
      drafts: draftSettingsBySessionId
    })
  );
  const targetSafeNodeDefaultSettings = useStableComposerSettings(
    activeConversationId === null
      ? sanitizeComposerSettingsForTarget({
          settings: storedNodeDefaultSettings,
          target: selectedComposerTargetData,
          options: providerComposerOptions
        })
      : storedNodeDefaultSettings
  );
  const homeComposerSettings = useStableComposerSettings(
    resolveEffectiveComposerSettings({
      settings: targetSafeNodeDefaultSettings
    })
  );
  useEffect(() => {
    if (
      activeConversationId !== null ||
      !selectedComposerTargetData.agentTargetId ||
      !providerComposerOptions ||
      sameComposerSettings(
        storedNodeDefaultSettings,
        targetSafeNodeDefaultSettings
      )
    ) {
      return;
    }
    const targetDefaultDraftKey = nodeDefaultDraftKey(
      selectedComposerTargetData.provider,
      selectedComposerTargetData.agentTargetId
    );
    draftSettingsBySessionIdRef.current = {
      ...draftSettingsBySessionIdRef.current,
      [targetDefaultDraftKey]: targetSafeNodeDefaultSettings
    };
    setDraftSettingsBySessionId((current) => ({
      ...current,
      [targetDefaultDraftKey]: targetSafeNodeDefaultSettings
    }));
    onDataChangeRef.current((current) =>
      nodeDataFromComposerSettings(
        {
          ...current,
          provider: selectedComposerTargetData.provider,
          agentTargetId: selectedComposerTargetData.agentTargetId,
          providerTargetId: selectedComposerTargetData.providerTargetId,
          providerTargetRef: selectedComposerTargetData.providerTargetRef
        },
        targetSafeNodeDefaultSettings
      )
    );
    // Deliberately no onRememberComposerDefaults here: this sync only
    // reconciles drafts with target capabilities. The remembered defaults
    // must only change on explicit user switches, never via sanitization.
  }, [
    activeConversationId,
    providerComposerOptions,
    selectedComposerTargetData,
    storedNodeDefaultSettings,
    targetSafeNodeDefaultSettings
  ]);
  const activeConversationDraftSettings = activeConversationId
    ? (draftSettingsBySessionId[activeConversationId] ?? null)
    : null;
  const defaultConversationDraftSettings = useStableComposerSettings({
    ...(activeConversationDraftSettings ?? homeComposerSettings),
    permissionModeId:
      normalizePermissionModeId(activeSessionState?.permissionModeId) ??
      normalizePermissionModeId(
        (activeConversationDraftSettings ?? homeComposerSettings)
          .permissionModeId
      )
  });
  const draftSettings = activeConversationId
    ? (sessionSettings ?? defaultConversationDraftSettings)
    : homeComposerSettings;
  const persistedDraftModel = normalizeOptionalText(draftSettings.model);
  // "default" is Claude Code's own placeholder for "no explicit model
  // pinned" (claudeSDKModelConfigOption); an unset value normalizes to
  // null for every provider. Only in those "nothing meaningful persisted
  // yet" cases do we prefer the live app-server-reported current model
  // (kept fresh across an in-flight settings-refresh race, see the "keep
  // Claude model selection stable" fix). Once a session has a real,
  // concrete persisted model — e.g. one carried over from an imported
  // conversation (2U74Ri) — that value must win outright: it is the
  // authoritative source of what will actually run on the next turn, and
  // a live config option can legitimately lag or reflect a different
  // session's default while this one hasn't resumed yet.
  const usesPlaceholderDraftModel =
    persistedDraftModel === null || persistedDraftModel === "default";
  const liveConfigModel =
    activeConversationId !== null && usesPlaceholderDraftModel
      ? configOptionCurrentValue(activeSessionRuntimeContext, ["model"])
      : null;
  const draftModel = usesPlaceholderDraftModel
    ? (liveConfigModel ?? persistedDraftModel)
    : persistedDraftModel;
  const draftReasoningEffort = normalizeOptionalText(
    draftSettings.reasoningEffort
  ) as AgentSessionReasoningEffort | null;
  const draftSpeed = normalizeOptionalText(
    draftSettings.speed
  ) as AgentSessionSpeed | null;
  // The offer is derived from the same timeline data that renders the plan
  // card (the latest turn produced a plan item), gated on codex + plan mode
  // and a settled (non-working) conversation. No status-edge/runtimeContext
  // race; keyed by plan turn id so dismiss suppresses only that plan.
  const planImplementationTurnId =
    activeConversationId !== null &&
    dataRef.current.provider === "codex" &&
    composerSupport.plan &&
    Boolean(draftSettings.planMode) &&
    activeConversation?.status !== "working"
      ? latestPlanTurnId(activeTimelineItems)
      : null;
  planImplementationTurnIdRef.current = planImplementationTurnId;
  // Fold the codex plan decision into the unified interactive-prompt machinery
  // (server exit-plan wins if both somehow apply). Suppressed once skipped for
  // that plan turn; a fresh plan turn re-arms it.
  const planImplementationPromptVM =
    planImplementationTurnId !== null &&
    activeConversationId !== null &&
    dismissedPlanTurnIdBySessionId[activeConversationId] !==
      planImplementationTurnId
      ? planImplementationPromptFromPlanTurn(
          planImplementationTurnId,
          activeConversation?.title ?? ""
        )
      : null;
  const pendingInteractivePrompt =
    serverInteractivePrompt ?? planImplementationPromptVM;
  const activeRuntimeSession =
    runtimeSessionsBySessionId.get(activeConversationId ?? "") ?? null;
  useEffect(() => {
    const provider = normalizeOptionalText(
      activeRuntimeSession?.provider ?? activeConversation?.provider
    );
    if (provider === null) {
      return;
    }
    const model =
      normalizeOptionalText(activeSessionState?.settings?.model) ??
      normalizeOptionalText(activeRuntimeSession?.model);
    if (model === null) {
      return;
    }
    lastActiveModelByProviderRef.current = {
      ...lastActiveModelByProviderRef.current,
      [provider]: model
    };
  }, [
    activeConversation?.provider,
    activeRuntimeSession?.model,
    activeRuntimeSession?.provider,
    activeSessionState?.settings?.model
  ]);
  const activeActivityDisplayStatus = activeConversationId
    ? (agentActivityDisplayStatuses.get(activeConversationId) ?? null)
    : null;
  const activeHasPendingSubmittedTurn = activeConversationId
    ? Boolean(pendingTurnIdBySessionIdRef.current[activeConversationId])
    : false;
  // Derive from the turn lifecycle when present (ADR 0008); trust the wire
  // submitAvailability only for lifecycle-less control states.
  const activeSubmitBlocked = activeSessionState
    ? resolveSubmitAvailability(activeSessionState).state === "blocked"
    : false;
  const activeConversationBusy =
    agentActivityDisplayStatusBusy(activeActivityDisplayStatus) ||
    activeHasPendingSubmittedTurn ||
    activeSubmitBlocked;
  const activeSessionResumable =
    activeRuntimeSession?.resumable ??
    activeConversation?.resumable ??
    activeSessionState?.resumable;
  const normalizedActiveConversationId = activeConversationId ?? "";
  const activeConversationActivationState = activeConversationId
    ? activation.stateFor(activeConversationId)
    : null;
  const activeConversationRequiresResume =
    normalizedActiveConversationId !== "" &&
    !activatedConversationIdsRef.current.has(normalizedActiveConversationId) &&
    activeConversationActivationState !== "active";
  const activeConversationResumeUnavailable =
    activeConversationRequiresResume && activeSessionResumable === false;
  const hasSentUserMessage = activeTimelineItems.some(
    (item) => item.role === "user"
  );
  const sessionChrome = useMemo<AgentGUISessionChrome>(() => {
    const normalizedError = activationError?.trim() ?? "";
    const authState = activeSessionState?.authState?.trim() ?? "";
    const runtimeContext = activeSessionState?.runtimeContext ?? null;
    const authMessageFromRuntime =
      typeof runtimeContext?.authMessage === "string" &&
      runtimeContext.authMessage.trim()
        ? runtimeContext.authMessage.trim()
        : null;
    const isAuthError =
      !hasProviderSessionNotFoundError &&
      (authState !== "" ||
        (normalizedError !== "" &&
          /auth|sign in|log in|login|unauthorized|authenticated/i.test(
            normalizedError
          )));
    const recoveryMessage =
      normalizedError ||
      (activeConversationResumeUnavailable
        ? translate("messages.agentResumeSessionNotLocal")
        : "");
    const recoveryIsNonRetryable =
      isNonRetryableResumeErrorCode(activationErrorCode) ||
      activeConversationResumeUnavailable;
    return {
      auth: hasProviderSessionNotFoundError
        ? null
        : authState !== ""
          ? { message: authMessageFromRuntime ?? authState }
          : isAuthError
            ? { message: normalizedError }
            : null,
      approval: pendingApproval,
      recovery:
        activeLiveState === "activating" &&
        // Suppress the "reconnecting" banner during a first-message create:
        // the user just submitted and is already seeing their optimistic
        // message, so an activation-in-flight state on the conversation they
        // just entered is not a recovery event.
        startingConversationIdRef.current !== activeConversationId
          ? {
              kind: "activating",
              // i18n-check-ignore: Legacy recovery fallback copy; localized presentation should move to view labels.
              message: "Reconnecting to the live agent session…"
            }
          : !isAuthError && recoveryMessage
            ? {
                kind: "failed",
                message: recoveryMessage,
                canRetry: !recoveryIsNonRetryable,
                ...(isResumeSessionNotLocalErrorCode(activationErrorCode) ||
                activeConversationResumeUnavailable
                  ? { followupAction: "continue-in-new-conversation" as const }
                  : {})
              }
            : null,
      rawState: activeSessionState
    };
  }, [
    activationError,
    activationErrorCode,
    activeLiveState,
    activeConversationId,
    activeConversationResumeUnavailable,
    activeSessionState,
    hasProviderSessionNotFoundError,
    pendingApproval
  ]);
  const canSubmit =
    !providerTargetsLoading &&
    activeLiveState !== "activating" &&
    activeLiveState !== "failed" &&
    !activeConversationResumeUnavailable &&
    (activeConversationId !== null ||
      effectiveSelectedProviderTarget.disabled !== true) &&
    (composerTargetData.provider !== "openclaw" ||
      openclawGateway?.status === "ready") &&
    pendingApproval === null &&
    pendingInteractivePrompt === null &&
    sessionChrome.auth === null &&
    !isCreatingConversation &&
    !isSubmitting &&
    !isInterrupting;
  const canQueueWhileBusy =
    Boolean(activeConversationId) &&
    (activeConversationBusy ||
      isSubmitting ||
      Boolean(activeSessionState?.pendingInteractive));
  useEffect(() => {
    const firstVersion = minFiniteMessageVersion(activeMessages);
    const lastVersion = maxFiniteMessageVersion(activeMessages);
    const diagnosticKey = [
      activeConversationId ?? "",
      activeConversation?.status ?? "",
      activeActivityDisplayStatus ?? "",
      activeLiveState,
      activeRuntimeSession?.status ?? "",
      activeRuntimeSession?.turnLifecycle?.phase ?? "",
      activeRuntimeSession?.turnLifecycle?.outcome ?? "",
      activeRuntimeSession?.turnLifecycle?.activeTurnId ?? "",
      activeRuntimeSession?.submitAvailability?.state ?? "",
      activeRuntimeSession?.submitAvailability?.reason ?? "",
      activeSessionState?.status ?? "",
      activeSessionState?.turnLifecycle?.phase ?? "",
      activeSessionState?.turnLifecycle?.outcome ?? "",
      activeSessionState?.submitAvailability?.state ?? "",
      activeSessionState?.submitAvailability?.reason ?? "",
      activeConversationBusy ? "busy" : "ready",
      activeHasPendingSubmittedTurn ? "pending-turn" : "no-pending-turn",
      activeSubmitBlocked ? "submit-blocked" : "submit-open",
      pendingApproval?.requestId ?? "",
      promptRequestId(pendingInteractivePrompt) ?? "",
      conversation?.rows.length ?? "",
      conversation?.sourceDetail.turns.length ?? "",
      firstVersion ?? "",
      lastVersion ?? "",
      isCreatingConversation ? "creating" : "",
      isLoadingMessages ? "loading-messages" : "",
      isSubmitting ? "submitting" : "",
      canSubmit ? "can-submit" : "cannot-submit",
      canQueueWhileBusy ? "can-queue" : "cannot-queue"
    ].join(":");
    if (lastRenderStateDiagnosticKeyRef.current === diagnosticKey) {
      return;
    }
    lastRenderStateDiagnosticKeyRef.current = diagnosticKey;
    reportAgentGUIRenderStateDiagnostic({
      activeActivityDisplayStatus,
      activeConversation,
      activeConversationBusy,
      activeConversationId,
      activeHasPendingSubmittedTurn,
      activeLiveState,
      activeRuntimeSession,
      activeSessionState,
      activeSubmitBlocked,
      canQueueWhileBusy,
      canSubmit,
      conversation,
      isCreatingConversation,
      isLoadingMessages,
      isSubmitting,
      pendingApproval,
      pendingInteractivePrompt,
      runtime: agentActivityRuntime,
      workspaceId
    });
  }, [
    activeActivityDisplayStatus,
    activeConversation,
    activeConversationBusy,
    activeConversationId,
    activeHasPendingSubmittedTurn,
    activeLiveState,
    activeMessages,
    activeRuntimeSession,
    activeSessionState,
    activeSubmitBlocked,
    agentActivityRuntime,
    canQueueWhileBusy,
    canSubmit,
    conversation,
    isCreatingConversation,
    isLoadingMessages,
    isSubmitting,
    pendingApproval,
    pendingInteractivePrompt,
    providerTargetsLoading,
    workspaceId
  ]);
  const activeSessionReasoningSelection = useMemo(
    () =>
      reasoningSelectionFromComposerOptions(
        providerComposerOptions,
        draftReasoningEffort
      ),
    [draftReasoningEffort, providerComposerOptions]
  );
  const activeSessionModelSelection = useMemo(
    () =>
      modelSelectionFromComposerOptions(providerComposerOptions, draftModel),
    [draftModel, providerComposerOptions]
  );
  const activeSessionSpeedSelection = useMemo(
    () =>
      speedSelectionFromComposerOptions(providerComposerOptions, draftSpeed),
    [draftSpeed, providerComposerOptions]
  );
  const composerSettings = useMemo<AgentGUIComposerSettingsVM>(() => {
    const permissionConfig = permissionConfigFromComposerOptions(
      providerComposerOptions
    );
    const supportsPermissionMode = Boolean(
      permissionConfig?.configurable && permissionConfig.modes.length > 0
    );
    const hasOptionsSource = providerComposerOptions !== null;
    const hasACPSettings =
      hasOptionsSource &&
      (!composerSupport.model || activeSessionModelSelection !== null) &&
      (!composerSupport.reasoning || activeSessionReasoningSelection !== null);
    const isSettingsLoading = !hasACPSettings;
    const isModelOptionsLoading = isAppServerStartupLoading(
      activeSessionRuntimeContext,
      "models"
    );
    // Before the daemon's composer options arrive, the options-derived
    // `composerSupport` is all-false, which would hide every settings control
    // and leave an empty row. Fall back to the provider-static capabilities
    // while loading so the controls still render (disabled, with a loading
    // hint); once options load, the accurate options-derived flags take over.
    const optionsLoading = isSettingsLoading || isModelOptionsLoading;
    const providerSupport = composerSupportForProvider(
      composerTargetData.provider
    );
    const selectedModelValue = draftModel;
    const selectedReasoningEffortValue =
      draftReasoningEffort as AgentSessionReasoningEffort | null;
    const selectedSpeedValue = draftSpeed as AgentSessionSpeed | null;
    const selectedPermissionModeValue =
      normalizePermissionModeId(draftSettings.permissionModeId) ??
      normalizePermissionModeId(permissionConfig?.defaultValue);

    return {
      sessionSettings,
      draftSettings: {
        model: draftModel,
        reasoningEffort: draftReasoningEffort,
        speed: draftSpeed,
        planMode: Boolean(draftSettings.planMode),
        browserUse: draftSettings.browserUse ?? true,
        computerUse: draftSettings.computerUse ?? true,
        permissionModeId: normalizePermissionModeId(
          draftSettings.permissionModeId
        )
      },
      supportsModel:
        composerSupport.model || (optionsLoading && providerSupport.model),
      supportsReasoningEffort:
        composerSupport.reasoning ||
        (optionsLoading && providerSupport.reasoning),
      supportsSpeed: composerSupport.speed,
      supportsBrowser: composerSupport.browser,
      supportsComputerUse: composerSupport.computer,
      supportsPermissionMode:
        supportsPermissionMode ||
        (optionsLoading && providerSupport.permission),
      supportsPlanMode: composerSupport.plan,
      planExclusiveWithPermissionMode:
        composerTargetData.provider === "claude-code",
      isSettingsLoading,
      isModelOptionsLoading,
      modelUnavailable:
        activeConversationId !== null &&
        sessionSettings === null &&
        composerSupport.model &&
        draftModel === null,
      reasoningUnavailable:
        activeConversationId !== null &&
        sessionSettings === null &&
        composerSupport.reasoning &&
        draftReasoningEffort === null,
      speedUnavailable:
        activeConversationId !== null &&
        sessionSettings === null &&
        composerSupport.speed &&
        draftSpeed === null,
      permissionModeUnavailable:
        activeConversationId !== null &&
        sessionSettings === null &&
        supportsPermissionMode &&
        selectedPermissionModeValue === null,
      selectedModelValue,
      selectedReasoningEffortValue,
      selectedSpeedValue,
      selectedPermissionModeValue,
      permissionConfig,
      selectedProjectPath:
        activeConversationId !== null
          ? (activeConversation?.cwd ?? null)
          : selectedProjectPath,
      projectLocked: activeConversationId !== null,
      // Cursor's live list spans many vendors with several versions each;
      // collapse it to the latest release per model family.
      modelListCollapsedToLatest: composerTargetData.provider === "cursor",
      availableModels:
        composerSupport.model &&
        hasOptionsSource &&
        activeSessionModelSelection !== null
          ? activeSessionModelSelection.options
          : [],
      availableReasoningEfforts:
        composerSupport.reasoning &&
        hasOptionsSource &&
        activeSessionReasoningSelection !== null
          ? activeSessionReasoningSelection.options
          : [],
      availableSpeeds:
        composerSupport.speed &&
        hasOptionsSource &&
        activeSessionSpeedSelection !== null
          ? activeSessionSpeedSelection.options
          : [],
      availablePermissionModes: supportsPermissionMode
        ? permissionModeOptions(composerTargetData.provider, permissionConfig)
        : []
    };
  }, [
    activeConversationId,
    activeConversation?.cwd,
    activeSessionModelSelection,
    activeSessionReasoningSelection,
    activeSessionSpeedSelection,
    activeSessionRuntimeContext,
    composerTargetData.provider,
    draftSettings.permissionModeId,
    draftSettings.planMode,
    providerComposerOptions,
    sessionSettings,
    selectedProjectPath,
    composerSupport,
    draftModel,
    draftReasoningEffort,
    draftSpeed
  ]);
  const stableComposerSettings = useStableComposerSettingsVM(composerSettings);

  const resolveDefaultHomeComposerTarget =
    useCallback((): AgentGUIProviderTarget | null => {
      const defaultTargetId = defaultProviderTargetId?.trim() ?? "";
      const explicitDefaultTarget = defaultTargetId
        ? (normalizedProviderTargets.find(
            (target) =>
              target.targetId === defaultTargetId ||
              target.agentTargetId === defaultTargetId
          ) ?? null)
        : null;
      return (
        explicitDefaultTarget ??
        normalizedProviderTargets.find((target) => target.disabled !== true) ??
        normalizedProviderTargets[0] ??
        null
      );
    }, [defaultProviderTargetId, normalizedProviderTargets]);

  const resetHomeComposerAgentTargetToDefault = useCallback(() => {
    if (previewMode) {
      return;
    }
    const nextTarget = resolveDefaultHomeComposerTarget();
    if (!nextTarget) {
      return;
    }
    const nextTargetIsExplicit = normalizedExplicitProviderTargets.some(
      (target) =>
        target.provider === nextTarget.provider &&
        target.targetId === nextTarget.targetId &&
        agentGUIProviderTargetRefsEqual(target.ref, nextTarget.ref)
    );
    const nextTargetData = composerTargetDataFromProviderTarget({
      current: dataRef.current,
      isExplicit: nextTargetIsExplicit,
      target: nextTarget
    });
    setHomeComposerTargetOverride(nextTarget);
    setIntent({ tag: "home" });
    isComposerHomeRef.current = true;
    setIsComposerHome(true);
    onDataChangeRef.current((current) => {
      const currentNextTargetData = composerTargetDataFromProviderTarget({
        current,
        isExplicit: nextTargetIsExplicit,
        target: nextTarget
      });
      const nextData: AgentGUINodeData = {
        ...currentNextTargetData.data,
        lastActiveAgentSessionId: null
      };
      dataRef.current = nextData;
      return nextData;
    });
    dataRef.current = {
      ...nextTargetData.data,
      lastActiveAgentSessionId: null
    };
    if (nextTarget.disabled !== true) {
      loadComposerOptionsForTarget(nextTargetData, { force: true });
    }
  }, [
    loadComposerOptionsForTarget,
    normalizedExplicitProviderTargets,
    previewMode,
    resolveDefaultHomeComposerTarget
  ]);

  const updateConversationFilter = useCallback(
    (filter: AgentGUIConversationFilter) => {
      const nextFilter = normalizeAgentGUIConversationFilter(filter);
      setConversationFilter(nextFilter);
      if (
        nextFilter.kind === "all" &&
        activeConversationIdRef.current === null
      ) {
        resetHomeComposerAgentTargetToDefault();
      }
    },
    [resetHomeComposerAgentTargetToDefault]
  );
  const selectHomeComposerAgentTarget = useCallback(
    (input: {
      provider: AgentGUIProvider;
      providerTargetId?: string | null;
    }) => {
      if (previewMode) {
        return;
      }
      const nextProvider = input.provider;
      const nextTarget = resolveAgentGUIProviderTarget({
        defaultProviderTargetId,
        provider: nextProvider,
        providerTargetId: input.providerTargetId,
        providerTargets: normalizedProviderTargets,
        useStaticCatalog: shouldUseStaticProviderTargets
      });
      if (!nextTarget) {
        return;
      }
      const nextTargetIsExplicit = normalizedExplicitProviderTargets.some(
        (target) =>
          target.provider === nextTarget.provider &&
          target.targetId === nextTarget.targetId &&
          agentGUIProviderTargetRefsEqual(target.ref, nextTarget.ref)
      );
      const nextTargetData = composerTargetDataFromProviderTarget({
        current: dataRef.current,
        isExplicit: nextTargetIsExplicit,
        target: nextTarget
      });
      const shouldSyncScopedRailFilter =
        conversationFilterRef.current.kind === "agentTarget";
      setHomeComposerTargetOverride(nextTarget);
      if (shouldSyncScopedRailFilter) {
        const nextAgentTargetId = nextTarget.agentTargetId?.trim() ?? "";
        setConversationFilter(
          nextAgentTargetId
            ? { kind: "agentTarget", agentTargetId: nextAgentTargetId }
            : { kind: "all" }
        );
      }
      const previous = activeConversationIdRef.current;
      if (previous) {
        void activation.unactivate(previous);
      }
      setIntent({ tag: "home" });
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      setIsLoadingMessages(false);
      setDetailError(null);
      persistActiveConversation(null);
      onDataChangeRef.current((current) => {
        const currentNextTargetData = composerTargetDataFromProviderTarget({
          current,
          isExplicit: nextTargetIsExplicit,
          target: nextTarget
        });
        const nextAgentTargetId = currentNextTargetData.agentTargetId;
        const currentTargetId =
          current.agentTargetId ?? current.providerTargetId ?? null;
        const nextTargetId = nextAgentTargetId ?? nextTarget.targetId;
        const providerTargetChanged =
          current.provider !== nextProvider ||
          ((currentTargetId !== null || nextAgentTargetId !== null) &&
            currentTargetId !== nextTargetId);
        const nextData: AgentGUINodeData = {
          ...current,
          provider: currentNextTargetData.provider,
          agentTargetId: currentNextTargetData.agentTargetId,
          lastActiveAgentSessionId: null,
          providerTargetId: currentNextTargetData.providerTargetId,
          providerTargetRef: currentNextTargetData.providerTargetRef,
          composerOverrides: providerTargetChanged
            ? null
            : current.composerOverrides
        };
        dataRef.current = nextData;
        return nextData;
      });
      if (nextTarget.disabled !== true) {
        loadComposerOptionsForTarget(nextTargetData, { force: true });
      }
    },
    [
      activation,
      defaultProviderTargetId,
      loadComposerOptionsForTarget,
      normalizedExplicitProviderTargets,
      normalizedProviderTargets,
      persistActiveConversation,
      previewMode,
      shouldUseStaticProviderTargets
    ]
  );
  const selectConversationFilterTarget = useCallback(
    (input: {
      provider: AgentGUIProvider;
      providerTargetId?: string | null;
    }) => {
      const nextTarget = resolveAgentGUIProviderTarget({
        defaultProviderTargetId,
        provider: input.provider,
        providerTargetId: input.providerTargetId,
        providerTargets: normalizedProviderTargets,
        useStaticCatalog: shouldUseStaticProviderTargets
      });
      if (!nextTarget) {
        reportAgentGUIConversationFilterTargetUnresolved({
          provider: input.provider,
          providerTargetId: input.providerTargetId ?? null,
          providerTargetCount: normalizedProviderTargets.length,
          reason: "unresolved",
          runtime: agentActivityRuntime,
          workspaceId
        });
        return;
      }
      const agentTargetId = nextTarget.agentTargetId?.trim() ?? "";
      const nextFilter = agentTargetId
        ? { kind: "agentTarget" as const, agentTargetId }
        : { kind: "all" as const };
      setConversationFilter(nextFilter);
      // Keep the home composer chip in sync with the selected tab. Active
      // conversations keep owning their target until the target-filtered list
      // has initialized and proven empty.
      if (activeConversationIdRef.current === null) {
        selectHomeComposerAgentTarget(input);
      }
    },
    [
      agentActivityRuntime,
      defaultProviderTargetId,
      normalizedProviderTargets,
      selectHomeComposerAgentTarget,
      shouldUseStaticProviderTargets,
      workspaceId
    ]
  );
  useEffect(() => {
    if (
      previewMode ||
      providerTargetsLoading ||
      activeConversationId === null ||
      conversationFilter.kind !== "agentTarget" ||
      isLoadingConversations ||
      conversationListState?.initialized !== true
    ) {
      return;
    }
    if (
      filterAgentGUIConversationSummaries(conversations, conversationFilter)
        .length > 0
    ) {
      return;
    }
    const target = normalizedProviderTargets.find(
      (candidate) =>
        (candidate.agentTargetId?.trim() ?? "") ===
        conversationFilter.agentTargetId
    );
    if (!target) {
      return;
    }
    selectHomeComposerAgentTarget({
      provider: target.provider,
      providerTargetId: target.targetId
    });
  }, [
    activeConversationId,
    conversationFilter,
    conversationListState?.initialized,
    conversations,
    isLoadingConversations,
    normalizedProviderTargets,
    previewMode,
    providerTargetsLoading,
    selectHomeComposerAgentTarget
  ]);
  const stableCreateConversation =
    useStableControllerEventCallback(createConversation);
  const stableSelectHomeComposerAgentTarget = useStableControllerEventCallback(
    selectHomeComposerAgentTarget
  );
  const stableSelectConversationFilterTarget = useStableControllerEventCallback(
    selectConversationFilterTarget
  );
  const stableSelectConversation =
    useStableControllerEventCallback(selectConversation);
  const stableSubmitPrompt = useStableControllerEventCallback(submitPrompt);
  const stableGoalControl = useStableControllerEventCallback(goalControl);
  const stableSubmitGuidancePrompt =
    useStableControllerEventCallback(submitGuidancePrompt);
  const stableShowPromptImagesUnsupported = useStableControllerEventCallback(
    showPromptImagesUnsupported
  );
  const stableSubmitApprovalOption =
    useStableControllerEventCallback(submitApprovalOption);
  const stableSubmitInteractivePrompt = useStableControllerEventCallback(
    submitInteractivePrompt
  );
  const stableInterruptCurrentTurn =
    useStableControllerEventCallback(interruptCurrentTurn);
  const stableUpdateDraftContent =
    useStableControllerEventCallback(updateDraftContent);
  const stableUpdateSelectedProjectPath = useStableControllerEventCallback(
    updateSelectedProjectPath
  );
  const stableUpdateComposerSettings = useStableControllerEventCallback(
    updateComposerSettings
  );
  const stableSendQueuedPromptNext =
    useStableControllerEventCallback(sendQueuedPromptNext);
  const stableRemoveQueuedPrompt =
    useStableControllerEventCallback(removeQueuedPrompt);
  const stableEditQueuedPrompt =
    useStableControllerEventCallback(editQueuedPrompt);
  const stableRemoveProject = useStableControllerEventCallback(removeProject);
  const stableRequestDeleteProjectConversations =
    useStableControllerEventCallback(requestDeleteProjectConversations);
  const stableCancelDeleteProjectConversations =
    useStableControllerEventCallback(cancelDeleteProjectConversations);
  const stableConfirmDeleteProjectConversations =
    useStableControllerEventCallback(confirmDeleteProjectConversations);
  const stableConfirmDeleteConversations = useStableControllerEventCallback(
    confirmDeleteConversations
  );
  const stableToggleConversationPinned = useStableControllerEventCallback(
    toggleConversationPinned
  );
  const stableRequestDeleteConversation = useStableControllerEventCallback(
    requestDeleteConversation
  );
  const stableRetryActivation =
    useStableControllerEventCallback(retryActivation);
  const stableContinueInNewConversation = useStableControllerEventCallback(
    continueInNewConversation
  );
  const stableCancelDeleteConversation = useStableControllerEventCallback(
    cancelDeleteConversation
  );
  const stableConfirmDeleteConversation = useStableControllerEventCallback(
    confirmDeleteConversation
  );
  const stableRetryOpenclawGateway = useStableControllerEventCallback(
    ensureOpenclawGateway
  );
  const stableLoadOlderConversationMessages = useStableControllerEventCallback(
    loadOlderConversationMessages
  );
  const stableUpdateConversationFilter = useStableControllerEventCallback(
    updateConversationFilter
  );
  const viewData =
    activeConversationId === null ? selectedComposerTargetData.data : data;
  const providerReadinessGate =
    activeConversationId === null
      ? (providerReadinessGates?.[effectiveSelectedProviderTarget.provider] ??
        null)
      : null;
  const controllerActions = useMemo(
    () => ({
      updateConversationFilter: stableUpdateConversationFilter,
      selectConversationFilterTarget: stableSelectConversationFilterTarget,
      selectHomeComposerAgentTarget: stableSelectHomeComposerAgentTarget,
      createConversation: stableCreateConversation,
      selectConversation: stableSelectConversation,
      submitPrompt: stableSubmitPrompt,
      goalControl: stableGoalControl,
      submitGuidancePrompt: stableSubmitGuidancePrompt,
      loadOlderConversationMessages: stableLoadOlderConversationMessages,
      showPromptImagesUnsupported: stableShowPromptImagesUnsupported,
      submitApprovalOption: stableSubmitApprovalOption,
      submitInteractivePrompt: stableSubmitInteractivePrompt,
      interruptCurrentTurn: stableInterruptCurrentTurn,
      updateDraftContent: stableUpdateDraftContent,
      updateSelectedProjectPath: stableUpdateSelectedProjectPath,
      updateComposerSettings: stableUpdateComposerSettings,
      sendQueuedPromptNext: stableSendQueuedPromptNext,
      removeQueuedPrompt: stableRemoveQueuedPrompt,
      editQueuedPrompt: stableEditQueuedPrompt,
      removeProject: stableRemoveProject,
      requestDeleteProjectConversations:
        stableRequestDeleteProjectConversations,
      cancelDeleteProjectConversations: stableCancelDeleteProjectConversations,
      confirmDeleteProjectConversations:
        stableConfirmDeleteProjectConversations,
      confirmDeleteConversations: stableConfirmDeleteConversations,
      toggleConversationPinned: stableToggleConversationPinned,
      requestDeleteConversation: stableRequestDeleteConversation,
      retryActivation: stableRetryActivation,
      continueInNewConversation: stableContinueInNewConversation,
      cancelDeleteConversation: stableCancelDeleteConversation,
      confirmDeleteConversation: stableConfirmDeleteConversation,
      retryOpenclawGateway: stableRetryOpenclawGateway
    }),
    [
      stableCancelDeleteConversation,
      stableCancelDeleteProjectConversations,
      stableConfirmDeleteConversation,
      stableConfirmDeleteConversations,
      stableConfirmDeleteProjectConversations,
      stableContinueInNewConversation,
      stableCreateConversation,
      stableEditQueuedPrompt,
      stableInterruptCurrentTurn,
      stableLoadOlderConversationMessages,
      stableRemoveProject,
      stableRemoveQueuedPrompt,
      stableRequestDeleteConversation,
      stableRequestDeleteProjectConversations,
      stableRetryActivation,
      stableRetryOpenclawGateway,
      stableSelectConversation,
      stableSelectConversationFilterTarget,
      stableSelectHomeComposerAgentTarget,
      stableSendQueuedPromptNext,
      stableSubmitGuidancePrompt,
      stableShowPromptImagesUnsupported,
      stableSubmitApprovalOption,
      stableSubmitInteractivePrompt,
      stableSubmitPrompt,
      stableGoalControl,
      stableToggleConversationPinned,
      stableUpdateConversationFilter,
      stableUpdateComposerSettings,
      stableUpdateDraftContent,
      stableUpdateSelectedProjectPath
    ]
  );

  return useMemo(
    () => ({
      viewModel: {
        workspaceId,
        workspacePath,
        currentUserId,
        data: viewData,
        selectedProviderTarget: effectiveSelectedProviderTarget,
        providerTargets: normalizedProviderTargets,
        providerTargetsLoading,
        comingSoonProviders: normalizedComingSoonProviders,
        conversationFilter,
        conversations: visibleConversations,
        userProjects,
        activeConversation,
        activeConversationId,
        availableCommands,
        availableSkills,
        draftPrompt,
        draftContent,
        isLoadingConversations,
        isLoadingMessages,
        isLoadingOlderMessages:
          activeSessionView?.isLoadingOlderMessages ?? false,
        hasOlderMessages: activeSessionView?.hasOlderMessages ?? false,
        isCreatingConversation,
        isSubmitting,
        isInterrupting,
        isCancelPending,
        isRespondingApproval,
        promptImagesSupported,
        compactSupported,
        goalPauseSupported,
        usage,
        backgroundAgentCount,
        listError,
        isDeletingConversation,
        isDeletingProjectConversations,
        pendingDeleteConversation,
        pendingDeleteProjectConversations,
        pendingApproval,
        pendingInteractivePrompt,
        activeLiveState,
        activationError,
        openclawGateway,
        canSubmit,
        composerSettings: stableComposerSettings,
        queuedPrompts,
        drainingQueuedPromptId,
        canQueueWhileBusy,
        hasSentUserMessage,
        avoidGroupingEdits,
        conversation,
        conversationDetail,
        sessionChrome,
        inlineNotice: detailError
          ? {
              id: `agent-gui-detail-error:${activeConversationId ?? "current"}`,
              message: detailError,
              tone: "error" as const,
              autoDismissMs: null
            }
          : null,
        detailError,
        providerReadinessGate
      },
      actions: controllerActions
    }),
    [
      activeConversation,
      activeConversationId,
      activeLiveState,
      activationError,
      avoidGroupingEdits,
      availableCommands,
      availableSkills,
      canSubmit,
      canQueueWhileBusy,
      conversation,
      conversationFilter,
      conversationDetail,
      controllerActions,
      data,
      effectiveSelectedProviderTarget,
      normalizedComingSoonProviders,
      normalizedProviderTargets,
      providerReadinessGate,
      providerTargetsLoading,
      detailError,
      draftContent,
      draftPrompt,
      isCreatingConversation,
      openclawGateway,
      promptImagesSupported,
      compactSupported,
      goalPauseSupported,
      usage,
      backgroundAgentCount,
      isInterrupting,
      isCancelPending,
      isLoadingConversations,
      isLoadingMessages,
      activeSessionView?.hasOlderMessages,
      activeSessionView?.isLoadingOlderMessages,
      isRespondingApproval,
      listError,
      isDeletingConversation,
      isDeletingProjectConversations,
      isSubmitting,
      hasSentUserMessage,
      pendingDeleteConversation,
      pendingDeleteProjectConversations,
      pendingApproval,
      pendingInteractivePrompt,
      effectiveSelectedProviderTarget.disabled,
      queuedPrompts,
      drainingQueuedPromptId,
      currentUserId,
      workspaceId,
      workspacePath,
      stableComposerSettings,
      sessionChrome,
      viewData,
      userProjects,
      visibleConversations
    ]
  );
}

function normalizeProjectConversationPath(
  path: string | null | undefined
): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

function omitConversationLocalState<T>(
  current: Record<string, T>,
  conversationIds: ReadonlySet<string>
): Record<string, T> {
  let changed = false;
  const next = { ...current };
  for (const conversationId of conversationIds) {
    if (conversationId in next) {
      delete next[conversationId];
      changed = true;
    }
  }
  return changed ? next : current;
}

function approvalRequestFromConversation(
  conversation: AgentConversationVM | null
): AgentGUIApprovalRequest | null {
  return conversation?.pendingApproval ?? null;
}

function interactivePromptFromConversation(
  conversation: AgentConversationVM | null
): AgentGUIInteractivePrompt | null {
  return conversation?.pendingInteractivePrompt ?? null;
}

function interactiveApprovalFromSessionState(state: AgentSessionState | null) {
  const prompt = state?.pendingInteractive;
  if (!prompt || prompt.kind !== "approval") {
    return null;
  }
  const callID =
    typeof prompt.input?.callId === "string" && prompt.input.callId.trim()
      ? prompt.input.callId.trim()
      : (prompt.requestId?.trim() ?? "");
  const options = Array.isArray(prompt.input?.options)
    ? prompt.input.options
    : [];
  const normalizedOptions = options
    .map((option) => {
      if (!option || typeof option !== "object") {
        return null;
      }
      const candidate = option as Record<string, unknown>;
      const id =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : typeof candidate.optionId === "string" && candidate.optionId.trim()
            ? candidate.optionId.trim()
            : "";
      if (!id) {
        return null;
      }
      return {
        id,
        label:
          typeof candidate.name === "string" && candidate.name.trim()
            ? candidate.name.trim()
            : typeof candidate.label === "string" && candidate.label.trim()
              ? candidate.label.trim()
              : id,
        kind:
          typeof candidate.kind === "string" && candidate.kind.trim()
            ? candidate.kind.trim()
            : id,
        ...(typeof candidate.description === "string" &&
        candidate.description.trim()
          ? { description: candidate.description.trim() }
          : {})
      };
    })
    .filter(
      (
        option
      ): option is {
        id: string;
        label: string;
        kind: string;
        description?: string;
      } => option !== null
    );
  if (!prompt.requestId?.trim() || !callID || normalizedOptions.length === 0) {
    return null;
  }
  const approval: AgentApprovalItemVM = {
    kind: "approval",
    id: `approval:${callID}`,
    turnId: "turn:unknown",
    requestId: prompt.requestId.trim(),
    callId: callID,
    title:
      typeof prompt.toolName === "string" && prompt.toolName.trim()
        ? prompt.toolName.trim()
        : "Approval required",
    status: "waiting_approval",
    toolName:
      typeof prompt.toolName === "string" && prompt.toolName.trim()
        ? prompt.toolName.trim()
        : null,
    input: prompt.input ?? null,
    options: normalizedOptions,
    output: null,
    occurredAtUnixMs:
      typeof state?.updatedAtUnixMs === "number" ? state.updatedAtUnixMs : null
  };
  return approval;
}

function interactivePromptFromSessionState(
  state: AgentSessionState | null
): AgentGUIInteractivePrompt | null {
  const prompt = state?.pendingInteractive;
  if (!prompt || prompt.kind === "approval" || !prompt.requestId?.trim()) {
    return null;
  }
  const toolName = normalizeInteractiveToolName(prompt.toolName);
  if (toolName === "exitplanmode") {
    return {
      kind: "exit-plan",
      requestId: prompt.requestId.trim(),
      title: prompt.toolName?.trim() || "Exit plan mode",
      // Legacy exitplanmode session-state prompt carries no runtime mode
      // options; the surface falls back to the curated default list.
      options: []
    };
  }
  if (toolName !== "askuserquestion") {
    return null;
  }
  const questions = normalizeInteractiveQuestions(prompt.input?.questions);
  if (questions.length === 0) {
    return null;
  }
  return {
    kind: "ask-user",
    requestId: prompt.requestId.trim(),
    title: prompt.toolName?.trim() || "Questions for you",
    questions
  };
}

function normalizeInteractiveToolName(toolName: string | undefined): string {
  return (toolName?.trim() ?? "").replace(/[_\s-]+/g, "").toLowerCase();
}

function areAgentGUIUserProjectsEqual(
  left: readonly AgentHostUserProject[],
  right: readonly AgentHostUserProject[]
): boolean {
  return (
    left.length === right.length &&
    left.every((project, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        project.id === candidate.id &&
        project.path === candidate.path &&
        project.label === candidate.label
      );
    })
  );
}

function upsertAgentGUIUserProject(
  projects: readonly AgentHostUserProject[],
  project: {
    id: string;
    path: string;
    label: string;
    createdAtUnixMs?: number;
    updatedAtUnixMs?: number;
    lastUsedAtUnixMs?: number | null;
  }
): AgentHostUserProject[] {
  const normalizedProject: AgentHostUserProject = {
    ...(project.createdAtUnixMs === undefined
      ? {}
      : { createdAtUnixMs: project.createdAtUnixMs }),
    id: project.id,
    ...(project.lastUsedAtUnixMs === undefined ||
    project.lastUsedAtUnixMs === null
      ? {}
      : { lastUsedAtUnixMs: project.lastUsedAtUnixMs }),
    label: project.label,
    path: project.path,
    ...(project.updatedAtUnixMs === undefined
      ? {}
      : { updatedAtUnixMs: project.updatedAtUnixMs })
  };
  const index = projects.findIndex(
    (candidate) =>
      candidate.id === normalizedProject.id ||
      candidate.path === normalizedProject.path
  );
  if (index === -1) {
    return [...projects, normalizedProject];
  }
  const next = [...projects];
  next[index] = normalizedProject;
  return next;
}

function readAgentGUIUserProjectSnapshot(
  api: AgentHostUserProjectsApi | undefined
): AgentHostUserProject[] {
  const projects = api?.service?.getSnapshot?.().projects ?? [];
  return projects.map((project) => ({
    ...(project.createdAtUnixMs === undefined
      ? {}
      : { createdAtUnixMs: project.createdAtUnixMs }),
    id: project.id,
    ...(project.lastUsedAtUnixMs === undefined ||
    project.lastUsedAtUnixMs === null
      ? {}
      : { lastUsedAtUnixMs: project.lastUsedAtUnixMs }),
    label: project.label,
    path: project.path,
    ...(project.updatedAtUnixMs === undefined
      ? {}
      : { updatedAtUnixMs: project.updatedAtUnixMs })
  }));
}

function normalizeInteractiveQuestions(
  value: unknown
): AgentGUIInteractiveQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const candidate = option as Record<string, unknown>;
          const label =
            typeof candidate.label === "string" && candidate.label.trim()
              ? candidate.label.trim()
              : typeof candidate.name === "string" && candidate.name.trim()
                ? candidate.name.trim()
                : "";
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description:
                typeof candidate.description === "string"
                  ? candidate.description.trim()
                  : ""
            }
          ];
        })
      : [];
    const question =
      typeof record.question === "string" && record.question.trim()
        ? record.question.trim()
        : typeof record.header === "string" && record.header.trim()
          ? record.header.trim()
          : "";
    if (!question) {
      return [];
    }
    return [
      {
        id:
          typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `question-${index + 1}`,
        header:
          typeof record.header === "string" && record.header.trim()
            ? record.header.trim()
            : `Question ${index + 1}`,
        question,
        options,
        multiSelect: Boolean(record.multiSelect),
        isOther: Boolean(record.isOther)
      }
    ];
  });
}
