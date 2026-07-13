import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { AGENT_PROVIDER_LABEL } from "../../../contexts/settings/domain/agentSettings";
import { translate } from "../../../i18n/index";
import { isWorkspaceAgentActivityOptimisticMessage } from "../../../shared/workspaceAgentMessageOverlay";
import {
  createAgentSessionMentionHref,
  formatAgentMentionMarkdown,
  normalizeAgentSessionMentionTitle
} from "../agentRichText/agentFileMentionExtension";
import { type AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { resolveAgentGUIExplicitConversationTitle } from "../model/agentGuiProviderIdentity";
import { stringPayloadValue } from "./agentGuiController.promptHelpers";
import { AGENT_GUI_SUBMIT_RETARGET_EARLY_MESSAGE_TOLERANCE_MS } from "./agentGuiController.providerHelpers";
import { createPendingOptimisticTurnId } from "./agentGuiController.draftMessageHelpers";

interface AgentSubmitTraceState {
  clientSubmitId: string;
  startedAtUnixMs: number;
  turnId: string | null;
}
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
  normalizeTimelineStatus,
  normalizedPositiveNumber,
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
export function buildContinueInNewConversationPrompt(input: {
  workspaceId: string;
  agentSessionId: string;
  conversationUserId?: string | null;
  currentUserId?: string | null;
  userProfilesByUserId: Record<string, { name?: string | null }>;
  provider: string;
  agentTargetId?: string | null;
  conversationTitle: string;
  existingDraftPrompt: string;
}): string {
  const providerLabelFromCatalog =
    AGENT_PROVIDER_LABEL[input.provider as keyof typeof AGENT_PROVIDER_LABEL] ??
    null;
  const providerLabel =
    providerLabelFromCatalog ||
    input.provider.trim() ||
    translate("sidebar.fallbackAgentLabel");
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
  const href = createAgentSessionMentionHref({
    agentTargetId: input.agentTargetId,
    agentSessionId: input.agentSessionId,
    label: mentionLabel,
    workspaceId: input.workspaceId
  });
  const mention = formatAgentMentionMarkdown({
    kind: "session",
    href,
    workspaceId: input.workspaceId,
    targetId: input.agentSessionId,
    agentTargetId: input.agentTargetId?.trim() || undefined,
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

export function retargetOptimisticPromptMessages(
  messages: readonly AgentActivityMessage[],
  input: { clientSubmitId: string; turnId: string }
): { changed: boolean; messages: AgentActivityMessage[] } {
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

export function shouldRetargetOptimisticPromptFromMessage(
  message: AgentActivityMessage,
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

export function messageActivityTimeUnixMs(
  message: AgentActivityMessage
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

export function hasPromptConversationTitle(
  conversation: AgentGUIConversationSummary
): boolean {
  return resolveAgentGUIExplicitConversationTitle(conversation) !== null;
}
