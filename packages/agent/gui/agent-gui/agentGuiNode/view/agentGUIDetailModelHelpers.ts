import { useRef } from "react";
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import {
  createAgentSessionMentionHref,
  formatAgentMentionMarkdown
} from "../agentRichText/agentFileMentionExtension";
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
import { conversationPlainTitle } from "./agentGUIViewUtils";

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

export function buildAgentConversationHandoffPrompt(input: {
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  currentUserId?: string | null;
  labels: Pick<AgentGUIViewLabels, "fallbackAgentTitle">;
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
  const href = createAgentSessionMentionHref({
    agentTargetId: conversation.agentTargetId,
    agentSessionId: conversation.id,
    label: mentionLabel,
    workspaceId: input.workspaceId
  });
  return `${formatAgentMentionMarkdown({
    kind: "session",
    href,
    workspaceId: input.workspaceId,
    targetId: conversation.id,
    agentTargetId: conversation.agentTargetId ?? undefined,
    name: mentionLabel,
    title: title || sourceAgentLabel,
    scope: "my_sessions",
    initiatorName: input.currentUserId?.trim() || sourceAgentLabel,
    agentName: sourceAgentLabel,
    status: conversation.status,
    updatedAtUnixMs: conversation.updatedAtUnixMs
  })} `;
}

export function handoffProjectPathForConversation(
  conversation: AgentGUINodeViewModel["rail"]["activeConversation"]
): string | null {
  return (
    conversation?.project?.path?.trim() || conversation?.cwd?.trim() || null
  );
}
