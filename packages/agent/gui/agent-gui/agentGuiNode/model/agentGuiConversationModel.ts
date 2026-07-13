import type { AgentSessionEvent } from "../../../shared/agentSessionTypes";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import {
  buildWorkspaceAgentActivityListViewModel,
  type WorkspaceAgentActivityCard,
  type WorkspaceAgentActivityStatus
} from "../../../shared/workspaceAgentActivityListViewModel";
import {
  buildWorkspaceAgentSessionDetailViewModel,
  type WorkspaceAgentSessionDetailViewModel
} from "../../../shared/workspaceAgentSessionDetailViewModel";
import { projectAgentSessionEventsToTimelineItems } from "../../../shared/agentConversation/projection/agentSessionEventProjection";
import { projectAgentConversationVM } from "../../../shared/agentConversation/projection/agentConversationProjection";
import {
  attachSubAgentLanesToConversationVM,
  buildSubAgentLanesByCallId,
  partitionSubAgentTimelineItems
} from "../../../shared/agentConversation/projection/subAgentTimelinePartition";
import {
  filterAgentGUIConversationSummaries,
  normalizeAgentGUIConversationFilter
} from "./agentGuiConversationFilter";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import {
  resolveAgentGUIConversationTitle,
  resolveAgentGUIExplicitConversationTitle,
  resolveAgentGUIProviderIdentity,
  type AgentGUIConversationTitleFallback
} from "../../../shared/agentConversationTitleProjection.ts";
import type {
  AgentActivitySession,
  AgentActivitySnapshot,
  CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import { selectCanonicalAgentActivitySessions } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentTimelineTypes";
import { resolveWorkspaceAgentSessionSortTimeUnixMs } from "../../../shared/workspaceAgentSessionSortTime";
import {
  createAgentGUIConversationProjectResolver,
  type AgentGUIConversationNoProjectPathResolver,
  type AgentGUIConversationProjectResolutionOptions,
  type AgentGUIConversationProjectResolver,
  type AgentGUIConversationProjectSummary,
  type AgentGUIConversationUserProject
} from "./agentGuiConversationProjectResolver";
import type {
  AgentGUIConversationProjectResolutionContext,
  AgentGUIConversationProjectionSource,
  AgentGUIConversationStatus,
  AgentGUIConversationSummary,
  AgentGUITimelineRow,
  BuildAgentGUIConversationsInput
} from "./agentGuiConversationTypes";
import {
  firstUserMessageTitleFromMessages,
  firstUserMessageTitleFromTimelineItems,
  timelineRowsFromActivityTimelineItems,
  timelineSessionFromItems,
  workspaceAgentMessagesFromTimelineItems
} from "./agentGuiTimelineProjection";
import { sortTimelineRows } from "./agentGuiInteractiveProjection";
import { mergeTimelineItems } from "./agentGuiTimelineMerge";

export {
  AGENT_GUI_RUNTIME_SESSION_ORIGIN,
  resolveAgentGUIConversationSortTimeUnixMs
} from "./agentGuiConversationTypes";
export {
  selectPendingApproval,
  selectPendingApprovalFromTimelineItems,
  selectPendingInteractivePromptFromTimelineItems
} from "./agentGuiInteractiveProjection";
export { resolveAgentGUIConversationProject } from "./agentGuiConversationProjectResolver";
export type {
  AgentGUIConversationNoProjectPathResolver,
  AgentGUIConversationProjectResolutionOptions,
  AgentGUIConversationProjectSummary,
  AgentGUIConversationUserProject
} from "./agentGuiConversationProjectResolver";
export type {
  AgentGUIApprovalOption,
  AgentGUIApprovalRequest,
  AgentGUIConversationProjectionSource,
  AgentGUIConversationStatus,
  AgentGUIConversationSummary,
  AgentGUIInteractivePrompt,
  AgentGUIInteractiveQuestion,
  AgentGUIInteractiveQuestionOption,
  AgentGUITimelineRow,
  BuildAgentGUIConversationsInput
} from "./agentGuiConversationTypes";
export function buildAgentGUIConversationSummaries({
  conversationFilter,
  isNoProjectPath,
  snapshot,
  provider,
  sessionMessagesById,
  userProjects = []
}: BuildAgentGUIConversationsInput): AgentGUIConversationSummary[] {
  const runtimeSnapshot = filterAgentGUIRuntimeSnapshot(snapshot);
  const sessionsById = new Map(
    selectCanonicalAgentActivitySessions(runtimeSnapshot).map((session) => [
      session.agentSessionId,
      session
    ])
  );
  const projectResolver = createAgentGUIConversationProjectResolver(
    userProjects,
    { isNoProjectPath }
  );
  const conversations = buildWorkspaceAgentActivityListViewModel(
    runtimeSnapshot,
    {
      sessionMessagesById
    }
  ).activities.map((activity) =>
    conversationSummaryFromActivity(
      activity,
      sessionsById.get(activity.sessionId),
      { projectResolver }
    )
  );
  if (conversationFilter) {
    return filterAgentGUIConversationSummaries(
      conversations,
      normalizeAgentGUIConversationFilter(conversationFilter)
    );
  }
  return conversations.filter(
    (conversation) =>
      conversation.provider === provider || conversation.provider === "unknown"
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
      timelineItems.length > 0
        ? {
            sessionMessagesById: {
              [session.agentSessionId]:
                workspaceAgentMessagesFromTimelineItems(timelineItems)
            }
          }
        : {}
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

export function buildAgentGUIConversationModels({
  timelineItems,
  conversation,
  workspaceRoot = null,
  avoidGroupingEdits = false
}: {
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[];
  conversation: AgentGUIConversationProjectionSource;
  workspaceRoot?: string | null;
  avoidGroupingEdits?: boolean;
}): {
  conversation: AgentConversationVM | null;
  detail: WorkspaceAgentSessionDetailViewModel | null;
} {
  const detail = buildAgentGUIConversationDetail({
    timelineItems,
    conversation,
    workspaceRoot
  });
  if (!detail) {
    return { conversation: null, detail: null };
  }
  // Child-thread rows are excluded from the transcript by the canonical
  // detail builder; here they are regrouped into live sub-agent lanes and
  // attached to their collab spawn card so running sub-agents stay visible.
  const subAgentLanesByCallId = buildSubAgentLanesByCallId(
    partitionSubAgentTimelineItems(timelineItems)
  );
  return {
    conversation: attachSubAgentLanesToConversationVM(
      projectAgentConversationVM(detail, { avoidGroupingEdits }),
      subAgentLanesByCallId
    ),
    detail
  };
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
  return buildAgentGUIConversationModels({
    timelineItems,
    conversation,
    workspaceRoot,
    avoidGroupingEdits
  }).conversation;
}

export function mergeTimelineItemsByEventID(
  previous: readonly WorkspaceAgentActivityTimelineItem[],
  incoming: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  return mergeTimelineItems(previous, incoming);
}

export function conversationSummaryFromAgentSession(
  session: CanonicalAgentSession,
  options: {
    isNoProjectPath?: AgentGUIConversationNoProjectPathResolver;
    userProjects?: readonly AgentGUIConversationUserProject[];
  } = {}
): AgentGUIConversationSummary {
  const projectResolver = createAgentGUIConversationProjectResolver(
    options.userProjects ?? [],
    { isNoProjectPath: options.isNoProjectPath }
  );
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
    agentTargetId: session.agentTargetId ?? null,
    provider,
    resumable: session.resumable,
    title,
    titleFallback,
    status: conversationStatusFromActivity(
      session.activeTurnId ? "working" : "idle"
    ),
    cwd: session.cwd?.trim() ?? "",
    project: resolveConversationProject(session, projectResolver),
    ...(isExternalImportNoProjectSession(session)
      ? { projectMode: "none" }
      : {}),
    pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
    sortTimeUnixMs: resolveWorkspaceAgentSessionSortTimeUnixMs(session),
    updatedAtUnixMs:
      session.updatedAtUnixMs || session.createdAtUnixMs || Date.now()
  };
}

export function applyAgentGUIConversationProjects(
  conversations: readonly AgentGUIConversationSummary[],
  userProjects: readonly AgentGUIConversationUserProject[] = [],
  options: AgentGUIConversationProjectResolutionOptions = {}
): AgentGUIConversationSummary[] {
  let changed = false;
  const projectResolver = createAgentGUIConversationProjectResolver(
    userProjects,
    options
  );
  const next = conversations.map((conversation) => {
    const project =
      conversation.projectMode === "none"
        ? null
        : projectResolver.resolve(conversation.cwd);
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
  messages: readonly AgentActivityMessage[];
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
  snapshot: AgentActivitySnapshot
): AgentActivitySnapshot {
  return {
    ...snapshot,
    sessions: selectCanonicalAgentActivitySessions(snapshot).filter((session) =>
      isAgentGUIRuntimeSession(session)
    )
  };
}

function isAgentGUIRuntimeSession(session: AgentActivitySession): boolean {
  return session.agentSessionId.trim().length > 0;
}

function conversationSummaryFromActivity(
  activity: WorkspaceAgentActivityCard,
  session: AgentActivitySession | undefined,
  options: AgentGUIConversationProjectResolutionContext
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
    agentTargetId: session?.agentTargetId ?? null,
    provider,
    resumable: session?.resumable,
    title,
    titleFallback,
    status,
    cwd: session?.cwd.trim() ?? "",
    project: resolveConversationProject(session, options.projectResolver),
    ...(isExternalImportNoProjectSession(session)
      ? { projectMode: "none" }
      : {}),
    pinnedAtUnixMs: session?.pinnedAtUnixMs ?? null,
    sortTimeUnixMs: activity.sortTimeUnixMs,
    updatedAtUnixMs: session?.updatedAtUnixMs || activity.sortTimeUnixMs || 0,
    activeTurn: session?.activeTurn ?? null,
    ...(isImportedWorkspaceAgentSession(session) ? { isImported: true } : {})
  };
}

function resolveConversationProject(
  session: AgentActivitySession | CanonicalAgentSession | undefined,
  projectResolver: AgentGUIConversationProjectResolver
): AgentGUIConversationProjectSummary | null {
  if (isExternalImportNoProjectSession(session)) {
    return null;
  }
  return projectResolver.resolve(session?.cwd);
}

function isExternalImportNoProjectSession(
  session: AgentActivitySession | CanonicalAgentSession | undefined
): boolean {
  return Boolean(
    session &&
    "imported" in session &&
    (session.noProject === true || session.imported === true)
  );
}

function isImportedWorkspaceAgentSession(
  session: AgentActivitySession | undefined
): boolean {
  return session?.imported === true;
}

function isSameAgentGUIConversationProject(
  left: AgentGUIConversationProjectSummary | null | undefined,
  right: AgentGUIConversationProjectSummary | null
): boolean {
  if (left === null && right === null) {
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
  const status = conversation.status === "ready" ? "idle" : conversation.status;
  if (
    (!explicitTitle || activity.title === explicitTitle) &&
    activity.status === status
  ) {
    return activity;
  }
  return {
    ...activity,
    status,
    ...(explicitTitle ? { title: explicitTitle } : {})
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
