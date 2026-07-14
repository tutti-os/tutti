import type {
  AgentActivityComposerOptions,
  AgentActivityDisplayStatus,
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { type AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort
} from "../../../shared/agentSessionTypes";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIAgentTarget
} from "../../../types";
import {
  emptyAgentComposerDraft,
  materializePastedTextInstructions
} from "../model/agentComposerDraft";
import { type AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
  AgentGUIQueuedPromptVM,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import {
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
  recordValue,
  stringPayloadValue
} from "./agentGuiController.promptHelpers";
export {
  normalizePermissionModeSemantic,
  permissionConfigFromComposerOptions,
  permissionModeDescription,
  permissionModeLabel,
  permissionModeOptions
} from "./agentGuiController.composerHelpers";
export {
  agentGUIConversationDiagnosticDetails,
  agentGUIRuntimeSessionDiagnosticDetails,
  agentGUISessionStateDiagnosticDetails,
  agentGUIToolCallStatusIsWaiting,
  promptRequestId
} from "./agentGuiController.diagnostics";
export * from "./agentGuiController.errors";
export {
  createAgentGUIConversationId,
  normalizeOptionalPrompt,
  normalizeOptionalText,
  projectAgentGUIMessagesToTimelineItems,
  recordValue,
  stringPayloadValue
} from "./agentGuiController.promptHelpers";
export * from "./agentGuiController.providerHelpers";
export {
  messageFromMessageUpdate,
  normalizedPositiveNumber,
  normalizeTimelineStatus,
  timelineItemTime
} from "./agentGuiController.sessionHelpers";
export {
  filterMessagesForDetailWindowOverlay,
  maxFiniteMessageVersion,
  minFiniteMessageVersion,
  sessionHasRenderableMessages,
  sessionViewHasUnhydratedOlderDetailMessages,
  windowHasTurnMissingUserPrompt
} from "./useAgentConversationMessagePaging";
export interface AgentGUIOpenSessionRequest {
  agentSessionId: string;
  sequence: number;
}
export function createPendingOptimisticTurnId(clientSubmitId: string): string {
  return `pending:${clientSubmitId}`;
}

export function composerSettingsFromPendingRecord(
  value: Readonly<Record<string, unknown>>
): AgentSessionComposerSettings {
  const settings: AgentSessionComposerSettings = {};
  if (typeof value.model === "string" || value.model === null) {
    settings.model = value.model;
  }
  if (
    typeof value.reasoningEffort === "string" ||
    value.reasoningEffort === null
  ) {
    settings.reasoningEffort = value.reasoningEffort;
  }
  if (typeof value.speed === "string" || value.speed === null) {
    settings.speed = value.speed;
  }
  for (const key of ["planMode", "browserUse", "computerUse"] as const) {
    if (typeof value[key] === "boolean") settings[key] = value[key];
  }
  if (
    typeof value.permissionModeId === "string" ||
    value.permissionModeId === null
  ) {
    settings.permissionModeId = value.permissionModeId;
  }
  return settings;
}

export function resolveSameProviderActiveSessionModel(input: {
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

export function normalizeAgentGUIOpenSessionRequest(
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

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function activeBackgroundAgentCount(
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

export function conversationBusyStatus(
  status: AgentGUIConversationSummary["status"] | null
): boolean {
  return status === "working" || status === "waiting";
}

export function resolveUnreadCompletionAfterStatusPatch(input: {
  status: AgentGUIConversationSummary["status"];
  hasUnreadCompletion: boolean | undefined;
}): boolean {
  if (input.status === "completed" || input.status === "ready") {
    return input.hasUnreadCompletion ?? false;
  }
  return false;
}

export function resolveUnreadCompletionKeyAfterStatusPatch(input: {
  status: AgentGUIConversationSummary["status"];
  currentKey: string | null | undefined;
  nextKey: string | null | undefined;
  hasUnreadCompletion: boolean | undefined;
}): string | null {
  if (input.status === "completed" || input.nextKey) {
    return input.currentKey ?? input.nextKey ?? null;
  }
  if (input.status === "ready" && input.hasUnreadCompletion === true) {
    return input.currentKey ?? null;
  }
  return null;
}

export function agentActivityDisplayStatusBusy(
  status: AgentActivityDisplayStatus | null | undefined
): boolean {
  return status === "working" || status === "waiting";
}

export function conversationBusyStatusFromAgentActivityDisplayStatus(
  status: AgentActivityDisplayStatus | null | undefined
): "working" | "waiting" | null {
  if (status === "working" || status === "waiting") {
    return status;
  }
  return null;
}

export function agentActivitySessionHasLiveTurn(
  session: AgentActivitySession | null | undefined
): boolean {
  return Boolean(
    session?.activeTurnId?.trim() ||
    (session?.activeTurn && session.activeTurn.phase !== "settled")
  );
}

export function reuseAgentActivityDisplayStatusesIfUnchanged(
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

export const EMPTY_AGENT_COMPOSER_DRAFT = emptyAgentComposerDraft();
export const EMPTY_QUEUED_PROMPTS: readonly AgentGUIQueuedPromptVM[] =
  Object.freeze([]);

export function areAgentComposerDraftsEqual(
  left: AgentComposerDraft,
  right: AgentComposerDraft
): boolean {
  return areDraftValuesStructurallyEqual(left, right);
}

function areDraftValuesStructurallyEqual(
  left: unknown,
  right: unknown
): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        areDraftValuesStructurallyEqual(value, right[index])
      )
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        areDraftValuesStructurallyEqual(leftRecord[key], rightRecord[key])
    )
  );
}

export function deleteSubmittedDraftSnapshotsForScopes(input: {
  snapshots: Record<string, SubmittedDraftSnapshot>;
  scopeKeys: ReadonlySet<string>;
  targetAgentSessionIds?: ReadonlySet<string>;
}): void {
  for (const [clientSubmitId, snapshot] of Object.entries(input.snapshots)) {
    if (
      input.scopeKeys.has(snapshot.sourceScopeKey) ||
      (snapshot.targetAgentSessionId != null &&
        input.targetAgentSessionIds?.has(snapshot.targetAgentSessionId))
    ) {
      delete input.snapshots[clientSubmitId];
    }
  }
}

export function deleteUnacceptedSubmittedDraftSnapshot(input: {
  snapshots: Record<string, SubmittedDraftSnapshot>;
  clientSubmitId: string;
  accepted: boolean;
  queued: boolean;
}): void {
  if (!input.accepted && !input.queued) {
    delete input.snapshots[input.clientSubmitId];
  }
}

export function readAgentComposerDraftContent(input: {
  projectPath: string | null;
  drafts: Record<string, AgentComposerDraft>;
}): AgentComposerDraft {
  return (
    input.drafts[
      resolveAgentComposerDraftScopeKey({ projectPath: input.projectPath })
    ] ?? EMPTY_AGENT_COMPOSER_DRAFT
  );
}

export function resolvePromptImageSelectedModel(input: {
  activeConversationId: string | null;
  activeSessionPermissionModeId?: string | null;
  activeSessionRuntimeContext?: Record<string, unknown> | null;
  activeSessionSettings: AgentSessionComposerSettings | null;
  data: AgentGUINodeData;
  defaultReasoningEffort: AgentSessionReasoningEffort | null;
  draftSettingsBySessionId: Record<string, AgentSessionComposerSettings>;
  providerComposerOptions: AgentActivityComposerOptions | null;
  selectedComposerTargetData: AgentGUIComposerTargetData;
}): string | null {
  const storedNodeDefaultSettings = readNodeDefaultDraftSettings({
    data:
      input.activeConversationId === null
        ? input.selectedComposerTargetData.data
        : input.data,
    defaultReasoningEffort: input.defaultReasoningEffort,
    drafts: input.draftSettingsBySessionId
  });
  const targetSafeNodeDefaultSettings =
    input.activeConversationId === null
      ? sanitizeComposerSettingsForTarget({
          settings: storedNodeDefaultSettings,
          target: input.selectedComposerTargetData,
          options: input.providerComposerOptions
        })
      : storedNodeDefaultSettings;
  const homeComposerSettings = resolveEffectiveComposerSettings({
    settings: targetSafeNodeDefaultSettings
  });
  const activeConversationDraftSettings = input.activeConversationId
    ? (input.draftSettingsBySessionId[input.activeConversationId] ?? null)
    : null;
  const defaultConversationDraftSettings = {
    ...(activeConversationDraftSettings ?? homeComposerSettings),
    permissionModeId:
      normalizePermissionModeId(input.activeSessionPermissionModeId) ??
      normalizePermissionModeId(
        (activeConversationDraftSettings ?? homeComposerSettings)
          .permissionModeId
      )
  };
  const draftSettings = input.activeConversationId
    ? (input.activeSessionSettings ?? defaultConversationDraftSettings)
    : homeComposerSettings;
  const persistedDraftModel = normalizeOptionalText(draftSettings.model);
  return persistedDraftModel;
}

export function completionKeyFromMessage(
  message: AgentActivityMessage
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

export function isCompletedOutcomeToken(
  value: string | null | undefined
): boolean {
  return value?.trim().toLowerCase() === "completed";
}

export const emptyComingSoonProviders: readonly AgentGUIProvider[] = [];

export function applyComingSoonProviderTargets(
  targets: AgentGUIAgentTarget[],
  comingSoonProviders: readonly AgentGUIProvider[]
): AgentGUIAgentTarget[] {
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

export function toRuntimeSendContent(
  content: readonly AgentPromptContentBlock[]
): AgentPromptContentBlock[] {
  return materializePastedTextInstructions(content, {
    header: () => translate("agentHost.agentGui.pastedTextFilesHeader"),
    line: (preview, path) =>
      translate("agentHost.agentGui.pastedTextFileLine", { preview, path })
  });
}

export function shouldClearSubmittedDraft(input: {
  currentDraft: AgentComposerDraft | undefined;
  submittedDraft: AgentComposerDraft;
}): boolean {
  return Boolean(
    input.currentDraft &&
    areAgentComposerDraftsEqual(input.currentDraft, input.submittedDraft)
  );
}

export function clearSubmittedDraftIfUnchanged(input: {
  drafts: Record<string, AgentComposerDraft>;
  snapshot: SubmittedDraftSnapshot;
}): Record<string, AgentComposerDraft> {
  if (
    !shouldClearSubmittedDraft({
      currentDraft: input.drafts[input.snapshot.sourceScopeKey],
      submittedDraft: input.snapshot.content
    })
  ) {
    return input.drafts;
  }
  return {
    ...input.drafts,
    [input.snapshot.sourceScopeKey]: emptyAgentComposerDraft()
  };
}
