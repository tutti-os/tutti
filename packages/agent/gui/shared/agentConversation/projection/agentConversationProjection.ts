import type {
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "../../workspaceAgentSessionDetailViewModel";
import type { AgentApprovalItemVM } from "../contracts/agentApprovalItemVM";
import type {
  AgentConversationPendingInteractivePromptVM,
  AgentConversationVM
} from "../contracts/agentConversationVM";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import {
  buildAgentTurnSequenceItems,
  computeAgentToolGroups
} from "./agentToolGroupingProjection";
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

export function projectAgentConversationVM(
  detail: WorkspaceAgentSessionDetailViewModel,
  options: AgentConversationProjectionOptions = {}
): AgentConversationVM {
  const rows: AgentTranscriptRowVM[] = [];
  const turns = detail.turns;
  const allowTrailingToolGrouping = !isSessionWorking(detail);

  turns.forEach((turn, index) => {
    rows.push(...projectUserRows(turn, detail.session.workspaceId));
    rows.push(
      ...projectTurnAgentRows(turn, {
        agentSessionId: detail.session.agentSessionId,
        turnIndex: index,
        allowTrailingFinalization:
          allowTrailingToolGrouping || index < turns.length - 1,
        avoidGroupingEdits: options.avoidGroupingEdits
      })
    );
    if (shouldShowTurnSummaryForTurn(detail, index)) {
      rows.push(
        ...projectAgentTurnSummaryRowForTurn(turn, {
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
    rows: normalizedRows,
    pendingApproval: selectPendingApproval(normalizedRows),
    pendingInteractivePrompt: selectPendingInteractivePrompt(normalizedRows)
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
    rows: rowsArrayReused ? previous.rows : rows,
    pendingApproval: reuseEquivalentValue(
      previous.pendingApproval,
      next.pendingApproval
    ),
    pendingInteractivePrompt: reuseEquivalentValue(
      previous.pendingInteractivePrompt,
      next.pendingInteractivePrompt
    )
  };
}

function reuseEquivalentValue<T>(previous: T, next: T): T {
  return equivalentValue(previous, next) ? previous : next;
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

function equivalentValue(left: unknown, right: unknown): boolean {
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
      left.every((value, index) => equivalentValue(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") {
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
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        equivalentValue(leftRecord[key], rightRecord[key])
    )
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
  return text.includes(CODEX_SKILLS_CONTEXT_BUDGET_NOTICE_FRAGMENT);
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
  const status = normalizedSessionDisplayStatus(detail);
  return !isUnsettledSessionStatus(status);
}

function isSessionWorking(
  detail: WorkspaceAgentSessionDetailViewModel
): boolean {
  const status = normalizedSessionDisplayStatus(detail);
  return isWorkingSessionStatus(status);
}

function isWorkingSessionStatus(status: string): boolean {
  return status === "working";
}

function isUnsettledSessionStatus(status: string): boolean {
  return isWorkingSessionStatus(status) || status === "waiting";
}

function normalizeStatusToken(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? "";
}

function normalizedSessionDisplayStatus(
  detail: WorkspaceAgentSessionDetailViewModel
): string {
  const session = detail.session as {
    effectiveStatus?: string | null;
    turnPhase?: string | null;
    status?: string | null;
  };
  return normalizeStatusToken(
    session.effectiveStatus ?? session.turnPhase ?? session.status
  );
}

function projectUserRows(
  turn: WorkspaceAgentSessionDetailTurn,
  workspaceId: string | null | undefined
): AgentMessageRowVM[] {
  return turn.userMessages.map((message) => {
    const turnId = message.turnId ?? turn.id;
    return {
      kind: "message",
      id: `message:user:${message.id}`,
      turnId,
      speaker: "user",
      messages: projectUserMessageContentParts(message, turnId, workspaceId),
      thinking: [],
      occurredAtUnixMs: message.occurredAtUnixMs ?? null
    };
  });
}

function projectUserMessageContentParts(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  turnId: string,
  workspaceId: string | null | undefined
): AgentMessageContentVM[] {
  const blocks = userPromptContentBlocks(message, workspaceId);
  if (blocks.length === 0) {
    return [
      {
        kind: "message-content",
        id: message.id,
        turnId,
        body: message.body,
        contentKind: "text",
        occurredAtUnixMs: message.occurredAtUnixMs ?? null,
        sourceTimelineItems: message.sourceTimelineItems
      }
    ];
  }

  const parts: AgentMessageContentVM[] = [];
  const imageBlocks = blocks.filter(
    (block): block is UserPromptImageBlock => block.type === "image"
  );
  if (imageBlocks.length > 0) {
    parts.push({
      kind: "message-content",
      id: `${message.id}:images:0`,
      turnId,
      body: "",
      contentKind: "image-grid",
      images: imageBlocks.map((image, index) => ({
        id:
          image.path || image.attachmentId || `${message.id}:image:0:${index}`,
        workspaceId: image.workspaceId,
        agentSessionId: image.agentSessionId,
        attachmentId: image.attachmentId,
        mimeType: image.mimeType,
        name: image.name,
        data: image.data,
        path: image.path
      })),
      occurredAtUnixMs: message.occurredAtUnixMs ?? null,
      sourceTimelineItems: message.sourceTimelineItems
    });
  }

  blocks.forEach((block, index) => {
    if (block.type === "image") {
      return;
    }
    if (block.text.trim() === "") {
      return;
    }
    parts.push({
      kind: "message-content",
      id: `${message.id}:text:${index}`,
      turnId,
      body: block.text,
      contentKind: "text",
      occurredAtUnixMs: message.occurredAtUnixMs ?? null,
      sourceTimelineItems: message.sourceTimelineItems
    });
  });

  return parts.length > 0
    ? parts
    : [
        {
          kind: "message-content",
          id: message.id,
          turnId,
          body: message.body,
          contentKind: "text",
          occurredAtUnixMs: message.occurredAtUnixMs ?? null,
          sourceTimelineItems: message.sourceTimelineItems
        }
      ];
}

type UserPromptContentBlock = UserPromptTextBlock | UserPromptImageBlock;

interface UserPromptTextBlock {
  type: "text";
  text: string;
}

interface UserPromptImageBlock {
  type: "image";
  workspaceId?: string | null;
  agentSessionId: string;
  attachmentId?: string | null;
  mimeType: string;
  name?: string | null;
  data?: string | null;
  path?: string | null;
}

function userPromptContentBlocks(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  fallbackWorkspaceId: string | null | undefined
): UserPromptContentBlock[] {
  const item = message.sourceTimelineItems?.find((candidate) =>
    Array.isArray(candidate.payload?.content)
  );
  const content = Array.isArray(item?.payload?.content)
    ? item.payload.content
    : null;
  if (!content) {
    return [];
  }
  const displayPrompt = firstString(
    message.sourceTimelineItems?.map((candidate) =>
      typeof candidate.payload?.displayPrompt === "string"
        ? candidate.payload.displayPrompt
        : ""
    ) ?? []
  );
  const blocks = content.flatMap((raw): UserPromptContentBlock[] => {
    const block =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    if (!block) {
      return [];
    }
    if (block.type === "text" && typeof block.text === "string") {
      if (displayPrompt) {
        return [];
      }
      return [{ type: "text", text: block.text }];
    }
    if (block.type !== "image") {
      return [];
    }
    const mimeType =
      typeof block.mimeType === "string" && block.mimeType.trim()
        ? block.mimeType.trim()
        : "";
    if (!mimeType) {
      return [];
    }
    return [
      {
        type: "image",
        workspaceId: item?.workspaceId ?? fallbackWorkspaceId ?? null,
        agentSessionId: item?.agentSessionId ?? message.id,
        attachmentId:
          typeof block.attachmentId === "string" && block.attachmentId.trim()
            ? block.attachmentId.trim()
            : null,
        mimeType,
        name:
          typeof block.name === "string" && block.name.trim()
            ? block.name.trim()
            : null,
        data:
          typeof block.data === "string" && block.data.trim()
            ? block.data.trim()
            : null,
        path:
          typeof block.path === "string" && block.path.trim()
            ? block.path.trim()
            : null
      }
    ];
  });
  if (!displayPrompt) {
    return blocks;
  }
  return [{ type: "text", text: displayPrompt }, ...blocks];
}

function firstString(values: readonly string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function projectTurnAgentRows(
  turn: WorkspaceAgentSessionDetailTurn,
  options: {
    agentSessionId: string;
    turnIndex: number;
    allowTrailingFinalization: boolean;
    avoidGroupingEdits?: boolean;
  }
): AgentTranscriptRowVM[] {
  const sequence = buildAgentTurnSequenceItems(turn);
  const { groups, groupedIndices, suppressedIndices } = computeAgentToolGroups(
    sequence,
    options
  );
  const skippedIndices = new Set([...groupedIndices, ...suppressedIndices]);
  return projectTurnRows(sequence, groups, skippedIndices, turn.id);
}

function selectPendingApproval(
  rows: readonly AgentTranscriptRowVM[]
): AgentApprovalItemVM | null {
  for (const row of [...rows].reverse()) {
    if (row.kind !== "tool-group") {
      continue;
    }
    for (const call of toolCallsFromRow(row).reverse()) {
      const approval = call.approval ?? fallbackApprovalFromCall(call);
      if (
        approval &&
        normalizeApprovalPendingStatus(
          approval.status ?? call.status,
          call.statusKind
        ) &&
        !approval.output
      ) {
        return approval;
      }
    }
  }
  return null;
}

function selectPendingInteractivePrompt(
  rows: readonly AgentTranscriptRowVM[]
): AgentConversationPendingInteractivePromptVM | null {
  for (const row of [...rows].reverse()) {
    if (row.kind !== "tool-group") {
      continue;
    }
    for (const call of toolCallsFromRow(row).reverse()) {
      if (
        call.askUserQuestion &&
        normalizeInteractivePendingStatus(
          call.askUserQuestion.status ?? call.status,
          call.statusKind
        ) &&
        call.askUserQuestion.questions.some(
          (question) => question.answer === null
        )
      ) {
        return {
          kind: "ask-user",
          requestId: call.askUserQuestion.requestId,
          title: call.askUserQuestion.title,
          questions: call.askUserQuestion.questions
        };
      }
      if (
        call.planMode?.kind === "exit" &&
        normalizeInteractivePendingStatus(
          call.planMode.status ?? call.status,
          call.statusKind
        )
      ) {
        return {
          kind: "exit-plan",
          requestId: call.planMode.requestId ?? call.id.replace(/^call:/, ""),
          title: call.planMode.title,
          options: call.planMode.options ?? [],
          ...(call.planMode.keepPlanningOptionId
            ? { keepPlanningOptionId: call.planMode.keepPlanningOptionId }
            : {})
        };
      }
    }
  }
  return null;
}

function toolCallsFromRow(
  row: Extract<AgentTranscriptRowVM, { kind: "tool-group" }>
): AgentToolCallVM[] {
  return row.calls.length > 0
    ? [...row.calls]
    : row.entries.flatMap((entry) =>
        entry.kind === "tool-call" ? [entry.call] : []
      );
}

function normalizeApprovalPendingStatus(
  value: string | null | undefined,
  statusKind: AgentToolCallVM["statusKind"]
): boolean {
  if (statusKind === "waiting") {
    return true;
  }
  const normalized = (value ?? "").trim().toLowerCase();
  switch (normalized) {
    case "awaiting_approval":
    case "requested":
    case "waiting_approval":
    case "waiting":
      return true;
    default:
      return false;
  }
}

function normalizeInteractivePendingStatus(
  value: string | null | undefined,
  statusKind: AgentToolCallVM["statusKind"]
): boolean {
  if (statusKind === "waiting" || statusKind === "working") {
    return true;
  }
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "waiting_input" ||
    normalized === "waiting" ||
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "streaming" ||
    normalized === "working"
  );
}

function fallbackApprovalFromCall(
  call: AgentToolCallVM
): AgentApprovalItemVM | null {
  if (call.rendererKind !== "approval") {
    return null;
  }
  const rawOptions = Array.isArray(call.input?.options)
    ? call.input.options
    : [];
  const options = rawOptions.flatMap((option) => {
    const record =
      option && typeof option === "object" && !Array.isArray(option)
        ? (option as Record<string, unknown>)
        : null;
    const id =
      typeof record?.id === "string" && record.id.trim()
        ? record.id.trim()
        : typeof record?.optionId === "string" && record.optionId.trim()
          ? record.optionId.trim()
          : "";
    if (!id) {
      return [];
    }
    return [
      {
        id,
        label:
          typeof record?.name === "string" && record.name.trim()
            ? record.name.trim()
            : typeof record?.label === "string" && record.label.trim()
              ? record.label.trim()
              : id,
        kind:
          typeof record?.kind === "string" && record.kind.trim()
            ? record.kind.trim()
            : id,
        ...(typeof record?.description === "string" && record.description.trim()
          ? { description: record.description.trim() }
          : {})
      }
    ];
  });
  const requestId =
    (typeof call.input?.requestId === "string" && call.input.requestId.trim()
      ? call.input.requestId.trim()
      : null) ?? call.id.replace(/^call:/, "");
  if (!requestId || options.length === 0) {
    return null;
  }
  return {
    kind: "approval",
    id: call.id,
    turnId: call.turnId,
    requestId,
    callId: call.id.replace(/^call:/, ""),
    title: call.summary.trim() || call.name,
    status:
      typeof call.payload?.status === "string" && call.payload.status.trim()
        ? call.payload.status.trim()
        : call.status,
    toolName: call.toolName,
    input: call.input,
    options,
    output: call.output,
    occurredAtUnixMs: call.occurredAtUnixMs
  };
}
