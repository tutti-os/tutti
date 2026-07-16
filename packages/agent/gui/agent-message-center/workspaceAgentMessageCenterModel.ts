import {
  type AgentActivityMessage,
  type AgentActivityNeedsAttentionItem,
  type AgentActivitySession,
  type WorkspaceAgentConsumerSession
} from "@tutti-os/agent-activity-core";
import type { AgentConversationPromptVM } from "../shared/agentConversation/contracts/agentConversationVM";
import { normalizeAskUserQuestions } from "../shared/agentConversation/askUserQuestions";
import { extractAgentMcpToolTarget } from "../shared/agentMcpToolTarget";
import { normalizeAgentApprovalPurpose } from "../shared/agentConversation/agentApprovalPurpose";
import type { WorkspaceAgentActivityStatus } from "../shared/workspaceAgentActivityListViewModel";
import { resolveWorkspaceAgentSessionSortTimeUnixMs } from "../shared/workspaceAgentSessionSortTime";
import {
  buildWorkspaceAgentMessageCenterDigest,
  resolveWorkspaceAgentMessageCenterDigestAgentMessageSummary,
  type WorkspaceAgentMessageCenterDigest,
  type WorkspaceAgentMessageCenterDigestAgentSummary
} from "./workspaceAgentMessageCenterDigest";
import {
  extractExitPlanKeepPlanningOptionId,
  extractExitPlanModeOptions,
  isExitPlanSwitchModeInput
} from "../shared/agentConversation/exitPlanOptions";
export {
  buildWorkspaceAgentMessageCenterModelFromItems,
  isCompletedMessageCenterItem,
  isInteractiveMessageCenterItem,
  isWaitingMessageCenterItem,
  selectMessageCenterAttentionDeckItems
} from "./workspaceAgentMessageCenterCollection";

export interface WorkspaceAgentMessageCenterModel {
  waitingCount: number;
  items: WorkspaceAgentMessageCenterItem[];
  counts: WorkspaceAgentMessageCenterCounts;
}

export interface WorkspaceAgentMessageCenterCounts {
  all: number;
  working: number;
  waiting: number;
  completed: number;
  failed: number;
}

export interface WorkspaceAgentMessageCenterItem {
  id: string;
  agentSessionId: string;
  agentTargetId?: string | null;
  agentName?: string | null;
  agentAvatarUrl?: string | null;
  provider: string;
  userId: string | null;
  title: string;
  imported?: boolean;
  identity: WorkspaceAgentMessageCenterIdentity | null;
  cwd: string;
  status: WorkspaceAgentActivityStatus;
  digest: WorkspaceAgentMessageCenterDigest;
  lastAgentMessageSummary: string;
  lastAgentMessageAtUnixMs: number | null;
  pendingPrompt: AgentConversationPromptVM | null;
  needsAttentionKind: AgentActivityNeedsAttentionItem["kind"] | null;
  needsAttentionSummary: string | null;
  latestTurnOutcome?: WorkspaceAgentMessageCenterTurnOutcome | null;
  sortTimeUnixMs: number;
}

export interface WorkspaceAgentMessageCenterTurnOutcome {
  notificationKey: string;
  status: "completed" | "failed";
  turnId: string | null;
}

export interface BuildWorkspaceAgentMessageCenterOptions {
  agentPresentations?: readonly WorkspaceAgentMessageCenterAgentPresentation[];
  avoidGroupingEdits?: boolean;
  identityBySessionId?: Record<string, WorkspaceAgentMessageCenterIdentity>;
  itemCutoffUnixMs?: number | null;
  promptFallbackLabels?: WorkspaceAgentMessageCenterPromptFallbackLabels;
  workspaceRoot?: string | null;
}

export interface WorkspaceAgentMessageCenterAgentPresentation {
  agentTargetId: string;
  iconUrl?: string | null;
  name: string;
}

export interface WorkspaceAgentMessageCenterIdentity {
  userName: string;
  userAvatarUrl?: string;
  agentName: string;
  agentAvatarUrl?: string;
}

export interface WorkspaceAgentMessageCenterPromptFallbackLabels {
  constraintHeader: string;
  inputHeader: string;
  question: string;
  title: string;
}

export interface BuildWorkspaceAgentMessageCenterItemInput {
  session: WorkspaceAgentMessageCenterSession;
  latestTurn?: WorkspaceAgentConsumerSession["latestTurn"] | null;
  messages: readonly AgentActivityMessage[];
  status: WorkspaceAgentActivityStatus;
  needsAttention: AgentActivityNeedsAttentionItem | null;
  pendingPrompt: AgentConversationPromptVM | null;
  latestTurnOutcome: WorkspaceAgentMessageCenterTurnOutcome | null;
  options?: BuildWorkspaceAgentMessageCenterOptions;
}

type WorkspaceAgentMessageCenterSession =
  | AgentActivitySession
  | WorkspaceAgentConsumerSession["session"];

export function buildWorkspaceAgentMessageCenterItem({
  session,
  latestTurn,
  messages,
  status,
  needsAttention,
  pendingPrompt,
  latestTurnOutcome,
  options = {}
}: BuildWorkspaceAgentMessageCenterItemInput): WorkspaceAgentMessageCenterItem {
  const messageAnalysis = analyzeMessageCenterSessionMessages(
    session.agentSessionId,
    messages
  );
  const lastAgentMessage = messageAnalysis.latestAgentMessage;
  const title = session.title.trim();
  const digest = buildWorkspaceAgentMessageCenterDigest({
    fallbackTitle: title,
    latestAgentMessage: messageAnalysis.latestDigestAgentMessage,
    needsAttention,
    pendingPrompt,
    status
  });
  const agentPresentation = resolveMessageCenterAgentPresentation(
    session.agentTargetId,
    options.agentPresentations
  );
  return {
    id: `message-center-${session.agentSessionId}`,
    agentSessionId: session.agentSessionId,
    agentTargetId: session.agentTargetId?.trim() || null,
    agentName: agentPresentation?.name ?? null,
    agentAvatarUrl: agentPresentation?.iconUrl ?? null,
    provider: session.provider,
    userId: session.userId?.trim() || null,
    title,
    ...(isImportedMessageCenterSession(session) ? { imported: true } : {}),
    identity: resolveMessageCenterIdentity(
      session.agentSessionId,
      options.identityBySessionId
    ),
    cwd: session.cwd,
    status,
    digest,
    lastAgentMessageSummary:
      lastAgentMessage?.summary ?? needsAttention?.summary ?? title,
    lastAgentMessageAtUnixMs: lastAgentMessage?.occurredAtUnixMs ?? null,
    pendingPrompt,
    needsAttentionKind: needsAttention?.kind ?? null,
    needsAttentionSummary: needsAttention?.summary ?? null,
    latestTurnOutcome,
    sortTimeUnixMs: resolveWorkspaceAgentSessionSortTimeUnixMs({
      ...session,
      latestTurn
    })
  };
}

function resolveMessageCenterAgentPresentation(
  agentTargetId: string | null | undefined,
  presentations:
    | readonly WorkspaceAgentMessageCenterAgentPresentation[]
    | undefined
): { iconUrl: string | null; name: string } | null {
  const targetId = agentTargetId?.trim() ?? "";
  if (!targetId) {
    return null;
  }
  const presentation = presentations?.find(
    (candidate) => candidate.agentTargetId.trim() === targetId
  );
  const name = presentation?.name.trim() ?? "";
  if (!presentation || !name) {
    return null;
  }
  return {
    iconUrl: presentation.iconUrl?.trim() || null,
    name
  };
}

function resolveMessageCenterIdentity(
  agentSessionId: string,
  identityBySessionId:
    | Record<string, WorkspaceAgentMessageCenterIdentity>
    | undefined
): WorkspaceAgentMessageCenterIdentity | null {
  const identity = identityBySessionId?.[agentSessionId];
  if (!identity) {
    return null;
  }
  const userName = identity.userName.trim();
  const agentName = identity.agentName.trim();
  if (!userName || !agentName) {
    return null;
  }
  const userAvatarUrl = identity.userAvatarUrl?.trim() ?? "";
  const agentAvatarUrl = identity.agentAvatarUrl?.trim() ?? "";
  return {
    userName,
    ...(userAvatarUrl ? { userAvatarUrl } : {}),
    agentName,
    ...(agentAvatarUrl ? { agentAvatarUrl } : {})
  };
}

function isImportedMessageCenterSession(
  session: WorkspaceAgentMessageCenterSession
): boolean {
  return "imported" in session && session.imported === true;
}

interface MessageCenterSessionMessageAnalysis {
  latestDigestAgentMessage: WorkspaceAgentMessageCenterDigestAgentSummary | null;
  latestAgentMessage: WorkspaceAgentMessageCenterDigestAgentSummary | null;
  latestTurnOutcome: WorkspaceAgentMessageCenterTurnOutcome | null;
  pendingPrompt: AgentConversationPromptVM | null;
}

interface PendingPromptCandidate {
  message: AgentActivityMessage;
  prompt: AgentConversationPromptVM;
}

interface TurnOutcomeCandidate {
  message: AgentActivityMessage;
  outcome: WorkspaceAgentMessageCenterTurnOutcome;
}

function analyzeMessageCenterSessionMessages(
  agentSessionId: string,
  messages: readonly AgentActivityMessage[]
): MessageCenterSessionMessageAnalysis {
  let latestAgentMessage: WorkspaceAgentMessageCenterDigestAgentSummary | null =
    null;
  let latestDigestAgentMessage: WorkspaceAgentMessageCenterDigestAgentSummary | null =
    null;
  let latestPendingPrompt: PendingPromptCandidate | null = null;
  let latestOutcome: TurnOutcomeCandidate | null = null;

  for (const message of messages) {
    if (
      isAgentMessageRole(message.role) &&
      !isReasoningMessageKind(message.kind)
    ) {
      const summary = messageSummary(message);
      if (summary) {
        const occurredAtUnixMs = messageTimeUnixMs(message);
        if (
          !latestAgentMessage ||
          occurredAtUnixMs >= latestAgentMessage.occurredAtUnixMs
        ) {
          latestAgentMessage = { summary, occurredAtUnixMs };
        }
      }
      const digestSummary =
        resolveWorkspaceAgentMessageCenterDigestAgentMessageSummary(message);
      if (digestSummary) {
        const occurredAtUnixMs = messageTimeUnixMs(message);
        if (
          !latestDigestAgentMessage ||
          occurredAtUnixMs >= latestDigestAgentMessage.occurredAtUnixMs
        ) {
          latestDigestAgentMessage = {
            summary: digestSummary,
            occurredAtUnixMs
          };
        }
      }

      const outcome = turnOutcomeFromMessage(agentSessionId, message);
      if (
        outcome &&
        (!latestOutcome ||
          compareMessagesByRecentTime(message, latestOutcome.message) < 0)
      ) {
        latestOutcome = { message, outcome };
      }
    }

    if (!isTerminalMessageStatus(message.status)) {
      const prompt = promptFromMessage(message);
      if (
        prompt &&
        (!latestPendingPrompt ||
          compareMessagesByRecentTime(message, latestPendingPrompt.message) < 0)
      ) {
        latestPendingPrompt = { message, prompt };
      }
    }
  }

  return {
    latestDigestAgentMessage,
    latestAgentMessage,
    latestTurnOutcome: latestOutcome?.outcome ?? null,
    pendingPrompt: latestPendingPrompt?.prompt ?? null
  };
}

function promptFromMessage(
  message: AgentActivityMessage
): AgentConversationPromptVM | null {
  return (
    exitPlanPromptFromMessage(message) ??
    approvalPromptFromMessage(message) ??
    askUserPromptFromMessage(message)
  );
}

function approvalPromptFromMessage(
  message: AgentActivityMessage
): AgentConversationPromptVM | null {
  if (!isPermissionMessage(message)) {
    return null;
  }
  const payload = recordValue(message.payload);
  const input = recordValue(payload.input);
  if (isExitPlanMessage(message, input)) {
    return null;
  }
  const requestId =
    stringValue(input.requestId) ??
    stringValue(payload.requestId) ??
    stringValue(payload.approvalRequestId) ??
    message.messageId;
  const options = [
    ...arrayValue(input.options),
    ...arrayValue(payload.options)
  ].flatMap((option) => {
    const record = recordValue(option);
    const id =
      stringValue(record.optionId) ??
      stringValue(record.id) ??
      stringValue(record.kind);
    if (!id) {
      return [];
    }
    return [
      {
        id,
        label:
          stringValue(record.name) ??
          stringValue(record.label) ??
          stringValue(record.title) ??
          id,
        kind: stringValue(record.kind) ?? id,
        ...(stringValue(record.description)
          ? { description: stringValue(record.description) as string }
          : {})
      }
    ];
  });
  if (options.length === 0) {
    return null;
  }
  const mcpTarget = extractAgentMcpToolTarget({ payload });
  const approvalPurpose = normalizeAgentApprovalPurpose(
    payload.approvalPurpose
  );
  return {
    kind: "approval",
    id: `approval:${requestId}`,
    turnId: message.turnId ?? "turn:unknown",
    requestId,
    callId: stringValue(payload.callId) ?? message.messageId,
    ...(approvalPurpose ? { approvalPurpose } : {}),
    title: firstNonEmptyString(
      mcpTarget?.displayName ?? null,
      stringValue(payload.summary),
      stringValue(payload.title),
      stringValue(input.title),
      stringValue(input.command),
      messageSummary(message),
      message.kind
    ),
    toolName:
      stringValue(payload.toolName) ??
      stringValue(payload.name) ??
      stringValue(payload.tool),
    status: message.status ?? stringValue(payload.status),
    input: Object.keys(input).length > 0 ? input : payload,
    options,
    output: null,
    occurredAtUnixMs: messageTimeUnixMs(message) || null
  };
}

function askUserPromptFromMessage(
  message: AgentActivityMessage
): AgentConversationPromptVM | null {
  if (!isQuestionMessage(message)) {
    return null;
  }
  const payload = recordValue(message.payload);
  // The structured questions live on the tool-call input (payload.input.questions
  // or payload.tool_state.input.questions) — the same source the in-conversation
  // projection reads — so the deck card renders the identical question + options.
  const toolState = recordValue(payload.tool_state);
  const input =
    Object.keys(recordValue(payload.input)).length > 0
      ? recordValue(payload.input)
      : recordValue(toolState.input);
  const questions = normalizeAskUserQuestions(input.questions);
  if (questions.length === 0) {
    return null;
  }
  return {
    kind: "ask-user",
    requestId:
      stringValue(input.requestId) ??
      stringValue(payload.requestId) ??
      stringValue(payload.interactiveRequestId) ??
      message.messageId,
    title:
      stringValue(payload.title) ??
      stringValue(payload.summary) ??
      messageSummary(message),
    questions
  };
}

function exitPlanPromptFromMessage(
  message: AgentActivityMessage
): AgentConversationPromptVM | null {
  const payload = recordValue(message.payload);
  const input = recordValue(payload.input);
  if (!isExitPlanMessage(message, input)) {
    return null;
  }
  return {
    kind: "exit-plan",
    requestId:
      stringValue(input.requestId) ??
      stringValue(payload.requestId) ??
      message.messageId,
    title:
      stringValue(input.title) ??
      stringValue(recordValue(input.toolCall).title) ??
      stringValue(payload.title) ??
      stringValue(payload.summary) ??
      messageSummary(message),
    options: extractExitPlanModeOptions(input, payload),
    ...keepPlanningOption(extractExitPlanKeepPlanningOptionId(input, payload))
  };
}

function keepPlanningOption(optionId: string | null): {
  keepPlanningOptionId?: string;
} {
  return optionId ? { keepPlanningOptionId: optionId } : {};
}

function isExitPlanMessage(
  message: AgentActivityMessage,
  input: Record<string, unknown> = recordValue(
    recordValue(message.payload).input
  )
): boolean {
  // Some shapes only flag exit-plan via metadata ("exitplanmode"); the canonical
  // Claude shape is a `switch_mode` approval carrying a `plan` option.
  return (
    includesAny(normalizedMetadataValues(message), ["exitplanmode"]) ||
    isExitPlanSwitchModeInput(input)
  );
}

function turnOutcomeFromMessage(
  agentSessionId: string,
  message: AgentActivityMessage
): WorkspaceAgentMessageCenterTurnOutcome | null {
  const status = outcomeStatusFromMessage(message);
  if (!status) {
    return null;
  }
  const turnId = message.turnId?.trim() || null;
  const messageId = message.messageId.trim();
  const notificationSubject = turnId
    ? `turn:${turnId}`
    : `message:${messageId}`;
  return {
    notificationKey: `${agentSessionId}:${notificationSubject}:${status}`,
    status,
    turnId
  };
}

function outcomeStatusFromMessage(
  message: AgentActivityMessage
): WorkspaceAgentMessageCenterTurnOutcome["status"] | null {
  if (!isAgentMessageRole(message.role)) {
    return null;
  }
  const payload = recordValue(message.payload);
  const status = (message.status ?? stringValue(payload.status) ?? "")
    .trim()
    .toLowerCase();
  switch (status) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function isAgentMessageRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "assistant" || normalized === "agent";
}

/**
 * Reasoning/thinking messages are stored with an assistant-like `role` but a
 * distinct `kind: "reasoning"` (see workspaceAgentMessageProjection.ts, which
 * routes `kind === "reasoning"` to a separate "assistant_thinking" timeline
 * item instead of a normal reply). The message center must not treat these as
 * a normal agent reply when picking the latest message to preview, otherwise
 * raw thinking content (occasionally still carrying literal tag markup) can
 * surface verbatim in the message-center list instead of the actual reply.
 */
function isReasoningMessageKind(kind: string): boolean {
  return kind.trim().toLowerCase() === "reasoning";
}

function isTerminalMessageStatus(status: string | null | undefined): boolean {
  switch (status?.trim().toLowerCase()) {
    case "answered":
    case "canceled":
    case "cancelled":
    case "completed":
    case "failed":
    case "rejected":
    case "resolved":
      return true;
    default:
      return false;
  }
}

function isPermissionMessage(message: AgentActivityMessage): boolean {
  return includesAny(normalizedMetadataValues(message), [
    "permission",
    "approval"
  ]);
}

function isQuestionMessage(message: AgentActivityMessage): boolean {
  return includesAny(normalizedMetadataValues(message), [
    "ask_user",
    "ask-user",
    "askuserquestion",
    "question"
  ]);
}

function normalizedMetadataValues(message: AgentActivityMessage): string {
  const payload = recordValue(message.payload);
  const input = recordValue(payload.input);
  return [
    message.kind,
    message.status ?? "",
    stringValue(payload.type) ?? "",
    stringValue(payload.action) ?? "",
    stringValue(payload.requestType) ?? "",
    stringValue(payload.callType) ?? "",
    stringValue(payload.toolName) ?? "",
    stringValue(payload.name) ?? "",
    stringValue(payload.status) ?? "",
    stringValue(input.type) ?? "",
    stringValue(input.action) ?? "",
    stringValue(input.requestType) ?? "",
    stringValue(input.callType) ?? "",
    stringValue(input.toolName) ?? "",
    stringValue(input.name) ?? "",
    stringValue(input.status) ?? ""
  ]
    .join(" ")
    .replace(/[_\s-]+/g, "")
    .toLowerCase();
}

function compareMessagesByRecentTime(
  left: AgentActivityMessage,
  right: AgentActivityMessage
): number {
  return (
    messageTimeUnixMs(right) - messageTimeUnixMs(left) ||
    right.version - left.version ||
    right.messageId.localeCompare(left.messageId)
  );
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) =>
    value.includes(needle.replace(/[_\s-]+/g, "").toLowerCase())
  );
}

function messageSummary(message: AgentActivityMessage): string {
  return firstNonEmptyString(
    stringValue(message.payload.summary),
    stringValue(message.payload.displayPrompt),
    stringValue(message.payload.text),
    stringValue(message.payload.content),
    stringValue(message.payload.message),
    stringValue(message.payload.body),
    stringValue(message.payload.title)
  );
}

function messageTimeUnixMs(message: AgentActivityMessage): number {
  return (
    positiveNumber(message.occurredAtUnixMs) ??
    positiveNumber(message.completedAtUnixMs) ??
    positiveNumber(message.startedAtUnixMs) ??
    positiveNumber(message.version) ??
    0
  );
}

function firstNonEmptyString(...values: Array<string | null>): string {
  return values.find((value) => value !== null && value.length > 0) ?? "";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
