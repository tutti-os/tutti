import { useRef } from "react";
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import { createAgentSessionHandoffPrompt } from "../agentRichText/agentFileMentionExtension";
import type {
  AgentComposerSlashStatus,
  AgentComposerSlashStatusLimit
} from "../AgentComposer";
import type {
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "../model/agentGuiNodeTypes";
import type { AgentGUIAgentTarget } from "../../../types";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { conversationPlainTitle, stringValue } from "./agentGUIViewUtils";

export function commandAppSource(
  command: unknown
): Record<string, unknown> | null {
  if (!command || typeof command !== "object" || !("source" in command)) {
    return null;
  }
  const source = (command as { source?: unknown }).source;
  if (!source || typeof source !== "object") return null;
  const sourceRecord = source as Record<string, unknown>;
  return sourceRecord.kind === "app" ? sourceRecord : null;
}

export function workspaceAppIconKey(
  appId: string,
  workspaceId: string
): string {
  return `${workspaceId}\u0000${appId}`;
}

export function isDifferentKnownConversationOwner(input: {
  conversationUserId?: string | null;
  currentUserId?: string | null;
}): boolean {
  const conversationUserId = input.conversationUserId?.trim() ?? "";
  const currentUserId = input.currentUserId?.trim() ?? "";
  if (
    !conversationUserId ||
    !currentUserId ||
    conversationUserId === "local" ||
    currentUserId === "local"
  ) {
    return false;
  }
  return conversationUserId !== currentUserId;
}

export function isContextCanceledMessage(
  message: string | null | undefined
): boolean {
  const normalized = message?.trim().toLowerCase() ?? "";
  return normalized === "context canceled";
}

export function resolveConversationDetailStatus(
  detail: AgentGUINodeViewModel["detail"]["conversationDetail"]
): AgentGUINodeViewModel["rail"]["conversations"][number]["status"] | null {
  if (!detail) {
    return null;
  }
  const normalized = normalizeOptionalWorkspaceAgentStatus({
    activeTurnPhase: detail.session.activeTurn?.phase,
    latestTurnOutcome: detail.session.latestTurn?.outcome
  });
  switch (normalized?.kind) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "canceled":
      return "canceled";
    case "ready":
      return "ready";
    default:
      return null;
  }
}

export function resolveSlashStatus({
  rawState,
  limits,
  limitsLoading,
  limitsUnavailable,
  usage
}: {
  rawState: AgentGUISessionChrome["rawState"];
  limits: readonly AgentComposerSlashStatusLimit[];
  limitsLoading: boolean;
  limitsUnavailable: boolean;
  usage: AgentGUINodeViewModel["detail"]["usage"];
}): AgentComposerSlashStatus {
  const usedTokens = usage?.usedTokens ?? null;
  const totalTokens = usage?.totalTokens ?? null;
  return {
    agentSessionId: rawState?.agentSessionId ?? null,
    baseUrl: null,
    limits,
    limitsLoading,
    limitsUnavailable,
    contextWindow:
      usedTokens !== null && totalTokens !== null
        ? { usedTokens, totalTokens }
        : null
  };
}

function slashStatusLimitsEqual(
  left: readonly AgentComposerSlashStatusLimit[] | null | undefined,
  right: readonly AgentComposerSlashStatusLimit[] | null | undefined
): boolean {
  const leftLimits = left ?? [];
  const rightLimits = right ?? [];
  return (
    leftLimits.length === rightLimits.length &&
    leftLimits.every((limit, index) => {
      const rightLimit = rightLimits[index]!;
      return (
        limit.id === rightLimit.id &&
        limit.label === rightLimit.label &&
        (limit.percentRemaining ?? null) ===
          (rightLimit.percentRemaining ?? null) &&
        limit.value === rightLimit.value
      );
    })
  );
}

function slashStatusesEqual(
  left: AgentComposerSlashStatus,
  right: AgentComposerSlashStatus
): boolean {
  return (
    (left.agentSessionId ?? null) === (right.agentSessionId ?? null) &&
    (left.baseUrl ?? null) === (right.baseUrl ?? null) &&
    (left.contextWindow?.usedTokens ?? null) ===
      (right.contextWindow?.usedTokens ?? null) &&
    (left.contextWindow?.totalTokens ?? null) ===
      (right.contextWindow?.totalTokens ?? null) &&
    slashStatusLimitsEqual(left.limits, right.limits) &&
    Boolean(left.limitsLoading) === Boolean(right.limitsLoading) &&
    Boolean(left.limitsUnavailable) === Boolean(right.limitsUnavailable)
  );
}

export function useStableSlashStatus(
  status: AgentComposerSlashStatus
): AgentComposerSlashStatus {
  const statusRef = useRef<AgentComposerSlashStatus | null>(null);
  if (
    statusRef.current === null ||
    !slashStatusesEqual(statusRef.current, status)
  ) {
    statusRef.current = status;
  }
  return statusRef.current;
}

function conversationHasActiveWork(
  conversation: AgentConversationVM | null | undefined
): boolean {
  return (
    conversation?.rows.some((row) => {
      if (row.kind === "processing") {
        return true;
      }
      if (row.kind === "tool-group") {
        return row.calls.some(
          (call) =>
            call.statusKind === "working" || call.statusKind === "waiting"
        );
      }
      if (row.kind === "message") {
        return row.thinking.some(
          (thinking) =>
            thinking.statusKind === "working" ||
            thinking.statusKind === "waiting"
        );
      }
      return false;
    }) ?? false
  );
}

function isSettledConversationStatus(
  status:
    | AgentGUINodeViewModel["rail"]["conversations"][number]["status"]
    | null
    | undefined
): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function resolveActiveConversationBusyStatus(input: {
  conversationStatus:
    | AgentGUINodeViewModel["rail"]["conversations"][number]["status"]
    | undefined;
  detailStatus:
    | AgentGUINodeViewModel["rail"]["conversations"][number]["status"]
    | null;
  conversation: AgentConversationVM | null | undefined;
}): AgentGUINodeViewModel["rail"]["conversations"][number]["status"] | null {
  if (
    input.conversationStatus === "waiting" ||
    input.detailStatus === "waiting"
  ) {
    return "waiting";
  }
  if (
    input.conversationStatus === "working" ||
    input.detailStatus === "working"
  ) {
    return "working";
  }
  if (
    isSettledConversationStatus(input.conversationStatus) ||
    isSettledConversationStatus(input.detailStatus)
  ) {
    return null;
  }
  if (conversationHasActiveWork(input.conversation)) {
    return "working";
  }
  return null;
}

export function shouldShowAgentGUIStopButton(input: {
  hasPendingApproval: boolean;
  hasPendingInteractivePrompt: boolean;
  isAuthBlocked: boolean;
  isCancelPending: boolean;
  isConversationBusy: boolean;
  isCreatingConversation: boolean;
  isInterrupting: boolean;
  isSubmitting: boolean;
  isUnavailable: boolean;
}): boolean {
  if (input.isUnavailable || input.isAuthBlocked) return false;
  if (input.isCreatingConversation || input.isCancelPending) return true;
  return (
    !input.isSubmitting &&
    (input.isConversationBusy ||
      input.hasPendingApproval ||
      input.hasPendingInteractivePrompt ||
      input.isInterrupting)
  );
}

export function isAgentGUITransportNoticeVisible(
  recovery: AgentGUISessionChrome["recovery"]
): boolean {
  return (
    recovery?.kind === "transport-connecting" ||
    recovery?.kind === "transport-unavailable"
  );
}

export function resolveAgentGUIHomeNoticeChrome(input: {
  inlineNoticeChrome: AgentGUISessionChrome | null;
  sessionChrome: AgentGUISessionChrome;
}): AgentGUISessionChrome | null {
  return isAgentGUITransportNoticeVisible(input.sessionChrome.recovery)
    ? input.sessionChrome
    : input.inlineNoticeChrome;
}

export function resolveAgentGUIStopControl(input: {
  hasPendingApproval: boolean;
  hasPendingInteractivePrompt: boolean;
  isAuthBlocked: boolean;
  isCancelPending: boolean;
  isConversationBusy: boolean;
  isCreatingConversation: boolean;
  isInterrupting: boolean;
  isSubmitting: boolean;
  isUnavailable: boolean;
  sessionRuntimeBlocked: boolean;
}): { disabled: boolean; visible: boolean } {
  return {
    disabled: input.sessionRuntimeBlocked,
    visible: shouldShowAgentGUIStopButton(input)
  };
}

export function buildAgentConversationHandoffPrompt(input: {
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  currentUserId?: string | null;
  labels: Pick<AgentGUIViewLabels, "untitledConversationTitle">;
  selectedAgentTarget: AgentGUIAgentTarget | null;
  uiLanguage: UiLanguage;
  workspaceId: string;
}): string {
  const conversation = input.activeConversation;
  if (!conversation) {
    return "";
  }
  const sourceAgentLabel =
    input.selectedAgentTarget?.label?.trim() || conversation.provider;
  const title = conversationPlainTitle(
    conversation,
    input.labels,
    input.uiLanguage
  );
  const mentionLabel = title || sourceAgentLabel;
  return createAgentSessionHandoffPrompt({
    agentTargetId: conversation.agentTargetId,
    agentSessionId: conversation.id,
    label: mentionLabel,
    workspaceId: input.workspaceId
  });
}

export function handoffProjectPathForConversation(
  conversation: AgentGUINodeViewModel["rail"]["activeConversation"]
): string | null {
  return (
    conversation?.project?.path?.trim() || conversation?.cwd?.trim() || null
  );
}

export function mergeWorkspaceAppIconsFromCommands(input: {
  commands: AgentGUINodeViewModel["composer"]["availableCommands"];
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  workspaceId: string;
}): readonly AgentMessageMarkdownWorkspaceAppIcon[] {
  const seen = new Set(
    input.workspaceAppIcons.flatMap((icon) => {
      const appId = icon.appId.trim();
      const iconUrl = icon.iconUrl?.trim() ?? "";
      if (!appId || !iconUrl) {
        return [];
      }
      return [
        workspaceAppIconKey(appId, icon.workspaceId?.trim() ?? ""),
        workspaceAppIconKey(appId, "")
      ];
    })
  );
  let next: AgentMessageMarkdownWorkspaceAppIcon[] | null = null;
  for (const command of input.commands) {
    const source = commandAppSource(command);
    if (!source) {
      continue;
    }
    const appId = stringValue(source.appId).trim();
    const iconUrl = stringValue(source.iconUrl).trim();
    if (!appId || !iconUrl) {
      continue;
    }
    const key = workspaceAppIconKey(appId, input.workspaceId);
    if (seen.has(key)) {
      continue;
    }
    if (!next) {
      next = [...input.workspaceAppIcons];
    }
    next.push({
      appId,
      iconUrl,
      workspaceId: input.workspaceId
    });
    seen.add(key);
  }
  return next ?? input.workspaceAppIcons;
}
