import {
  selectNeedsAttentionItems,
  selectSessionDisplayStatuses,
  type AgentActivityMessage,
  type AgentActivityNeedsAttentionItem,
  type AgentActivitySession,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { AgentConversationPromptVM } from "../shared/agentConversation/contracts/agentConversationVM";
import { normalizeAskUserQuestions } from "../shared/agentConversation/askUserQuestions";
import { extractAgentMcpToolTarget } from "../shared/agentMcpToolTarget";
import type { WorkspaceAgentActivityStatus } from "../shared/workspaceAgentActivityListViewModel";
import { resolveWorkspaceAgentSessionSortTimeUnixMs } from "../shared/workspaceAgentSessionSortTime";
import {
  latestPlanTurnId,
  planImplementationPromptFromPlanTurn
} from "../shared/agentConversation/planImplementation";
import {
  buildWorkspaceAgentMessageCenterDigest,
  type WorkspaceAgentMessageCenterDigest
} from "./workspaceAgentMessageCenterDigest";

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
  provider: string;
  userId: string | null;
  title: string;
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
  avoidGroupingEdits?: boolean;
  identityBySessionId?: Record<string, WorkspaceAgentMessageCenterIdentity>;
  promptFallbackLabels?: WorkspaceAgentMessageCenterPromptFallbackLabels;
  workspaceRoot?: string | null;
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

const EMPTY_COUNTS: WorkspaceAgentMessageCenterCounts = {
  all: 0,
  working: 0,
  waiting: 0,
  completed: 0,
  failed: 0
};

export function buildWorkspaceAgentMessageCenterModel(
  snapshot: AgentActivitySnapshot,
  options: BuildWorkspaceAgentMessageCenterOptions = {}
): WorkspaceAgentMessageCenterModel {
  const needsAttentionBySessionId = latestNeedsAttentionBySessionId(
    selectNeedsAttentionItems(snapshot)
  );
  const displayStatuses = selectSessionDisplayStatuses(snapshot);
  const items = snapshot.sessions
    .filter((session) => session.visible !== false)
    .map((session) => {
      const messages = resolveSessionMessages(snapshot, session);
      const needsAttention =
        needsAttentionBySessionId.get(session.agentSessionId) ?? null;
      const status = displayStatuses.get(session.agentSessionId) ?? "idle";
      const lastAgentMessage = latestAgentMessage(messages);
      const title = resolveSessionTitle(session, messages);
      const pendingPrompt =
        pendingPromptFromMessages(messages) ??
        codexPlanImplementationPrompt(session, status, messages) ??
        fallbackPromptFromNeedsAttention(
          needsAttention,
          options.promptFallbackLabels
        );
      const digest = buildWorkspaceAgentMessageCenterDigest({
        fallbackTitle: resolveDigestFallbackTitle(session),
        messages,
        needsAttention,
        pendingPrompt,
        status
      });
      const sortTimeUnixMs = resolveWorkspaceAgentSessionSortTimeUnixMs(
        session,
        {
          messages
        }
      );

      return {
        id: `message-center-${session.agentSessionId}`,
        agentSessionId: session.agentSessionId,
        provider: session.provider,
        userId: session.userId?.trim() || null,
        title,
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
        latestTurnOutcome: latestTurnOutcome(session.agentSessionId, messages),
        sortTimeUnixMs
      } satisfies WorkspaceAgentMessageCenterItem;
    });

  return {
    waitingCount: items.filter(isWaitingMessageCenterItem).length,
    items: items.sort(compareMessageCenterItems),
    counts: countMessageCenterItems(items)
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

export function isWaitingMessageCenterItem(
  item: WorkspaceAgentMessageCenterItem
): boolean {
  return item.pendingPrompt !== null || item.needsAttentionKind !== null;
}

export function isInteractiveMessageCenterItem(
  item: WorkspaceAgentMessageCenterItem
): boolean {
  return item.pendingPrompt !== null;
}

export function selectMessageCenterAttentionDeckItems(
  items: readonly WorkspaceAgentMessageCenterItem[]
): WorkspaceAgentMessageCenterItem[] {
  return items.filter(isInteractiveMessageCenterItem);
}

export function isCompletedMessageCenterItem(
  item: WorkspaceAgentMessageCenterItem
): boolean {
  return (
    item.status === "completed" ||
    item.status === "canceled" ||
    item.status === "idle"
  );
}

function latestNeedsAttentionBySessionId(
  items: readonly AgentActivityNeedsAttentionItem[]
): Map<string, AgentActivityNeedsAttentionItem> {
  const bySessionId = new Map<string, AgentActivityNeedsAttentionItem>();
  for (const item of items) {
    const previous = bySessionId.get(item.agentSessionId);
    if (!previous || item.occurredAtUnixMs > previous.occurredAtUnixMs) {
      bySessionId.set(item.agentSessionId, item);
    }
  }
  return bySessionId;
}

function resolveSessionMessages(
  snapshot: AgentActivitySnapshot,
  session: AgentActivitySession
): AgentActivityMessage[] {
  for (const sessionId of [session.agentSessionId, session.providerSessionId]) {
    const normalized = sessionId?.trim() ?? "";
    if (normalized && snapshot.sessionMessagesById[normalized]) {
      return snapshot.sessionMessagesById[normalized];
    }
  }
  return [];
}

function resolveSessionTitle(
  session: AgentActivitySession,
  messages: readonly AgentActivityMessage[]
): string {
  const title = session.title.trim();
  if (title) {
    return title;
  }
  return (
    firstUserMessageText(messages) || session.provider || session.agentSessionId
  );
}

function resolveDigestFallbackTitle(session: AgentActivitySession): string {
  return session.title.trim() || session.provider || session.agentSessionId;
}

function firstUserMessageText(
  messages: readonly AgentActivityMessage[]
): string {
  for (const message of messages) {
    if (message.role.trim().toLowerCase() !== "user") {
      continue;
    }
    const summary = messageSummary(message);
    if (summary) {
      return summary;
    }
  }
  return "";
}

function pendingPromptFromMessages(
  messages: readonly AgentActivityMessage[]
): AgentConversationPromptVM | null {
  for (const message of [...messages].sort(compareMessagesByRecentTime)) {
    if (isTerminalMessageStatus(message.status)) {
      continue;
    }
    const approval = approvalPromptFromMessage(message);
    if (approval) {
      return approval;
    }
    const askUser = askUserPromptFromMessage(message);
    if (askUser) {
      return askUser;
    }
    const exitPlan = exitPlanPromptFromMessage(message);
    if (exitPlan) {
      return exitPlan;
    }
  }
  return null;
}

function approvalPromptFromMessage(
  message: AgentActivityMessage
): AgentConversationPromptVM | null {
  if (!isPermissionMessage(message)) {
    return null;
  }
  const payload = recordValue(message.payload);
  const input = recordValue(payload.input);
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
  return {
    kind: "approval",
    id: `approval:${requestId}`,
    turnId: message.turnId ?? "turn:unknown",
    requestId,
    callId: stringValue(payload.callId) ?? message.messageId,
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
  // payload.questions is a legacy fallback for shapes that inline them.
  const toolState = recordValue(payload.tool_state);
  const input =
    Object.keys(recordValue(payload.input)).length > 0
      ? recordValue(payload.input)
      : recordValue(toolState.input);
  const rawQuestions =
    arrayValue(input.questions).length > 0
      ? input.questions
      : payload.questions;
  const questions = normalizeAskUserQuestions(rawQuestions);
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
  if (!includesAny(normalizedMetadataValues(message), ["exitplanmode"])) {
    return null;
  }
  const payload = recordValue(message.payload);
  return {
    kind: "exit-plan",
    requestId: stringValue(payload.requestId) ?? message.messageId,
    title:
      stringValue(payload.title) ??
      stringValue(payload.summary) ??
      messageSummary(message)
  };
}

function codexPlanImplementationPrompt(
  session: AgentActivitySession,
  status: WorkspaceAgentActivityStatus,
  messages: readonly AgentActivityMessage[]
): AgentConversationPromptVM | null {
  if (session.provider.trim().toLowerCase() !== "codex") {
    return null;
  }
  // Only offer once the session has settled to completed/idle — not while it
  // is still working/waiting, and not after failed/canceled (no point asking
  // to implement a plan from a turn that didn't finish cleanly). Mirrors the
  // codex TUI gate but evaluated against the latest turn rather than a
  // transient per-turn flag.
  if (status !== "completed" && status !== "idle") {
    return null;
  }
  const planTurnId = latestPlanTurnId(messages);
  if (!planTurnId) {
    return null;
  }
  // Title from the plan message itself (matching latestPlanTurnId's plan-item
  // detection), not whichever message in the turn happens to come first.
  const planMessage = messages.find(
    (item) =>
      item.turnId?.trim() === planTurnId &&
      recordValue(item.payload).messageKind === "plan"
  );
  const title = planMessage ? messageSummary(planMessage) : "";
  return planImplementationPromptFromPlanTurn(planTurnId, title);
}

function latestAgentMessage(
  messages: readonly AgentActivityMessage[]
): { summary: string; occurredAtUnixMs: number } | null {
  return messages.reduce<{ summary: string; occurredAtUnixMs: number } | null>(
    (latest, message) => {
      if (!isAgentMessageRole(message.role)) {
        return latest;
      }
      const summary = messageSummary(message);
      if (!summary) {
        return latest;
      }
      const occurredAtUnixMs = messageTimeUnixMs(message);
      if (!latest || occurredAtUnixMs >= latest.occurredAtUnixMs) {
        return { summary, occurredAtUnixMs };
      }
      return latest;
    },
    null
  );
}

function latestTurnOutcome(
  agentSessionId: string,
  messages: readonly AgentActivityMessage[]
): WorkspaceAgentMessageCenterTurnOutcome | null {
  const latest = messages
    .flatMap((message) => {
      const status = outcomeStatusFromMessage(message);
      if (!status) {
        return [];
      }
      const turnId = message.turnId?.trim() || null;
      const messageId = message.messageId.trim();
      const notificationSubject = turnId
        ? `turn:${turnId}`
        : `message:${messageId}`;
      return [
        {
          notificationKey: `${agentSessionId}:${notificationSubject}:${status}`,
          status,
          turnId,
          sortMessage: message
        }
      ];
    })
    .sort((left, right) =>
      compareMessagesByRecentTime(left.sortMessage, right.sortMessage)
    )[0];

  if (!latest) {
    return null;
  }
  return {
    notificationKey: latest.notificationKey,
    status: latest.status,
    turnId: latest.turnId
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

function fallbackPromptFromNeedsAttention(
  item: AgentActivityNeedsAttentionItem | null,
  labels: WorkspaceAgentMessageCenterPromptFallbackLabels | undefined
): AgentConversationPromptVM | null {
  if (!item || item.kind === "permission" || !labels) {
    return null;
  }
  return {
    kind: "ask-user",
    requestId: requestIdFromNeedsAttentionItem(item),
    title: item.summary || item.title || labels.title,
    questions: [
      {
        id: "response",
        header:
          item.kind === "constraint"
            ? labels.constraintHeader
            : labels.inputHeader,
        question: item.summary || item.title || labels.question,
        options: [],
        multiSelect: false,
        answer: null
      }
    ]
  };
}

function requestIdFromNeedsAttentionItem(
  item: AgentActivityNeedsAttentionItem
): string {
  const [, messageId] = item.id.split(":", 2);
  return messageId?.trim() || item.id;
}

function countMessageCenterItems(
  items: readonly WorkspaceAgentMessageCenterItem[]
): WorkspaceAgentMessageCenterCounts {
  return items.reduce<WorkspaceAgentMessageCenterCounts>(
    (counts, item) => {
      counts.all += 1;
      if (isWaitingMessageCenterItem(item)) {
        counts.waiting += 1;
        return counts;
      }
      if (isCompletedMessageCenterItem(item)) {
        counts.completed += 1;
        return counts;
      }
      switch (item.status) {
        case "working":
          counts.working += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
        default:
          break;
      }
      return counts;
    },
    { ...EMPTY_COUNTS }
  );
}

function compareMessageCenterItems(
  left: WorkspaceAgentMessageCenterItem,
  right: WorkspaceAgentMessageCenterItem
): number {
  const leftWaiting = isWaitingMessageCenterItem(left);
  const rightWaiting = isWaitingMessageCenterItem(right);
  if (leftWaiting !== rightWaiting) {
    return leftWaiting ? -1 : 1;
  }
  return (
    right.sortTimeUnixMs - left.sortTimeUnixMs ||
    left.agentSessionId.localeCompare(right.agentSessionId)
  );
}

function isAgentMessageRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "assistant" || normalized === "agent";
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
