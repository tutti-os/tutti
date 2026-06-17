import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import { toast } from "@tutti-os/ui-system";
import { translate } from "../../../i18n/index";
import {
  useAgentActivityRuntime,
  useAgentActivitySnapshot,
  type AgentActivityRuntime
} from "../../../agentActivityRuntime";
import { useAgentHostApi } from "../../../agentActivityHost";
import {
  resolveAgentActivityCapability,
  resolveAgentActivityUsage,
  selectSessionDisplayStatuses
} from "@tutti-os/agent-activity-core";
import type {
  AgentActivityCancelSessionResult,
  AgentActivityComposerOptions,
  AgentActivityDisplayStatus,
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
  AgentSessionCommand,
  AgentSessionComposerSettings,
  AgentSessionPermissionConfig,
  AgentSessionPermissionModeOption,
  AgentSessionReasoningEffort,
  AgentSessionSpeed,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import { AGENT_PROVIDER_LABEL } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUINodeData } from "../../../types";
import {
  AGENT_GUI_RUNTIME_SESSION_ORIGIN,
  buildAgentGUIConversationSummaries,
  buildAgentGUIConversationDetail,
  buildAgentGUIConversationVM,
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
import type { AgentHostUserProject } from "../../../host/agentHostApi";
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
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import { projectCoreSessionStatus } from "../../../shared/agentActivitySnapshotProjection";
import { isWorkspaceAgentUntitledTask } from "../../../shared/workspaceAgentLatestActivitySummary";
import { projectWorkspaceAgentMessagesToTimelineItems } from "../../../shared/agentConversation/projection/workspaceAgentMessageProjection";
import { mergeWorkspaceAgentMessages } from "../../../host/workspaceAgentSessionMessages";
import {
  mergeWorkspaceAgentActivityDurableAndOverlayMessages,
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
  setAgentSessionViewError,
  setAgentSessionViewControlState,
  setAgentSessionViewControlStateLoading,
  setAgentSessionViewOverlayMessages,
  setAgentSessionViewMessagesLoading,
  updateAgentSessionViewControlState
} from "../../../contexts/workspace/presentation/renderer/agentSessions/agentSessionViewStore";
import {
  useAgentSessionDurableRefresh,
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
  scheduleAgentGUIConversationListProjection,
  setAgentGUIConversationListActiveConversation,
  subscribeAgentGUIConversationListStore,
  upsertLocalCreatedAgentGUIConversation,
  updateAgentGUIConversationListConversations,
  type AgentGUIConversationListQuery
} from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore";
import { useAgentGuiConversationList } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { useAgentGUIActivation } from "./useAgentGUIActivation";
import {
  buildAgentSessionMentionHref,
  formatAgentMentionMarkdown,
  normalizeAgentSessionMentionTitle
} from "../agentRichText/agentFileMentionExtension";
import { resolveAgentGUIExplicitConversationTitle } from "../model/agentGuiProviderIdentity";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import {
  buildNodeDefaultComposerSettings,
  cloneComposerSettings,
  composerSupportForProvider,
  mergeRuntimeContextComposerSettings,
  nodeDataFromComposerSettings,
  normalizeConfigOptionValue,
  normalizePermissionModeId,
  resolveEffectiveComposerSettings,
  sameComposerSettings
} from "./agentGuiController.composerHelpers";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP,
  latestPlanTurnId,
  planDecisionOps,
  planImplementationPromptFromPlanTurn
} from "../../../shared/agentConversation/planImplementation";
import {
  INITIAL_USAGE_ALERT_STATE,
  nextUsageAlert,
  type UsageAlertState,
  type UsageAlertTier
} from "../model/agentUsageAlerts";

const EMPTY_AGENT_GUI_MESSAGES: readonly WorkspaceAgentActivityMessage[] = [];
const EMPTY_AGENT_GUI_AVAILABLE_COMMANDS: AgentSessionCommand[] = [];
const ACTIVITY_STREAM_STATE_RELOAD_DEBOUNCE_MS = 150;

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
const AGENT_SESSION_ACTIVE_TURN_CONFLICT_MESSAGE =
  "agent session already has an active turn";
const AGENT_PROVIDER_SESSION_NOT_FOUND_FALLBACK_MESSAGE =
  "The previous agent session can no longer be restored.";
const AGENT_RESUME_SESSION_NOT_LOCAL_FALLBACK_MESSAGE =
  "The previous agent session is not available on this machine.";
const AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT = 4000;
const SELECTED_SESSION_NOT_FOUND_RETRY_DELAY_MS = 150;

type AgentGUIRuntimeErrorPhase =
  | "create_conversation"
  | "drain_queued_prompt_interrupt"
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

interface QueuedPromptRetryBlock {
  queuedPromptId: string;
  sessionStateUpdatedAtUnixMs: number | null;
  conversationUpdatedAtUnixMs: number | null;
}

interface QueuedComposerSettingsUpdate {
  sessionSettingsPatch: AgentSessionComposerSettings;
  nextNodeDefaults: AgentSessionComposerSettings;
}

interface ACPConfigOptionSelection {
  options: AgentGUIComposerSettingOption[];
  currentValue: string | null;
}

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

function reportAgentGUICancelDiagnostic(input: {
  agentSessionId: string;
  busySource?: string | null;
  currentSessionStatus?: string | null;
  phase: "drain_queued_prompt_interrupt" | "interrupt_current_turn";
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
  const href = buildAgentSessionMentionHref(
    input.workspaceId,
    input.agentSessionId,
    input.provider
  );
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

function isAgentSessionActiveTurnConflictError(error: unknown): boolean {
  const message = getAgentGUIRawErrorMessage(error);
  return (
    message
      ?.toLowerCase()
      .includes(AGENT_SESSION_ACTIVE_TURN_CONFLICT_MESSAGE) ?? false
  );
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
    return next;
  }
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) {
      return next;
    }
  }
  return previous as AgentGUIConversationSummary[];
}

function mergeConversationTitleUpdateFields(
  current: AgentGUIConversationSummary,
  incomingTitle: string
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
  return {
    title,
    titleFallback: null
  };
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

function createOptimisticPromptMessage(input: {
  workspaceId: string;
  agentSessionId: string;
  turnId: string;
  userId: string;
  prompt: string;
  content: AgentPromptContentBlock[];
  occurredAtUnixMs: number;
}): WorkspaceAgentActivityMessage {
  return {
    id: Math.max(1, Math.floor(input.occurredAtUnixMs)),
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    messageId: `optimistic:user:${input.turnId}`,
    version: Math.max(1, Math.floor(input.occurredAtUnixMs)),
    turnId: input.turnId,
    role: "user",
    kind: "text",
    payload: {
      __agentGuiOptimisticPrompt: true,
      actorId: input.userId,
      content: input.content,
      text: input.prompt
    },
    occurredAtUnixMs: input.occurredAtUnixMs,
    startedAtUnixMs: input.occurredAtUnixMs
  };
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
  return options?.skills.map((skill) => ({ ...skill })) ?? [];
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
    left.pluginName === right.pluginName
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
    left.sessionSettings === right.sessionSettings &&
    areComposerSettingsDraftsEqual(left.draftSettings, right.draftSettings) &&
    (left.effectivePlanMode ?? false) === (right.effectivePlanMode ?? false) &&
    left.supportsModel === right.supportsModel &&
    left.supportsReasoningEffort === right.supportsReasoningEffort &&
    left.supportsSpeed === right.supportsSpeed &&
    (left.supportsPermissionMode ?? false) ===
      (right.supportsPermissionMode ?? false) &&
    left.supportsPlanMode === right.supportsPlanMode &&
    left.isSettingsLoading === right.isSettingsLoading &&
    left.modelUnavailable === right.modelUnavailable &&
    left.reasoningUnavailable === right.reasoningUnavailable &&
    left.speedUnavailable === right.speedUnavailable &&
    (left.permissionModeUnavailable ?? false) ===
      (right.permissionModeUnavailable ?? false) &&
    left.planUnavailable === right.planUnavailable &&
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
  if (
    settingsRef.current === null ||
    !areComposerSettingsVMsEqual(settingsRef.current, settings)
  ) {
    settingsRef.current = settings;
  }
  return settingsRef.current;
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

function removeQueuedPromptById(
  queue: readonly AgentGUIQueuedPromptVM[],
  queuedPromptId: string
): AgentGUIQueuedPromptVM[] {
  return queue.filter((queuedPrompt) => queuedPrompt.id !== queuedPromptId);
}

const NODE_DEFAULT_DRAFT_KEY = "__agent_gui_node_defaults__";
const EMPTY_AGENT_COMPOSER_DRAFT = emptyAgentComposerDraft();

function nodeDefaultDraftKey(
  agentProvider: AgentGUINodeData["provider"]
): string {
  return `${NODE_DEFAULT_DRAFT_KEY}:${agentProvider}`;
}

function nodeDefaultDraftContentKey(
  agentProvider: AgentGUINodeData["provider"]
): string {
  return nodeDefaultDraftKey(agentProvider);
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

function hasSessionControlStatePatch(
  patch: WorkspaceAgentActivityStatePatch
): boolean {
  return (
    normalizeOptionalText(patch.permissionModeId) !== null ||
    patch.settings !== undefined ||
    patch.runtimeContext !== undefined
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
  if (
    patch.occurredAtUnixMs !== undefined &&
    Number.isFinite(patch.occurredAtUnixMs)
  ) {
    next.updatedAtUnixMs = patch.occurredAtUnixMs;
    changed = true;
  }
  return changed ? next : current;
}

function conversationStatusFromSessionState(
  state: AgentSessionState
): AgentGUIConversationSummary["status"] | null {
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

interface AgentPlanModeObservedState {
  planMode: boolean;
  observedAtUnixMs: number;
}

function latestPlanModeStateFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentPlanModeObservedState | null {
  let latest: AgentPlanModeObservedState | null = null;
  for (const item of timelineItems) {
    const toolName = normalizePlanModeToolName(
      item.name ??
        stringPayloadValue(item.payload, "toolName") ??
        stringPayloadValue(item.payload, "name") ??
        stringPayloadValue(item.payload, "title")
    );
    if (toolName !== "enterplanmode" && toolName !== "exitplanmode") {
      continue;
    }
    const status = normalizePlanModeToolStatus(
      item.status ?? stringPayloadValue(item.payload, "status")
    );
    if (status === "failed" || status === "canceled") {
      continue;
    }
    if (toolName === "exitplanmode" && status !== "completed") {
      continue;
    }
    const next = {
      planMode: toolName === "enterplanmode",
      observedAtUnixMs: timelineItemTime(item)
    };
    if (!latest || next.observedAtUnixMs >= latest.observedAtUnixMs) {
      latest = next;
    }
  }
  return latest;
}

function planModeStateFromSessionState(
  state: AgentSessionState | null
): AgentPlanModeObservedState | null {
  if (!state) {
    return null;
  }
  const runtimeMode = normalizePlanModeToolName(
    typeof state.runtimeContext?.mode === "string"
      ? state.runtimeContext.mode
      : undefined
  );
  if (runtimeMode) {
    return {
      planMode: runtimeMode === "plan",
      observedAtUnixMs: state.updatedAtUnixMs
    };
  }
  if (state.settings?.planMode !== undefined) {
    return {
      planMode: Boolean(state.settings.planMode),
      observedAtUnixMs: state.updatedAtUnixMs
    };
  }
  return null;
}

function resolveEffectivePlanModeFromStates(input: {
  sessionPlanModeState: AgentPlanModeObservedState | null;
  timelinePlanModeState: AgentPlanModeObservedState | null;
  fallbackPlanMode: boolean;
}): boolean {
  if (
    input.timelinePlanModeState &&
    (!input.sessionPlanModeState ||
      input.timelinePlanModeState.observedAtUnixMs >=
        input.sessionPlanModeState.observedAtUnixMs)
  ) {
    return input.timelinePlanModeState.planMode;
  }
  return input.sessionPlanModeState?.planMode ?? input.fallbackPlanMode;
}

function normalizePlanModeToolName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[_\s-]+/g, "")
    .trim()
    .toLowerCase();
}

function normalizePlanModeToolStatus(
  value: string | null | undefined
): "completed" | "failed" | "canceled" | "other" {
  switch (value?.trim().toLowerCase()) {
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
    case "done":
      return "completed";
    case "failed":
    case "failure":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "rejected":
    case "aborted":
      return "canceled";
    default:
      return "other";
  }
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
    ...(update.turnId?.trim() ? { turnId: update.turnId.trim() } : {}),
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
    ...(update.occurredAtUnixMs !== undefined
      ? { occurredAtUnixMs: update.occurredAtUnixMs }
      : {}),
    ...(update.startedAtUnixMs !== undefined
      ? { startedAtUnixMs: update.startedAtUnixMs }
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

interface UseAgentGUINodeControllerInput {
  nodeId?: string;
  workspaceId: string;
  currentUserId?: string | null;
  workspacePath: string;
  avoidGroupingEdits: boolean;
  data: AgentGUINodeData;
  openSessionRequest?: AgentGUIOpenSessionRequest | null;
  prefillPromptRequest?: AgentGUIPrefillPromptRequest | null;
  previewMode?: boolean;
  onDataChange: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
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
  draftPrompt: string;
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
  openSessionRequest = null,
  prefillPromptRequest = null,
  previewMode = false,
  onDataChange,
  onShowMessage
}: UseAgentGUINodeControllerInput) {
  const agentActivityRuntime = useAgentActivityRuntime();
  const agentHostApi = useAgentHostApi();
  const agentActivitySnapshot = useAgentActivitySnapshot(workspaceId);
  const agentActivityDisplayStatuses = useMemo(
    () => selectSessionDisplayStatuses(agentActivitySnapshot),
    [agentActivitySnapshot]
  );
  const generatedControllerOwnerKey = useId();
  const conversationListQuery =
    useMemo<AgentGUIConversationListQuery | null>(() => {
      const userId = currentUserId?.trim() ?? "";
      const provider = data.provider?.trim() ?? "";
      if (!workspaceId.trim() || !userId || !provider) {
        return null;
      }
      return {
        workspaceId,
        userId,
        provider: data.provider,
        sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN
      };
    }, [currentUserId, data.provider, workspaceId]);
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
  const [userProjects, setUserProjects] = useState<AgentHostUserProject[]>([]);
  const isNoProjectPath = agentHostApi.userProjects?.isNoProjectPath;
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(data.lastActiveAgentSessionId);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(
    null
  );
  const [isComposerHome, setIsComposerHome] = useState(
    data.lastActiveAgentSessionId === null
  );
  const [draftBySessionId, setDraftBySessionId] = useState<
    Record<string, AgentComposerDraft>
  >({});
  const [draftSettingsBySessionId, setDraftSettingsBySessionId] = useState<
    Record<string, AgentSessionComposerSettings>
  >({});
  const [queuedPromptsBySessionId, setQueuedPromptsBySessionId] = useState<
    Record<string, AgentGUIQueuedPromptVM[]>
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
  const [drainingQueuedPromptSessionId, setDrainingQueuedPromptSessionId] =
    useState<string | null>(null);
  const [
    sendNextQueuedPromptIdBySessionId,
    setSendNextQueuedPromptIdBySessionId
  ] = useState<Record<string, string | null>>({});
  const [failedQueuedPromptIdBySessionId, setFailedQueuedPromptIdBySessionId] =
    useState<Record<string, string | null>>({});
  const [
    queuedPromptRetryBlockBySessionId,
    setQueuedPromptRetryBlockBySessionId
  ] = useState<Record<string, QueuedPromptRetryBlock | null>>({});
  const [interruptingSessionIds, setInterruptingSessionIds] = useState<
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
  const providerComposerOptions =
    agentActivitySnapshot.composerOptionsByProvider?.[data.provider] ?? null;
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
  const activeSessionRuntimeContext = activeSessionState?.runtimeContext;
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
  const supports = composerSupportForProvider(data.provider);
  const usage = useMemo(
    () =>
      resolveAgentActivityUsage({
        sessionRuntimeContext: activeSessionRuntimeContext
      }),
    [activeSessionRuntimeContext]
  );
  const usageAlertStateBySessionIdRef = useRef<Record<string, UsageAlertState>>(
    {}
  );
  const [usageAlertBySessionId, setUsageAlertBySessionId] = useState<
    Record<string, UsageAlertTier>
  >({});
  // Maps a session to the plan turn id whose implement-plan offer was
  // dismissed, so a given plan is offered once while a fresh plan turn
  // (different turn id) re-arms the offer.
  const [dismissedPlanTurnIdBySessionId, setDismissedPlanTurnIdBySessionId] =
    useState<Record<string, string>>({});
  const planImplementationTurnIdRef = useRef<string | null>(null);
  const usagePercentUsed = usage?.percentUsed ?? null;
  useEffect(() => {
    const agentSessionId = activeConversationId;
    if (!agentSessionId) {
      return;
    }
    const previousState =
      usageAlertStateBySessionIdRef.current[agentSessionId] ??
      INITIAL_USAGE_ALERT_STATE;
    const { fire, state } = nextUsageAlert(usagePercentUsed, previousState);
    usageAlertStateBySessionIdRef.current[agentSessionId] = state;
    if (fire) {
      setUsageAlertBySessionId((current) =>
        current[agentSessionId] === fire
          ? current
          : { ...current, [agentSessionId]: fire }
      );
      return;
    }
    if (!state.warned && !state.criticaled) {
      setUsageAlertBySessionId((current) => {
        if (!(agentSessionId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[agentSessionId];
        return next;
      });
    }
  }, [activeConversationId, usagePercentUsed]);
  const usageAlert = activeConversationId
    ? (usageAlertBySessionId[activeConversationId] ?? null)
    : null;
  const dismissUsageAlert = useCallback(() => {
    const agentSessionId = activeConversationId;
    if (!agentSessionId) {
      return;
    }
    setUsageAlertBySessionId((current) => {
      if (!(agentSessionId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[agentSessionId];
      return next;
    });
  }, [activeConversationId]);
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
      return mergeWorkspaceAgentActivityDurableAndOverlayMessages({
        durableMessages:
          agentActivitySnapshot.sessionMessagesById[normalizedAgentSessionId],
        localMessages:
          getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
            ?.overlayMessages ?? EMPTY_AGENT_GUI_MESSAGES
      });
    },
    [agentActivitySnapshot.sessionMessagesById, sessionViewRef]
  );
  const activeMessages = useMemo(() => {
    return activeConversationId
      ? resolveSessionMessages(activeConversationId)
      : (activeSessionView?.overlayMessages ?? EMPTY_AGENT_GUI_MESSAGES);
  }, [
    activeConversationId,
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
    const next = { ...stableRuntimeSyncStateBySessionIdRef.current };
    const activeSessionIds = new Set<string>();
    for (const session of agentActivitySnapshot.sessions) {
      const agentSessionId = session.agentSessionId.trim();
      if (!agentSessionId) {
        continue;
      }
      activeSessionIds.add(agentSessionId);
      const nextSyncState = runtimeSessionSyncState(session);
      if (!nextSyncState) {
        delete next[agentSessionId];
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
        next[agentSessionId] = nextSyncState;
      }
    }
    for (const agentSessionId of Object.keys(next)) {
      if (!activeSessionIds.has(agentSessionId)) {
        delete next[agentSessionId];
        delete latestRuntimeSyncStateBySessionIdRef.current[agentSessionId];
      }
    }
    stableRuntimeSyncStateBySessionIdRef.current = next;
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
  const draftSettingsBySessionIdRef = useRef(draftSettingsBySessionId);
  const onDataChangeRef = useRef(onDataChange);
  const onShowMessageRef = useRef(onShowMessage);
  const handledPrefillPromptSequenceRef = useRef<number | null>(null);
  const persistedActiveConversationIdRef = useRef(
    data.lastActiveAgentSessionId
  );
  const pendingLocalActiveConversationIdRef = useRef<string | null>(null);
  const externalConversationReloadAttemptRef = useRef<string | null>(null);
  const suppressedHomeConversationIdRef = useRef<string | null>(null);
  const [transientConversation, setTransientConversationState] =
    useState<AgentGUIConversationSummary | null>(null);
  const transientConversationRef = useRef<AgentGUIConversationSummary | null>(
    transientConversation
  );
  const startingConversationIdRef = useRef<string | null>(null);
  const activatedConversationIdsRef = useRef(new Set<string>());
  const failedNewConversationIdsRef = useRef(new Set<string>());
  const pendingTurnIdBySessionIdRef = useRef<Record<string, string>>({});
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
  const activityStreamStateReloadSeqRef = useRef(0);
  const stateReloadTimerRef = useRef<number | null>(null);
  const stateReloadInFlightRef = useRef(false);
  const stateReloadQueuedRef = useRef(false);
  const stateReloadTargetSessionIdRef = useRef<string | null>(null);
  const selectedConversationMessageLoadSeqRef = useRef(0);
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
  const stateReloadCauseRef = useRef<{
    source: "activity-stream";
    eventType?: string;
    requestId?: number;
  } | null>(null);
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
      queuedPromptId?: string | null
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

  const updateConversationList = useCallback(
    (
      updater: (
        current: AgentGUIConversationSummary[]
      ) => AgentGUIConversationSummary[]
    ) => {
      if (!conversationListQuery) {
        return;
      }
      updateAgentGUIConversationListConversations(
        conversationListQuery,
        updater
      );
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
    if (previewMode) {
      return undefined;
    }
    const api = agentHostApi.userProjects;
    let disposed = false;
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
    const unsubscribe = api?.subscribe?.(() => {
      void loadUserProjects();
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [agentHostApi.userProjects, previewMode, setUserProjectsSnapshot]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!conversationListQuery || agentActivitySnapshot.sessions.length === 0) {
      return;
    }
    const snapshotConversations = buildAgentGUIConversationSummaries({
      isNoProjectPath,
      snapshot: agentActivitySnapshot,
      provider: data.provider,
      sessionMessagesById: agentActivitySnapshot.sessionMessagesById,
      userProjects
    });
    if (snapshotConversations.length === 0) {
      return;
    }
    const completedConversationIds = new Set<string>();
    updateConversationList((current) => {
      const currentById = new Map(
        current.map((conversation) => [conversation.id, conversation])
      );
      const snapshotIds = new Set(
        snapshotConversations.map((conversation) => conversation.id)
      );
      const merged: AgentGUIConversationSummary[] = snapshotConversations.map(
        (conversation) => {
          const existing = currentById.get(conversation.id);
          if (!existing) {
            return {
              ...conversation,
              hasUnreadCompletion: conversation.hasUnreadCompletion ?? false
            };
          }
          const titleFields =
            hasPromptConversationTitle(existing) &&
            isWorkspaceAgentUntitledTask(conversation.title)
              ? {
                  title: existing.title,
                  titleFallback: existing.titleFallback
                }
              : mergeConversationTitleUpdateFields(
                  existing,
                  conversation.title
                );
          const incomingWouldSettleBusyStatus =
            conversationBusyStatus(existing.status) &&
            !conversationBusyStatus(conversation.status);
          const shouldKeepExistingStatus =
            existing.updatedAtUnixMs > conversation.updatedAtUnixMs &&
            incomingWouldSettleBusyStatus;
          const status = shouldKeepExistingStatus
            ? existing.status
            : conversation.status;
          if (status === "completed" && existing.status !== "completed") {
            completedConversationIds.add(conversation.id);
          }
          const syncState =
            conversation.syncState &&
            shouldApplySyncState(existing.syncState, conversation.syncState) &&
            !syncStateRenderFieldsEqual(
              existing.syncState,
              conversation.syncState
            )
              ? conversation.syncState
              : existing.syncState;
          const hasUnreadCompletion =
            conversation.status === "completed"
              ? (existing.hasUnreadCompletion ??
                conversation.hasUnreadCompletion ??
                false)
              : false;
          return {
            ...existing,
            ...conversation,
            ...titleFields,
            status,
            syncState,
            updatedAtUnixMs: shouldKeepExistingStatus
              ? existing.updatedAtUnixMs
              : titleFields.title === existing.title &&
                  titleFields.titleFallback === existing.titleFallback &&
                  status === existing.status &&
                  syncState === existing.syncState
                ? existing.updatedAtUnixMs
                : conversation.updatedAtUnixMs,
            hasUnreadCompletion
          };
        }
      );
      for (const conversation of current) {
        if (!snapshotIds.has(conversation.id)) {
          merged.push(conversation);
        }
      }
      return applyAgentGUIConversationProjects(merged, userProjects, {
        isNoProjectPath
      });
    });
    for (const conversationId of completedConversationIds) {
      markAgentGUIConversationCompletionObserved({
        query: conversationListQuery,
        conversationId
      });
    }
  }, [
    agentActivitySnapshot,
    conversationListQuery,
    data.provider,
    isNoProjectPath,
    previewMode,
    updateConversationList,
    userProjects
  ]);

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

  useEffect(() => {
    if (previewMode) {
      return;
    }
    updateConversationList((current) =>
      applyAgentGUIConversationProjects(current, userProjects, {
        isNoProjectPath
      })
    );
    setTransientConversation((current) =>
      current
        ? (applyAgentGUIConversationProjects([current], userProjects, {
            isNoProjectPath
          })[0] ?? current)
        : current
    );
  }, [
    isNoProjectPath,
    previewMode,
    setTransientConversation,
    updateConversationList,
    userProjects
  ]);

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
    persistedActiveConversationIdRef.current = data.lastActiveAgentSessionId;
    if (
      pendingLocalActiveConversationIdRef.current ===
      data.lastActiveAgentSessionId
    ) {
      pendingLocalActiveConversationIdRef.current = null;
    }
  }, [data]);

  useEffect(() => {
    isComposerHomeRef.current = isComposerHome;
  }, [isComposerHome]);

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
    onShowMessageRef.current = onShowMessage;
  }, [onShowMessage]);

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
    const previousSnapshot = previousConversationListSnapshotRef.current;
    const previousQuery = previousSnapshot.query;
    const previousQueryKey = previousQuery
      ? createAgentGUIConversationListQueryKey(previousQuery)
      : null;
    const nextQueryKey = conversationListQuery
      ? createAgentGUIConversationListQueryKey(conversationListQuery)
      : null;
    if (
      previousQuery &&
      conversationListQuery &&
      previousQueryKey !== nextQueryKey &&
      previousQuery.workspaceId === conversationListQuery.workspaceId &&
      previousQuery.provider === conversationListQuery.provider &&
      previousQuery.sessionOrigin === conversationListQuery.sessionOrigin &&
      previousSnapshot.conversations.length > 0
    ) {
      ensureAgentGUIConversationListQuery(conversationListQuery);
      updateAgentGUIConversationListConversations(
        conversationListQuery,
        (current) =>
          current.length === 0 ? previousSnapshot.conversations : current
      );
    }
    previousConversationListSnapshotRef.current = {
      query: conversationListQuery,
      conversations
    };
  }, [conversationListQuery, conversations, previewMode]);
  const persistActiveConversation = useCallback(
    (agentSessionId: string | null) => {
      if (persistedActiveConversationIdRef.current === agentSessionId) {
        return;
      }
      pendingLocalActiveConversationIdRef.current = agentSessionId;
      persistedActiveConversationIdRef.current = agentSessionId;
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
      metadata?: { action: "clear" | "create_new" | "select_existing" }
    ) => {
      const normalizedPath = normalizeProjectDraftPath(path);
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
        markSelectedConversationDetailPending(normalized);
      }
      if (pendingNewConversationId && pendingNewConversationId !== normalized) {
        activatedConversationIdsRef.current.delete(pendingNewConversationId);
        void activation.unactivate(pendingNewConversationId);
      }
      if (suppressedHomeConversationIdRef.current === normalized) {
        suppressedHomeConversationIdRef.current = null;
      }
      const shouldReloadConversations =
        options?.reloadConversations !== false &&
        conversationIdsRef.current.has(normalized);
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
      }
      persistActiveConversation(normalized);
    },
    [
      activation,
      conversationListQuery,
      markSelectedConversationDetailPending,
      persistActiveConversation
    ]
  );

  const syncConversationListProjection = useCallback(
    async (_preferredSessionId?: string | null) => {
      if (!conversationListQuery) {
        activeConversationIdRef.current = null;
        setActiveConversationId(null);
        persistActiveConversation(null);
        return;
      }
      ensureAgentGUIConversationListQuery(conversationListQuery);
      scheduleAgentGUIConversationListProjection(
        conversationListQuery,
        "projection-sync"
      );
    },
    [conversationListQuery, persistActiveConversation]
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
    const requestedConversationId = data.lastActiveAgentSessionId?.trim() ?? "";
    const explicitRequestedConversationId =
      pendingOpenSessionRequest?.agentSessionId.trim() ?? "";
    const effectiveRequestedConversationId =
      explicitRequestedConversationId || requestedConversationId;
    const hasExplicitOpenSessionRequest =
      explicitRequestedConversationId !== "";
    const requestedConversationExists =
      effectiveRequestedConversationId !== ""
        ? resolveConversationSummaryById(
            conversations,
            effectiveRequestedConversationId,
            transientConversationRef.current
          ) !== null
        : false;
    if (!effectiveRequestedConversationId) {
      externalConversationReloadAttemptRef.current = null;
      suppressedHomeConversationIdRef.current = null;
      return;
    }
    if (
      effectiveRequestedConversationId === activeConversationIdRef.current &&
      (!hasLoadedConversations || requestedConversationExists)
    ) {
      externalConversationReloadAttemptRef.current = null;
      if (hasExplicitOpenSessionRequest) {
        pendingOpenSessionRequestRef.current = null;
      }
      return;
    }
    if (
      !hasExplicitOpenSessionRequest &&
      (isComposerHomeRef.current ||
        suppressedHomeConversationIdRef.current ===
          effectiveRequestedConversationId)
    ) {
      return;
    }
    if (
      !hasExplicitOpenSessionRequest &&
      pendingLocalActiveConversationIdRef.current !== null &&
      effectiveRequestedConversationId !==
        pendingLocalActiveConversationIdRef.current &&
      externalConversationReloadAttemptRef.current !==
        effectiveRequestedConversationId
    ) {
      return;
    }
    if (hasExplicitOpenSessionRequest) {
      pendingLocalActiveConversationIdRef.current = null;
    }

    if (!requestedConversationExists) {
      if (
        effectiveRequestedConversationId === activeConversationIdRef.current &&
        hasLoadedConversations &&
        conversations.length > 0
      ) {
        externalConversationReloadAttemptRef.current = null;
        if (hasExplicitOpenSessionRequest) {
          pendingOpenSessionRequestRef.current = null;
        }
        const fallbackConversationId = selectAgentGUIConversationId(
          conversations,
          activeConversationIdRef.current
        );
        if (fallbackConversationId) {
          selectConversation(fallbackConversationId, {
            reloadConversations: false
          });
        }
        return;
      }
      if (
        hasLoadedConversations &&
        externalConversationReloadAttemptRef.current !==
          effectiveRequestedConversationId
      ) {
        externalConversationReloadAttemptRef.current =
          effectiveRequestedConversationId;
        void syncConversationListProjection(effectiveRequestedConversationId);
        return;
      }
      if (
        hasLoadedConversations &&
        !isLoadingConversations &&
        externalConversationReloadAttemptRef.current ===
          effectiveRequestedConversationId
      ) {
        externalConversationReloadAttemptRef.current = null;
        if (hasExplicitOpenSessionRequest) {
          pendingOpenSessionRequestRef.current = null;
        }
        const fallbackConversationId =
          isComposerHomeRef.current && !effectiveRequestedConversationId
            ? null
            : selectAgentGUIConversationId(
                conversations,
                activeConversationIdRef.current
              );
        if (fallbackConversationId) {
          selectConversation(fallbackConversationId, {
            reloadConversations: false
          });
        }
      }
      return;
    }

    externalConversationReloadAttemptRef.current = null;
    if (hasExplicitOpenSessionRequest) {
      pendingOpenSessionRequestRef.current = null;
    }
    selectConversation(effectiveRequestedConversationId, {
      reloadConversations: false
    });
  }, [
    conversations,
    data.lastActiveAgentSessionId,
    hasLoadedConversations,
    isLoadingConversations,
    openSessionRequest,
    syncConversationListProjection,
    selectConversation,
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
      const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
        durableMessages,
        localMessages
      });
      const mergedMessages = mergeWorkspaceAgentMessages(
        durableMessages,
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
      updateConversationList((current) => {
        const previous =
          current.find(
            (conversation) => conversation.id === normalizedAgentSessionId
          ) ?? null;
        if (!previous) {
          return current;
        }
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
          return current;
        }
        return current.map((conversation) =>
          conversation.id === normalizedAgentSessionId
            ? {
                ...conversation,
                ...(title
                  ? {
                      title: title.title,
                      titleFallback: title.titleFallback
                    }
                  : {}),
                status: settledStatus
              }
            : conversation
        );
      });
      if (activeConversationIdRef.current === normalizedAgentSessionId) {
        setIsLoadingMessages(false);
      }
      setAgentSessionViewMessagesLoading(
        sessionViewRef(normalizedAgentSessionId),
        false
      );
    },
    [sessionViewRef, updateConversationList]
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
      updateConversationList((current) =>
        current.map((conversation) => {
          if (conversation.id !== agentSessionId) {
            return conversation;
          }
          const timelineItems = projectAgentGUIMessagesToTimelineItems(
            resolveSessionMessages(agentSessionId)
          );
          const canSettleBusyStatus = canSettleBusyConversationFromSessionState(
            {
              timelineItems,
              syncState: conversation.syncState
            }
          );
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
          const nextConversation = {
            ...conversation,
            ...titleFields,
            status,
            updatedAtUnixMs: resolveConversationUpdatedAtUnixMsFromSessionState(
              {
                currentUpdatedAtUnixMs: conversation.updatedAtUnixMs,
                snapshotUpdatedAtUnixMs: shouldAdvanceConversationUpdatedAt
                  ? snapshot.updatedAtUnixMs
                  : undefined,
                source: cause?.source
              }
            ),
            hasUnreadCompletion:
              status === "completed"
                ? (conversation.hasUnreadCompletion ?? false)
                : false
          };
          return nextConversation;
        })
      );
      if (nextStatus === "completed" && conversationListQuery) {
        markAgentGUIConversationCompletionObserved({
          query: conversationListQuery,
          conversationId: agentSessionId
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
            activeConversationIdRef.current !== agentSessionId
        });
      }
    },
    [conversationListQuery, sessionViewRef, setTransientConversation]
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
        setAgentSessionViewControlState(
          sessionViewRef(agentSessionId),
          snapshot
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
          deleteAgentSessionView(sessionViewRef(agentSessionId));
          suppressedHomeConversationIdRef.current = agentSessionId;
          isComposerHomeRef.current = true;
          setIsComposerHome(true);
          activeConversationIdRef.current = null;
          setActiveConversationId(null);
          setIsLoadingMessages(false);
          setDetailError(null);
          persistActiveConversation(null);
          updateConversationList((current) =>
            current.filter((conversation) => conversation.id !== agentSessionId)
          );
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
      agentActivityRuntime,
      applySessionStateSnapshot,
      clearFailedLiveState,
      clearSelectedConversationNotFoundRetryWhenInitialLoadsSettled,
      markFailedLiveState,
      persistActiveConversation,
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
        const page = await agentActivityRuntime.listSessionMessages({
          workspaceId,
          agentSessionId: normalizedAgentSessionId
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
        clearSelectedConversationNotFoundRetryWhenInitialLoadsSettled(
          normalizedAgentSessionId
        );
        const durableMessages = mergeWorkspaceAgentMessages(
          [],
          agentActivitySnapshotRef.current.sessionMessagesById[
            normalizedAgentSessionId
          ] ?? []
        );
        const currentOverlayMessages =
          getAgentSessionView(sessionViewRef(normalizedAgentSessionId))
            ?.overlayMessages ?? [];
        const localMessages = mergeWorkspaceAgentMessages(
          currentOverlayMessages,
          page.messages as WorkspaceAgentActivityMessage[]
        );
        const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
          durableMessages,
          localMessages
        });
        setAgentSessionViewOverlayMessages(
          sessionViewRef(normalizedAgentSessionId),
          overlayMessages
        );
        refreshMessagesFromSnapshot(normalizedAgentSessionId);
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
      refreshMessagesFromSnapshot,
      scheduleSelectedConversationNotFoundRetry,
      sessionViewRef,
      workspaceId
    ]
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
        if (hadPendingMessageLoad) {
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

  const loadDraftComposerOptions = useCallback(
    (options?: { force?: boolean }): void => {
      // Composer options are loaded for every provider: besides settings they
      // carry the capabilities fallback and the skills list.
      const provider = dataRef.current.provider;
      if (isCreatingConversationRef.current) {
        return;
      }
      const settings = readNodeDefaultDraftSettings({
        data: dataRef.current,
        defaultReasoningEffort,
        drafts: draftSettingsBySessionIdRef.current
      });
      void Promise.resolve(
        agentActivityRuntime.getComposerOptions({
          workspaceId,
          cwd: selectedProjectPathRef.current ?? "",
          force: options?.force,
          provider,
          settings
        })
      ).catch(() => undefined);
    },
    [agentActivityRuntime, defaultReasoningEffort, workspaceId]
  );

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!supports.model && !supports.reasoning && !supports.permission) {
      return;
    }
    const projectKey = `${data.provider}\0${selectedProjectPath ?? ""}`;
    const previousProjectKey = composerOptionsProjectKeyRef.current;
    composerOptionsProjectKeyRef.current = projectKey;
    if (previousProjectKey === null || previousProjectKey === projectKey) {
      return;
    }
    loadDraftComposerOptions({ force: true });
  }, [
    data.provider,
    loadDraftComposerOptions,
    previewMode,
    selectedProjectPath,
    supports.model,
    supports.permission,
    supports.reasoning
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
        const provider = dataRef.current.provider;
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
    loadDraftComposerOptions();
  }, [
    activeConversationId,
    data.provider,
    isComposerHome,
    loadDraftComposerOptions,
    previewMode
  ]);

  const clearPendingSessionStateReload = useCallback(() => {
    if (stateReloadTimerRef.current !== null) {
      window.clearTimeout(stateReloadTimerRef.current);
      stateReloadTimerRef.current = null;
    }
    stateReloadQueuedRef.current = false;
    stateReloadTargetSessionIdRef.current = null;
    stateReloadCauseRef.current = null;
  }, []);

  const scheduleActivityStreamStateReload = useCallback(
    (
      agentSessionId: string,
      cause: {
        source: "activity-stream";
        eventType?: string;
        requestId?: number;
      }
    ) => {
      if (
        blockedActivityStreamStateReloadSessionIdsRef.current.has(
          agentSessionId
        )
      ) {
        return;
      }
      stateReloadTargetSessionIdRef.current = agentSessionId;
      stateReloadCauseRef.current = cause;
      if (stateReloadInFlightRef.current) {
        stateReloadQueuedRef.current = true;
        return;
      }
      if (stateReloadTimerRef.current !== null) {
        return;
      }
      stateReloadTimerRef.current = window.setTimeout(() => {
        stateReloadTimerRef.current = null;
        const targetSessionId = stateReloadTargetSessionIdRef.current;
        const pendingCause = stateReloadCauseRef.current;
        stateReloadTargetSessionIdRef.current = null;
        stateReloadCauseRef.current = null;
        if (
          !targetSessionId ||
          !pendingCause ||
          blockedActivityStreamStateReloadSessionIdsRef.current.has(
            targetSessionId
          ) ||
          activeConversationIdRef.current !== targetSessionId ||
          !isMountedRef.current
        ) {
          stateReloadQueuedRef.current = false;
          return;
        }
        stateReloadInFlightRef.current = true;
        void loadSessionState(targetSessionId, {
          ...pendingCause
        }).finally(() => {
          stateReloadInFlightRef.current = false;
          if (
            stateReloadQueuedRef.current &&
            activeConversationIdRef.current === targetSessionId &&
            isMountedRef.current
          ) {
            stateReloadQueuedRef.current = false;
            scheduleActivityStreamStateReload(targetSessionId, {
              source: "activity-stream",
              eventType: pendingCause.eventType,
              requestId: pendingCause.requestId
            });
            return;
          }
          stateReloadQueuedRef.current = false;
        });
      }, ACTIVITY_STREAM_STATE_RELOAD_DEBOUNCE_MS);
    },
    [loadSessionState]
  );

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
        updateConversationList((current) =>
          current.map((conversation) =>
            conversation.id === agentSessionId
              ? (() => {
                  const status = resolveConversationStatusAfterTimelineUpdate({
                    currentStatus: conversation.status,
                    incomingTimelineStatus: nextStatus,
                    sessionState,
                    timelineItems: merged
                  });
                  return {
                    ...conversation,
                    status,
                    updatedAtUnixMs: Math.max(
                      conversation.updatedAtUnixMs,
                      updatedAtUnixMs
                    ),
                    hasUnreadCompletion: false
                  };
                })()
              : conversation
          )
        );
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
    [resolveSessionMessages, sessionViewRef, setTransientConversation]
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
      updateConversationList((current) => {
        let changed = false;
        const next = current.map((conversation) => {
          if (conversation.id !== agentSessionId) {
            return conversation;
          }
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
            return conversation;
          }
          changed = true;
          return {
            ...conversation,
            status,
            updatedAtUnixMs: nextUpdatedAtUnixMs,
            hasUnreadCompletion: false
          };
        });
        return changed ? next : current;
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
    [setTransientConversation]
  );

  const recordLocalMessages = useCallback(
    (
      agentSessionId: string,
      nextMessages: readonly WorkspaceAgentActivityMessage[]
    ) => {
      if (nextMessages.length === 0) {
        return;
      }
      const currentMessages =
        getAgentSessionView(sessionViewRef(agentSessionId))?.overlayMessages ??
        [];
      const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
        durableMessages:
          agentActivitySnapshot.sessionMessagesById[agentSessionId],
        localMessages: mergeWorkspaceAgentMessages(
          currentMessages,
          nextMessages
        )
      });
      const mergedMessages = mergeWorkspaceAgentMessages(
        agentActivitySnapshot.sessionMessagesById[agentSessionId] ?? [],
        overlayMessages
      );
      const nextItems = projectAgentGUIMessagesToTimelineItems(nextMessages);
      const mergedItems =
        projectAgentGUIMessagesToTimelineItems(mergedMessages);
      setAgentSessionViewOverlayMessages(
        sessionViewRef(agentSessionId),
        overlayMessages
      );
      applyTimelineProjectionUpdate(agentSessionId, nextItems, mergedItems);
    },
    [
      agentActivitySnapshot.sessionMessagesById,
      applyTimelineProjectionUpdate,
      sessionViewRef
    ]
  );

  const applyStatePatch = useCallback(
    (patch: WorkspaceAgentActivityStatePatch) => {
      const agentSessionId = patch.agentSessionId.trim();
      if (!agentSessionId) {
        return;
      }
      const normalizedLastError = patch.lastError?.trim() ?? "";
      const nextStatus = conversationStatusFromStatePatch(patch);
      const hasControlStatePatch = hasSessionControlStatePatch(patch);
      const pendingTurnId =
        pendingTurnIdBySessionIdRef.current[agentSessionId]?.trim() ?? "";
      const patchTurnId = patch.turn?.turnId?.trim() ?? "";
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
      updateConversationList((current) => {
        let changed = false;
        const next = current.map((conversation) => {
          if (conversation.id !== agentSessionId) {
            return conversation;
          }
          const titleFields = mergeConversationTitleUpdateFields(
            conversation,
            patchTitle
          );
          const timelineItems = projectAgentGUIMessagesToTimelineItems(
            resolveSessionMessages(agentSessionId)
          );
          const status = resolveConversationStatusFromTimelineEvidence({
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
            !clearedPendingSubmittedTurn
          ) {
            return conversation;
          }
          changed = true;
          return {
            ...conversation,
            ...titleFields,
            status,
            hasUnreadCompletion
          };
        });
        return changed ? next : current;
      });
      if (nextStatus === "completed" && conversationListQuery) {
        markAgentGUIConversationCompletionObserved({
          query: conversationListQuery,
          conversationId: agentSessionId
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
        const transientStatus = resolveConversationStatusFromTimelineEvidence({
          status: nextStatus ?? transient.status,
          timelineItems
        });
        setTransientConversation({
          ...transient,
          ...transientTitleFields,
          status: transientStatus,
          hasUnreadCompletion:
            transientStatus === "completed" &&
            activeConversationIdRef.current !== agentSessionId
        });
      }
    },
    [
      resolveSessionMessages,
      sessionViewRef,
      setTransientConversation,
      statePatchErrorBySessionId,
      agentActivityRuntime,
      conversationListQuery,
      workspaceId
    ]
  );
  const handleActivityStreamEvent = useCallback(
    (event: AgentActivityStreamEvent) => {
      if (event.eventType === "available_commands_update") {
        return;
      }
      if (event.eventType === "message_update") {
        const message = messageFromMessageUpdate(event.data);
        const agentSessionId = message.agentSessionId.trim();
        if (agentSessionId) {
          applyBackgroundTimelineStatusUpdate(
            agentSessionId,
            projectAgentGUIMessagesToTimelineItems([message])
          );
        }
        return;
      }
      if (event.eventType === "state_patch") {
        applyStatePatch(event.data);
      }
    },
    [applyStatePatch, applyBackgroundTimelineStatusUpdate]
  );

  const handleBackgroundActivityStreamEvent = useCallback(
    (event: AgentActivityStreamEvent) => {
      if (event.eventType === "message_update") {
        handleActivityStreamEvent(event);
        return;
      }
      if (event.eventType === "state_patch") {
        applyStatePatch(event.data);
      }
    },
    [applyStatePatch, handleActivityStreamEvent]
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
      setDetailError(null);
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

  useAgentSessionDurableRefresh({
    agentSessionId: activeConversationId,
    sessionView: activeSessionView,
    blockControlStateRefresh:
      previewMode ||
      activeConversationId === null ||
      blockedActivityStreamStateReloadSessionIdsRef.current.has(
        activeConversationId
      ),
    onControlStateRefresh: () => {
      if (!activeConversationId) {
        return;
      }
      const requestId = ++activityStreamStateReloadSeqRef.current;
      void loadSessionState(activeConversationId, {
        source: "activity-stream",
        eventType: "state_patch",
        requestId
      });
    }
  });

  useWatchAgentSession({
    workspaceId,
    agentSessionId: activeConversationId,
    enabled: !previewMode && activeConversationId !== null,
    onSubscribe: () => {
      if (!activeConversationId) {
        return;
      }
    },
    onEvent: (event) => {
      if (!activeConversationId) {
        return;
      }
      handleActivityStreamEvent(event);
      const eventSessionId =
        event.data.agentSessionId?.trim() || activeConversationId;
      if (
        activeConversationIdRef.current !== activeConversationId ||
        activeConversationIdRef.current !== eventSessionId
      ) {
        return;
      }
      if (event.eventType === "config_options_update") {
        const requestId = ++activityStreamStateReloadSeqRef.current;
        scheduleActivityStreamStateReload(activeConversationId, {
          source: "activity-stream",
          eventType: event.eventType,
          requestId
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
    onEvent: (event) => {
      handleBackgroundActivityStreamEvent(event);
    }
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      clearPendingSessionStateReload();
      clearSelectedConversationNotFoundRetry();
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
  }, [clearPendingSessionStateReload, clearSelectedConversationNotFoundRetry]);

  const startConversation = useCallback(
    (initialContentInput?: unknown) => {
      if (
        isCreatingConversation ||
        (data.provider === "openclaw" && openclawGateway?.status !== "ready")
      ) {
        return;
      }
      const normalizedInitialContent = Array.isArray(initialContentInput)
        ? normalizeAgentPromptContentBlocks(
            initialContentInput as AgentPromptContentBlock[]
          )
        : textPromptContent(normalizeOptionalPrompt(initialContentInput));
      const normalizedInitialPrompt = agentPromptContentDisplayText(
        normalizedInitialContent
      );
      const initialConversationTitle =
        normalizedInitialPrompt || AGENT_PROVIDER_LABEL[data.provider];
      isCreatingConversationRef.current = true;
      setLocalIsCreatingConversation(true);
      setDetailError(null);
      let pendingCreateAgentSessionId: string | null = null;
      void (async () => {
        const provider = data.provider;
        const currentData =
          dataRef.current.provider === provider ? dataRef.current : data;
        const selectedProjectPath = selectedProjectPathRef.current;
        const initialNodeSettings = readNodeDefaultDraftSettings({
          data: currentData,
          defaultReasoningEffort,
          drafts: draftSettingsBySessionIdRef.current
        });
        const initialSettings = resolveEffectiveComposerSettings({
          settings: initialNodeSettings
        });
        const agentSessionId = createAgentGUIConversationId();
        pendingCreateAgentSessionId = agentSessionId;
        const createdAtUnixMs = Date.now();
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
        setTransientConversation(optimisticConversation);
        setAgentSessionViewMessagesLoading(
          sessionViewRef(agentSessionId),
          true
        );
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
          [agentSessionId]: initialSettings
        };
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [agentSessionId]: initialSettings
        }));
        setIsLoadingMessages(true);
        return activation.activate({
          mode: "new",
          agentSessionId,
          provider,
          cwd: selectedProjectPath ?? "",
          initialContent: normalizedInitialContent,
          title: initialConversationTitle,
          settings: initialSettings,
          openclawGatewayReady:
            provider === "openclaw"
              ? openclawGateway?.status === "ready"
              : undefined
        });
      })()
        .then((result) => {
          const agentSessionId = result.session.agentSessionId;
          if (conversationListQuery) {
            clearAgentGUIConversationCreatePending({
              query: conversationListQuery,
              ownerKey: pendingCreateOwnerKey,
              conversationId: agentSessionId
            });
          }
          const projectedConversation = conversationSummaryFromAgentSession(
            result.session,
            {
              isNoProjectPath: isNoProjectPathRef.current,
              userProjects: userProjectsRef.current
            }
          );
          const optimisticSortTimeUnixMs =
            transientConversationRef.current?.id === agentSessionId
              ? transientConversationRef.current.sortTimeUnixMs
              : undefined;
          const conversation: AgentGUIConversationSummary = {
            ...projectedConversation,
            sortTimeUnixMs: Math.max(
              projectedConversation.sortTimeUnixMs ?? 0,
              optimisticSortTimeUnixMs ?? 0
            )
          };
          failedNewConversationIdsRef.current.delete(conversation.id);
          if (startingConversationIdRef.current === agentSessionId) {
            startingConversationIdRef.current = null;
          }
          if (!isMountedRef.current) {
            void activation.unactivate(conversation.id);
            if (transientConversationRef.current?.id === agentSessionId) {
              setTransientConversation(null);
            }
            return;
          }
          const shouldAttachCreatedConversation =
            activeConversationIdRef.current === null &&
            isComposerHomeRef.current;
          if (
            !shouldAttachCreatedConversation &&
            unactivateIfStale(conversation.id)
          ) {
            if (transientConversationRef.current?.id === agentSessionId) {
              setTransientConversation(null);
            }
            return;
          }
          const activationFailed =
            result.activation.status === "failed" ||
            result.session.status === "failed";
          if (!activationFailed) {
            activatedConversationIdsRef.current.add(conversation.id);
          }
          setTransientConversation(conversation);
          if (conversationListQuery) {
            if (hasLoadedConversations) {
              upsertLocalCreatedAgentGUIConversation({
                query: conversationListQuery,
                conversation
              });
            }
            scheduleAgentGUIConversationListProjection(
              conversationListQuery,
              "local-create"
            );
          }
          isComposerHomeRef.current = false;
          setIsComposerHome(false);
          activeConversationIdRef.current = conversation.id;
          setActiveConversationId(conversation.id);
          setDraftBySessionId((current) => ({
            ...current,
            [nodeDefaultDraftContentKey(dataRef.current.provider)]:
              emptyAgentComposerDraft(),
            [conversation.id]: emptyAgentComposerDraft()
          }));
          persistActiveConversation(conversation.id);
          if (activationFailed) {
            failedNewConversationIdsRef.current.add(conversation.id);
            setIsLoadingMessages(false);
            void refreshMessagesFromSnapshot(conversation.id);
            void syncConversationListProjection(conversation.id);
            return;
          }
          void refreshMessagesFromSnapshot(conversation.id);
          void loadSessionState(conversation.id);
          void syncConversationListProjection(conversation.id);
        })
        .catch((error) => {
          const agentSessionId =
            startingConversationIdRef.current ?? createAgentGUIConversationId();
          if (conversationListQuery) {
            clearAgentGUIConversationCreatePending({
              query: conversationListQuery,
              ownerKey: pendingCreateOwnerKey,
              conversationId: pendingCreateAgentSessionId ?? agentSessionId
            });
          }
          const shouldShowFailedConversation =
            startingConversationIdRef.current === agentSessionId ||
            (activeConversationIdRef.current === null &&
              isComposerHomeRef.current);
          if (
            !shouldShowFailedConversation &&
            !isCurrentConversation(agentSessionId)
          ) {
            if (startingConversationIdRef.current === agentSessionId) {
              startingConversationIdRef.current = null;
            }
            if (transientConversationRef.current?.id === agentSessionId) {
              setTransientConversation(null);
            }
            return;
          }
          const message = getAgentGUIErrorMessage(error);
          reportAgentGUIRuntimeError({
            agentSessionId,
            error,
            phase: "create_conversation",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId
          });
          const failedAtUnixMs = Date.now();
          const failedConversation: AgentGUIConversationSummary = {
            id: agentSessionId,
            provider: dataRef.current.provider,
            title: initialConversationTitle,
            titleFallback: null,
            cwd: selectedProjectPathRef.current ?? "",
            project: resolveAgentGUIConversationProject(
              selectedProjectPathRef.current,
              userProjectsRef.current,
              { isNoProjectPath: isNoProjectPathRef.current }
            ),
            status: "failed",
            sortTimeUnixMs: failedAtUnixMs,
            updatedAtUnixMs: failedAtUnixMs
          };
          failedNewConversationIdsRef.current.add(agentSessionId);
          setTransientConversation(failedConversation);
          if (startingConversationIdRef.current === agentSessionId) {
            startingConversationIdRef.current = null;
          }
          isComposerHomeRef.current = false;
          setIsComposerHome(false);
          activeConversationIdRef.current = agentSessionId;
          setActiveConversationId(agentSessionId);
          setDraftBySessionId((current) => ({
            ...current,
            [nodeDefaultDraftContentKey(dataRef.current.provider)]:
              emptyAgentComposerDraft(),
            [agentSessionId]: emptyAgentComposerDraft()
          }));
          setIsLoadingMessages(false);
          setDetailError(message);
        })
        .finally(() => {
          isCreatingConversationRef.current = false;
          setLocalIsCreatingConversation(false);
        });
    },
    [
      currentUserId,
      data,
      defaultReasoningEffort,
      isCreatingConversation,
      openclawGateway?.status,
      syncConversationListProjection,
      loadSessionState,
      refreshMessagesFromSnapshot,
      persistActiveConversation,
      activation,
      conversationListQuery,
      isCurrentConversation,
      agentActivityRuntime,
      pendingCreateOwnerKey,
      unactivateIfStale,
      workspaceId
    ]
  );

  const createConversation = useCallback(
    (options?: { projectPath?: string | null }) => {
      if (options && "projectPath" in options) {
        const projectPath = normalizeProjectDraftPath(options.projectPath);
        selectedProjectPathRef.current = projectPath;
        setSelectedProjectPath(projectPath);
      }
      const previous = activeConversationIdRef.current;
      if (previous) {
        void activation.unactivate(previous);
      }
      suppressedHomeConversationIdRef.current =
        previous ?? dataRef.current.lastActiveAgentSessionId;
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      setIsLoadingMessages(false);
      setDetailError(null);
      persistActiveConversation(null);
      loadDraftComposerOptions();
    },
    [activation, loadDraftComposerOptions, persistActiveConversation]
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
    if (previous) {
      void activation.unactivate(previous);
    }
    suppressedHomeConversationIdRef.current =
      previous ?? dataRef.current.lastActiveAgentSessionId;
    isComposerHomeRef.current = true;
    setIsComposerHome(true);
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setIsLoadingMessages(false);
    setDetailError(null);
    setDraftBySessionId((current) => ({
      ...current,
      [nodeDefaultDraftContentKey(dataRef.current.provider)]: {
        ...emptyAgentComposerDraft(),
        prompt: draftPrompt
      }
    }));
    persistActiveConversation(null);
    loadDraftComposerOptions();
  }, [
    activation,
    loadDraftComposerOptions,
    persistActiveConversation,
    prefillPromptRequest,
    previewMode
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
    if (previous) {
      void activation.unactivate(previous);
    }
    suppressedHomeConversationIdRef.current =
      previous ?? dataRef.current.lastActiveAgentSessionId;
    isComposerHomeRef.current = true;
    setIsComposerHome(true);
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setIsLoadingMessages(false);
    setDetailError(null);
    setDraftBySessionId((current) => ({
      ...current,
      [nodeDefaultDraftContentKey(dataRef.current.provider)]: {
        prompt: nextDraftPrompt,
        images: []
      }
    }));
    persistActiveConversation(null);
    loadDraftComposerOptions();
  }, [
    accountProfilesByUserId,
    activation,
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
      queuedPromptId?: string | null
    ) => {
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (!agentSessionId || normalizedContent.length === 0) {
        return;
      }
      const submittedPromptText =
        agentPromptContentDisplayText(normalizedContent);
      const submittedAtUnixMs = Date.now();
      const previousConversationStatus =
        resolveConversationSummaryById(
          conversationsRef.current,
          agentSessionId,
          transientConversationRef.current
        )?.status ?? null;
      if (conversationListQuery) {
        markAgentGUIConversationSubmitPending({
          query: conversationListQuery,
          conversationId: agentSessionId
        });
      }
      setLocalIsSubmitting(true);
      setDetailError(null);
      updateConversationList((current) =>
        current.map((conversation) =>
          conversation.id === agentSessionId
            ? {
                ...conversation,
                status: "working",
                sortTimeUnixMs: Math.max(
                  conversation.sortTimeUnixMs ?? 0,
                  submittedAtUnixMs
                ),
                updatedAtUnixMs: Math.max(
                  conversation.updatedAtUnixMs,
                  submittedAtUnixMs
                )
              }
            : conversation
        )
      );
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
      applyStatePatch({
        agentSessionId,
        currentPhase: "working",
        occurredAtUnixMs: submittedAtUnixMs
      });
      void Promise.resolve()
        .then(() => {
          if (!isCurrentConversation(agentSessionId)) {
            return null;
          }
          return agentActivityRuntime.sendInput({
            workspaceId,
            agentSessionId,
            content: normalizedContent
          });
        })
        .then((result) => {
          if (!result || !isCurrentConversation(agentSessionId)) {
            return;
          }
          const submittedStatus = conversationStatusFromStatusValue(
            projectCoreSessionStatus(result.status)
          );
          if (submittedStatus && submittedStatus !== "ready") {
            updateConversationList((current) =>
              current.map((conversation) =>
                conversation.id === agentSessionId
                  ? {
                      ...conversation,
                      status: submittedStatus,
                      updatedAtUnixMs: Date.now()
                    }
                  : conversation
              )
            );
          }
          if (!queuedPromptId) {
            setDraftBySessionId((current) => {
              const currentDraft = current[agentSessionId];
              if (
                currentDraft?.prompt.trim() !== submittedPromptText ||
                currentDraft.images.length > 0
              ) {
                return current;
              }
              return {
                ...current,
                [agentSessionId]: emptyAgentComposerDraft()
              };
            });
          }
          if (queuedPromptId) {
            setQueuedPromptsBySessionId((current) => {
              const queue = current[agentSessionId] ?? [];
              if (
                queue.length === 0 ||
                !queue.some((item) => item.id === queuedPromptId)
              ) {
                return current;
              }
              return {
                ...current,
                [agentSessionId]: removeQueuedPromptById(queue, queuedPromptId)
              };
            });
            setSendNextQueuedPromptIdBySessionId((current) => {
              if (current[agentSessionId] !== queuedPromptId) {
                return current;
              }
              return { ...current, [agentSessionId]: null };
            });
            setFailedQueuedPromptIdBySessionId((current) => {
              if (current[agentSessionId] !== queuedPromptId) {
                return current;
              }
              return { ...current, [agentSessionId]: null };
            });
            setQueuedPromptRetryBlockBySessionId((current) => {
              if (current[agentSessionId]?.queuedPromptId !== queuedPromptId) {
                return current;
              }
              return { ...current, [agentSessionId]: null };
            });
          }
          const submittedTurnId =
            normalizeConfigOptionValue(recordValue(result)?.turnId) ?? "";
          if (submittedTurnId) {
            pendingTurnIdBySessionIdRef.current = {
              ...pendingTurnIdBySessionIdRef.current,
              [agentSessionId]: submittedTurnId
            };
            recordLocalMessages(agentSessionId, [
              createOptimisticPromptMessage({
                workspaceId,
                agentSessionId,
                turnId: submittedTurnId,
                userId: currentUserId?.trim() || "user",
                prompt: submittedPromptText,
                content: normalizedContent,
                occurredAtUnixMs: Date.now()
              })
            ]);
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
          const currentSessionState =
            getAgentSessionView(sessionViewRef(agentSessionId))?.controlState ??
            null;
          const currentConversationSummary = resolveConversationSummaryById(
            conversations,
            agentSessionId,
            transientConversationRef.current
          );
          const shouldRetryQueuedPromptOnNextActivity =
            queuedPromptId !== undefined &&
            isAgentSessionActiveTurnConflictError(error);
          if (
            !shouldRetryQueuedPromptOnNextActivity &&
            previousConversationStatus &&
            previousConversationStatus !== "working"
          ) {
            updateConversationList((current) =>
              current.map((conversation) =>
                conversation.id === agentSessionId &&
                conversation.status === "working"
                  ? {
                      ...conversation,
                      status: previousConversationStatus,
                      updatedAtUnixMs: Date.now()
                    }
                  : conversation
              )
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
          if (
            isCurrentConversation(agentSessionId) &&
            !shouldRetryQueuedPromptOnNextActivity
          ) {
            reportAgentGUIRuntimeError({
              agentSessionId,
              context: {
                queuedPrompt: queuedPromptId !== undefined,
                retryQueuedPromptOnNextActivity:
                  shouldRetryQueuedPromptOnNextActivity
              },
              error,
              phase: "send_prompt",
              provider: dataRef.current.provider,
              runtime: agentActivityRuntime,
              workspaceId
            });
            setDetailError(getAgentGUIErrorMessage(error));
          }
          if (queuedPromptId) {
            if (shouldRetryQueuedPromptOnNextActivity) {
              setQueuedPromptRetryBlockBySessionId((current) => ({
                ...current,
                [agentSessionId]: {
                  queuedPromptId,
                  sessionStateUpdatedAtUnixMs:
                    currentSessionState?.updatedAtUnixMs ?? null,
                  conversationUpdatedAtUnixMs:
                    currentConversationSummary?.updatedAtUnixMs ?? null
                }
              }));
            } else {
              setFailedQueuedPromptIdBySessionId((current) => ({
                ...current,
                [agentSessionId]: queuedPromptId
              }));
            }
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
          setDrainingQueuedPromptSessionId((current) =>
            current === agentSessionId ? null : current
          );
        });
    },
    [
      currentUserId,
      isCurrentConversation,
      applyStatePatch,
      conversations,
      conversationListQuery,
      syncConversationListProjection,
      loadSessionState,
      refreshMessagesFromSnapshot,
      recordLocalMessages,
      sessionViewRef,
      setTransientConversation,
      updateConversationList,
      workspaceId,
      agentActivityRuntime
    ]
  );

  useEffect(() => {
    executePromptRef.current = executePrompt;
  }, [executePrompt]);

  const queuePromptLocally = useCallback(
    (agentSessionId: string, content: readonly AgentPromptContentBlock[]) => {
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (!agentSessionId || normalizedContent.length === 0) {
        return;
      }
      const queuedPrompt: AgentGUIQueuedPromptVM = {
        id: `local-${createAgentGUIConversationId()}`,
        content: normalizedContent,
        createdAtUnixMs: Date.now()
      };
      setQueuedPromptsBySessionId((current) => ({
        ...current,
        [agentSessionId]: [...(current[agentSessionId] ?? []), queuedPrompt]
      }));
      setDraftBySessionId((current) => ({
        ...current,
        [agentSessionId]: emptyAgentComposerDraft()
      }));
      setDetailError(null);
    },
    []
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
      return agentActivityDisplayStatusBusy(
        agentActivityDisplayStatuses.get(normalizedAgentSessionId)
      );
    },
    [agentActivityDisplayStatuses, isRespondingApproval, isSubmitting]
  );

  const submitPrompt = useCallback(
    (content: AgentPromptContentBlock[]) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedContent = normalizeAgentPromptContentBlocks(content);
      if (normalizedContent.length === 0) {
        return;
      }
      if (
        resolvedPromptImagesSupported === false &&
        agentPromptContentHasImage(normalizedContent)
      ) {
        setDetailError(translate("agentHost.agentGui.promptImagesUnsupported"));
        return;
      }
      if (!agentSessionId) {
        startConversation(normalizedContent);
        return;
      }
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
      if (shouldQueuePromptLocally(agentSessionId)) {
        queuePromptLocally(agentSessionId, normalizedContent);
        return;
      }
      executePrompt(agentSessionId, normalizedContent);
    },
    [
      activation,
      executePrompt,
      isSessionMarkedNonResumable,
      resolvedPromptImagesSupported,
      queuePromptLocally,
      shouldQueuePromptLocally,
      startConversation
    ]
  );

  const submitCompact = useCallback(() => {
    submitPrompt(textPromptContent("/compact"));
  }, [submitPrompt]);

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
      const submittedPrompt = activePendingPromptRef.current;
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
          if (
            submittedPrompt?.requestId === normalizedRequestId &&
            submittedPrompt.kind === "exit-plan" &&
            input.action === "allow"
          ) {
            // Plan approved: leave plan mode so the next turn executes
            // instead of replanning. The approved option is the permission
            // mode the provider switches to, so mirror it in the dropdown.
            updateComposerSettingsRef.current({
              planMode: false,
              ...(normalizedOptionId
                ? { permissionModeId: normalizedOptionId }
                : {})
            });
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
          if (isCurrentConversation(agentSessionId)) {
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
          }
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

  const updateDraftContent = useCallback((draftContent: AgentComposerDraft) => {
    const agentSessionId = activeConversationIdRef.current;
    const draftKey =
      agentSessionId ?? nodeDefaultDraftContentKey(dataRef.current.provider);
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
      const { agentSessionId, nextNodeDefaults, sessionSettingsPatch } = input;
      const persistNodeDefaults = () => {
        const defaultDraftKey = nodeDefaultDraftKey(dataRef.current.provider);
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [defaultDraftKey]: nextNodeDefaults
        }));
        onDataChangeRef.current((current) =>
          nodeDataFromComposerSettings(current, nextNodeDefaults)
        );
      };
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
          const nextAppliedSettings = optimisticSettings
            ? {
                ...result.settings,
                ...optimisticSettings
              }
            : result.settings;
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
            persistNodeDefaults();
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
              sessionSettingsPatch: queuedUpdate.sessionSettingsPatch,
              nextNodeDefaults: queuedUpdate.nextNodeDefaults
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

  const updateComposerSettings = useCallback(
    (nextSettings: Partial<AgentSessionComposerSettings>) => {
      // Values pass through unclamped: the toggle visibility is capability
      // gated and the daemon clamps persisted settings per provider.
      const supportedNextSettings: Partial<AgentSessionComposerSettings> = {
        ...nextSettings
      };
      const agentSessionId = activeConversationIdRef.current;
      if (!agentSessionId) {
        const defaultDraftKey = nodeDefaultDraftKey(dataRef.current.provider);
        const storedDefaults = readNodeDefaultDraftSettings({
          data: dataRef.current,
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
            supportedNextSettings.browserUse ?? previousSettings.browserUse
        };
        draftSettingsBySessionIdRef.current = {
          ...draftSettingsBySessionIdRef.current,
          [defaultDraftKey]: merged
        };
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [defaultDraftKey]: merged
        }));
        onDataChangeRef.current((current) =>
          nodeDataFromComposerSettings(current, merged)
        );
        void agentActivityRuntime.trackDraftComposerSettingsChange?.({
          workspaceId,
          provider: dataRef.current.provider,
          previousSettings,
          nextSettings: merged
        });
        loadDraftComposerOptions();
        return;
      }
      const activeSessionState =
        getAgentSessionView(sessionViewRef(agentSessionId))?.controlState ??
        null;
      const sessionSettings = cloneComposerSettings(
        activeSessionState?.settings ?? null
      );
      const currentDefaults = readNodeDefaultDraftSettings({
        data: dataRef.current,
        defaultReasoningEffort,
        drafts: draftSettingsBySessionIdRef.current
      });
      const baseDefaultsFromSession: AgentSessionComposerSettings = {
        ...currentDefaults,
        model: sessionSettings?.model ?? currentDefaults.model,
        reasoningEffort:
          sessionSettings?.reasoningEffort ?? currentDefaults.reasoningEffort,
        speed: sessionSettings?.speed ?? currentDefaults.speed,
        planMode: sessionSettings?.planMode ?? currentDefaults.planMode,
        browserUse: sessionSettings?.browserUse ?? currentDefaults.browserUse,
        permissionModeId:
          sessionSettings?.permissionModeId ?? currentDefaults.permissionModeId
      };
      const nextNodeDefaults: AgentSessionComposerSettings = {
        ...baseDefaultsFromSession,
        model:
          supportedNextSettings.model !== undefined
            ? supportedNextSettings.model
            : baseDefaultsFromSession.model,
        reasoningEffort:
          supportedNextSettings.reasoningEffort !== undefined
            ? supportedNextSettings.reasoningEffort
            : baseDefaultsFromSession.reasoningEffort,
        speed:
          supportedNextSettings.speed !== undefined
            ? supportedNextSettings.speed
            : baseDefaultsFromSession.speed,
        planMode:
          supportedNextSettings.planMode ?? baseDefaultsFromSession.planMode,
        browserUse:
          supportedNextSettings.browserUse ??
          baseDefaultsFromSession.browserUse,
        permissionModeId:
          supportedNextSettings.permissionModeId !== undefined
            ? supportedNextSettings.permissionModeId
            : baseDefaultsFromSession.permissionModeId
      };
      const persistNodeDefaults = () => {
        const defaultDraftKey = nodeDefaultDraftKey(dataRef.current.provider);
        setDraftSettingsBySessionId((current) => ({
          ...current,
          [defaultDraftKey]: nextNodeDefaults
        }));
        onDataChangeRef.current((current) =>
          nodeDataFromComposerSettings(current, nextNodeDefaults)
        );
      };
      const nextPermission = normalizeOptionalText(
        nextSettings.permissionModeId ??
          sessionSettings?.permissionModeId ??
          currentDefaults.permissionModeId
      );
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
      const currentPlanMode = resolveEffectivePlanModeFromStates({
        sessionPlanModeState: planModeStateFromSessionState(activeSessionState),
        timelinePlanModeState:
          latestPlanModeStateFromTimelineItems(activeTimelineItems),
        fallbackPlanMode: sessionSettings?.planMode ?? false
      });
      const nextBrowserUse = supportedNextSettings.browserUse;
      const currentBrowserUse = sessionSettings?.browserUse ?? true;
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
        nextPermission &&
        nextPermission !== currentPermission &&
        activeSessionState !== null
      ) {
        sessionSettingsPatch.permissionModeId =
          normalizePermissionModeId(nextPermission);
      }
      if (
        Object.keys(sessionSettingsPatch).length > 0 &&
        activeSessionState !== null
      ) {
        persistNodeDefaults();
        updateAgentSessionViewControlState(
          sessionViewRef(agentSessionId),
          (existing) =>
            existing
              ? {
                  ...existing,
                  permissionModeId:
                    sessionSettingsPatch.permissionModeId ??
                    existing.permissionModeId,
                  runtimeContext: mergeRuntimeContextComposerSettings(
                    dataRef.current.provider,
                    existing.runtimeContext,
                    sessionSettingsPatch
                  ),
                  settings: {
                    ...(existing.settings ?? {}),
                    ...sessionSettingsPatch
                  }
                }
              : existing
        );
        if (updatingSessionSettingsIdsRef.current[agentSessionId]) {
          const queuedUpdate =
            queuedComposerSettingsUpdatesRef.current[agentSessionId];
          queuedComposerSettingsUpdatesRef.current[agentSessionId] = {
            sessionSettingsPatch: {
              ...(queuedUpdate?.sessionSettingsPatch ?? {}),
              ...sessionSettingsPatch
            },
            nextNodeDefaults
          };
        } else {
          markSessionSettingsRequestState(agentSessionId, true);
          flushQueuedComposerSettingsUpdate({
            agentSessionId,
            sessionSettingsPatch,
            nextNodeDefaults
          });
        }
        return;
      }
      persistNodeDefaults();
    },
    [
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

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!activeConversationId) {
      return;
    }
    const queuedPrompt =
      (queuedPromptsBySessionId[activeConversationId] ?? [])[0] ?? null;
    const failedQueuedPromptId =
      failedQueuedPromptIdBySessionId[activeConversationId] ?? null;
    const queuedPromptRetryBlock =
      queuedPromptRetryBlockBySessionId[activeConversationId] ?? null;
    const activeSessionState =
      getAgentSessionView(sessionViewRef(activeConversationId))?.controlState ??
      null;
    const activeConversationSummary = resolveConversationSummaryById(
      conversations,
      activeConversationId,
      transientConversationRef.current
    );
    const blockedByStaleActiveTurnConflict =
      queuedPrompt !== null &&
      queuedPromptRetryBlock?.queuedPromptId === queuedPrompt.id &&
      queuedPromptRetryBlock.sessionStateUpdatedAtUnixMs ===
        (activeSessionState?.updatedAtUnixMs ?? null) &&
      queuedPromptRetryBlock.conversationUpdatedAtUnixMs ===
        (activeConversationSummary?.updatedAtUnixMs ?? null);
    const canDrainQueuedPrompt =
      queuedPrompt !== null &&
      queuedPrompt.id !== failedQueuedPromptId &&
      !blockedByStaleActiveTurnConflict &&
      drainingQueuedPromptSessionId === null &&
      !isSubmitting &&
      !isRespondingApproval &&
      !agentActivityDisplayStatusBusy(
        agentActivityDisplayStatuses.get(activeConversationId)
      );
    if (!canDrainQueuedPrompt) {
      return;
    }
    setDrainingQueuedPromptSessionId(activeConversationId);
    executePrompt(activeConversationId, queuedPrompt.content, queuedPrompt.id);
  }, [
    activeConversationId,
    agentActivityDisplayStatuses,
    conversations,
    drainingQueuedPromptSessionId,
    executePrompt,
    isRespondingApproval,
    isSubmitting,
    failedQueuedPromptIdBySessionId,
    previewMode,
    queuedPromptRetryBlockBySessionId,
    queuedPromptsBySessionId
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!activeConversationId) {
      return;
    }
    const sendNextQueuedPromptId =
      sendNextQueuedPromptIdBySessionId[activeConversationId] ?? null;
    const queuedPrompts = queuedPromptsBySessionId[activeConversationId] ?? [];
    if (
      !sendNextQueuedPromptId ||
      queuedPrompts[0]?.id !== sendNextQueuedPromptId
    ) {
      return;
    }
    const activeSessionState =
      getAgentSessionView(sessionViewRef(activeConversationId))?.controlState ??
      null;
    const activeConversationSummary = resolveConversationSummaryById(
      conversations,
      activeConversationId,
      transientConversationRef.current
    );
    const activeActivityDisplayStatus =
      agentActivityDisplayStatuses.get(activeConversationId) ?? null;
    const shouldInterrupt =
      drainingQueuedPromptSessionId === null &&
      !isSubmitting &&
      activeActivityDisplayStatus === "working";
    if (!shouldInterrupt || interruptingSessionIds[activeConversationId]) {
      return;
    }

    setInterruptingSessionIds((current) => ({
      ...current,
      [activeConversationId]: true
    }));
    setDetailError(null);
    void Promise.resolve()
      .then(() => {
        if (!isCurrentConversation(activeConversationId)) {
          return null;
        }
        return agentActivityRuntime.cancelSession({
          workspaceId,
          agentSessionId: activeConversationId
        });
      })
      .then((result) => {
        if (!result || !isCurrentConversation(activeConversationId)) {
          return;
        }
        reportAgentGUICancelDiagnostic({
          agentSessionId: activeConversationId,
          busySource: cancelBusySource({
            conversationStatus: activeConversationSummary?.status ?? null,
            hasActivePrompt: false,
            runtimeSessionStatus:
              runtimeSessionsBySessionId.get(activeConversationId)?.status ??
              null,
            sessionStateStatus: activeSessionState?.status ?? null
          }),
          currentSessionStatus: activeSessionState?.status ?? null,
          phase: "drain_queued_prompt_interrupt",
          provider: dataRef.current.provider,
          result,
          runtime: agentActivityRuntime,
          workspaceId
        });
        void refreshMessagesFromSnapshot(activeConversationId);
        void loadSessionState(activeConversationId);
        void syncConversationListProjection(activeConversationId);
      })
      .catch((error) => {
        if (isCurrentConversation(activeConversationId)) {
          reportAgentGUIRuntimeError({
            agentSessionId: activeConversationId,
            error,
            phase: "drain_queued_prompt_interrupt",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId
          });
          setDetailError(getAgentGUIErrorMessage(error));
        }
      })
      .finally(() => {
        setInterruptingSessionIds((current) => {
          if (!current[activeConversationId]) {
            return current;
          }
          const next = { ...current };
          delete next[activeConversationId];
          return next;
        });
      });
  }, [
    activeConversationId,
    agentActivityDisplayStatuses,
    conversations,
    drainingQueuedPromptSessionId,
    interruptingSessionIds,
    isCurrentConversation,
    isSubmitting,
    syncConversationListProjection,
    loadSessionState,
    refreshMessagesFromSnapshot,
    previewMode,
    queuedPromptsBySessionId,
    runtimeSessionsBySessionId,
    workspaceId,
    sessionViewRef,
    sendNextQueuedPromptIdBySessionId,
    agentActivityRuntime
  ]);

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

  const removeQueuedPrompt = useCallback((queuedPromptId: string) => {
    const agentSessionId = activeConversationIdRef.current;
    const normalizedQueuedPromptId = queuedPromptId.trim();
    if (!agentSessionId || !normalizedQueuedPromptId) {
      return;
    }
    setQueuedPromptsBySessionId((current) => {
      const queue = current[agentSessionId] ?? [];
      const queuedPrompt =
        queue.find((item) => item.id === normalizedQueuedPromptId) ?? null;
      if (!queuedPrompt) {
        return current;
      }
      return {
        ...current,
        [agentSessionId]: removeQueuedPromptById(
          queue,
          normalizedQueuedPromptId
        )
      };
    });
    setSendNextQueuedPromptIdBySessionId((current) => {
      if (current[agentSessionId] !== normalizedQueuedPromptId) {
        return current;
      }
      return { ...current, [agentSessionId]: null };
    });
    setFailedQueuedPromptIdBySessionId((current) => {
      if (current[agentSessionId] !== normalizedQueuedPromptId) {
        return current;
      }
      return { ...current, [agentSessionId]: null };
    });
    setQueuedPromptRetryBlockBySessionId((current) => {
      if (
        current[agentSessionId]?.queuedPromptId !== normalizedQueuedPromptId
      ) {
        return current;
      }
      return { ...current, [agentSessionId]: null };
    });
  }, []);

  const editQueuedPrompt = useCallback(
    (queuedPromptId: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (!agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      const queue = queuedPromptsBySessionId[agentSessionId] ?? [];
      const queuedPrompt =
        queue.find((item) => item.id === normalizedQueuedPromptId) ?? null;
      if (!queuedPrompt) {
        return;
      }
      setQueuedPromptsBySessionId((current) => ({
        ...current,
        [agentSessionId]: removeQueuedPromptById(
          current[agentSessionId] ?? [],
          normalizedQueuedPromptId
        )
      }));
      setDraftBySessionId((current) => ({
        ...current,
        [agentSessionId]: agentPromptContentToComposerDraft(
          queuedPrompt.content,
          `restore-${queuedPrompt.id}`
        )
      }));
      setSendNextQueuedPromptIdBySessionId((current) => {
        if (current[agentSessionId] !== normalizedQueuedPromptId) {
          return current;
        }
        return { ...current, [agentSessionId]: null };
      });
      setFailedQueuedPromptIdBySessionId((current) => {
        if (current[agentSessionId] !== normalizedQueuedPromptId) {
          return current;
        }
        return { ...current, [agentSessionId]: null };
      });
      setQueuedPromptRetryBlockBySessionId((current) => {
        if (
          current[agentSessionId]?.queuedPromptId !== normalizedQueuedPromptId
        ) {
          return current;
        }
        return { ...current, [agentSessionId]: null };
      });
    },
    [queuedPromptsBySessionId]
  );

  const sendQueuedPromptNext = useCallback(
    (queuedPromptId: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (!agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      const queue = [...(queuedPromptsBySessionId[agentSessionId] ?? [])];
      const queueIndex = queue.findIndex(
        (item) => item.id === normalizedQueuedPromptId
      );
      if (queueIndex < 0) {
        return;
      }
      if (queueIndex > 0) {
        const [selected] = queue.splice(queueIndex, 1);
        queue.unshift(selected!);
      }
      setQueuedPromptsBySessionId((current) => ({
        ...current,
        [agentSessionId]: queue
      }));
      setSendNextQueuedPromptIdBySessionId((current) => ({
        ...current,
        [agentSessionId]: normalizedQueuedPromptId
      }));
      setFailedQueuedPromptIdBySessionId((current) => {
        if (current[agentSessionId] !== normalizedQueuedPromptId) {
          return current;
        }
        return { ...current, [agentSessionId]: null };
      });
      setQueuedPromptRetryBlockBySessionId((current) => {
        if (
          current[agentSessionId]?.queuedPromptId !== normalizedQueuedPromptId
        ) {
          return current;
        }
        return { ...current, [agentSessionId]: null };
      });
    },
    [queuedPromptsBySessionId]
  );

  const removeProject = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      const remove = agentHostApi.userProjects?.remove;
      if (!normalizedPath || !remove) {
        return;
      }
      const previousProjects = userProjectsRef.current;
      setListError(null);
      setUserProjectsSnapshot(
        previousProjects.filter((project) => project.path !== normalizedPath)
      );
      const handleRemoveError = (error: unknown) => {
        const message = getAgentGUIErrorMessage(error);
        setUserProjectsSnapshot(previousProjects);
        setListError(message);
        toast.error(message);
      };
      try {
        void Promise.resolve(remove({ path: normalizedPath })).catch(
          handleRemoveError
        );
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
          normalizeProjectConversationPath(conversation.project?.path) ===
          normalizedPath
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
        label:
          project?.label?.trim() ||
          targetConversations[0]?.project?.label ||
          path,
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
        setQueuedPromptsBySessionId((current) => {
          if (!current[target.id]) {
            return current;
          }
          const next = { ...current };
          delete next[target.id];
          return next;
        });
        setSendNextQueuedPromptIdBySessionId((current) => {
          if (!(target.id in current)) {
            return current;
          }
          const next = { ...current };
          delete next[target.id];
          return next;
        });
        setFailedQueuedPromptIdBySessionId((current) => {
          if (!(target.id in current)) {
            return current;
          }
          const next = { ...current };
          delete next[target.id];
          return next;
        });
        setQueuedPromptRetryBlockBySessionId((current) => {
          if (!(target.id in current)) {
            return current;
          }
          const next = { ...current };
          delete next[target.id];
          return next;
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
          } else {
            clearSelectedConversationNotFoundRetry();
            setIsLoadingMessages(false);
          }
          activeConversationIdRef.current = nextActive;
          setActiveConversationId(nextActive);
          persistActiveConversation(nextActive);
        }
        updateConversationList((current) =>
          current.filter((conversation) => conversation.id !== target.id)
        );
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
    updateConversationList
  ]);

  const confirmDeleteProjectConversations = useCallback(
    (path?: string) => {
      const normalizedPath = normalizeProjectConversationPath(path);
      const target =
        normalizedPath !== ""
          ? {
              conversationCount: conversationsRef.current.filter(
                (conversation) =>
                  normalizeProjectConversationPath(
                    conversation.project?.path
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
          normalizeProjectConversationPath(conversation.project?.path) ===
          target.path
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
          setQueuedPromptsBySessionId((current) =>
            omitConversationLocalState(current, targetIds)
          );
          setSendNextQueuedPromptIdBySessionId((current) =>
            omitConversationLocalState(current, targetIds)
          );
          setFailedQueuedPromptIdBySessionId((current) =>
            omitConversationLocalState(current, targetIds)
          );
          setQueuedPromptRetryBlockBySessionId((current) =>
            omitConversationLocalState(current, targetIds)
          );
          const nextConversations = conversationsRef.current.filter(
            (conversation) => !targetIds.has(conversation.id)
          );
          const currentActiveId = activeConversationIdRef.current;
          if (currentActiveId && targetIds.has(currentActiveId)) {
            const nextActive = nextConversations[0]?.id ?? null;
            if (nextActive) {
              markSelectedConversationDetailPending(nextActive);
            } else {
              clearSelectedConversationNotFoundRetry();
              setIsLoadingMessages(false);
            }
            activeConversationIdRef.current = nextActive;
            setActiveConversationId(nextActive);
            persistActiveConversation(nextActive);
          }
          updateConversationList((current) =>
            current.filter((conversation) => !targetIds.has(conversation.id))
          );
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
      isDeletingProjectConversations,
      markSelectedConversationDetailPending,
      pendingDeleteProjectConversations,
      persistActiveConversation,
      sessionViewRef,
      setTransientConversation,
      updateConversationList,
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
      updateConversationList((current) =>
        current.map((conversation) =>
          conversation.id === normalizedAgentSessionId
            ? { ...conversation, pinnedAtUnixMs: optimisticPinnedAtUnixMs }
            : conversation
        )
      );
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
          updateConversationList((current) =>
            current.map((conversation) =>
              conversation.id === normalizedAgentSessionId
                ? { ...conversation, pinnedAtUnixMs }
                : conversation
            )
          );
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
          updateConversationList(() => previousConversations);
          setTransientConversation((current) => {
            const previous = previousConversations.find(
              (conversation) => conversation.id === normalizedAgentSessionId
            );
            return current?.id === normalizedAgentSessionId && previous
              ? previous
              : current;
          });
        });
    },
    [agentActivityRuntime, updateConversationList, workspaceId]
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
  const visibleConversationsRef = useRef<AgentGUIConversationSummary[] | null>(
    null
  );
  const visibleConversations = useMemo(() => {
    const source = isLoadingConversations
      ? mergeVisibleConversations(
          conversations,
          transientConversationRef.current
        )
      : conversations;
    const next = source.map((conversation) => {
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
    const stableNext = stableConversationSummaryList(
      visibleConversationsRef.current,
      next
    );
    visibleConversationsRef.current = stableNext;
    return stableNext;
  }, [
    agentActivityDisplayStatuses,
    conversations,
    isLoadingConversations,
    stableRuntimeSyncStateBySessionId,
    transientConversation
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
      if (
        previous &&
        previous.id === activeConversation.id &&
        previous.userId === activeConversation.userId &&
        previous.provider === activeConversation.provider &&
        previous.title === activeConversation.title &&
        previous.titleFallback === activeConversation.titleFallback &&
        previous.status === activeConversation.status &&
        previous.cwd === activeConversation.cwd &&
        previous.project === activeConversation.project
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
            project: activeConversation.project,
            updatedAtUnixMs: activeConversation.updatedAtUnixMs,
            syncState: activeConversation.syncState
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
      activeConversation?.project,
      activeConversation?.status,
      activeConversation?.title,
      activeConversation?.titleFallback,
      activeConversation?.userId
    ]);
  const draftContent = activeConversationId
    ? (draftBySessionId[activeConversationId] ?? EMPTY_AGENT_COMPOSER_DRAFT)
    : readNodeDefaultDraftContent({
        data,
        drafts: draftBySessionId
      });
  const draftPrompt = draftContent.prompt;
  const availableCommands =
    activeSessionView?.controlCommands ?? EMPTY_AGENT_GUI_AVAILABLE_COMMANDS;
  const timelinePlanModeState = useMemo(
    () => latestPlanModeStateFromTimelineItems(activeTimelineItems),
    [activeTimelineItems]
  );
  const sessionPlanModeState = useMemo(
    () => planModeStateFromSessionState(activeSessionState),
    [activeSessionState]
  );
  const availableSkills = useStableProviderSkillOptions(
    useMemo(
      () => providerSkillsFromComposerOptions(providerComposerOptions),
      [providerComposerOptions]
    )
  );
  const conversationDetail = useMemo(
    () =>
      projectionConversation
        ? buildAgentGUIConversationDetail({
            timelineItems: activeTimelineItems,
            conversation: projectionConversation,
            workspaceRoot: workspacePath
          })
        : null,
    [activeTimelineItems, projectionConversation, workspacePath]
  );
  const conversation = useMemo(
    () =>
      projectionConversation
        ? buildAgentGUIConversationVM({
            timelineItems: activeTimelineItems,
            conversation: projectionConversation,
            workspaceRoot: workspacePath,
            avoidGroupingEdits
          })
        : null,
    [
      activeTimelineItems,
      avoidGroupingEdits,
      projectionConversation,
      workspacePath
    ]
  );
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
  const queuedPrompts = useMemo(
    () =>
      activeConversationId !== null
        ? (queuedPromptsBySessionId[activeConversationId] ?? [])
        : [],
    [activeConversationId, queuedPromptsBySessionId]
  );
  const drainingQueuedPromptId =
    drainingQueuedPromptSessionId === activeConversationId
      ? (queuedPrompts[0]?.id ?? null)
      : null;
  const sessionSettings = useStableComposerSettings(
    cloneComposerSettings(activeSessionState?.settings ?? null)
  );
  const storedNodeDefaultSettings = useStableComposerSettings(
    readNodeDefaultDraftSettings({
      data,
      defaultReasoningEffort,
      drafts: draftSettingsBySessionId
    })
  );
  const homeComposerSettings = useStableComposerSettings(
    resolveEffectiveComposerSettings({
      settings: storedNodeDefaultSettings
    })
  );
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
  const draftModel = normalizeOptionalText(draftSettings.model);
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
  const activeActivityDisplayStatus = activeConversationId
    ? (agentActivityDisplayStatuses.get(activeConversationId) ?? null)
    : null;
  const activeHasPendingSubmittedTurn = activeConversationId
    ? Boolean(pendingTurnIdBySessionIdRef.current[activeConversationId])
    : false;
  const activeConversationBusy =
    agentActivityDisplayStatusBusy(activeActivityDisplayStatus) ||
    activeHasPendingSubmittedTurn;
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
        activeLiveState === "activating"
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
    activeConversationResumeUnavailable,
    activeSessionState,
    hasProviderSessionNotFoundError,
    pendingApproval
  ]);
  const canSubmit =
    activeLiveState !== "activating" &&
    activeLiveState !== "failed" &&
    !activeConversationResumeUnavailable &&
    (data.provider !== "openclaw" || openclawGateway?.status === "ready") &&
    pendingApproval === null &&
    pendingInteractivePrompt === null &&
    sessionChrome.auth === null &&
    !isCreatingConversation &&
    !isSubmitting &&
    !isInterrupting;
  const canQueueWhileBusy =
    Boolean(activeConversationId) && (activeConversationBusy || isSubmitting);
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
  const effectivePlanMode = useMemo(
    () =>
      resolveEffectivePlanModeFromStates({
        sessionPlanModeState,
        timelinePlanModeState,
        fallbackPlanMode: Boolean(draftSettings.planMode)
      }),
    [draftSettings.planMode, sessionPlanModeState, timelinePlanModeState]
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
        permissionModeId: normalizePermissionModeId(
          draftSettings.permissionModeId
        )
      },
      effectivePlanMode: composerSupport.plan ? effectivePlanMode : false,
      supportsModel: composerSupport.model,
      supportsReasoningEffort: composerSupport.reasoning,
      supportsSpeed: composerSupport.speed,
      supportsBrowser: composerSupport.browser,
      supportsPermissionMode,
      supportsPlanMode: composerSupport.plan,
      isSettingsLoading,
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
      planUnavailable:
        activeConversationId !== null &&
        sessionSettings === null &&
        composerSupport.plan &&
        !effectivePlanMode,
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
        ? permissionModeOptions(data.provider, permissionConfig)
        : []
    };
  }, [
    activeConversationId,
    activeConversation?.cwd,
    activeSessionModelSelection,
    activeSessionReasoningSelection,
    activeSessionSpeedSelection,
    draftSettings.permissionModeId,
    draftSettings.planMode,
    effectivePlanMode,
    providerComposerOptions,
    sessionSettings,
    selectedProjectPath,
    composerSupport,
    timelinePlanModeState,
    draftModel,
    draftReasoningEffort,
    draftSpeed
  ]);
  const stableComposerSettings = useStableComposerSettingsVM(composerSettings);

  const stableCreateConversation =
    useStableControllerEventCallback(createConversation);
  const stableSelectConversation =
    useStableControllerEventCallback(selectConversation);
  const stableSubmitPrompt = useStableControllerEventCallback(submitPrompt);
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
  const stableSubmitCompact = useStableControllerEventCallback(submitCompact);
  const stableDismissUsageAlert =
    useStableControllerEventCallback(dismissUsageAlert);
  const controllerActions = useMemo(
    () => ({
      createConversation: stableCreateConversation,
      selectConversation: stableSelectConversation,
      submitPrompt: stableSubmitPrompt,
      submitCompact: stableSubmitCompact,
      dismissUsageAlert: stableDismissUsageAlert,
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
      stableConfirmDeleteProjectConversations,
      stableContinueInNewConversation,
      stableCreateConversation,
      stableDismissUsageAlert,
      stableEditQueuedPrompt,
      stableInterruptCurrentTurn,
      stableRemoveProject,
      stableRemoveQueuedPrompt,
      stableRequestDeleteConversation,
      stableRequestDeleteProjectConversations,
      stableRetryActivation,
      stableRetryOpenclawGateway,
      stableSelectConversation,
      stableSendQueuedPromptNext,
      stableShowPromptImagesUnsupported,
      stableSubmitApprovalOption,
      stableSubmitCompact,
      stableSubmitInteractivePrompt,
      stableSubmitPrompt,
      stableToggleConversationPinned,
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
        data,
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
        isCreatingConversation,
        isSubmitting,
        isInterrupting,
        isRespondingApproval,
        promptImagesSupported,
        compactSupported,
        usage,
        usageAlert,
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
        detailError
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
      conversationDetail,
      controllerActions,
      data,
      detailError,
      draftContent,
      draftPrompt,
      isCreatingConversation,
      openclawGateway,
      promptImagesSupported,
      compactSupported,
      usage,
      usageAlert,
      dismissUsageAlert,
      isInterrupting,
      isLoadingConversations,
      isLoadingMessages,
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
      queuedPrompts,
      drainingQueuedPromptId,
      currentUserId,
      workspaceId,
      workspacePath,
      stableComposerSettings,
      sessionChrome,
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
      title: prompt.toolName?.trim() || "Exit plan mode"
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
