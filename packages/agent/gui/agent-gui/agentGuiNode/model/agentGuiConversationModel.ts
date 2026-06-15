import type {
  AgentSessionEvent,
  AgentSession
} from "../../../shared/agentSessionTypes";
import type { AgentGUIProvider } from "../../../types";
import {
  buildWorkspaceAgentActivityListViewModel,
  type WorkspaceAgentActivityCard,
  type WorkspaceAgentActivityStatus
} from "../../../shared/workspaceAgentActivityListViewModel";
import {
  buildWorkspaceAgentSessionDetailViewModel,
  type WorkspaceAgentSessionDetailViewModel,
  type WorkspaceAgentSessionDetailToolCall
} from "../../../shared/workspaceAgentSessionDetailViewModel";
import { projectAgentSessionEventsToTimelineItems } from "../../../shared/agentConversation/projection/agentSessionEventProjection";
import { projectWorkspaceAgentTimelineToConversationVM } from "../../../shared/agentConversation/projection/workspaceAgentTimelineProjection";
import type { AgentApprovalItemVM } from "../../../shared/agentConversation/contracts/agentApprovalItemVM";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentConversationPromptVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentAskUserQuestionVM } from "../../../shared/agentConversation/contracts/agentAskUserQuestionItemVM";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import { resolveWorkspaceUserProjectDisplayLabel } from "@tutti-os/workspace-user-project/core";
import {
  resolveAgentGUIConversationTitle,
  resolveAgentGUIExplicitConversationTitle,
  resolveAgentGUIProviderIdentity,
  type AgentGUIConversationTitleFallback,
  type AgentGUIResolvedProvider
} from "./agentGuiProviderIdentity";
import {
  WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN,
  isWorkspaceAgentActivityRuntimeSessionOrigin,
  type WorkspaceAgentActivityMessage,
  type WorkspaceAgentActivitySession,
  type WorkspaceAgentActivitySnapshot,
  type WorkspaceAgentActivitySyncState,
  type WorkspaceAgentActivityTimelineItem
} from "../../../shared/workspaceAgentActivityTypes";
import { resolveWorkspaceAgentSessionSortTimeUnixMs } from "../../../shared/workspaceAgentSessionSortTime";

export const AGENT_GUI_RUNTIME_SESSION_ORIGIN =
  WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN;
const AGENT_GUI_CONVERSATION_PROJECT_SUMMARY_CACHE_LIMIT = 512;
const agentGUIConversationProjectSummaryCache = new Map<
  string,
  AgentGUIConversationProjectSummary
>();

export interface AgentGUIConversationSummary {
  id: string;
  userId?: string;
  provider: AgentGUIResolvedProvider;
  resumable?: boolean;
  title: string;
  titleFallback?: AgentGUIConversationTitleFallback;
  status: AgentGUIConversationStatus;
  cwd: string;
  project?: AgentGUIConversationProjectSummary | null;
  pinnedAtUnixMs?: number | null;
  sortTimeUnixMs?: number;
  updatedAtUnixMs: number;
  hasUnreadCompletion?: boolean;
  syncState?: WorkspaceAgentActivitySyncState;
}

export type AgentGUIConversationProjectionSource = Pick<
  AgentGUIConversationSummary,
  | "id"
  | "userId"
  | "provider"
  | "title"
  | "titleFallback"
  | "status"
  | "cwd"
  | "project"
  | "pinnedAtUnixMs"
  | "sortTimeUnixMs"
  | "updatedAtUnixMs"
  | "syncState"
>;

export interface AgentGUIConversationProjectSummary {
  id: string;
  path: string;
  label: string;
  createdAtUnixMs?: number;
  updatedAtUnixMs?: number;
  lastUsedAtUnixMs?: number;
}

export type AgentGUIConversationUserProject = Pick<
  AgentHostUserProject,
  | "id"
  | "path"
  | "label"
  | "createdAtUnixMs"
  | "updatedAtUnixMs"
  | "lastUsedAtUnixMs"
>;

export type AgentGUIConversationNoProjectPathResolver = (input: {
  path: string;
}) => boolean;

export interface AgentGUIConversationProjectResolutionOptions {
  isNoProjectPath?: AgentGUIConversationNoProjectPathResolver;
}

export type AgentGUIConversationStatus =
  | "working"
  | "waiting"
  | "ready"
  | "completed"
  | "failed"
  | "canceled";

export function resolveAgentGUIConversationSortTimeUnixMs(
  conversation: Pick<
    AgentGUIConversationSummary,
    "sortTimeUnixMs" | "updatedAtUnixMs"
  >
): number {
  return conversation.sortTimeUnixMs ?? conversation.updatedAtUnixMs;
}

export interface AgentGUITimelineRow {
  id: string;
  turnId: string;
  role: string;
  content: string;
  eventType: string;
  status: string | null;
  callType?: string;
  approval?: AgentGUIApprovalRequest | null;
  occurredAtUnixMs: number;
}

export type AgentGUIApprovalRequest = AgentApprovalItemVM;

export interface AgentGUIApprovalOption {
  id: string;
  label: string;
  kind: string;
  description?: string;
}

export interface AgentGUIInteractiveQuestionOption {
  label: string;
  description: string;
}

export interface AgentGUIInteractiveQuestion extends AgentAskUserQuestionVM {
  isOther?: boolean;
}

export type AgentGUIInteractivePrompt =
  | AgentGUIApprovalRequest
  | {
      kind: "ask-user";
      requestId: string;
      title: string;
      questions: AgentGUIInteractiveQuestion[];
    }
  | Extract<AgentConversationPromptVM, { kind: "exit-plan" }>
  | Extract<AgentConversationPromptVM, { kind: "plan-implementation" }>;

export interface BuildAgentGUIConversationsInput {
  isNoProjectPath?: AgentGUIConversationNoProjectPathResolver;
  snapshot: WorkspaceAgentActivitySnapshot;
  provider: AgentGUIProvider;
  sessionMessagesById?: Record<string, WorkspaceAgentActivityMessage[]>;
  userProjects?: readonly AgentGUIConversationUserProject[];
}

export function buildAgentGUIConversationSummaries({
  isNoProjectPath,
  snapshot,
  provider,
  sessionMessagesById,
  userProjects = []
}: BuildAgentGUIConversationsInput): AgentGUIConversationSummary[] {
  const runtimeSnapshot = filterAgentGUIRuntimeSnapshot(snapshot);
  const sessionsById = new Map(
    runtimeSnapshot.sessions.map((session) => [session.agentSessionId, session])
  );
  return buildWorkspaceAgentActivityListViewModel(runtimeSnapshot, {
    sessionMessagesById
  })
    .activities.map((activity) =>
      conversationSummaryFromActivity(
        activity,
        sessionsById.get(activity.sessionId),
        { isNoProjectPath, userProjects }
      )
    )
    .filter(
      (conversation) =>
        conversation.provider === provider ||
        conversation.provider === "unknown"
    );
}

export function selectAgentGUIConversationId(
  conversations: readonly AgentGUIConversationSummary[],
  preferredSessionId: string | null | undefined
): string | null {
  const preferred = preferredSessionId?.trim();
  if (
    preferred &&
    conversations.some((conversation) => conversation.id === preferred)
  ) {
    return preferred;
  }
  return conversations[0]?.id ?? null;
}

export function buildAgentGUITimelineRows(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentGUITimelineRow[] {
  return timelineRowsFromActivityTimelineItems(
    mergeTimelineItems([], timelineItems)
  );
}

export function buildAgentGUITimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  return mergeTimelineItems([], timelineItems);
}

export function buildAgentGUITimelineRowsFromSessionEvents(
  events: readonly AgentSessionEvent[]
): AgentGUITimelineRow[] {
  const timelineItems = buildAgentGUITimelineItemsFromSessionEvents(events);
  return timelineRowsFromActivityTimelineItems(timelineItems);
}

export function buildAgentGUITimelineItemsFromSessionEvents(
  events: readonly AgentSessionEvent[]
): WorkspaceAgentActivityTimelineItem[] {
  return projectAgentSessionEventsToTimelineItems(events);
}

export function mergeAgentGUITimelineRows(
  left: readonly AgentGUITimelineRow[],
  right: readonly AgentGUITimelineRow[]
): AgentGUITimelineRow[] {
  const byID = new Map<string, AgentGUITimelineRow>();
  for (const row of [...left, ...right]) {
    byID.set(row.id, row);
  }
  return sortTimelineRows([...byID.values()]);
}

export function mergeAgentGUITimelineItems(
  left: readonly WorkspaceAgentActivityTimelineItem[],
  right: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  return mergeTimelineItems(left, right);
}

export function buildAgentGUIConversationDetail({
  timelineItems,
  conversation,
  workspaceRoot = null
}: {
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
  conversation: AgentGUIConversationProjectionSource;
  workspaceRoot?: string | null;
}): WorkspaceAgentSessionDetailViewModel | null {
  const session = timelineSessionFromItems(timelineItems, conversation);
  const activity =
    buildWorkspaceAgentActivityListViewModel(
      {
        presences: [],
        sessions: [session]
      },
      {
        sessionMessagesById: {
          [session.agentSessionId]:
            workspaceAgentMessagesFromTimelineItems(timelineItems)
        }
      }
    ).activities[0] ?? null;
  if (!activity) {
    return null;
  }
  const resolvedActivity = activityWithExplicitConversationTitle(
    activity,
    conversation
  );
  const detail = buildWorkspaceAgentSessionDetailViewModel({
    activity: resolvedActivity,
    session,
    timelineItems: [...timelineItems],
    workspaceRoot
  });
  return detail;
}

export function buildAgentGUIConversationVM({
  timelineItems,
  conversation,
  workspaceRoot = null,
  avoidGroupingEdits = false
}: {
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
  conversation: AgentGUIConversationProjectionSource;
  workspaceRoot?: string | null;
  avoidGroupingEdits?: boolean;
}): AgentConversationVM | null {
  const session = timelineSessionFromItems(timelineItems, conversation);
  const activity =
    buildWorkspaceAgentActivityListViewModel(
      {
        presences: [],
        sessions: [session]
      },
      {
        sessionMessagesById: {
          [session.agentSessionId]:
            workspaceAgentMessagesFromTimelineItems(timelineItems)
        }
      }
    ).activities[0] ?? null;
  if (!activity) {
    return null;
  }
  const resolvedActivity = activityWithExplicitConversationTitle(
    activity,
    conversation
  );
  const conversationVM = projectWorkspaceAgentTimelineToConversationVM(
    {
      activity: resolvedActivity,
      session,
      timelineItems: [...timelineItems],
      workspaceRoot
    },
    { avoidGroupingEdits }
  );
  return conversationVM;
}

export function mergeTimelineItemsByEventID(
  previous: readonly WorkspaceAgentActivityTimelineItem[],
  incoming: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  return mergeTimelineItems(previous, incoming);
}

export function conversationSummaryFromAgentSession(
  session: AgentSession,
  options: {
    isNoProjectPath?: AgentGUIConversationNoProjectPathResolver;
    userProjects?: readonly AgentGUIConversationUserProject[];
  } = {}
): AgentGUIConversationSummary {
  const workspaceAgentSession = agentSessionToWorkspaceAgentSession(session);
  const activity =
    buildWorkspaceAgentActivityListViewModel({
      presences: [],
      sessions: [workspaceAgentSession]
    }).activities[0] ?? null;
  if (activity) {
    return conversationSummaryFromActivity(activity, workspaceAgentSession, {
      isNoProjectPath: options.isNoProjectPath,
      userProjects: options.userProjects ?? []
    });
  }
  const provider = resolveAgentGUIProviderIdentity({
    sessionProvider: session.provider
  });
  const { title, titleFallback } = resolveAgentGUIConversationTitle(
    session.title,
    provider
  );
  return {
    id: session.agentSessionId.trim(),
    userId: "",
    provider,
    resumable: session.resumable,
    title,
    titleFallback,
    status: conversationStatusFromActivity("idle"),
    cwd: session.cwd?.trim() ?? "",
    project: resolveAgentGUIConversationProject(
      session.cwd,
      options.userProjects ?? [],
      { isNoProjectPath: options.isNoProjectPath }
    ),
    pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
    sortTimeUnixMs: resolveWorkspaceAgentSessionSortTimeUnixMs(
      workspaceAgentSession
    ),
    updatedAtUnixMs:
      session.updatedAtUnixMs || session.createdAtUnixMs || Date.now(),
    syncState: undefined
  };
}

export function resolveAgentGUIConversationProject(
  cwd: string | null | undefined,
  userProjects: readonly AgentGUIConversationUserProject[] = [],
  options: AgentGUIConversationProjectResolutionOptions = {}
): AgentGUIConversationProjectSummary | null {
  const normalizedCwd = normalizeAgentGUIProjectPath(cwd);
  if (!normalizedCwd) {
    return null;
  }
  if (options.isNoProjectPath?.({ path: normalizedCwd })) {
    return null;
  }
  let matchedProject: AgentGUIConversationUserProject | null = null;
  let matchedPath = "";
  for (const project of userProjects) {
    const projectPath = normalizeAgentGUIProjectPath(project.path);
    if (
      !projectPath ||
      (normalizedCwd !== projectPath &&
        !normalizedCwd.startsWith(`${projectPath}/`))
    ) {
      continue;
    }
    if (projectPath.length <= matchedPath.length) {
      continue;
    }
    matchedProject = project;
    matchedPath = projectPath;
  }
  if (!matchedProject) {
    return null;
  }
  const summary: AgentGUIConversationProjectSummary = {
    id: matchedProject.id,
    path: matchedProject.path,
    label: resolveWorkspaceUserProjectDisplayLabel(matchedProject)
  };
  if (matchedProject.createdAtUnixMs !== undefined) {
    summary.createdAtUnixMs = matchedProject.createdAtUnixMs;
  }
  if (matchedProject.updatedAtUnixMs !== undefined) {
    summary.updatedAtUnixMs = matchedProject.updatedAtUnixMs;
  }
  if (matchedProject.lastUsedAtUnixMs !== undefined) {
    summary.lastUsedAtUnixMs = matchedProject.lastUsedAtUnixMs;
  }
  return cachedAgentGUIConversationProjectSummary(summary);
}

export function applyAgentGUIConversationProjects(
  conversations: readonly AgentGUIConversationSummary[],
  userProjects: readonly AgentGUIConversationUserProject[] = [],
  options: AgentGUIConversationProjectResolutionOptions = {}
): AgentGUIConversationSummary[] {
  let changed = false;
  const next = conversations.map((conversation) => {
    const project = resolveAgentGUIConversationProject(
      conversation.cwd,
      userProjects,
      options
    );
    if (isSameAgentGUIConversationProject(conversation.project, project)) {
      return conversation;
    }
    changed = true;
    return {
      ...conversation,
      project
    };
  });
  return changed ? next : (conversations as AgentGUIConversationSummary[]);
}

export function resolveAgentGUIConversationTitleFromTimelineItems({
  timelineItems,
  conversation
}: {
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
  conversation: AgentGUIConversationSummary;
}): {
  title: string;
  titleFallback: AgentGUIConversationTitleFallback;
} | null {
  if (resolveAgentGUIExplicitConversationTitle(conversation) !== null) {
    return null;
  }
  const userMessageTitle =
    firstUserMessageTitleFromTimelineItems(timelineItems);
  if (!userMessageTitle) {
    return null;
  }
  return resolveAgentGUIConversationTitle(
    userMessageTitle,
    conversation.provider
  );
}

export function resolveAgentGUIConversationTitleFromMessages({
  messages,
  conversation
}: {
  messages: readonly WorkspaceAgentActivityMessage[];
  conversation: AgentGUIConversationSummary;
}): {
  title: string;
  titleFallback: AgentGUIConversationTitleFallback;
} | null {
  if (resolveAgentGUIExplicitConversationTitle(conversation) !== null) {
    return null;
  }
  const userMessageTitle = firstUserMessageTitleFromMessages(messages);
  if (!userMessageTitle) {
    return null;
  }
  return resolveAgentGUIConversationTitle(
    userMessageTitle,
    conversation.provider
  );
}

function filterAgentGUIRuntimeSnapshot(
  snapshot: WorkspaceAgentActivitySnapshot
): WorkspaceAgentActivitySnapshot {
  return {
    presences: snapshot.presences,
    sessions: snapshot.sessions.filter((session) =>
      isAgentGUIRuntimeSession(session)
    )
  };
}

function isAgentGUIRuntimeSession(
  session: WorkspaceAgentActivitySession
): boolean {
  return (
    session.agentSessionId.trim().length > 0 &&
    isWorkspaceAgentActivityRuntimeSessionOrigin(session.sessionOrigin)
  );
}

function conversationSummaryFromActivity(
  activity: WorkspaceAgentActivityCard,
  session: WorkspaceAgentActivitySession | undefined,
  options: {
    isNoProjectPath?: AgentGUIConversationNoProjectPathResolver;
    userProjects?: readonly AgentGUIConversationUserProject[];
  } = {}
): AgentGUIConversationSummary {
  const status = conversationStatusFromActivity(activity.status);
  const provider = resolveAgentGUIProviderIdentity({
    workspaceSessionProvider: session?.provider,
    conversationProvider: activity.agentProvider
  });
  const explicitSessionTitle = session
    ? resolveAgentGUIExplicitConversationTitle({
        provider,
        title: session.title ?? "",
        titleFallback: null
      })
    : null;
  const { title, titleFallback } = resolveAgentGUIConversationTitle(
    explicitSessionTitle ?? activity.title,
    provider
  );
  return {
    id: activity.sessionId,
    userId: session?.userId?.trim() ?? "",
    provider,
    resumable: session?.resumable,
    title,
    titleFallback,
    status,
    cwd: session?.cwd.trim() ?? "",
    project: resolveAgentGUIConversationProject(
      session?.cwd,
      options.userProjects ?? [],
      { isNoProjectPath: options.isNoProjectPath }
    ),
    pinnedAtUnixMs: session?.pinnedAtUnixMs ?? null,
    sortTimeUnixMs: activity.sortTimeUnixMs,
    updatedAtUnixMs: session?.updatedAtUnixMs || activity.sortTimeUnixMs || 0,
    syncState: session?.syncState
  };
}

function normalizeAgentGUIProjectPath(path: string | null | undefined): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

function cachedAgentGUIConversationProjectSummary(
  summary: AgentGUIConversationProjectSummary
): AgentGUIConversationProjectSummary {
  const key = [
    summary.id,
    summary.path,
    summary.label,
    summary.createdAtUnixMs ?? "",
    summary.updatedAtUnixMs ?? "",
    summary.lastUsedAtUnixMs ?? ""
  ].join("\u001f");
  const cached = agentGUIConversationProjectSummaryCache.get(key);
  if (cached) {
    return cached;
  }
  if (
    agentGUIConversationProjectSummaryCache.size >=
    AGENT_GUI_CONVERSATION_PROJECT_SUMMARY_CACHE_LIMIT
  ) {
    const oldestKey = agentGUIConversationProjectSummaryCache
      .keys()
      .next().value;
    if (oldestKey) {
      agentGUIConversationProjectSummaryCache.delete(oldestKey);
    }
  }
  agentGUIConversationProjectSummaryCache.set(key, summary);
  return summary;
}

function isSameAgentGUIConversationProject(
  left: AgentGUIConversationProjectSummary | null | undefined,
  right: AgentGUIConversationProjectSummary | null
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.id === right.id &&
    left.path === right.path &&
    left.label === right.label &&
    left.createdAtUnixMs === right.createdAtUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.lastUsedAtUnixMs === right.lastUsedAtUnixMs
  );
}

function activityWithExplicitConversationTitle(
  activity: WorkspaceAgentActivityCard,
  conversation: AgentGUIConversationProjectionSource
): WorkspaceAgentActivityCard {
  const explicitTitle = resolveAgentGUIExplicitConversationTitle(conversation);
  if (!explicitTitle || activity.title === explicitTitle) {
    return activity;
  }
  return {
    ...activity,
    title: explicitTitle
  };
}

function conversationStatusFromActivity(
  status: WorkspaceAgentActivityStatus
): AgentGUIConversationStatus {
  switch (status) {
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
    case "idle":
    default:
      return "ready";
  }
}

function timelineRowsFromActivityTimelineItems(
  timelineItems: WorkspaceAgentActivityTimelineItem[]
): AgentGUITimelineRow[] {
  if (timelineItems.length === 0) {
    return [];
  }
  const session = timelineSessionFromItems(timelineItems);
  const activity =
    buildWorkspaceAgentActivityListViewModel(
      {
        presences: [],
        sessions: [session]
      },
      {
        sessionMessagesById: {
          [session.agentSessionId]:
            workspaceAgentMessagesFromTimelineItems(timelineItems)
        }
      }
    ).activities[0] ?? null;
  if (!activity) {
    return [];
  }
  const detail = buildWorkspaceAgentSessionDetailViewModel({
    activity,
    session,
    timelineItems
  });
  const rows: AgentGUITimelineRow[] = [];
  for (const turn of detail.turns) {
    for (const message of turn.userMessages) {
      const rowID = stableTimelineRowID(timelineItems, message.id);
      rows.push({
        id: rowID,
        turnId: turn.id,
        role: "user",
        content: message.body,
        eventType: "message.user",
        status: timelineRowStatus(timelineItems, message.id),
        occurredAtUnixMs: timelineRowTime(timelineItems, message.id)
      });
    }
    for (const item of turn.agentItems) {
      if (item.kind === "message") {
        const rowID = stableTimelineRowID(timelineItems, item.message.id);
        rows.push({
          id: rowID,
          turnId: turn.id,
          role: "assistant",
          content: item.message.body,
          eventType: "message.assistant",
          status: timelineRowStatus(timelineItems, item.message.id),
          occurredAtUnixMs: timelineRowTime(timelineItems, item.message.id)
        });
      } else if (item.kind === "thinking") {
        const rowID = stableTimelineRowID(timelineItems, item.thinking.id);
        rows.push({
          id: rowID,
          turnId: turn.id,
          role: "assistant_thinking",
          content: item.thinking.body,
          eventType: "message.assistant_thinking",
          status: timelineRowStatus(timelineItems, item.thinking.id),
          occurredAtUnixMs: timelineRowTime(timelineItems, item.thinking.id)
        });
      } else {
        for (const call of item.toolCalls) {
          const callID = normalizeToolCallID(call.id);
          const latestCallItem = latestTimelineItemByCallId(
            timelineItems,
            callID
          );
          const approval = latestCallItem
            ? approvalRequestFromTimelineItem(latestCallItem)
            : null;
          rows.push({
            id: `call:${turn.id}:${callID}`,
            turnId: turn.id,
            role: "tool",
            content: toolRowContent(call, approval?.title || null),
            eventType: "call",
            status:
              timelineRowStatusByCallId(timelineItems, callID) ?? call.status,
            callType: latestCallItem?.callType?.trim() || undefined,
            approval,
            occurredAtUnixMs: timelineRowTimeByCallId(timelineItems, callID)
          });
        }
      }
    }
  }
  return dedupeTimelineRowsByID(rows);
}

function toolRowContent(
  call: WorkspaceAgentSessionDetailToolCall,
  approvalTitle: string | null
): string {
  if (approvalTitle?.trim()) {
    return approvalTitle.trim();
  }
  const summary = call.summary.trim();
  if (summary && !looksLikeOpaqueFunctionCallSummary(summary)) {
    return summary;
  }
  return call.name;
}

function looksLikeOpaqueFunctionCallSummary(value: string): boolean {
  return /^call function [a-z0-9]+(?: \d+)?$/i.test(value.trim());
}

function timelineSessionFromItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  conversation?: AgentGUIConversationProjectionSource
): WorkspaceAgentActivitySession {
  const first = timelineItems[0];
  const fallbackAgentSessionId =
    first?.agentSessionId?.trim() ||
    conversation?.syncState?.agentSessionId?.trim() ||
    conversation?.id?.trim() ||
    "agent-gui-session";
  const provider = resolveAgentGUIProviderIdentity({
    conversationProvider: conversation?.provider,
    timelineItems
  });
  const workspaceId =
    first?.workspaceId?.trim() ||
    conversation?.syncState?.workspaceId?.trim() ||
    "";
  return {
    id: 0,
    workspaceId,
    agentSessionId: fallbackAgentSessionId,
    presenceId: 0,
    userId: conversation?.userId?.trim() ?? "",
    provider,
    providerSessionId: fallbackAgentSessionId,
    sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
    cwd: conversation?.cwd?.trim() ?? "",
    lifecycleStatus: sessionLifecycleStatus(conversation?.status ?? "ready"),
    turnPhase: conversation?.status === "working" ? "working" : "idle",
    effectiveStatus: conversation?.status ?? "ready",
    status: conversation?.status ?? "ready",
    title: conversation?.title,
    createdAtUnixMs: first?.createdAtUnixMs ?? first?.occurredAtUnixMs ?? 0,
    updatedAtUnixMs:
      latestTimelineTime(timelineItems) || conversation?.updatedAtUnixMs || 0,
    pinnedAtUnixMs: conversation?.pinnedAtUnixMs
  };
}

function agentSessionToWorkspaceAgentSession(
  session: AgentSession
): WorkspaceAgentActivitySession {
  const workspaceId = session.workspaceId.trim();
  return {
    id: hashStringToPositiveInt(session.agentSessionId),
    workspaceId,
    agentSessionId: session.agentSessionId.trim(),
    presenceId: 0,
    userId: "",
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    resumable: session.resumable,
    sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
    cwd: session.cwd?.trim() ?? "",
    lifecycleStatus: sessionLifecycleStatus(session.status),
    turnPhase: session.status === "working" ? "working" : "idle",
    effectiveStatus: session.status,
    status: session.status,
    title: session.title,
    pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
    createdAtUnixMs: session.createdAtUnixMs,
    updatedAtUnixMs: session.updatedAtUnixMs
  };
}

function firstUserMessageTitleFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): string {
  const userMessage = [...timelineItems]
    .filter(
      (item) =>
        timelineItemRole(item) === "user" && timelineItemText(item).length > 0
    )
    .sort(compareTimelineItemsAscending)[0];
  return userMessage ? timelineItemText(userMessage) : "";
}

function firstUserMessageTitleFromMessages(
  messages: readonly WorkspaceAgentActivityMessage[]
): string {
  const userMessage = [...messages]
    .filter(
      (message) =>
        messageRole(message) === "user" && messageText(message).length > 0
    )
    .sort(compareMessagesAscending)[0];
  return userMessage ? messageText(userMessage) : "";
}

function workspaceAgentMessagesFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityMessage[] {
  return timelineItems.map((item, index) => ({
    id: item.id,
    workspaceId: item.workspaceId,
    agentSessionId: item.agentSessionId,
    messageId: item.eventId || `${item.agentSessionId}:${item.id}:${index}`,
    version: item.seq ?? item.id,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    role: item.role ?? timelineItemRole(item) ?? item.actorType,
    kind: item.itemType === "call" ? "tool_call" : item.itemType,
    ...(item.status ? { status: item.status } : {}),
    payload: {
      ...item.payload,
      content: item.payload?.content ?? item.content,
      text: item.payload?.text ?? item.content,
      callType: item.callType,
      callId: item.callId,
      name: item.name
    },
    occurredAtUnixMs: item.occurredAtUnixMs ?? item.createdAtUnixMs,
    startedAtUnixMs: item.createdAtUnixMs,
    completedAtUnixMs: item.occurredAtUnixMs
  }));
}

function messageRole(
  message: WorkspaceAgentActivityMessage
): "user" | "agent" | null {
  const role = message.role?.trim().toLowerCase();
  if (role === "user") {
    return "user";
  }
  if (role === "assistant" || role === "agent") {
    return "agent";
  }
  const kind = message.kind.trim().toLowerCase();
  if (kind === "message.user") {
    return "user";
  }
  if (kind === "message.assistant" || kind === "message.agent") {
    return "agent";
  }
  return null;
}

function messageText(message: WorkspaceAgentActivityMessage): string {
  const payloadDisplayPrompt =
    typeof message.payload?.displayPrompt === "string"
      ? message.payload.displayPrompt
      : "";
  const payloadContent =
    typeof message.payload?.content === "string" ? message.payload.content : "";
  const payloadText =
    typeof message.payload?.text === "string" ? message.payload.text : "";
  return (payloadDisplayPrompt || payloadText || payloadContent)
    .replace(/\s+/g, " ")
    .trim();
}

function compareMessagesAscending(
  left: WorkspaceAgentActivityMessage,
  right: WorkspaceAgentActivityMessage
): number {
  const leftTime =
    left.occurredAtUnixMs ??
    left.completedAtUnixMs ??
    left.startedAtUnixMs ??
    0;
  const rightTime =
    right.occurredAtUnixMs ??
    right.completedAtUnixMs ??
    right.startedAtUnixMs ??
    0;
  const timeDiff = leftTime - rightTime;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return (
    (left.id ?? 0) - (right.id ?? 0) ||
    left.messageId.localeCompare(right.messageId)
  );
}

function timelineItemRole(
  item: WorkspaceAgentActivityTimelineItem
): "user" | "agent" | null {
  const role = item.role?.trim().toLowerCase();
  if (role === "user") {
    return "user";
  }
  if (role === "assistant" || role === "agent") {
    return "agent";
  }
  const itemType = item.itemType.trim().toLowerCase();
  if (itemType === "message.user") {
    return "user";
  }
  if (itemType === "message.assistant" || itemType === "message.agent") {
    return "agent";
  }
  return null;
}

function timelineItemText(item: WorkspaceAgentActivityTimelineItem): string {
  const payloadDisplayPrompt =
    typeof item.payload?.displayPrompt === "string"
      ? item.payload.displayPrompt
      : "";
  const payloadContent =
    typeof item.payload?.content === "string" ? item.payload.content : "";
  const payloadText =
    typeof item.payload?.text === "string" ? item.payload.text : "";
  return (payloadDisplayPrompt || payloadText || item.content || payloadContent)
    .replace(/\s+/g, " ")
    .trim();
}

function compareTimelineItemsAscending(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  const leftTime = left.occurredAtUnixMs ?? left.createdAtUnixMs ?? 0;
  const rightTime = right.occurredAtUnixMs ?? right.createdAtUnixMs ?? 0;
  const timeDiff = leftTime - rightTime;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return left.id - right.id || left.eventId.localeCompare(right.eventId);
}

function sessionLifecycleStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "completed":
    case "canceled":
      return "ended";
    case "failed":
      return "failed";
    default:
      return "active";
  }
}

export function selectPendingApproval(
  rows: readonly AgentGUITimelineRow[]
): AgentGUIApprovalRequest | null {
  return (
    [...rows]
      .filter(
        (row) =>
          row.approval && normalizeStatus(row.status) === "waiting_approval"
      )
      .sort((left, right) => right.occurredAtUnixMs - left.occurredAtUnixMs)[0]
      ?.approval ?? null
  );
}

export function selectPendingApprovalFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentGUIApprovalRequest | null {
  return (
    [...timelineItems]
      .sort((left, right) => compareTimelineItemsForMerge(right, left))
      .map(approvalRequestFromTimelineItem)
      .filter((value): value is AgentGUIApprovalRequest => value !== null)[0] ??
    null
  );
}

export function selectPendingInteractivePromptFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentGUIInteractivePrompt | null {
  return (
    [...timelineItems]
      .sort((left, right) => compareTimelineItemsForMerge(right, left))
      .map(interactivePromptFromTimelineItem)
      .filter(
        (value): value is AgentGUIInteractivePrompt => value !== null
      )[0] ?? null
  );
}

function approvalRequestFromTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): AgentGUIApprovalRequest | null {
  const payload = item.payload ?? {};
  const callType =
    normalizeCallType(item.callType) ||
    normalizeCallType(stringPayload(payload.callType));
  if (callType !== "approval") {
    return null;
  }
  if (
    normalizeStatus(item.status) !== "waiting_approval" &&
    normalizeStatus(stringPayload(payload.status)) !== "waiting_approval"
  ) {
    return null;
  }
  const input = objectPayload(payload.input);
  const requestId =
    stringPayload(input?.requestId) || stringPayload(payload.requestId);
  const callId = item.callId?.trim() || stringPayload(payload.callId);
  if (!requestId || !callId) {
    return null;
  }
  const options = normalizeApprovalOptions(
    arrayPayload(input?.options) ?? arrayPayload(payload.options) ?? []
  );
  if (isExitPlanApprovalInput(input, options)) {
    return null;
  }
  return {
    kind: "approval",
    id: String(item.id),
    turnId: item.turnId?.trim() || "turn:unknown",
    requestId,
    callId,
    title:
      item.name?.trim() ||
      stringPayload(payload.name) ||
      item.content?.trim() ||
      callId,
    status: item.status?.trim() || stringPayload(payload.status) || null,
    toolName: item.name?.trim() || stringPayload(payload.name) || null,
    input,
    options,
    output: objectPayload(payload.output),
    occurredAtUnixMs: item.occurredAtUnixMs ?? null
  };
}

function interactivePromptFromTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): AgentGUIInteractivePrompt | null {
  const payload = item.payload ?? {};
  const callType =
    normalizeCallType(item.callType) ||
    normalizeCallType(stringPayload(payload.callType));
  const input = objectPayload(payload.input);
  if (callType === "approval") {
    const options = normalizeApprovalOptions(
      arrayPayload(input?.options) ?? arrayPayload(payload.options) ?? []
    );
    if (!isExitPlanApprovalInput(input, options)) {
      return null;
    }
    const status =
      normalizeStatus(item.status) ||
      normalizeStatus(stringPayload(payload.status));
    if (
      status !== "waiting" &&
      status !== "pending" &&
      status !== "waiting_approval"
    ) {
      return null;
    }
    const requestId =
      stringPayload(input?.requestId) ||
      stringPayload(payload.requestId) ||
      stringPayload(objectPayload(payload.metadata)?.requestId);
    if (!requestId) {
      return null;
    }
    return {
      kind: "exit-plan",
      requestId,
      title:
        stringPayload(objectPayload(input?.toolCall)?.title) ||
        item.name?.trim() ||
        stringPayload(payload.name) ||
        "Exit plan mode"
    };
  }
  if (callType !== "interactive") {
    return null;
  }
  const status =
    normalizeStatus(item.status) ||
    normalizeStatus(stringPayload(payload.status));
  if (status !== "waiting" && status !== "pending") {
    return null;
  }
  const toolName = normalizeInteractiveToolName(
    item.name?.trim() ||
      stringPayload(payload.name) ||
      stringPayload(payload.toolName)
  );
  const requestId =
    stringPayload(input?.requestId) ||
    stringPayload(payload.requestId) ||
    stringPayload(objectPayload(payload.metadata)?.requestId);
  if (!requestId) {
    return null;
  }
  if (toolName === "exitplanmode") {
    return {
      kind: "exit-plan",
      requestId,
      title:
        item.name?.trim() || stringPayload(payload.name) || "Exit plan mode"
    };
  }
  if (toolName !== "askuserquestion") {
    return null;
  }
  const questions = normalizeInteractiveQuestions(
    arrayPayload(input?.questions) ?? []
  );
  if (questions.length === 0) {
    return null;
  }
  return {
    kind: "ask-user",
    requestId,
    title:
      item.name?.trim() || stringPayload(payload.name) || "Questions for you",
    questions
  };
}

function isExitPlanApprovalInput(
  input: Record<string, unknown> | null,
  options: readonly AgentGUIApprovalOption[]
): boolean {
  const toolCall = objectPayload(input?.toolCall);
  const kind = stringPayload(toolCall?.kind)?.toLowerCase() ?? "";
  if (kind !== "switch_mode") {
    return false;
  }
  return options.some((option) => option.id === "plan");
}

function timelineRowTime(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  rowID: string
): number {
  const item = timelineItems.find((candidate) => itemID(candidate) === rowID);
  return item?.occurredAtUnixMs ?? item?.createdAtUnixMs ?? 0;
}

function timelineRowStatus(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  rowID: string
): string | null {
  const item = timelineItems.find((candidate) => itemID(candidate) === rowID);
  return itemStatus(item);
}

function timelineRowTimeByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): number {
  const item = [...timelineItems]
    .filter((candidate) => candidate.callId?.trim() === callID)
    .sort(
      (left, right) =>
        (right.occurredAtUnixMs ?? 0) - (left.occurredAtUnixMs ?? 0)
    )[0];
  return item?.occurredAtUnixMs ?? item?.createdAtUnixMs ?? 0;
}

function timelineRowStatusByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): string | null {
  const item = latestTimelineItemByCallId(timelineItems, callID);
  return itemStatus(item);
}

function latestTimelineItemByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): WorkspaceAgentActivityTimelineItem | undefined {
  return [...timelineItems]
    .filter((candidate) => candidate.callId?.trim() === callID)
    .sort(
      (left, right) =>
        (right.occurredAtUnixMs ?? 0) - (left.occurredAtUnixMs ?? 0)
    )[0];
}

function itemStatus(
  item: WorkspaceAgentActivityTimelineItem | undefined
): string | null {
  if (!item) {
    return null;
  }
  return item.status?.trim() || stringPayload(item.payload?.status) || null;
}

function itemID(item: WorkspaceAgentActivityTimelineItem): string {
  const eventID = item.eventId?.trim();
  if (eventID) {
    return eventID;
  }
  if (Number.isFinite(item.id) && item.id > 0) {
    return `server:${item.id}`;
  }
  return `local:${item.occurredAtUnixMs ?? 0}:${item.itemType}:${item.role ?? ""}`;
}

function stableTimelineRowID(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  detailItemID: string
): string {
  const item = timelineItems.find(
    (candidate) => itemID(candidate) === detailItemID
  );
  const eventID = item?.eventId?.trim();
  return eventID ? `event:${eventID}` : detailItemID;
}

function normalizeToolCallID(callID: string): string {
  return callID.startsWith("call:") ? callID.slice("call:".length) : callID;
}

function dedupeTimelineRowsByID(
  rows: AgentGUITimelineRow[]
): AgentGUITimelineRow[] {
  const byID = new Map<string, AgentGUITimelineRow>();
  for (const row of rows) {
    byID.set(row.id, row);
  }
  return sortTimelineRows([...byID.values()]);
}

function sortTimelineRows(rows: AgentGUITimelineRow[]): AgentGUITimelineRow[] {
  return rows.sort(
    (a, b) =>
      a.occurredAtUnixMs - b.occurredAtUnixMs || a.id.localeCompare(b.id)
  );
}

function latestTimelineTime(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): number {
  return Math.max(
    0,
    ...timelineItems.map(
      (item) => item.occurredAtUnixMs ?? item.createdAtUnixMs ?? 0
    )
  );
}

function normalizeCallType(callType: string | undefined): string {
  return callType?.trim().toLowerCase() ?? "";
}

function normalizeInteractiveToolName(toolName: string | undefined): string {
  return (toolName?.trim() ?? "").replace(/[_\s-]+/g, "").toLowerCase();
}

function normalizeStatus(status: string | null | undefined): string {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (normalized === "awaiting_approval") {
    return "waiting_approval";
  }
  if (normalized === "waiting_input") {
    return "waiting";
  }
  return normalized;
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayPayload(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function normalizeApprovalOptions(
  values: readonly unknown[]
): AgentGUIApprovalOption[] {
  return values.flatMap((value) => {
    const option = objectPayload(value);
    if (!option) {
      return [];
    }
    const id = stringPayload(option.optionId) || stringPayload(option.id);
    if (!id) {
      return [];
    }
    const label =
      stringPayload(option.name) ||
      stringPayload(option.label) ||
      stringPayload(option.title) ||
      stringPayload(option.kind) ||
      id;
    return [
      {
        id,
        label,
        kind: stringPayload(option.kind) ?? "",
        ...(stringPayload(option.description)
          ? { description: stringPayload(option.description) }
          : {})
      }
    ];
  });
}

function normalizeInteractiveQuestions(
  values: readonly unknown[]
): AgentGUIInteractiveQuestion[] {
  return values.flatMap((value, index) => {
    const question = objectPayload(value);
    if (!question) {
      return [];
    }
    const id = stringPayload(question.id) || `question-${index + 1}`;
    const options = (arrayPayload(question.options) ?? []).flatMap(
      (optionValue) => {
        const option = objectPayload(optionValue);
        if (!option) {
          return [];
        }
        const label = stringPayload(option.label) || stringPayload(option.name);
        if (!label) {
          return [];
        }
        return [
          {
            label,
            description: stringPayload(option.description)
          }
        ];
      }
    );
    return [
      {
        id,
        header: stringPayload(question.header) || id,
        question:
          stringPayload(question.question) ||
          stringPayload(question.header) ||
          `Question ${index + 1}`,
        options,
        multiSelect: Boolean(question.multiSelect),
        isOther: Boolean(question.isOther)
      }
    ];
  });
}

function hashStringToPositiveInt(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}

function mergeTimelineItems(
  left: readonly WorkspaceAgentActivityTimelineItem[],
  right: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  const byKey = new Map<string, WorkspaceAgentActivityTimelineItem>();
  for (const item of [...left, ...right].sort(compareTimelineItemsForMerge)) {
    if (shouldOmitAgentGUITimelineItem(item)) {
      continue;
    }
    const key = timelineItemMergeKey(item);
    const previous = byKey.get(key);
    byKey.set(key, previous ? mergeTimelineItem(previous, item) : item);
  }
  return pruneOptimisticUserPrompts([...byKey.values()]).sort(
    compareTimelineItemsForMerge
  );
}

function shouldOmitAgentGUITimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const itemType = item.itemType?.trim().toLowerCase() ?? "";
  const payload = objectPayload(item.payload);
  const metadata = objectPayload(payload?.metadata);
  const activityKey =
    stringPayload(payload?.activityKey) || stringPayload(metadata?.activityKey);
  if (activityKey.toLowerCase() === "agent.responding") {
    return true;
  }
  const activityKind =
    stringPayload(payload?.activityKind) ||
    stringPayload(metadata?.activityKind);
  return (
    activityKind.toLowerCase() === "responding" &&
    (itemType === "event" || itemType.startsWith("activity."))
  );
}

function pruneOptimisticUserPrompts(
  items: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  return items.filter((item) => {
    if (!isOptimisticUserPromptItem(item)) {
      return true;
    }
    const turnId = item.turnId?.trim();
    const body = normalizedTimelineItemBody(item);
    return !items.some((candidate) => {
      return (
        candidate !== item &&
        candidate.role === "user" &&
        !isOptimisticUserPromptItem(candidate) &&
        candidate.turnId?.trim() === turnId &&
        normalizedTimelineItemBody(candidate) === body
      );
    });
  });
}

function isOptimisticUserPromptItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  return item.payload?.__agentGuiOptimisticPrompt === true;
}

function normalizedTimelineItemBody(
  item: WorkspaceAgentActivityTimelineItem
): string {
  const content =
    typeof item.payload?.displayPrompt === "string" &&
    item.payload.displayPrompt.trim()
      ? item.payload.displayPrompt
      : typeof item.payload?.text === "string" && item.payload.text.trim()
        ? item.payload.text
        : typeof item.payload?.content === "string" &&
            item.payload.content.trim()
          ? item.payload.content
          : typeof item.content === "string"
            ? item.content
            : "";
  return content.trim();
}

function timelineItemMergeKey(
  item: WorkspaceAgentActivityTimelineItem
): string {
  const callId = item.callId?.trim();
  if (callId) {
    return `call:${item.turnId?.trim() ?? ""}:${callId}`;
  }
  const eventId = item.eventId?.trim();
  if (eventId) {
    return `event:${eventId}`;
  }
  const seq = item.seq ?? 0;
  if (seq > 0) {
    const turnId = item.turnId?.trim();
    if (turnId) {
      return `seq:${turnId}:${seq}`;
    }
    return `seq:${seq}`;
  }
  return `id:${item.id}`;
}

function mergeTimelineItem(
  previous: WorkspaceAgentActivityTimelineItem,
  next: WorkspaceAgentActivityTimelineItem
): WorkspaceAgentActivityTimelineItem {
  const preserveLatestMessageTimestamp =
    isMessageTimelineItem(previous) || isMessageTimelineItem(next);
  return {
    ...previous,
    ...next,
    id: durableTimelineItemId(previous.id, next.id),
    payload: mergeTimelinePayload(previous.payload, next.payload),
    content: next.content || previous.content,
    status: next.status || previous.status,
    role: next.role || previous.role,
    callId: next.callId || previous.callId,
    callType: next.callType || previous.callType,
    name: next.name || previous.name,
    seq: Math.max(previous.seq ?? 0, next.seq ?? 0),
    occurredAtUnixMs: preserveLatestMessageTimestamp
      ? latestPositiveTimestamp(
          previous.occurredAtUnixMs,
          next.occurredAtUnixMs
        )
      : earliestPositiveTimestamp(
          previous.occurredAtUnixMs,
          next.occurredAtUnixMs
        ),
    createdAtUnixMs: preserveLatestMessageTimestamp
      ? latestPositiveTimestamp(previous.createdAtUnixMs, next.createdAtUnixMs)
      : earliestPositiveTimestamp(
          previous.createdAtUnixMs,
          next.createdAtUnixMs
        )
  };
}

function mergeTimelinePayload(
  previous: WorkspaceAgentActivityTimelineItem["payload"],
  next: WorkspaceAgentActivityTimelineItem["payload"]
): WorkspaceAgentActivityTimelineItem["payload"] {
  const previousRecord = objectPayload(previous);
  const nextRecord = objectPayload(next);
  if (!previousRecord && !nextRecord) {
    return undefined;
  }
  return mergeRecords(previousRecord ?? {}, nextRecord ?? {});
}

function mergeRecords(
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    const previousValue = objectPayload(merged[key]);
    const nextValue = objectPayload(value);
    merged[key] =
      previousValue && nextValue
        ? mergeRecords(previousValue, nextValue)
        : value;
  }
  return merged;
}

function durableTimelineItemId(previousId: number, nextId: number): number {
  if (nextId > 0) {
    return nextId;
  }
  return previousId > 0 ? previousId : nextId;
}

function earliestPositiveTimestamp(
  previous: number | undefined,
  next: number | undefined
): number | undefined {
  const positiveValues = [previous, next].filter(
    (value): value is number => typeof value === "number" && value > 0
  );
  return positiveValues.length > 0 ? Math.min(...positiveValues) : undefined;
}

function latestPositiveTimestamp(
  previous: number | undefined,
  next: number | undefined
): number | undefined {
  const positiveValues = [previous, next].filter(
    (value): value is number => typeof value === "number" && value > 0
  );
  return positiveValues.length > 0 ? Math.max(...positiveValues) : undefined;
}

function isMessageTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  return item.itemType?.trim().toLowerCase().startsWith("message.") ?? false;
}

function compareTimelineItemsForMerge(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  const leftSeq = left.seq ?? 0;
  const rightSeq = right.seq ?? 0;
  return (
    (left.occurredAtUnixMs ?? left.createdAtUnixMs ?? 0) -
      (right.occurredAtUnixMs ?? right.createdAtUnixMs ?? 0) ||
    leftSeq - rightSeq ||
    left.id - right.id
  );
}
