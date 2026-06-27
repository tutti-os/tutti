import {
  mergeAgentActivityMessages,
  AgentActivityMessage,
  AgentActivityMessageSemantics,
  AgentActivityPresence,
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivitySubmitAvailability,
  AgentActivityTurnLifecycle
} from "@tutti-os/agent-activity-core";

export type WorkspaceAgentActivityProvider = "codex" | "claude-code" | string;

export interface WorkspaceAgentActivityComposerSettings {
  model?: string | null;
  reasoningEffort?: string | null;
  speed?: string | null;
  planMode?: boolean;
  browserUse?: boolean;
  permissionModeId?: string | null;
}

export const WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN =
  "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME";

export type WorkspaceAgentActivitySessionOrigin =
  | typeof WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN
  | string;

export function isWorkspaceAgentActivityRuntimeSessionOrigin(
  sessionOrigin: string | null | undefined
): boolean {
  const normalized = sessionOrigin?.trim() ?? "";
  // Core-native AgentActivitySession does not carry the legacy host origin DTO.
  return (
    normalized === "" ||
    normalized === WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN
  );
}

export function createWorkspaceAgentActivityUserMessageIdFromClientSubmitId(
  clientSubmitId: string
): string | null {
  const normalized = clientSubmitId.trim();
  return normalized ? `client-submit:user:${normalized}` : null;
}

export type WorkspaceAgentActivitySyncStatus =
  | "pending"
  | "synced"
  | "failed"
  | string;

export interface WorkspaceAgentActivitySyncState {
  workspaceId?: string;
  agentSessionId?: string;
  status: WorkspaceAgentActivitySyncStatus;
  pendingTimelineItemCount?: number;
  pendingStatePatchCount?: number;
  attemptCount?: number;
  failedReportCount?: number;
  lastError?: string;
  lastAttemptAtUnixMs?: number;
  lastSyncedAtUnixMs?: number;
  updatedAtUnixMs?: number;
}

export interface WorkspaceAgentActivityPresence extends Omit<
  AgentActivityPresence,
  "id" | "provider" | "status"
> {
  id: string | number;
  provider: WorkspaceAgentActivityProvider;
  status: string;
  userId?: string | null;
}

export interface WorkspaceAgentActivitySession extends Omit<
  AgentActivitySession,
  | "provider"
  | "providerSessionId"
  | "pinnedAtUnixMs"
  | "status"
  | "title"
  | "workspaceId"
> {
  id?: number;
  workspaceId?: string;
  presenceId?: string | number;
  userId?: string;
  provider?: WorkspaceAgentActivityProvider;
  providerSessionId?: string | null;
  resumable?: boolean;
  sessionOrigin?: WorkspaceAgentActivitySessionOrigin;
  lifecycleStatus?: string;
  turnPhase?: string;
  endedAtUnixMs?: number;
  effectiveStatus?: string;
  status?: string;
  turnLifecycle?: AgentActivityTurnLifecycle | null;
  submitAvailability?: AgentActivitySubmitAvailability | null;
  title?: string;
  pinnedAtUnixMs?: number | null;
  syncState?: WorkspaceAgentActivitySyncState;
}

export interface WorkspaceAgentActivityFileChange {
  path: string;
  change?: "added" | "modified" | "deleted" | "moved" | string;
  tools?: string[];
}

export interface WorkspaceAgentActivityFileChanges {
  coverage?: string;
  files?: WorkspaceAgentActivityFileChange[];
}

export interface WorkspaceAgentActivityTimelineItem {
  id: number;
  workspaceId?: string;
  agentSessionId: string;
  seq?: number;
  turnId?: string;
  eventSource?: string;
  eventId: string;
  actorType: string;
  actorId: string;
  itemType: "message" | "call" | "event" | "error" | "lifecycle" | string;
  role?: string;
  callType?: "tool" | "skill" | "subagent" | "approval" | "workflow" | string;
  callId?: string;
  name?: string;
  status?: string | null;
  content?: string;
  payload?: Record<string, unknown> & {
    content?: unknown;
    text?: unknown;
    fileChanges?: WorkspaceAgentActivityFileChanges;
  };
  occurredAtUnixMs?: number;
  createdAtUnixMs?: number;
}

export interface WorkspaceAgentActivityMessage extends Omit<
  AgentActivityMessage,
  "id" | "status"
> {
  id?: number;
  status?: string | null;
  semantics?: AgentActivityMessageSemantics;
}

export interface WorkspaceAgentActivitySnapshot extends Omit<
  AgentActivitySnapshot,
  "sessions" | "presences" | "sessionMessagesById" | "workspaceId"
> {
  workspaceId?: string;
  presences: WorkspaceAgentActivityPresence[];
  sessions: WorkspaceAgentActivitySession[];
  sessionMessagesById?: Record<string, WorkspaceAgentActivityMessage[]>;
}

export interface WorkspaceAgentActivityTurnStatePatch {
  turnId: string;
  phase?: string;
  outcome?: string;
  fileChanges?: Record<string, unknown>;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
  activeTurnId?: string | null;
  settling?: boolean;
  completedCommand?: {
    kind: string;
    status: string;
  } | null;
  submitAvailability?: AgentActivitySubmitAvailability;
}

export interface WorkspaceAgentActivityEntityStatePatch {
  callId: string;
  turnId?: string;
  callType?: string;
  name?: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}

export interface WorkspaceAgentActivityStatePatch {
  workspaceId?: string;
  agentSessionId: string;
  provider?: string;
  providerSessionId?: string;
  model?: string;
  permissionModeId?: string;
  settings?: WorkspaceAgentActivityComposerSettings;
  runtimeContext?: Record<string, unknown>;
  cwd?: string;
  title?: string;
  lifecycleStatus?: string;
  currentPhase?: string;
  lastError?: string;
  occurredAtUnixMs?: number;
  submitAvailability?: AgentActivitySubmitAvailability;
  turn?: WorkspaceAgentActivityTurnStatePatch;
  entities?: WorkspaceAgentActivityEntityStatePatch[];
}

export interface WorkspaceAgentActivitySessionSummaryItem {
  id?: number;
  turnId?: string;
  actorType?: string;
  actorId?: string;
  itemType?: string;
  role?: string;
  content?: string;
  title?: string;
  status?: string;
  callType?: string;
  name?: string;
  payload?: Record<string, unknown>;
  occurredAtUnixMs?: number;
}

export interface WorkspaceAgentActivitySessionSummaryTurn {
  turnId: string;
  userItems?: WorkspaceAgentActivitySessionSummaryItem[];
  agentItems?: WorkspaceAgentActivitySessionSummaryItem[];
}

export interface WorkspaceAgentActivitySessionExecutionStatus {
  currentOrFinalStatus?: string;
  updatedAtUnixMs?: number;
}

export interface WorkspaceAgentActivitySessionSummary {
  agentSessionId: string;
  latestUserRequirement?: string;
  initialUserRequirement?: string;
  latestTurn?: WorkspaceAgentActivitySessionSummaryTurn;
  recentAgentReplies?: string[];
  recentTurns?: WorkspaceAgentActivitySessionSummaryTurn[];
  currentOrFinalStatus?: string;
  executionStatus?: WorkspaceAgentActivitySessionExecutionStatus;
}

export function isWorkspaceAgentActivityOptimisticMessage(
  message: WorkspaceAgentActivityMessage
): boolean {
  return message.payload?.__agentGuiOptimisticPrompt === true;
}

export function selectWorkspaceAgentActivityOverlayMessages(input: {
  durableMessages?: readonly WorkspaceAgentActivityMessage[] | null;
  localMessages?: readonly WorkspaceAgentActivityMessage[] | null;
}): WorkspaceAgentActivityMessage[] {
  const durableMessages = input.durableMessages ?? [];
  const localMessages = input.localMessages ?? [];
  if (localMessages.length === 0) {
    return [];
  }
  const durableIdentities = new Set(
    durableMessages
      .map(workspaceAgentActivityMessageIdentity)
      .filter((identity): identity is string => identity !== null)
  );
  const durableClientSubmitIds = new Set(
    durableMessages
      .map(workspaceAgentActivityClientSubmitId)
      .filter(
        (clientSubmitId): clientSubmitId is string => clientSubmitId !== null
      )
  );
  const durableUserPromptSignatures = new Set(
    durableMessages
      .map(workspaceAgentActivityUserPromptSignature)
      .filter((signature): signature is string => signature !== null)
  );
  return localMessages.filter((message) => {
    const identity = workspaceAgentActivityMessageIdentity(message);
    if (identity !== null && durableIdentities.has(identity)) {
      return false;
    }
    if (isWorkspaceAgentActivityOptimisticMessage(message)) {
      const clientSubmitId = workspaceAgentActivityClientSubmitId(message);
      if (
        clientSubmitId !== null &&
        durableClientSubmitIds.has(clientSubmitId)
      ) {
        return false;
      }
      const signature = workspaceAgentActivityUserPromptSignature(message);
      return signature === null || !durableUserPromptSignatures.has(signature);
    }
    return true;
  });
}

export function mergeWorkspaceAgentActivityDurableAndOverlayMessages(input: {
  durableMessages?: readonly WorkspaceAgentActivityMessage[] | null;
  localMessages?: readonly WorkspaceAgentActivityMessage[] | null;
}): WorkspaceAgentActivityMessage[] {
  const durableMessages = input.durableMessages ?? [];
  const overlayMessages = selectWorkspaceAgentActivityOverlayMessages(input);
  return overlayMessages.length === 0
    ? [...durableMessages]
    : mergeAgentActivityMessages(durableMessages, overlayMessages);
}

function workspaceAgentActivityMessageIdentity(
  message: WorkspaceAgentActivityMessage
): string | null {
  const messageId = message.messageId?.trim() ?? "";
  if (messageId) {
    return `message:${messageId}`;
  }
  if (typeof message.version === "number" && Number.isFinite(message.version)) {
    return `version:${message.version}`;
  }
  return null;
}

function workspaceAgentActivityClientSubmitId(
  message: WorkspaceAgentActivityMessage
): string | null {
  const clientSubmitId = message.payload?.clientSubmitId;
  return typeof clientSubmitId === "string" && clientSubmitId.trim()
    ? `${message.agentSessionId}\u0000${clientSubmitId.trim()}`
    : null;
}

function workspaceAgentActivityUserPromptSignature(
  message: WorkspaceAgentActivityMessage
): string | null {
  if (message.role !== "user") {
    return null;
  }
  const text = workspaceAgentActivityPayloadText(message.payload).trim();
  const content = workspaceAgentActivityPayloadContentSignature(
    message.payload
  );
  if (!text && content === null) {
    return null;
  }
  return [message.agentSessionId, text, content ?? ""].join("\u0000");
}

function workspaceAgentActivityPayloadText(
  payload: Record<string, unknown> | undefined
): string {
  const text = payload?.text;
  return typeof text === "string" ? text : "";
}

function workspaceAgentActivityPayloadContentSignature(
  payload: Record<string, unknown> | undefined
): string | null {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, "content")) {
    return null;
  }
  const content = payload.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    const signature = workspaceAgentActivityPromptBlockSignature(block);
    if (signature === null) {
      return null;
    }
    parts.push(signature);
  }
  return parts.join("\u0001");
}

function workspaceAgentActivityPromptBlockSignature(
  block: unknown
): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const record = block as Record<string, unknown>;
  const type = workspaceAgentActivityStringField(record, "type");
  if (!type) {
    return null;
  }
  const fields = [
    "text",
    "mimeType",
    "data",
    "url",
    "attachmentId",
    "name",
    "path",
    "uri",
    "hostPath",
    "uploadStatus",
    "assetId",
    "kind"
  ];
  const parts = [`type=${type}`];
  for (const field of fields) {
    const value = workspaceAgentActivityStringField(record, field);
    if (value) {
      parts.push(`${field}=${value}`);
    }
  }
  const sizeBytes = record.sizeBytes;
  if (typeof sizeBytes === "number" && Number.isFinite(sizeBytes)) {
    parts.push(`sizeBytes=${sizeBytes}`);
  }
  return parts.join("\u0002");
}

function workspaceAgentActivityStringField(
  record: Record<string, unknown>,
  field: string
): string {
  const value = record[field];
  return typeof value === "string" ? value.trim() : "";
}
