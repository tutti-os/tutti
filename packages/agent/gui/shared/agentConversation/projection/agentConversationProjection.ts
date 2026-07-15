import type {
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "../../workspaceAgentSessionDetailViewModel";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import { computeAgentToolGroups } from "./agentToolGroupingProjection";
import { buildAgentTurnSequenceItems } from "./agentTurnSequenceProjection";
import { projectTurnRows } from "./agentTurnRowProjection";
import { projectAgentProcessingRow } from "./agentProcessingProjection";
import {
  projectAgentTurnSummaryRowForTurn,
  projectAgentTurnSummaryRows
} from "./agentTurnSummaryProjection";

export interface AgentConversationProjectionOptions {
  avoidGroupingEdits?: boolean;
}

const RENDER_IRRELEVANT_TRANSCRIPT_ROW_FIELDS = new Set(["occurredAtUnixMs"]);
const CODEX_SKILLS_CONTEXT_BUDGET_NOTICE_FRAGMENT =
  "skill descriptions were shortened to fit the 2% skills context budget";
const CODEX_MODEL_METADATA_FALLBACK_NOTICE_FRAGMENT =
  "defaulting to fallback metadata";

export function projectAgentConversationVM(
  detail: WorkspaceAgentSessionDetailViewModel,
  options: AgentConversationProjectionOptions = {}
): AgentConversationVM {
  const rows: AgentTranscriptRowVM[] = [];
  const turns = detail.turns;

  turns.forEach((turn, index) => {
    rows.push(
      ...projectTurnConversationRows(turn, detail.session.workspaceId, {
        agentSessionId: detail.session.agentSessionId,
        avoidGroupingEdits: options.avoidGroupingEdits
      })
    );
    if (shouldShowTurnSummaryForTurn(detail, index)) {
      rows.push(
        ...projectAgentTurnSummaryRowForTurn(turn, {
          defaultCwd: detail.cwd,
          workspaceRoot: detail.workspaceRoot
        })
      );
    }
  });

  if (
    !rows.some((row) => row.kind === "turn-summary") &&
    shouldShowLatestTurnSummaryFallback(detail)
  ) {
    rows.push(...projectAgentTurnSummaryRows(detail));
  }

  const processing = projectAgentProcessingRow(detail, rows);
  if (processing) {
    rows.push(processing);
  }

  const normalizedRows = projectMessageCopyText(
    dropCodexRuntimeDiagnosticNotices(
      dropRedundantErrorWarningNotices(
        mergeAdjacentAssistantMessageRows(
          mergeAdjacentTransportRetryNoticeRows(rows)
        )
      )
    ),
    {
      assistantCopyEligibleTurnIds: buildAssistantCopyEligibleTurnIds(detail)
    }
  );

  return {
    activity: detail.activity,
    workspaceRoot: detail.workspaceRoot,
    sourceDetail: detail,
    rows: normalizedRows
  };
}

export function reconcileProjectedAgentConversationVM(
  previous: AgentConversationVM | null | undefined,
  next: AgentConversationVM
): AgentConversationVM {
  if (!previous) {
    return next;
  }

  const previousRowsById = new Map(previous.rows.map((row) => [row.id, row]));
  let reusedRowCount = 0;
  const rows = next.rows.map((row) => {
    const previousRow = previousRowsById.get(row.id);
    if (previousRow && equivalentTranscriptRowForRender(previousRow, row)) {
      reusedRowCount += 1;
      return previousRow;
    }
    return row;
  });
  const rowsArrayReused =
    reusedRowCount === next.rows.length &&
    next.rows.length === previous.rows.length &&
    next.rows.every((_row, index) => rows[index] === previous.rows[index]);

  return {
    ...next,
    rows: rowsArrayReused ? previous.rows : rows
  };
}

function equivalentTranscriptRowForRender(
  previous: AgentTranscriptRowVM,
  next: AgentTranscriptRowVM
): boolean {
  return equivalentValueIgnoringKeys(
    previous,
    next,
    RENDER_IRRELEVANT_TRANSCRIPT_ROW_FIELDS
  );
}

function equivalentValueIgnoringKeys(
  left: unknown,
  right: unknown,
  ignoredKeys: ReadonlySet<string>
): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        equivalentValueIgnoringKeys(value, right[index], ignoredKeys)
      )
    );
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter(
    (key) => !ignoredKeys.has(key)
  );
  const rightKeys = Object.keys(rightRecord).filter(
    (key) => !ignoredKeys.has(key)
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        equivalentValueIgnoringKeys(
          leftRecord[key],
          rightRecord[key],
          ignoredKeys
        )
    )
  );
}

function mergeAdjacentAssistantMessageRows(
  rows: readonly AgentTranscriptRowVM[]
): AgentTranscriptRowVM[] {
  const merged: AgentTranscriptRowVM[] = [];
  for (const row of rows) {
    const previous = merged.at(-1);
    if (
      isMergeableAssistantMessageRow(previous) &&
      canMergeAdjacentAssistantMessageRows(previous, row)
    ) {
      const lastMessage = previous.messages.at(-1);
      const nextMessage = row.messages[0];
      if (lastMessage && nextMessage) {
        lastMessage.body += nextMessage.body;
        lastMessage.statusKind =
          nextMessage.statusKind ?? lastMessage.statusKind ?? null;
        lastMessage.occurredAtUnixMs =
          nextMessage.occurredAtUnixMs ?? lastMessage.occurredAtUnixMs;
      }
      if (row.messages.length > 1) {
        previous.messages.push(...row.messages.slice(1));
      }
      previous.occurredAtUnixMs =
        row.occurredAtUnixMs ?? previous.occurredAtUnixMs;
      continue;
    }
    merged.push(row);
  }
  return merged;
}

function dropCodexRuntimeDiagnosticNotices(
  rows: readonly AgentTranscriptRowVM[]
): AgentTranscriptRowVM[] {
  const filteredRows: AgentTranscriptRowVM[] = [];
  for (const row of rows) {
    if (row.kind !== "message" || row.speaker !== "assistant") {
      filteredRows.push(row);
      continue;
    }
    const messages = row.messages.filter(
      (message) => !isCodexSkillsContextBudgetNotice(message)
    );
    if (messages.length === 0 && row.thinking.length === 0) {
      continue;
    }
    if (messages.length === row.messages.length) {
      filteredRows.push(row);
      continue;
    }
    filteredRows.push({ ...row, messages });
  }
  return filteredRows;
}

function isCodexSkillsContextBudgetNotice(
  message: AgentMessageContentVM
): boolean {
  const notice = message.systemNotice;
  if (!notice || notice.noticeKind !== "warning") {
    return false;
  }
  if (notice.source !== "runtime") {
    return false;
  }
  const text = [notice.title, notice.detail, message.body]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return (
    text.includes(CODEX_SKILLS_CONTEXT_BUDGET_NOTICE_FRAGMENT) ||
    text.includes(CODEX_MODEL_METADATA_FALLBACK_NOTICE_FRAGMENT)
  );
}

function dropRedundantErrorWarningNotices(
  rows: readonly AgentTranscriptRowVM[]
): AgentTranscriptRowVM[] {
  const turnsWithVisibleError = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "message" || row.speaker !== "assistant") {
      continue;
    }
    for (const message of row.messages) {
      if (message.visibleError) {
        turnsWithVisibleError.add(row.turnId);
      }
    }
  }
  if (turnsWithVisibleError.size === 0) {
    return [...rows];
  }

  const filteredRows: AgentTranscriptRowVM[] = [];
  for (const row of rows) {
    if (row.kind !== "message" || row.speaker !== "assistant") {
      filteredRows.push(row);
      continue;
    }
    if (!turnsWithVisibleError.has(row.turnId)) {
      filteredRows.push(row);
      continue;
    }
    const messages = row.messages.filter(
      (message) => !isRedundantErrorWarningNotice(message)
    );
    if (messages.length === 0) {
      continue;
    }
    if (messages.length === row.messages.length) {
      filteredRows.push(row);
      continue;
    }
    filteredRows.push({ ...row, messages });
  }
  return filteredRows;
}

function isRedundantErrorWarningNotice(
  message: AgentMessageContentVM
): boolean {
  const notice = message.systemNotice;
  if (!notice || notice.noticeKind !== "warning") {
    return false;
  }
  const title = notice.title?.trim() ?? "";
  return title === "Codex reported an error.";
}

function mergeAdjacentTransportRetryNoticeRows(
  rows: readonly AgentTranscriptRowVM[]
): AgentTranscriptRowVM[] {
  const merged: AgentTranscriptRowVM[] = [];
  for (const row of rows) {
    const previous = merged.at(-1);
    if (
      isSingleTransportRetryNoticeRow(previous) &&
      isSingleTransportRetryNoticeRow(row) &&
      previous.turnId === row.turnId
    ) {
      const previousMessage = previous.messages[0];
      const nextMessage = row.messages[0];
      if (!previousMessage || !nextMessage) {
        merged.push(row);
        continue;
      }
      const sourceTimelineItems = mergeSourceTimelineItems(
        previousMessage.sourceTimelineItems,
        nextMessage.sourceTimelineItems
      );
      previous.messages[0] = {
        ...previousMessage,
        body: nextMessage.body || previousMessage.body,
        systemNotice: nextMessage.systemNotice ?? previousMessage.systemNotice,
        statusKind:
          nextMessage.statusKind ?? previousMessage.statusKind ?? null,
        occurredAtUnixMs:
          nextMessage.occurredAtUnixMs ?? previousMessage.occurredAtUnixMs,
        ...(sourceTimelineItems ? { sourceTimelineItems } : {})
      };
      previous.occurredAtUnixMs =
        row.occurredAtUnixMs ?? previous.occurredAtUnixMs;
      continue;
    }
    merged.push(row);
  }
  return merged;
}

function isSingleTransportRetryNoticeRow(
  row: AgentTranscriptRowVM | undefined
): row is AgentMessageRowVM {
  if (
    !row ||
    row.kind !== "message" ||
    row.speaker !== "assistant" ||
    row.thinking.length > 0 ||
    row.messages.length !== 1
  ) {
    return false;
  }
  return row.messages[0]?.systemNotice?.noticeKind === "transport_retry";
}

function mergeSourceTimelineItems(
  previous: AgentMessageContentVM["sourceTimelineItems"],
  next: AgentMessageContentVM["sourceTimelineItems"]
): AgentMessageContentVM["sourceTimelineItems"] {
  if (!previous || previous.length === 0) {
    return next;
  }
  if (!next || next.length === 0) {
    return previous;
  }
  return [...previous, ...next];
}

function projectMessageCopyText(
  rows: readonly AgentTranscriptRowVM[],
  options: { assistantCopyEligibleTurnIds: ReadonlySet<string> }
): AgentTranscriptRowVM[] {
  const assistantCopyTargetKeys = findLatestAssistantCopyTargetKeys(
    rows,
    options.assistantCopyEligibleTurnIds
  );
  return rows.map((row) => {
    if (row.kind !== "message") {
      return row;
    }

    let changed = false;
    const messages = row.messages.map((message) => {
      const copyText =
        row.speaker === "user"
          ? copyTextForUserMessage(message)
          : assistantCopyTargetKeys.has(messageCopyTargetKey(row, message))
            ? message.body
            : null;
      if ((message.copyText ?? null) === copyText) {
        return message;
      }
      changed = true;
      if (copyText) {
        return { ...message, copyText };
      }
      const { copyText: _copyText, ...withoutCopyText } = message;
      return withoutCopyText;
    });

    return changed ? { ...row, messages } : row;
  });
}

function buildAssistantCopyEligibleTurnIds(
  detail: WorkspaceAgentSessionDetailViewModel
): ReadonlySet<string> {
  const ids = new Set<string>();
  detail.turns.forEach((turn, index) => {
    if (index < detail.turns.length - 1 || isLatestTurnSettled(detail)) {
      ids.add(turn.id);
    }
  });
  return ids;
}

function findLatestAssistantCopyTargetKeys(
  rows: readonly AgentTranscriptRowVM[],
  eligibleTurnIds: ReadonlySet<string>
): ReadonlySet<string> {
  const targetKeys = new Set<string>();
  const coveredTurnIds = new Set<string>();
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex];
    if (
      row?.kind !== "message" ||
      row.speaker !== "assistant" ||
      coveredTurnIds.has(row.turnId) ||
      !eligibleTurnIds.has(row.turnId)
    ) {
      continue;
    }
    for (
      let messageIndex = row.messages.length - 1;
      messageIndex >= 0;
      messageIndex -= 1
    ) {
      const message = row.messages[messageIndex];
      if (message && isSettledTextMessageCopyCandidate(message)) {
        targetKeys.add(messageCopyTargetKey(row, message));
        coveredTurnIds.add(row.turnId);
        break;
      }
    }
  }
  return targetKeys;
}

function messageCopyTargetKey(
  row: AgentMessageRowVM,
  message: AgentMessageContentVM
): string {
  return `${row.id}\u0000${message.id}`;
}

function copyTextForUserMessage(message: AgentMessageContentVM): string | null {
  return isTextMessageCopyCandidate(message) ? message.body : null;
}

function isSettledTextMessageCopyCandidate(
  message: AgentMessageContentVM
): boolean {
  return (
    isTextMessageCopyCandidate(message) &&
    message.statusKind !== "working" &&
    message.statusKind !== "waiting"
  );
}

function isTextMessageCopyCandidate(message: AgentMessageContentVM): boolean {
  return (
    message.body.trim() !== "" &&
    message.contentKind !== "image-grid" &&
    !message.visibleError &&
    !message.systemNotice
  );
}

function isMergeableAssistantMessageRow(
  row: AgentTranscriptRowVM | undefined
): row is AgentMessageRowVM {
  return Boolean(
    row &&
    row.kind === "message" &&
    row.speaker === "assistant" &&
    row.thinking.length === 0 &&
    !row.messages.some(isSpecialAssistantMessage)
  );
}

function canMergeAdjacentAssistantMessageRows(
  previous: AgentMessageRowVM,
  next: AgentTranscriptRowVM
): next is AgentMessageRowVM {
  return (
    next.kind === "message" &&
    next.speaker === "assistant" &&
    next.thinking.length === 0 &&
    previous.turnId === next.turnId &&
    !next.messages.some(isSpecialAssistantMessage)
  );
}

function isSpecialAssistantMessage(message: {
  visibleError?: unknown;
  systemNotice?: unknown;
  contentKind?: string;
}): boolean {
  return Boolean(
    message.visibleError ||
    message.systemNotice ||
    message.contentKind === "plan"
  );
}

function shouldShowTurnSummaryForTurn(
  detail: WorkspaceAgentSessionDetailViewModel,
  turnIndex: number
): boolean {
  return turnIndex < detail.turns.length - 1 || isLatestTurnSettled(detail);
}

function shouldShowLatestTurnSummaryFallback(
  detail: WorkspaceAgentSessionDetailViewModel
): boolean {
  return detail.turns.length === 0 || isLatestTurnSettled(detail);
}

function isLatestTurnSettled(
  detail: WorkspaceAgentSessionDetailViewModel
): boolean {
  const phase = detail.session.activeTurn?.phase.trim().toLowerCase() ?? "";
  const canonicalTurnUnsettled = [
    "submitted",
    "running",
    "waiting",
    "settling"
  ].includes(phase);
  return detail.showProcessingIndicator !== true && !canonicalTurnUnsettled;
}

function projectTurnConversationRows(
  turn: WorkspaceAgentSessionDetailTurn,
  workspaceId: string | null | undefined,
  options: {
    agentSessionId: string;
    avoidGroupingEdits?: boolean;
  }
): AgentTranscriptRowVM[] {
  const sequence = buildAgentTurnSequenceItems(turn, workspaceId);
  const { groups, groupedIndices, suppressedIndices } = computeAgentToolGroups(
    sequence,
    options
  );
  const skippedIndices = new Set([...groupedIndices, ...suppressedIndices]);
  return projectTurnRows(
    sequence,
    groups,
    skippedIndices,
    turn.id,
    options.agentSessionId
  );
}
