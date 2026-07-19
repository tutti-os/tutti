import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import {
  buildAgentTranscriptTurnGroups,
  transcriptRowKey
} from "../components/agentTranscriptModel";

export interface AgentConversationExportTurn {
  turnId: string;
  rows: AgentTranscriptRowVM[];
}

export interface AgentConversationExportLabels {
  agentText: string;
  executionRecord: string;
  fileChanges: string;
  prompt: string;
  questionAnswer: (index: number) => string;
  toolCalls: (count: number) => string;
}

export type AgentConversationExportErrorKind =
  | "desktop-restart-required"
  | "unknown";

export function classifyAgentConversationExportError(
  error: unknown
): AgentConversationExportErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No handler registered") &&
    message.includes("host:files:exportAgentConversation")
    ? "desktop-restart-required"
    : "unknown";
}

export function buildAgentConversationExportTurns(
  conversation: AgentConversationVM
): AgentConversationExportTurn[] {
  const activeTurnId = conversation.sourceDetail.session.activeTurnId;
  const activeTurnPhase = conversation.sourceDetail.session.activeTurn?.phase;
  const activeTurnIsSettled = activeTurnPhase === "settled";
  return buildAgentTranscriptTurnGroups(
    conversation.rows,
    conversation.rows.map((row) => row.id)
  ).flatMap((group) => {
    if (!group.turnId) {
      return [];
    }
    const rows = group.rows.map(({ row }) => row);
    const hasPrompt = rows.some(isNonEmptyUserMessageRow);
    const hasAgentFeedback = rows.some(isNonEmptyAgentFeedbackRow);
    const isProcessing = rows.some((row) => row.kind === "processing");
    const isActiveAndUnsettled =
      group.turnId === activeTurnId && !activeTurnIsSettled;
    if (
      !hasPrompt ||
      !hasAgentFeedback ||
      isProcessing ||
      isActiveAndUnsettled
    ) {
      return [];
    }
    return [{ turnId: group.turnId, rows }];
  });
}

export function toggleAgentConversationExportTurn(
  selectedTurnIds: ReadonlySet<string>,
  turnId: string
): Set<string> {
  const next = new Set(selectedTurnIds);
  if (next.has(turnId)) {
    next.delete(turnId);
  } else {
    next.add(turnId);
  }
  return next;
}

export function buildAgentConversationPrintConversation(
  conversation: AgentConversationVM,
  selectedTurnIds: ReadonlySet<string>
): AgentConversationVM {
  return {
    ...conversation,
    rows: conversation.rows.filter(
      (row) => row.turnId && selectedTurnIds.has(row.turnId)
    ),
    sourceDetail: {
      ...conversation.sourceDetail,
      session: {
        ...conversation.sourceDetail.session,
        activeTurn: null,
        activeTurnId: null
      },
      sessionTurns: conversation.sourceDetail.sessionTurns?.filter((turn) =>
        selectedTurnIds.has(turn.turnId)
      ),
      showProcessingIndicator: false,
      turns: conversation.sourceDetail.turns.filter((turn) =>
        selectedTurnIds.has(turn.id)
      )
    }
  };
}

export function serializeAgentConversationExportMarkdown(input: {
  expandedToolRowKeys: ReadonlySet<string>;
  labels: AgentConversationExportLabels;
  title: string;
  turns: readonly AgentConversationExportTurn[];
}): string {
  const title = headingText(input.title) || "Conversation";
  const sections = input.turns.map((turn, index) =>
    serializeTurn(turn, index + 1, input.labels, input.expandedToolRowKeys)
  );
  return [`# ${title}`, ...sections].join("\n\n---\n\n").trimEnd() + "\n";
}

export function suggestedAgentConversationExportFileName(input: {
  format: "markdown" | "pdf";
  now?: Date;
  openingText: string;
  sessionId: string;
}): string {
  const opening = fileNameSegment(
    Array.from(input.openingText.trim()).slice(0, 6).join("")
  );
  const session = fileNameSegment(
    Array.from(input.sessionId.trim()).slice(0, 6).join("")
  );
  const timestamp = localTimestamp(input.now ?? new Date());
  const extension = input.format === "markdown" ? "md" : "pdf";
  return `${timestamp}_${opening || "conversation"}_${session || "session"}.${extension}`;
}

export function agentConversationOpeningText(
  conversation: AgentConversationVM
): string {
  for (const row of conversation.rows) {
    if (row.kind !== "message" || row.speaker !== "user") continue;
    const body = visibleMessageBodies(row).join("\n").trim();
    if (body) return body;
  }
  return "";
}

function serializeTurn(
  turn: AgentConversationExportTurn,
  index: number,
  labels: AgentConversationExportLabels,
  expandedToolRowKeys: ReadonlySet<string>
): string {
  const parts = [`## ${headingText(labels.questionAnswer(index))}`];
  let currentSection:
    | "prompt"
    | "agent-text"
    | "execution"
    | "file-changes"
    | null = null;
  const enterSection = (
    section: Exclude<typeof currentSection, null>,
    label: string
  ): void => {
    if (currentSection === section) return;
    parts.push(`### ${headingText(label)}`);
    currentSection = section;
  };

  for (const row of turn.rows) {
    if (row.kind === "message" && row.speaker === "user") {
      const bodies = visibleMessageBodies(row);
      if (bodies.length === 0) continue;
      enterSection("prompt", labels.prompt);
      parts.push(...bodies);
      continue;
    }
    if (row.kind === "message" && row.speaker === "assistant") {
      const bodies = visibleMessageBodies(row);
      if (bodies.length === 0) continue;
      enterSection("agent-text", labels.agentText);
      parts.push(...bodies);
      continue;
    }
    if (row.kind === "tool-group") {
      if (row.grouped && !expandedToolRowKeys.has(transcriptRowKey(row))) {
        enterSection("execution", labels.executionRecord);
        parts.push(`- ${labels.toolCalls(row.calls.length)}`);
        continue;
      }
      const records = row.entries.flatMap((entry) =>
        entry.kind === "tool-call" ? [serializeToolCall(entry.call)] : []
      );
      if (records.length === 0 && row.summary?.trim()) {
        records.push(`- ${row.summary.trim()}`);
      }
      if (records.length === 0) continue;
      enterSection("execution", labels.executionRecord);
      parts.push(...records);
      continue;
    }
    if (row.kind === "turn-summary" && row.files.length > 0) {
      enterSection("file-changes", labels.fileChanges);
      parts.push(
        ...row.files.map(
          (file) => `- ${file.changeType}: \`${escapeInlineCode(file.path)}\``
        )
      );
      continue;
    }
    if (row.kind === "generated-image") {
      enterSection("agent-text", labels.agentText);
      const alt = row.prompt?.trim() || "Generated image";
      parts.push(`![${escapeMarkdownLabel(alt)}](${row.uri.trim()})`);
    }
  }

  return parts.join("\n\n");
}

function serializeToolCall(call: AgentToolCallVM): string {
  const status = call.status?.trim();
  const summary = call.summary.trim();
  const label = [call.name.trim(), status ? `(${status})` : ""]
    .filter(Boolean)
    .join(" ");
  const result = [`#### ${headingText(label || call.toolName || "Tool")}`];
  if (summary) result.push(summary);
  const detail = toolCallDetail(call);
  if (detail) {
    result.push(`\`\`\`json\n${detail}\n\`\`\``);
  }
  return result.join("\n\n");
}

function toolCallDetail(call: AgentToolCallVM): string | null {
  const structured = compactRecord({
    input: call.input,
    output: call.output,
    error: call.error
  });
  const value = Object.keys(structured).length > 0 ? structured : call.payload;
  if (!value || Object.keys(value).length === 0) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function compactRecord(
  input: Record<string, Record<string, unknown> | null | undefined>
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        typeof entry[1] === "object" && entry[1] !== null
    )
  );
}

function visibleMessageBodies(
  row: Extract<AgentTranscriptRowVM, { kind: "message" }>
): string[] {
  return row.messages.flatMap((message) => {
    const body = (message.copyText ?? message.body).trim();
    return body ? [body] : [];
  });
}

function isNonEmptyUserMessageRow(row: AgentTranscriptRowVM): boolean {
  return (
    row.kind === "message" &&
    row.speaker === "user" &&
    visibleMessageBodies(row).length > 0
  );
}

function isNonEmptyAgentFeedbackRow(row: AgentTranscriptRowVM): boolean {
  if (row.kind === "generated-image") return Boolean(row.uri.trim());
  return (
    row.kind === "message" &&
    row.speaker === "assistant" &&
    visibleMessageBodies(row).length > 0
  );
}

function headingText(value: string): string {
  return value
    .replace(/[\r\n#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\]]/g, "\\$&");
}

function fileNameSegment(value: string): string {
  return Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? "-" : character;
    })
    .join("")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function localTimestamp(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return (
    [value.getFullYear(), pad(value.getMonth() + 1), pad(value.getDate())].join(
      "."
    ) +
    `-${[pad(value.getHours()), pad(value.getMinutes()), pad(value.getSeconds())].join(".")}`
  );
}
