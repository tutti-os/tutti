import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import {
  isWorkspaceAgentToolCallItem,
  resolveWorkspaceAgentToolName
} from "./workspaceAgentToolCallDisplay";
import type {
  BuildWorkspaceAgentSessionDetailInput,
  WorkspaceAgentSessionDetailAgentItem,
  WorkspaceAgentSessionDetailToolCall,
  WorkspaceAgentSessionDetailToolGroupEntry,
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "./workspaceAgentSessionDetailViewModel";
import {
  isPlaceholderThinkingBody,
  isRecentDuplicateUserMessage,
  messageBody,
  messageRole,
  messageStatusKind,
  normalizedMessageBody,
  stripReviewProcessSummaryTitle,
  thinkingStatusKind
} from "./workspaceAgentTimelineMessageHelpers";
import { timelineItemOwnerThreadId } from "./agentConversation/projection/subAgentTimelinePartition";
import {
  compareToolCallsAscending,
  delegatedToolStepFromCall,
  firstPresentString,
  isTaskLikeToolCall,
  mergeSourceTimelineItems,
  normalizedPayload,
  parentToolUseIdFromCall,
  shouldShowProcessingIndicator,
  stringRecordValue,
  summarizeToolCallGroup,
  systemNoticeFromPayload,
  toolCallView,
  visibleErrorFromPayload,
  withSourceTimelineItems
} from "./workspaceAgentTimelineProjectionHelpers";

export function buildCanonicalWorkspaceAgentDetailView({
  activity,
  session,
  timelineItems,
  workspaceRoot = null
}: BuildWorkspaceAgentSessionDetailInput): WorkspaceAgentSessionDetailViewModel {
  const turns = new Map<string, WorkspaceAgentSessionDetailTurn>();
  const recentUserMessages = new Map<
    string,
    WorkspaceAgentActivityTimelineItem
  >();
  const seenThinkingMessages = new Set<string>();
  let activeSequenceTurnId: string | null = null;
  const sortedTimelineItems = [...timelineItems].sort(
    compareTimelineItemsAscending
  );
  const suppressedToolCallIds =
    suppressedUnavailableAskUserQuestionCallIds(sortedTimelineItems);

  for (const item of sortedTimelineItems) {
    // Sub-agent child-thread rows (payload.ownerThreadId) belong to the
    // delegated thread, not the parent transcript. They surface through the
    // parent's collab tool card lanes instead of interleaving here — even
    // when no matching card has arrived yet.
    if (timelineItemOwnerThreadId(item)) {
      continue;
    }
    const role = messageRole(item);
    const body = messageBody(item);
    const explicitTurnId = item.turnId?.trim();

    if (role === "user") {
      const turnId = explicitTurnId || `seq:${item.seq || item.id}`;
      if (!body) {
        continue;
      }
      if (
        isRecentDuplicateUserMessage(
          recentUserMessages.get(normalizedMessageBody(body)),
          item
        )
      ) {
        continue;
      }
      activeSequenceTurnId = turnId;
      const turn = getTurn(turns, turnId);
      const message = withSourceTimelineItems(
        {
          id: itemId(item),
          body,
          turnId,
          occurredAtUnixMs:
            item.occurredAtUnixMs ?? item.createdAtUnixMs ?? null
        },
        [item]
      );
      turn.userMessages.push(message);
      turn.userMessage ??= message;
      recentUserMessages.set(normalizedMessageBody(body), item);
      continue;
    }

    const turnId =
      explicitTurnId || activeSequenceTurnId || `seq:${item.seq || item.id}`;
    const turn = getTurn(turns, turnId);

    if (isWorkspaceAgentToolCallItem(item)) {
      if (shouldSuppressToolCall(item, suppressedToolCallIds)) {
        continue;
      }
      upsertToolCall(turn, item);
      continue;
    }

    if (role === "thinking" && body) {
      const payload = normalizedPayload(item.payload);
      if (payload?.messageKind === "review-process") {
        const status = firstPresentString(
          item.status,
          stringRecordValue(payload, "status")
        );
        const statusKind = messageStatusKind(status);
        const message = withSourceTimelineItems(
          {
            id: itemId(item),
            body: stripReviewProcessSummaryTitle(body),
            ...(status ? { status } : {}),
            ...(statusKind ? { statusKind } : {}),
            turnId,
            occurredAtUnixMs:
              item.occurredAtUnixMs ?? item.createdAtUnixMs ?? null
          },
          [item]
        );
        turn.agentMessages.push(message);
        turn.agentItems.push({ kind: "message", message });
        continue;
      }
      if (isPlaceholderThinkingBody(body)) {
        continue;
      }
      const duplicateKey = `${turnId}\u0000${normalizedMessageBody(body)}`;
      if (seenThinkingMessages.has(duplicateKey)) {
        continue;
      }
      seenThinkingMessages.add(duplicateKey);
      const statusKind = thinkingStatusKind(item);
      const thinking = withSourceTimelineItems(
        {
          id: itemId(item),
          body,
          ...(statusKind ? { statusKind } : {}),
          turnId,
          occurredAtUnixMs:
            item.occurredAtUnixMs ?? item.createdAtUnixMs ?? null
        },
        [item]
      );
      turn.agentItems.push({ kind: "thinking", thinking });
      continue;
    }

    if (role === "agent" && body) {
      const payload = normalizedPayload(item.payload);
      const visibleError = visibleErrorFromPayload(payload);
      const systemNotice = systemNoticeFromPayload(payload);
      const status = firstPresentString(
        item.status,
        stringRecordValue(payload, "status")
      );
      const statusKind = messageStatusKind(status);
      const message = withSourceTimelineItems(
        {
          id: itemId(item),
          body,
          ...(status ? { status } : {}),
          ...(statusKind ? { statusKind } : {}),
          turnId,
          occurredAtUnixMs:
            item.occurredAtUnixMs ?? item.createdAtUnixMs ?? null,
          ...(visibleError ? { visibleError } : {}),
          ...(systemNotice ? { systemNotice } : {})
        },
        [item]
      );
      turn.agentMessages.push(message);
      turn.agentItems.push({ kind: "message", message });
    }
  }

  const visibleTurns = [...turns.values()].filter(
    (turn) => turn.userMessages.length > 0 || turn.agentItems.length > 0
  );
  nestDelegatedToolCallsAcrossTurns(visibleTurns);
  visibleTurns.forEach(mergeBackgroundTerminalContinuations);
  visibleTurns.forEach((turn) => {
    turn.rawAgentItems = [...turn.agentItems];
    turn.agentItems = regroupAgentItems(turn.agentItems);
  });

  return {
    activity,
    session,
    cwd: session.cwd.trim(),
    workspaceRoot: workspaceRoot?.trim() || null,
    turns: visibleTurns,
    showProcessingIndicator: shouldShowProcessingIndicator(
      session,
      visibleTurns
    )
  };
}

function getTurn(
  turns: Map<string, WorkspaceAgentSessionDetailTurn>,
  id: string
): WorkspaceAgentSessionDetailTurn {
  const existing = turns.get(id);
  if (existing) {
    return existing;
  }
  const turn: WorkspaceAgentSessionDetailTurn = {
    id,
    userMessage: null,
    userMessages: [],
    agentMessages: [],
    toolCalls: [],
    toolCallCount: 0,
    hasFailedToolCall: false,
    agentItems: []
  };
  turns.set(id, turn);
  return turn;
}

function compareTimelineItemsAscending(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  const leftSeq = left.seq ?? 0;
  const rightSeq = right.seq ?? 0;
  if (leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  return (
    (left.occurredAtUnixMs ?? left.createdAtUnixMs ?? 0) -
      (right.occurredAtUnixMs ?? right.createdAtUnixMs ?? 0) ||
    leftSeq - rightSeq ||
    left.id - right.id
  );
}

function itemId(item: WorkspaceAgentActivityTimelineItem): string {
  const eventId = item.eventId?.trim();
  if (eventId) {
    return eventId;
  }
  const seq = item.seq ?? 0;
  return seq > 0 ? `seq:${seq}` : `id:${item.id}`;
}

function upsertToolCall(
  turn: WorkspaceAgentSessionDetailTurn,
  item: WorkspaceAgentActivityTimelineItem
): void {
  const call = toolCallView(item);
  const existingIndex = turn.toolCalls.findIndex(
    (existing) => existing.id === call.id
  );
  if (existingIndex >= 0) {
    const existing = turn.toolCalls[existingIndex];
    if (!existing) {
      return;
    }
    turn.toolCalls[existingIndex] = mergeToolCallDetail(existing, call);
  } else {
    turn.toolCalls.push(call);
  }
  turn.toolCallCount = turn.toolCalls.length;
  turn.hasFailedToolCall = turn.toolCalls.some(
    (existing) => existing.statusKind === "failed"
  );
  upsertToolCallAgentItem(turn, call, itemId(item));
}

function suppressedUnavailableAskUserQuestionCallIds(
  items: readonly WorkspaceAgentActivityTimelineItem[]
): Set<string> {
  const suppressed = new Set<string>();
  for (const item of items) {
    if (
      normalizeToolName(toolNameFromItem(item)) !== "askuserquestion" ||
      !isUnavailableAskUserQuestionFailure(item)
    ) {
      continue;
    }
    const callId = toolCallSuppressionId(item);
    if (callId) {
      suppressed.add(callId);
    }
  }
  return suppressed;
}

function shouldSuppressToolCall(
  item: WorkspaceAgentActivityTimelineItem,
  suppressedToolCallIds: ReadonlySet<string>
): boolean {
  const callId = toolCallSuppressionId(item);
  return callId ? suppressedToolCallIds.has(callId) : false;
}

function toolCallSuppressionId(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  return firstPresentString(
    item.callId,
    stringRecordValue(item.payload, "callId"),
    stringRecordValue(item.payload, "toolCallId")
  );
}

function isUnavailableAskUserQuestionFailure(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const status = firstPresentString(
    item.status,
    stringRecordValue(item.payload, "status")
  );
  if (status !== "failed") {
    return false;
  }
  const payload = normalizedPayload(item.payload);
  const output = normalizedPayload(
    payload?.output as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const error = normalizedPayload(
    payload?.error as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const message = firstPresentString(
    stringRecordValue(output, "output"),
    stringRecordValue(output, "text"),
    stringRecordValue(output, "message"),
    stringRecordValue(error, "error"),
    stringRecordValue(error, "message"),
    stringRecordValue(payload, "error"),
    stringRecordValue(payload, "message")
  );
  return message?.includes("No such tool available: AskUserQuestion") ?? false;
}

function upsertToolCallAgentItem(
  turn: WorkspaceAgentSessionDetailTurn,
  call: WorkspaceAgentSessionDetailToolCall,
  sourceId: string
): void {
  for (const entry of turn.agentItems) {
    if (entry.kind !== "tool-calls") {
      continue;
    }
    const existingIndex = entry.toolCalls.findIndex(
      (existing) => existing.id === call.id
    );
    if (existingIndex >= 0) {
      const existing = entry.toolCalls[existingIndex];
      if (!existing) {
        continue;
      }
      entry.toolCalls[existingIndex] = mergeToolCallDetail(existing, call);
      refreshToolCallAgentItem(entry);
      return;
    }
  }

  const entry: WorkspaceAgentSessionDetailAgentItem = {
    kind: "tool-calls",
    id: `tools:${sourceId}`,
    toolCalls: [call],
    toolCallCount: 1,
    hasFailedToolCall: call.statusKind === "failed"
  };
  turn.agentItems.push(entry);
}

function refreshToolCallAgentItem(
  entry: Extract<WorkspaceAgentSessionDetailAgentItem, { kind: "tool-calls" }>
): void {
  entry.toolCallCount = entry.toolCalls.length;
  entry.hasFailedToolCall = entry.toolCalls.some(
    (existing) => existing.statusKind === "failed"
  );
  const summary = summarizeToolCallGroup(entry.toolCalls);
  if (summary) {
    entry.summary = summary;
  } else {
    delete entry.summary;
  }
}

function regroupAgentItems(
  items: readonly WorkspaceAgentSessionDetailAgentItem[]
): WorkspaceAgentSessionDetailAgentItem[] {
  const regrouped: WorkspaceAgentSessionDetailAgentItem[] = [];
  let pending: Array<
    Extract<WorkspaceAgentSessionDetailAgentItem, { kind: "tool-calls" }>
  > = [];

  const flushPending = () => {
    if (pending.length === 0) {
      return;
    }
    const groupedCalls = pending.flatMap((item) => item.toolCalls);
    if (groupedCalls.length >= 2) {
      regrouped.push({
        kind: "tool-calls",
        id: pending.map((item) => item.id).join("+"),
        toolCalls: groupedCalls,
        toolCallCount: groupedCalls.length,
        hasFailedToolCall: groupedCalls.some(
          (call) => call.statusKind === "failed"
        ),
        summary: summarizeToolCallGroup(groupedCalls),
        groupEntries:
          pending.flatMap<WorkspaceAgentSessionDetailToolGroupEntry>((item) =>
            item.toolCalls.map((call) => ({ kind: "tool-call", call }))
          )
      });
    } else {
      regrouped.push(...pending);
    }
    pending = [];
  };

  for (const item of items) {
    if (item.kind === "tool-calls" && isGroupableToolCallItem(item)) {
      pending.push(item);
      continue;
    }
    flushPending();
    regrouped.push(item);
  }

  flushPending();
  return regrouped;
}

function isGroupableToolCallItem(
  item: Extract<WorkspaceAgentSessionDetailAgentItem, { kind: "tool-calls" }>
): boolean {
  return (
    item.toolCalls.length === 1 &&
    item.toolCalls.every((call) => isGroupableToolCall(call))
  );
}

function mergeToolCallDetail(
  previous: WorkspaceAgentSessionDetailToolCall,
  next: WorkspaceAgentSessionDetailToolCall
): WorkspaceAgentSessionDetailToolCall {
  return withSourceTimelineItems(
    {
      ...next,
      name: next.name || previous.name,
      toolName: next.toolName || previous.toolName,
      callType: next.callType || previous.callType,
      summary: next.summary || previous.summary,
      payload: next.payload ?? previous.payload
    },
    mergeSourceTimelineItems(
      previous.sourceTimelineItems,
      next.sourceTimelineItems
    )
  );
}

function mergeBackgroundTerminalContinuations(
  turn: WorkspaceAgentSessionDetailTurn
): void {
  if (turn.agentItems.length === 0 || turn.toolCalls.length === 0) {
    return;
  }

  const removedCallIDs = new Set<string>();

  for (let index = 0; index < turn.agentItems.length; index += 1) {
    const item = turn.agentItems[index];
    if (!item) {
      continue;
    }
    if (item.kind !== "tool-calls" || item.toolCalls.length !== 1) {
      continue;
    }
    const primaryCall = item.toolCalls[0];
    if (!primaryCall) {
      continue;
    }
    const terminalSessionID = backgroundTerminalSessionID(primaryCall);
    if (!terminalSessionID) {
      continue;
    }

    for (
      let nextIndex = index + 1;
      nextIndex < turn.agentItems.length;
      nextIndex += 1
    ) {
      const nextItem = turn.agentItems[nextIndex];
      if (!nextItem) {
        continue;
      }
      if (nextItem.kind !== "tool-calls" || nextItem.toolCalls.length !== 1) {
        continue;
      }
      const continuationCall = nextItem.toolCalls[0];
      if (!continuationCall) {
        continue;
      }
      if (
        !isBackgroundTerminalContinuation(continuationCall, terminalSessionID)
      ) {
        break;
      }

      const mergedCall = mergeBackgroundTerminalCall(
        primaryCall,
        continuationCall
      );
      item.toolCalls[0] = mergedCall;
      const turnToolIndex = turn.toolCalls.findIndex(
        (existing) => existing.id === primaryCall.id
      );
      if (turnToolIndex >= 0) {
        turn.toolCalls[turnToolIndex] = mergedCall;
      }
      refreshToolCallAgentItem(item);
      removedCallIDs.add(continuationCall.id);
      turn.agentItems.splice(nextIndex, 1);
      break;
    }
  }

  if (removedCallIDs.size === 0) {
    return;
  }

  turn.toolCalls = turn.toolCalls.filter(
    (call) => !removedCallIDs.has(call.id)
  );
  turn.toolCallCount = turn.toolCalls.length;
  turn.hasFailedToolCall = turn.toolCalls.some(
    (existing) => existing.statusKind === "failed"
  );
}

function mergeBackgroundTerminalCall(
  primary: WorkspaceAgentSessionDetailToolCall,
  continuation: WorkspaceAgentSessionDetailToolCall
): WorkspaceAgentSessionDetailToolCall {
  const continuationOutput = normalizedPayload(
    continuation.payload
      ?.output as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const mergedPayload = primary.payload ? { ...primary.payload } : {};
  if (continuationOutput) {
    mergedPayload.output = continuationOutput;
  }
  return {
    ...primary,
    status: continuation.status || primary.status,
    statusKind: continuation.statusKind || primary.statusKind,
    payload:
      Object.keys(mergedPayload).length > 0 ? mergedPayload : primary.payload,
    occurredAtUnixMs: continuation.occurredAtUnixMs ?? primary.occurredAtUnixMs
  };
}

function nestDelegatedToolCallsAcrossTurns(
  turns: readonly WorkspaceAgentSessionDetailTurn[]
): void {
  if (turns.length === 0) {
    return;
  }
  const parentCalls = new Map<string, WorkspaceAgentSessionDetailToolCall>();
  const callTurnByID = new Map<string, WorkspaceAgentSessionDetailTurn>();
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      parentCalls.set(call.id, call);
      parentCalls.set(call.id.replace(/^call:/, ""), call);
      callTurnByID.set(call.id, turn);
      callTurnByID.set(call.id.replace(/^call:/, ""), turn);
    }
  }
  const childCallsByParent = new Map<
    string,
    WorkspaceAgentSessionDetailToolCall[]
  >();
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const parentToolUseId = parentToolUseIdFromCall(call);
      if (!parentToolUseId) {
        continue;
      }
      const parentCall = parentCalls.get(parentToolUseId);
      if (!parentCall || !isTaskLikeToolCall(parentCall)) {
        continue;
      }
      const children = childCallsByParent.get(parentToolUseId) ?? [];
      children.push(call);
      childCallsByParent.set(parentToolUseId, children);
    }
  }
  if (childCallsByParent.size === 0) {
    return;
  }
  const removeIDsByTurn = new Map<
    WorkspaceAgentSessionDetailTurn,
    Set<string>
  >();
  for (const [parentID, childCalls] of childCallsByParent.entries()) {
    const parentCall = parentCalls.get(parentID);
    if (!parentCall) {
      continue;
    }
    appendDelegatedToolSteps(parentCall, childCalls);
    for (const childCall of childCalls) {
      const childTurn = callTurnByID.get(childCall.id);
      if (!childTurn) {
        continue;
      }
      const removeIDs = removeIDsByTurn.get(childTurn) ?? new Set<string>();
      removeIDs.add(childCall.id);
      removeIDsByTurn.set(childTurn, removeIDs);
    }
  }
  for (const [turn, removeIDs] of removeIDsByTurn.entries()) {
    pruneTurnToolCalls(turn, removeIDs);
  }
}

function backgroundTerminalSessionID(
  call: WorkspaceAgentSessionDetailToolCall
): string | null {
  const outputText = stringRecordValue(call.payload?.output, "output");
  if (!outputText) {
    return null;
  }
  const match = outputText.match(/Process running with session ID (\d+)/i);
  return match?.[1] ?? null;
}

function isBackgroundTerminalContinuation(
  call: WorkspaceAgentSessionDetailToolCall,
  sessionID: string
): boolean {
  const input = normalizedPayload(
    call.payload?.input as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const inputSessionID = firstPresentString(
    stringRecordValue(input, "session_id"),
    stringRecordValue(input, "sessionId")
  );
  if (inputSessionID !== sessionID) {
    return false;
  }
  const chars = firstPresentString(stringRecordValue(input, "chars")) ?? "";
  if (chars !== "") {
    return false;
  }
  return stringRecordValue(call.payload?.output, "output") !== null;
}

function isGroupableToolCall(
  call: WorkspaceAgentSessionDetailToolCall
): boolean {
  if (
    call.callType === "approval" ||
    call.callType === "interactive" ||
    call.callType === "subagent"
  ) {
    return false;
  }
  switch (normalizeToolName(call.toolName)) {
    case "askuserquestion":
    case "enterplanmode":
    case "exitplanmode":
    case "task":
    case "subagent":
    case "delegatetask":
      return false;
    default:
      return true;
  }
}

function pruneTurnToolCalls(
  turn: WorkspaceAgentSessionDetailTurn,
  removeIDs: ReadonlySet<string>
): void {
  if (removeIDs.size === 0) {
    return;
  }
  turn.toolCalls = turn.toolCalls.filter((call) => !removeIDs.has(call.id));
  turn.toolCallCount = turn.toolCalls.length;
  turn.hasFailedToolCall = turn.toolCalls.some(
    (existing) => existing.statusKind === "failed"
  );
  turn.agentItems =
    turn.agentItems.flatMap<WorkspaceAgentSessionDetailAgentItem>((item) => {
      if (item.kind !== "tool-calls") {
        return [item];
      }
      const toolCalls = item.toolCalls.filter(
        (call) => !removeIDs.has(call.id)
      );
      if (toolCalls.length === 0) {
        return [];
      }
      const nextItem = {
        ...item,
        toolCalls
      };
      refreshToolCallAgentItem(nextItem);
      return [nextItem];
    });
}

function appendDelegatedToolSteps(
  parentCall: WorkspaceAgentSessionDetailToolCall,
  childCalls: readonly WorkspaceAgentSessionDetailToolCall[]
): void {
  const nextPayload = parentCall.payload ? { ...parentCall.payload } : {};
  const nextMetadata =
    normalizedPayload(
      nextPayload.metadata as WorkspaceAgentActivityTimelineItem["payload"]
    ) ?? {};
  const existingSteps = Array.isArray(nextMetadata.steps)
    ? [...nextMetadata.steps]
    : [];
  const existingStepIDs = new Set(
    existingSteps
      .map((step) =>
        normalizedPayload(step as WorkspaceAgentActivityTimelineItem["payload"])
      )
      .map(
        (step) =>
          stringRecordValue(step, "toolUseId") ?? stringRecordValue(step, "id")
      )
      .filter((value): value is string => Boolean(value))
  );
  for (const childCall of [...childCalls].sort(compareToolCallsAscending)) {
    const step = delegatedToolStepFromCall(childCall);
    const stepID =
      stringRecordValue(step, "toolUseId") ?? stringRecordValue(step, "id");
    if (stepID && existingStepIDs.has(stepID)) {
      continue;
    }
    if (stepID) {
      existingStepIDs.add(stepID);
    }
    existingSteps.push(step);
  }
  nextMetadata.steps = existingSteps;
  nextPayload.metadata = nextMetadata;
  parentCall.payload = nextPayload;
}

function toolNameFromItem(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  return resolveWorkspaceAgentToolName(item);
}

function normalizeToolName(name: string | null): string {
  return (name ?? "")
    .trim()
    .replace(/[_\s-]+/g, "")
    .toLowerCase();
}
