import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentActivityTypes";
import {
  isWorkspaceAgentToolCallItem,
  resolveWorkspaceAgentToolName
} from "../../workspaceAgentToolCallDisplay";
import type {
  AgentTaskSubAgentActivityVM,
  AgentTaskSubAgentStatus,
  AgentTaskSubAgentVM
} from "../contracts/agentTaskItemVM";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentToolGroupRowVM } from "../contracts/agentToolGroupRowVM";

// Codex app-server collab child threads report their activity through the
// parent session. The daemon stamps every child-thread row with a non-empty
// payload.ownerThreadId plus payload.ownerCallId — the spawn call that
// created the thread (reporter.go withOwnerThreadID, ADR 0007); parent rows
// never carry the keys. These rows must never interleave with the parent
// transcript: they are segregated here and re-surfaced as live sub-agent
// lanes on the parent's collab spawn card, located by ownerCallId alone.

export interface SubAgentTimelinePartition {
  mainTimelineItems: WorkspaceAgentActivityTimelineItem[];
  subAgentItemsByOwner: ReadonlyMap<
    string,
    WorkspaceAgentActivityTimelineItem[]
  >;
}

export function timelineItemOwnerThreadId(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  return trimmedPayloadString(item.payload?.ownerThreadId);
}

export function timelineItemOwnerCallId(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  return trimmedPayloadString(item.payload?.ownerCallId);
}

function trimmedPayloadString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function partitionSubAgentTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): SubAgentTimelinePartition {
  const subAgentItemsByOwner = new Map<
    string,
    WorkspaceAgentActivityTimelineItem[]
  >();
  let mainTimelineItems: WorkspaceAgentActivityTimelineItem[] | null = null;
  for (let index = 0; index < timelineItems.length; index += 1) {
    const item = timelineItems[index];
    if (!item) {
      continue;
    }
    const ownerThreadId = timelineItemOwnerThreadId(item);
    if (!ownerThreadId) {
      mainTimelineItems?.push(item);
      continue;
    }
    if (!mainTimelineItems) {
      mainTimelineItems = timelineItems.slice(0, index);
    }
    const ownerItems = subAgentItemsByOwner.get(ownerThreadId) ?? [];
    ownerItems.push(item);
    subAgentItemsByOwner.set(ownerThreadId, ownerItems);
  }
  return {
    mainTimelineItems:
      mainTimelineItems ??
      (timelineItems as WorkspaceAgentActivityTimelineItem[]),
    subAgentItemsByOwner
  };
}

// A collab spawn card summarizes one delegated agent in the parent transcript.
// Lanes attach to cards by the ownerCallId the daemon records on every child
// row (the spawn call's item id, ADR 0007) — an exact lookup, never a guess.
// Rows without the key (recordings that predate it) and rows whose spawn card
// is outside the loaded message window stay hidden: a partial timeline must
// degrade to "not loaded yet", not to a mis-attached lane.
interface SubAgentCollabCard {
  callId: string;
  startedAtUnixMs: number;
  task: string | null;
  agentName: string | null;
  // The spawn CALL's own status - only used for receiver-less spawns (e.g.
  // tool-rejected), where no child lifecycle exists to drive the lane.
  callStatus: AgentTaskSubAgentStatus;
  receiverThreadIds: ReadonlySet<string>;
  childStatuses: ReadonlyMap<string, AgentTaskSubAgentStatus>;
}

export function buildSubAgentLanesByCallId(
  partition: SubAgentTimelinePartition
): ReadonlyMap<string, AgentTaskSubAgentVM[]> {
  const lanesByCallId = new Map<string, AgentTaskSubAgentVM[]>();
  const cards = collectCollabCards(partition.mainTimelineItems);
  if (cards.length === 0) {
    return lanesByCallId;
  }
  const cardsByCallId = new Map(cards.map((card) => [card.callId, card]));
  const lanedOwners = new Set<string>();
  for (const [ownerThreadId, items] of partition.subAgentItemsByOwner) {
    const sortedItems = [...items].sort(compareTimelineItemsAscending);
    const ownerCallId = firstOwnerCallId(sortedItems);
    if (!ownerCallId) {
      continue;
    }
    const card = cardsByCallId.get(ownerCallId);
    // The daemon never records a control card as owner; skipping here keeps
    // wait/close cards lane-free even against malformed rows.
    if (!card || isControlAgentToken(card.agentName)) {
      continue;
    }
    lanedOwners.add(ownerThreadId);
    const lanes = lanesByCallId.get(card.callId) ?? [];
    lanes.push(subAgentLane(ownerThreadId, sortedItems, card));
    lanesByCallId.set(card.callId, lanes);
  }
  // A spawn card is a sub-agent card from the moment it exists: seed
  // placeholder lanes for declared children that have not produced any rows
  // yet, so the spawn never renders as a bare tool row. Only spawn-kind cards
  // seed - wait/close control cards also declare receiverThreadIds and must
  // not duplicate the lanes.
  for (const card of cards) {
    if (!isSpawnAgentToken(card.agentName)) {
      continue;
    }
    for (const receiverThreadId of card.receiverThreadIds) {
      if (lanedOwners.has(receiverThreadId)) {
        continue;
      }
      lanedOwners.add(receiverThreadId);
      const lanes = lanesByCallId.get(card.callId) ?? [];
      lanes.push(subAgentLane(receiverThreadId, [], card));
      lanesByCallId.set(card.callId, lanes);
    }
    // A spawn that produced no child threads (e.g. the tool rejected the
    // request) still renders as a sub-agent card - the failed/pending lane is
    // the signal; a bare '委托 agent' tool row never appears for spawns.
    if (!lanesByCallId.has(card.callId)) {
      lanesByCallId.set(card.callId, [
        {
          ...subAgentLane(`spawn-pending:${card.callId}`, [], card),
          status: card.callStatus,
          // No child thread exists yet: codex caps concurrent sub-agents
          // (4/session by default) and queues further spawns.
          queued: card.callStatus === "running"
        }
      ]);
    }
  }
  for (const lanes of lanesByCallId.values()) {
    lanes.sort(
      (left, right) =>
        (left.startedAtUnixMs ?? 0) - (right.startedAtUnixMs ?? 0) ||
        left.ownerThreadId.localeCompare(right.ownerThreadId)
    );
    for (let index = 0; index < lanes.length; index += 1) {
      const lane = lanes[index];
      if (!lane) {
        continue;
      }
      lanes[index] = {
        ...lane,
        laneIndex: index + 1,
        laneCount: lanes.length
      };
    }
  }
  return lanesByCallId;
}

export function attachSubAgentLanesToConversationVM(
  conversation: AgentConversationVM | null,
  lanesByCallId: ReadonlyMap<string, AgentTaskSubAgentVM[]>
): AgentConversationVM | null {
  if (!conversation || lanesByCallId.size === 0) {
    return conversation;
  }
  let changed = false;
  const rows = conversation.rows.map((row) => {
    if (row.kind !== "tool-group") {
      return row;
    }
    const nextRow = toolGroupRowWithSubAgents(row, lanesByCallId);
    if (nextRow !== row) {
      changed = true;
    }
    return nextRow;
  });
  return changed ? { ...conversation, rows } : conversation;
}

function toolGroupRowWithSubAgents(
  row: AgentToolGroupRowVM,
  lanesByCallId: ReadonlyMap<string, AgentTaskSubAgentVM[]>
): AgentToolGroupRowVM {
  let changed = false;
  const callsById = new Map<string, AgentToolCallVM>();
  const calls = row.calls.map((call) => {
    const lanes = call.task ? lanesByCallId.get(toolCallRawId(call.id)) : null;
    if (!lanes || lanes.length === 0 || !call.task) {
      return call;
    }
    changed = true;
    const nextCall: AgentToolCallVM = {
      ...call,
      task: { ...call.task, subAgents: lanes }
    };
    callsById.set(nextCall.id, nextCall);
    return nextCall;
  });
  if (!changed) {
    return row;
  }
  const entries = row.entries.map((entry) => {
    if (entry.kind !== "tool-call") {
      return entry;
    }
    const nextCall = callsById.get(entry.call.id);
    return nextCall ? { ...entry, call: nextCall } : entry;
  });
  return { ...row, calls, entries };
}

function toolCallRawId(id: string): string {
  return id.startsWith("call:") ? id.slice("call:".length) : id;
}

const SUB_AGENT_ACTIVITY_LOG_CAP = 20;

function subAgentLane(
  ownerThreadId: string,
  sortedItems: readonly WorkspaceAgentActivityTimelineItem[],
  card: SubAgentCollabCard
): AgentTaskSubAgentVM {
  const activity = subAgentActivityLog(sortedItems);
  const latest = activity.entries[activity.entries.length - 1] ?? null;
  const terminal = latestTerminalMarker(sortedItems);
  const lastItem = sortedItems[sortedItems.length - 1];
  const status =
    terminal?.status ?? card.childStatuses.get(ownerThreadId) ?? "running";
  const terminalAtUnixMs = terminal?.occurredAtUnixMs ?? null;
  return {
    ownerThreadId,
    status,
    // Identity precedence: the child thread's own name (subAgentName marker,
    // rare in practice) > a short name derived from the task's opening
    // self-address ("你是 X。…" / "You are X. …") > the view's localized
    // numbered fallback. Never the collab tool name.
    name:
      latestNameMarker(sortedItems) ?? deriveSubAgentNameFromTask(card.task),
    task: card.task,
    laneIndex: 1,
    laneCount: 1,
    latestActivity: latest?.text ?? null,
    latestActivityKind: latest?.kind ?? null,
    activityLog: activity.entries,
    activityOmittedCount: activity.omittedCount,
    failureDetail: terminal?.detail ?? null,
    startedAtUnixMs:
      timelineItemTime(sortedItems[0]) || card.startedAtUnixMs || null,
    latestActivityAtUnixMs:
      terminalAtUnixMs ??
      (lastItem ? timelineItemTime(lastItem) : card.startedAtUnixMs) ??
      null,
    terminalAtUnixMs
  };
}

const SUB_AGENT_DERIVED_NAME_MAX = 36;

export function deriveSubAgentNameFromTask(task: string | null): string | null {
  if (!task) {
    return null;
  }
  const firstSentence = task
    .trim()
    .split(/[。．.!?！？，,\n]/, 1)[0]
    ?.trim();
  if (!firstSentence) {
    return null;
  }
  // Only a self-address opening ("你是 X" / "You are X" / "Act as X") is a
  // reliable identity signal; a plain task sentence is not a name.
  const selfAddress = /^(你现在是|你現在是|你是|you are|act as)\s*/i;
  if (!selfAddress.test(firstSentence)) {
    return null;
  }
  const stripped = firstSentence
    .replace(selfAddress, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 2 || stripped.length > SUB_AGENT_DERIVED_NAME_MAX) {
    return null;
  }
  // A bare restatement of the tool adds nothing.
  if (/^(spawnagent|agent)$/i.test(stripped)) {
    return null;
  }
  return stripped;
}

function isSpawnAgentToken(agentName: string | null): boolean {
  const token = normalizeToolToken(agentName);
  return token === "spawnagent" || token === "spawn";
}

function latestNameMarker(
  sortedItems: readonly WorkspaceAgentActivityTimelineItem[]
): string | null {
  for (let index = sortedItems.length - 1; index >= 0; index -= 1) {
    const payload = sortedItems[index]?.payload;
    if (payload?.messageKind !== "subAgentName") {
      continue;
    }
    const name = stringValue(payload.subAgentName);
    if (name) {
      return name;
    }
  }
  return null;
}

function isSubAgentMarkerItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const kind = item.payload?.messageKind;
  return kind === "subAgentLifecycle" || kind === "subAgentName";
}

function subAgentActivityLog(
  sortedItems: readonly WorkspaceAgentActivityTimelineItem[]
): { entries: AgentTaskSubAgentActivityVM[]; omittedCount: number } {
  const all: AgentTaskSubAgentActivityVM[] = [];
  for (const item of sortedItems) {
    if (!item || isSubAgentMarkerItem(item)) {
      continue;
    }
    const entry = displayableActivityEntry(item);
    if (entry) {
      all.push(entry);
    }
  }
  const omittedCount = Math.max(0, all.length - SUB_AGENT_ACTIVITY_LOG_CAP);
  return { entries: all.slice(omittedCount), omittedCount };
}

function displayableActivityEntry(
  item: WorkspaceAgentActivityTimelineItem
): AgentTaskSubAgentActivityVM | null {
  const atUnixMs = timelineItemTime(item) || null;
  if (isWorkspaceAgentToolCallItem(item)) {
    const name =
      firstString(item.name, stringValue(item.payload?.name)) ?? null;
    return name ? { kind: "tool", text: name, atUnixMs } : null;
  }
  const text = snippet(timelineItemText(item));
  if (!text) {
    return null;
  }
  const itemType = item.itemType?.trim().toLowerCase() ?? "";
  const role = item.role?.trim().toLowerCase() ?? "";
  if (
    itemType === "message.assistant_thinking" ||
    role === "assistant_thinking"
  ) {
    return { kind: "reasoning", text, atUnixMs };
  }
  return { kind: "message", text, atUnixMs };
}

function latestTerminalMarker(
  sortedItems: readonly WorkspaceAgentActivityTimelineItem[]
): {
  status: AgentTaskSubAgentStatus;
  detail: string | null;
  occurredAtUnixMs: number | null;
} | null {
  for (let index = sortedItems.length - 1; index >= 0; index -= 1) {
    const item = sortedItems[index];
    const payload = item?.payload;
    if (!payload || payload.messageKind !== "subAgentLifecycle") {
      continue;
    }
    return {
      status: subAgentStatusFromLifecycle(payload.subAgentLifecycleStatus),
      detail: stringValue(payload.detail) ?? null,
      occurredAtUnixMs: timelineItemTime(item) || null
    };
  }
  return null;
}

const SUB_AGENT_ACTIVITY_SNIPPET_LENGTH = 140;

function snippet(text: string): string {
  if (text.length <= SUB_AGENT_ACTIVITY_SNIPPET_LENGTH) {
    return text;
  }
  // Streamed assistant text grows at the tail; the trailing window is the
  // sub-agent's most current activity.
  return `…${text.slice(-SUB_AGENT_ACTIVITY_SNIPPET_LENGTH)}`;
}

function timelineItemText(item: WorkspaceAgentActivityTimelineItem): string {
  const text =
    stringValue(item.payload?.text) ??
    stringValue(item.payload?.content) ??
    stringValue(item.content) ??
    "";
  return text.replace(/\s+/g, " ").trim();
}

const COLLAB_CARD_TOOL_NAMES = new Set([
  "task",
  "subagent",
  "delegatetask",
  "delegateagent",
  "agent"
]);

function collectCollabCards(
  mainTimelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): SubAgentCollabCard[] {
  const cardsByCallId = new Map<
    string,
    {
      callId: string;
      startedAtUnixMs: number;
      latestAtUnixMs: number;
      latestCallStatus: string | null;
      receiverThreadIds: Set<string>;
      childStatuses: Map<string, AgentTaskSubAgentStatus>;
    }
  >();
  for (const item of mainTimelineItems) {
    if (!isWorkspaceAgentToolCallItem(item) || !isCollabCardItem(item)) {
      continue;
    }
    const callId = firstString(item.callId, stringValue(item.payload?.callId));
    if (!callId) {
      continue;
    }
    const time = timelineItemTime(item);
    const input = recordValue(item.payload?.input);
    const output = recordValue(item.payload?.output);
    const existing = cardsByCallId.get(callId);
    if (!existing) {
      cardsByCallId.set(callId, {
        callId,
        startedAtUnixMs: time,
        latestAtUnixMs: time,
        latestCallStatus: firstString(
          item.status,
          stringValue(item.payload?.status)
        ),
        receiverThreadIds: collectReceiverThreadIds(input),
        childStatuses: collectChildStatuses(output)
      });
      continue;
    }
    existing.startedAtUnixMs = Math.min(existing.startedAtUnixMs, time);
    if (time >= existing.latestAtUnixMs) {
      existing.latestAtUnixMs = time;
      existing.latestCallStatus =
        firstString(item.status, stringValue(item.payload?.status)) ??
        existing.latestCallStatus;
    }
    for (const value of collectReceiverThreadIds(input)) {
      existing.receiverThreadIds.add(value);
    }
    for (const [threadId, childStatus] of collectChildStatuses(output)) {
      existing.childStatuses.set(threadId, childStatus);
    }
  }
  return [...cardsByCallId.values()]
    .map((card) => {
      const input = recordValue(
        partitionCardInput(mainTimelineItems, card.callId)?.payload?.input
      );
      return {
        callId: card.callId,
        startedAtUnixMs: card.startedAtUnixMs,
        task: stringValue(input?.task),
        agentName: stringValue(input?.agentName),
        callStatus: subAgentStatusFromCallStatus(card.latestCallStatus),
        receiverThreadIds: card.receiverThreadIds,
        childStatuses: card.childStatuses
      };
    })
    .sort((left, right) => left.startedAtUnixMs - right.startedAtUnixMs);
}

function partitionCardInput(
  mainTimelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callId: string
): WorkspaceAgentActivityTimelineItem | null {
  for (const item of mainTimelineItems) {
    if (!isWorkspaceAgentToolCallItem(item) || !isCollabCardItem(item)) {
      continue;
    }
    if (
      firstString(item.callId, stringValue(item.payload?.callId)) === callId
    ) {
      return item;
    }
  }
  return null;
}

function isCollabCardItem(item: WorkspaceAgentActivityTimelineItem): boolean {
  const toolName = normalizeToolToken(resolveWorkspaceAgentToolName(item));
  return COLLAB_CARD_TOOL_NAMES.has(toolName);
}

function firstOwnerCallId(
  sortedItems: readonly WorkspaceAgentActivityTimelineItem[]
): string | null {
  for (const item of sortedItems) {
    const ownerCallId = timelineItemOwnerCallId(item);
    if (ownerCallId) {
      return ownerCallId;
    }
  }
  return null;
}

function isControlAgentToken(agentName: string | null): boolean {
  switch (normalizeToolToken(agentName)) {
    case "wait":
    case "waitagent":
    case "close":
    case "closeagent":
      return true;
    default:
      return false;
  }
}

function subAgentStatusFromCallStatus(
  status: string | null
): AgentTaskSubAgentStatus {
  switch ((status ?? "").trim().toLowerCase()) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
    case "errored":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "running";
  }
}

function subAgentStatusFromLifecycle(status: unknown): AgentTaskSubAgentStatus {
  switch (typeof status === "string" ? status.trim().toLowerCase() : "") {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
    case "errored":
      return "failed";
    case "canceled":
    case "cancelled":
    case "interrupted":
    case "stopped":
      return "canceled";
    default:
      return "running";
  }
}

function collectReceiverThreadIds(input: unknown): Set<string> {
  const out = new Set<string>();
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return out;
  }
  const raw = (input as Record<string, unknown>).receiverThreadIds;
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const entry of raw) {
    const id = stringValue(entry);
    if (id) {
      out.add(id);
    }
  }
  return out;
}

function collectChildStatuses(
  value: unknown
): Map<string, AgentTaskSubAgentStatus> {
  const out = new Map<string, AgentTaskSubAgentStatus>();
  collectChildStatusesInto(value, out, 0);
  return out;
}

function collectChildStatusesInto(
  value: unknown,
  out: Map<string, AgentTaskSubAgentStatus>,
  depth: number
): void {
  if (depth > 6 || value == null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChildStatusesInto(entry, out, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const status = subAgentStatusFromLifecycle(
    record.status ?? record.state ?? record.lifecycleStatus
  );
  const id = firstString(
    stringValue(record.threadId),
    stringValue(record.threadID),
    stringValue(record.agentId),
    stringValue(record.agent_id),
    stringValue(record.id)
  );
  if (id && status !== "running") {
    out.set(id, status);
  }
  for (const [key, entry] of Object.entries(record)) {
    if (key === "agentsStates" || key === "statuses") {
      collectChildStatusesInto(entry, out, depth + 1);
      continue;
    }
    if (typeof entry === "object" && entry != null) {
      const nestedStatus = subAgentStatusFromLifecycle(
        (entry as Record<string, unknown>).status ??
          (entry as Record<string, unknown>).state
      );
      if (nestedStatus !== "running" && key.trim()) {
        out.set(key, nestedStatus);
      }
    }
    collectChildStatusesInto(entry, out, depth + 1);
  }
}

function timelineItemTime(
  item: WorkspaceAgentActivityTimelineItem | undefined
): number {
  return item?.occurredAtUnixMs ?? item?.createdAtUnixMs ?? 0;
}

function compareTimelineItemsAscending(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  return (
    timelineItemTime(left) - timelineItemTime(right) ||
    (left.seq ?? 0) - (right.seq ?? 0) ||
    left.id - right.id
  );
}

function normalizeToolToken(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\s_-]+/g, "")
    .trim()
    .toLowerCase();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const resolved = stringValue(value);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}
