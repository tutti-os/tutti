import type {
  AgentActivityMessage,
  AgentActivityNeedsAttentionItem
} from "@tutti-os/agent-activity-core";
import type { AgentConversationPromptVM } from "../shared/agentConversation/contracts/agentConversationVM";
import { extractAgentMcpToolTarget } from "../shared/agentMcpToolTarget";
import type { WorkspaceAgentActivityStatus } from "../shared/workspaceAgentActivityListViewModel";

export type WorkspaceAgentMessageCenterDigestPrimaryKind =
  | "input-required"
  | "error"
  | "outcome"
  | "progress"
  | "summary";

export interface WorkspaceAgentMessageCenterDigestPrimary {
  kind: WorkspaceAgentMessageCenterDigestPrimaryKind;
  summary: string;
  occurredAtUnixMs: number | null;
}

export interface WorkspaceAgentMessageCenterDigest {
  primary: WorkspaceAgentMessageCenterDigestPrimary;
}

export interface BuildWorkspaceAgentMessageCenterDigestInput {
  fallbackTitle: string;
  messages: readonly AgentActivityMessage[];
  needsAttention: AgentActivityNeedsAttentionItem | null;
  pendingPrompt: AgentConversationPromptVM | null;
  status: WorkspaceAgentActivityStatus;
}

export function buildWorkspaceAgentMessageCenterDigest({
  fallbackTitle,
  messages,
  needsAttention,
  pendingPrompt,
  status
}: BuildWorkspaceAgentMessageCenterDigestInput): WorkspaceAgentMessageCenterDigest {
  const latestAgentMessage = latestAgentMessageSummary(messages);
  const fallbackSummary = firstNonEmptyString(
    latestAgentMessage?.summary ?? null,
    needsAttention?.summary ?? null,
    pendingPromptSummary(pendingPrompt),
    fallbackTitle
  );
  if (pendingPrompt || needsAttention) {
    return {
      primary: {
        kind: "input-required",
        summary: firstNonEmptyString(
          pendingPromptSummary(pendingPrompt),
          needsAttention?.summary ?? null,
          fallbackSummary
        ),
        occurredAtUnixMs:
          needsAttention?.occurredAtUnixMs ??
          promptTimeUnixMs(pendingPrompt) ??
          latestAgentMessage?.occurredAtUnixMs ??
          null
      }
    };
  }
  if (status === "failed") {
    return {
      primary: {
        kind: "error",
        summary: fallbackSummary,
        occurredAtUnixMs: latestAgentMessage?.occurredAtUnixMs ?? null
      }
    };
  }
  if (status === "completed" || status === "canceled" || status === "idle") {
    return {
      primary: {
        kind: "outcome",
        summary: fallbackSummary,
        occurredAtUnixMs: latestAgentMessage?.occurredAtUnixMs ?? null
      }
    };
  }
  if (status === "working") {
    return {
      primary: {
        kind: "progress",
        summary: fallbackSummary,
        occurredAtUnixMs: latestAgentMessage?.occurredAtUnixMs ?? null
      }
    };
  }
  return {
    primary: {
      kind: "summary",
      summary: fallbackSummary,
      occurredAtUnixMs: latestAgentMessage?.occurredAtUnixMs ?? null
    }
  };
}

function latestAgentMessageSummary(
  messages: readonly AgentActivityMessage[]
): { summary: string; occurredAtUnixMs: number } | null {
  return messages.reduce<{ summary: string; occurredAtUnixMs: number } | null>(
    (latest, message) => {
      if (!isAgentMessageRole(message.role)) {
        return latest;
      }
      const summary = meaningfulMessageSummary(message);
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

function pendingPromptSummary(
  prompt: AgentConversationPromptVM | null
): string | null {
  if (!prompt) {
    return null;
  }
  switch (prompt.kind) {
    case "ask-user":
      return firstNonEmptyString(
        prompt.title,
        prompt.questions[0]?.question ?? null
      );
    case "approval":
    case "exit-plan":
    case "plan-implementation":
      return prompt.title;
  }
}

function promptTimeUnixMs(
  prompt: AgentConversationPromptVM | null
): number | null {
  if (!prompt || !("occurredAtUnixMs" in prompt)) {
    return null;
  }
  return positiveNumber(prompt.occurredAtUnixMs);
}

function isAgentMessageRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "assistant" || normalized === "agent";
}

type MessageSummarySource =
  | "payload.summary"
  | "payload.displayPrompt"
  | "payload.text"
  | "payload.content"
  | "payload.message"
  | "payload.body"
  | "tool.error"
  | "tool.output"
  | "tool.input"
  | "payload.title";

interface MessageSummaryCandidate {
  source: MessageSummarySource;
  summary: string;
}

function meaningfulMessageSummary(message: AgentActivityMessage): string {
  for (const candidate of messageSummaryCandidates(message)) {
    if (!isGenericToolLabelSummary(message, candidate)) {
      return decorateMessageSummary(message, candidate);
    }
  }
  return "";
}

function messageSummaryCandidates(
  message: AgentActivityMessage
): MessageSummaryCandidate[] {
  const explicitCandidates = [
    summaryCandidate("payload.summary", message.payload.summary),
    summaryCandidate("payload.displayPrompt", message.payload.displayPrompt),
    summaryCandidate("payload.text", message.payload.text),
    summaryCandidate("payload.content", message.payload.content),
    summaryCandidate("payload.message", message.payload.message),
    summaryCandidate("payload.body", message.payload.body)
  ];
  if (!isToolLikeMessage(message)) {
    return [
      ...explicitCandidates,
      summaryCandidate("payload.title", message.payload.title)
    ].filter((candidate): candidate is MessageSummaryCandidate =>
      Boolean(candidate)
    );
  }
  return [
    ...explicitCandidates,
    toolErrorSummaryCandidate(message.payload),
    toolOutputSummaryCandidate(message.payload),
    toolInputSummaryCandidate(message.payload),
    summaryCandidate("payload.title", message.payload.title)
  ].filter((candidate): candidate is MessageSummaryCandidate =>
    Boolean(candidate)
  );
}

function summaryCandidate(
  source: MessageSummarySource,
  value: unknown
): MessageSummaryCandidate | null {
  const summary = normalizeSummaryText(stringValue(value));
  return summary ? { source, summary } : null;
}

function toolErrorSummaryCandidate(
  payload: Record<string, unknown>
): MessageSummaryCandidate | null {
  const error = recordValue(payload.error);
  const rawOutput = recordValue(error.rawOutput);
  return summaryCandidate(
    "tool.error",
    firstNonEmptyString(
      stringValue(payload.error),
      stringValue(error.summary),
      stringValue(error.message),
      stringValue(error.detail),
      stringValue(error.text),
      textFromContentValue(error.content),
      stringValue(error.output),
      stringValue(error.stdout),
      stringValue(error.stderr),
      stringValue(error.aggregated_output),
      stringValue(error.formatted_output),
      stringValue(rawOutput.stdout),
      stringValue(rawOutput.stderr),
      stringValue(rawOutput.aggregated_output),
      stringValue(rawOutput.formatted_output),
      stringValue(error.error)
    )
  );
}

function toolOutputSummaryCandidate(
  payload: Record<string, unknown>
): MessageSummaryCandidate | null {
  const output = recordValue(payload.output);
  const rawOutput = recordValue(output.rawOutput);
  return summaryCandidate(
    "tool.output",
    firstNonEmptyString(
      stringValue(output.summary),
      stringValue(output.message),
      stringValue(output.text),
      textFromContentValue(output.content),
      stringValue(output.content),
      stringValue(output.result),
      stringValue(output.output),
      stringValue(output.stdout),
      stringValue(output.stderr),
      stringValue(output.aggregated_output),
      stringValue(output.formatted_output),
      stringValue(rawOutput.stdout),
      stringValue(rawOutput.stderr),
      stringValue(rawOutput.aggregated_output),
      stringValue(rawOutput.formatted_output),
      stringValue(payload.result)
    )
  );
}

function toolInputSummaryCandidate(
  payload: Record<string, unknown>
): MessageSummaryCandidate | null {
  const input = recordValue(payload.input);
  const rawInput = recordValue(input.rawInput);
  const action = recordValue(input.action);
  return summaryCandidate(
    "tool.input",
    firstNonEmptyString(
      stringValue(input.summary),
      stringValue(input.command),
      stringValue(input.cmd),
      stringValue(rawInput.command),
      stringValue(rawInput.cmd),
      stringValue(input.path),
      stringValue(input.file_path),
      stringValue(input.fileName),
      stringValue(input.filename),
      stringValue(input.query),
      stringArrayFirstValue(input.search_query),
      stringArrayFirstValue(input.searchQuery),
      stringValue(input.url),
      stringValue(input.pattern),
      stringValue(input.glob),
      stringValue(input.regex),
      stringValue(input.prompt),
      stringValue(action.query),
      stringValue(action.url)
    )
  );
}

function isGenericToolLabelSummary(
  message: AgentActivityMessage,
  candidate: MessageSummaryCandidate
): boolean {
  if (!isToolLikeMessage(message)) {
    return false;
  }
  const normalizedSummary = normalizeToken(candidate.summary);
  if (!normalizedSummary) {
    return true;
  }
  if (structuralToolLabelTokens(message).has(normalizedSummary)) {
    return true;
  }
  return (
    candidate.source === "payload.title" &&
    !hasToolDigestSignal(message) &&
    looksLikeBareLabel(candidate.summary)
  );
}

function decorateMessageSummary(
  message: AgentActivityMessage,
  candidate: MessageSummaryCandidate
): string {
  if (!isToolLikeMessage(message)) {
    return candidate.summary;
  }
  const mcpTarget = extractAgentMcpToolTarget({ payload: message.payload });
  if (!mcpTarget) {
    return candidate.summary;
  }
  if (candidate.summary.includes(mcpTarget.displayName)) {
    return candidate.summary;
  }
  return `${mcpTarget.displayName}: ${candidate.summary}`;
}

function isToolLikeMessage(message: AgentActivityMessage): boolean {
  const payload = recordValue(message.payload);
  const normalizedKind = normalizeToken(message.kind);
  const normalizedType = [
    stringValue(payload.type),
    stringValue(payload.action),
    stringValue(payload.requestType)
  ]
    .map((value) => normalizeToken(value ?? ""))
    .join(" ");
  return (
    includesAny(normalizedKind, ["call", "tool"]) ||
    includesAny(normalizedType, ["call", "tool"]) ||
    Boolean(
      stringValue(payload.callType) ||
      stringValue(payload.toolName) ||
      stringValue(payload.tool) ||
      hasRecordValue(payload.input) ||
      hasRecordValue(payload.output) ||
      hasRecordValue(payload.error)
    )
  );
}

function structuralToolLabelTokens(message: AgentActivityMessage): Set<string> {
  const payload = recordValue(message.payload);
  const metadata = recordValue(payload.metadata);
  return new Set(
    [
      message.kind,
      message.status,
      stringValue(payload.type),
      stringValue(payload.action),
      stringValue(payload.requestType),
      stringValue(payload.callType),
      stringValue(payload.toolName),
      stringValue(payload.name),
      stringValue(payload.tool),
      stringValue(metadata.callType),
      stringValue(metadata.toolName),
      stringValue(metadata.name),
      stringValue(metadata.tool)
    ]
      .map((value) => normalizeToken(value ?? ""))
      .filter(Boolean)
  );
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(normalizeToken(needle)));
}

function hasToolDigestSignal(message: AgentActivityMessage): boolean {
  const payload = recordValue(message.payload);
  return Boolean(
    toolErrorSummaryCandidate(payload) ||
    toolOutputSummaryCandidate(payload) ||
    toolInputSummaryCandidate(payload)
  );
}

function looksLikeBareLabel(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 40 &&
    !/\s/u.test(trimmed) &&
    !/[/:\\.[\]{}()=#?&]/u.test(trimmed)
  );
}

function normalizeToken(value: string): string {
  return value.replace(/[_\s.-]+/g, "").toLowerCase();
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
  return (
    values.find((value) => value !== null && value.trim().length > 0) ?? ""
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArrayFirstValue(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return (
    value.map(stringValue).find((item): item is string => Boolean(item)) ?? null
  );
}

function textFromContentValue(value: unknown): string | null {
  if (typeof value === "string") {
    return stringValue(value);
  }
  if (Array.isArray(value)) {
    return (
      value
        .map(textFromContentValue)
        .find((item): item is string => Boolean(item)) ?? null
    );
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return firstNonEmptyString(
    stringValue(record.text),
    "content" in record ? textFromContentValue(record.content) : null
  );
}

function normalizeSummaryText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value
    .replace(/^#{1,6}\s+error\s*\n+/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasRecordValue(value: unknown): boolean {
  return Object.keys(recordValue(value)).length > 0;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
