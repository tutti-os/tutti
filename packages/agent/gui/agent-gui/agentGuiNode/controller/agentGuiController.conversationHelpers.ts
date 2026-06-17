// Agent GUI controller — conversation list, sync state, and status projection.

import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import { resolveAgentGUIExplicitConversationTitle } from "../model/agentGuiProviderIdentity";
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  WorkspaceAgentActivityStatePatch,
  WorkspaceAgentActivitySyncState,
  WorkspaceAgentActivityTimelineItem
} from "../../../shared/workspaceAgentActivityTypes";
import {
  normalizeOptionalText,
  recordValue,
  stringPayloadValue
} from "./agentGuiController.promptHelpers";
import {
  normalizeTimelineStatus,
  timelineItemTime
} from "./agentGuiController.sessionHelpers";
import {
  normalizePermissionModeId,
  sameComposerSettings
} from "./agentGuiController.composerHelpers";

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

export function resolveConversationSummaryById(
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

export function mergeVisibleConversations(
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

export function stableConversationSummaryList(
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

export function mergeConversationTitleUpdateFields(
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

export function hasPromptConversationTitle(
  conversation: AgentGUIConversationSummary
): boolean {
  return resolveAgentGUIExplicitConversationTitle(conversation) !== null;
}

export function syncStateUpdatedAtUnixMs(
  syncState: WorkspaceAgentActivitySyncState | null | undefined
): number | null {
  const updatedAtUnixMs = syncState?.updatedAtUnixMs;
  return typeof updatedAtUnixMs === "number" && Number.isFinite(updatedAtUnixMs)
    ? updatedAtUnixMs
    : null;
}

export function shouldApplySyncState(
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

export function hasPendingSyncReplay(
  syncState: WorkspaceAgentActivitySyncState | null | undefined
): boolean {
  const status = syncState?.status.trim().toLowerCase() ?? "";
  return (
    status === "pending" ||
    (syncState?.pendingTimelineItemCount ?? 0) > 0 ||
    (syncState?.pendingStatePatchCount ?? 0) > 0
  );
}

export function hasSettledTimelineEvidence(
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

export function canSettleBusyConversationFromSessionState(input: {
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

export function isSettledConversationStatus(
  status: AgentGUIConversationSummary["status"]
): status is Exclude<
  AgentGUIConversationSummary["status"],
  "working" | "waiting"
> {
  return !conversationBusyStatus(status);
}

export function settledConversationStatusFromSessionState(input: {
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

export function resolveConversationStatusFromTimelineEvidence(input: {
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

export function hasRejectedApprovalDecision(
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

export function isRejectedApprovalDecision(
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

export function normalizeApprovalDecisionToken(value: string): string {
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

export function conversationSyncStatesEqual(
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

export function mergeConversationSummaryWithRuntimeSession(input: {
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

export function runtimeSessionSyncState(
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
export function conversationBusyStatus(
  status: AgentGUIConversationSummary["status"] | null
): boolean {
  return status === "working" || status === "waiting";
}

export function agentSessionStatusBusy(input: {
  lifecycleStatus?: string;
  effectiveStatus?: string;
  status?: string;
  turnPhase?: string;
  currentPhase?: string;
}): boolean {
  const normalized = normalizeOptionalWorkspaceAgentStatus(input);
  return normalized?.kind === "working" || normalized?.kind === "waiting";
}

export function conversationHasActiveWork(
  conversation: AgentConversationVM | null | undefined
): boolean {
  return (
    conversation?.rows.some((row) => {
      switch (row.kind) {
        case "processing":
          return true;
        case "tool-group":
          return row.calls.some(
            (call) =>
              call.statusKind === "working" || call.statusKind === "waiting"
          );
        case "message":
          return row.thinking.some(
            (thinking) =>
              thinking.statusKind === "working" ||
              thinking.statusKind === "waiting"
          );
        default:
          return false;
      }
    }) ?? false
  );
}
export function conversationStatusFromStatePatch(
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

export function hasSessionControlStatePatch(
  patch: WorkspaceAgentActivityStatePatch
): boolean {
  return (
    normalizeOptionalText(patch.permissionModeId) !== null ||
    patch.settings !== undefined ||
    patch.runtimeContext !== undefined
  );
}

export function mergeSessionControlStatePatch(
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
    if (patch.settings.planMode !== undefined) {
      nextSettings.planMode = Boolean(patch.settings.planMode);
    }
    if (patch.settings.browserUse !== undefined) {
      nextSettings.browserUse = patch.settings.browserUse;
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

export function conversationStatusFromSessionState(
  state: AgentSessionState
): AgentGUIConversationSummary["status"] | null {
  return conversationStatusFromStatusValue(state.status);
}

export function conversationStatusFromStatusValue(
  value: string | null | undefined
): AgentGUIConversationSummary["status"] | null {
  return normalizeOptionalWorkspaceAgentStatus({ status: value })?.kind ?? null;
}

export function conversationStatusFromTimelineItems(
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
export function normalizeProjectConversationPath(
  path: string | null | undefined
): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

export function omitConversationLocalState<T>(
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
