import type {
  AgentActivityMessage,
  AgentActivityPresence,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { selectRootAgentActivitySessions } from "@tutti-os/agent-activity-core";
import { buildAssetUrl } from "./assetUrl";
import { resolveWorkspaceAgentSessionSortTimeUnixMs } from "./workspaceAgentSessionSortTime";
import { workspaceAgentProviderLabel } from "./workspaceAgentProviderLabel";
import {
  type BuildWorkspaceAgentActivityListOptions,
  type WorkspaceAgentActivityCard,
  type WorkspaceAgentActivityListViewModel,
  type WorkspaceAgentActivityListSnapshot,
  type WorkspaceAgentActivityStatus
} from "./workspaceAgentActivityListTypes";
import { changedFilesForSession } from "./workspaceAgentGeneratedFiles";
import { resolveWorkspaceAgentActivityStatus } from "./workspaceAgentActivityStatus";
import {
  resolveLatestActivity,
  resolveWorkspaceAgentActivityTitle
} from "./workspaceAgentActivitySummary";
import {
  compareActivities,
  shouldHideEmptyRuntimePlaceholderSession,
  workspaceAgentSessionMessageAliases
} from "./workspaceAgentActivityListOrdering";

export function buildWorkspaceAgentActivityListViewModel(
  snapshot: WorkspaceAgentActivityListSnapshot,
  options: BuildWorkspaceAgentActivityListOptions = {}
): WorkspaceAgentActivityListViewModel {
  const activities = selectRootAgentActivitySessions(snapshot)
    .map((session): WorkspaceAgentActivityCard | null => {
      const presence =
        snapshot.presences.find(
          (candidate) =>
            candidate.provider === session.provider &&
            Boolean(candidate.userId) &&
            candidate.userId === session.userId
        ) ?? null;
      const messages = resolveWorkspaceAgentSessionMessages(
        options.sessionMessagesById,
        session
      );
      const status = resolveWorkspaceAgentActivityStatus(session);
      if (
        shouldHideEmptyRuntimePlaceholderSession(
          session,
          messages,
          status,
          options
        )
      ) {
        return null;
      }
      const user = resolveActivityUser(session, presence, options);
      const agentProvider = resolveProvider(session, presence);
      const agentName = workspaceAgentProviderLabel(agentProvider);
      const resolvedSortTimeUnixMs =
        resolveWorkspaceAgentSessionSortTimeUnixMs(session);
      const latestActivity = resolveLatestActivity(messages, status, {
        agentName,
        userName: user.userName
      });

      const activity: WorkspaceAgentActivityCard = {
        id: `activity-${session.agentSessionId}`,
        sessionId: session.agentSessionId,
        userId: user.userId,
        userName: user.userName,
        ...(user.userAvatarUrl ? { userAvatarUrl: user.userAvatarUrl } : {}),
        agentProvider,
        agentName,
        title: resolveWorkspaceAgentActivityTitle(session),
        status,
        latestActivitySummary: latestActivity.summary,
        latestActivityActorName: latestActivity.actorName,
        changedFiles: changedFilesForSession(messages),
        sortTimeUnixMs: resolvedSortTimeUnixMs,
        readTimeUnixMs: readTimeUnixMs(session, status, resolvedSortTimeUnixMs)
      };

      return activity;
    })
    .filter(
      (activity): activity is WorkspaceAgentActivityCard => activity !== null
    )
    .sort(compareActivities);

  return { activities };
}

export function reuseWorkspaceAgentActivityListViewModelIfUnchanged(
  previous: WorkspaceAgentActivityListViewModel | null,
  next: WorkspaceAgentActivityListViewModel
): WorkspaceAgentActivityListViewModel {
  if (!previous) {
    return next;
  }
  if (next.activities.length === 0) {
    return previous.activities.length === 0 ? previous : next;
  }

  const previousActivitiesById = new Map(
    previous.activities.map((activity) => [activity.id, activity])
  );
  const activities = next.activities.map((activity) => {
    const previousActivity = previousActivitiesById.get(activity.id);
    if (
      !previousActivity ||
      !workspaceAgentActivityCardEquals(previousActivity, activity)
    ) {
      return activity;
    }
    return previousActivity;
  });
  const reusedEveryActivityInPlace =
    previous.activities.length === activities.length &&
    previous.activities.every(
      (activity, index) => activity === activities[index]
    );

  return reusedEveryActivityInPlace ? previous : { activities };
}
export { workspaceAgentProviderLabel } from "./workspaceAgentProviderLabel";

function workspaceAgentActivityCardEquals(
  left: WorkspaceAgentActivityCard,
  right: WorkspaceAgentActivityCard
): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.userId === right.userId &&
    left.userName === right.userName &&
    left.userAvatarUrl === right.userAvatarUrl &&
    left.agentProvider === right.agentProvider &&
    left.agentName === right.agentName &&
    left.title === right.title &&
    left.status === right.status &&
    left.latestActivitySummary === right.latestActivitySummary &&
    left.latestActivityActorName === right.latestActivityActorName &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    JSON.stringify(left.conversationPreview ?? []) ===
      JSON.stringify(right.conversationPreview ?? []) &&
    JSON.stringify(left.toolCalls ?? []) ===
      JSON.stringify(right.toolCalls ?? []) &&
    JSON.stringify(left.changedFiles) === JSON.stringify(right.changedFiles)
  );
}

function resolveWorkspaceAgentSessionMessages(
  sessionMessagesById: Record<string, AgentActivityMessage[]> | undefined,
  session: AgentActivitySession
): AgentActivityMessage[] {
  if (!sessionMessagesById) {
    return [];
  }
  for (const alias of workspaceAgentSessionMessageAliases(session)) {
    const messages = sessionMessagesById[alias];
    if (messages) {
      return messages;
    }
  }
  return [];
}

function resolveActivityUser(
  session: AgentActivitySession,
  presence: AgentActivityPresence | null,
  options: BuildWorkspaceAgentActivityListOptions
): Pick<WorkspaceAgentActivityCard, "userId" | "userName" | "userAvatarUrl"> {
  if (presence) {
    return resolveUserFromId(presence.userId ?? "", options);
  }

  const sessionUserId = session.userId?.trim() ?? "";
  if (sessionUserId) {
    return resolveUserFromId(sessionUserId, options);
  }

  return {
    userId: null,
    userName: "Unknown member"
  };
}

function resolveUserFromId(
  rawUserId: string,
  options: BuildWorkspaceAgentActivityListOptions
): Pick<WorkspaceAgentActivityCard, "userId" | "userName" | "userAvatarUrl"> {
  const userId = rawUserId.trim();
  const profile = options.userProfilesById?.[userId];
  const profileName = compactText(profile?.name ?? "");
  const profileAvatar = profile?.assetUrl?.trim();
  const rawName = profileName || userId || "Unknown member";

  return {
    userId,
    userName: stripTrailingParentheticalEmailFromLabel(rawName) || rawName,
    ...(profileAvatar
      ? {
          userAvatarUrl: buildAssetUrl(profileAvatar, {
            kind: "avatar",
            size: 32,
            format: "webp"
          })
        }
      : {})
  };
}

function resolveProvider(
  session: AgentActivitySession,
  presence: AgentActivityPresence | null
): string {
  const sessionProvider = normalizeProvider(session.provider);
  if (sessionProvider) {
    return sessionProvider;
  }

  const presenceProvider = normalizeProvider(presence?.provider);
  if (presenceProvider) {
    return presenceProvider;
  }

  return "unknown";
}

function normalizeProvider(provider: string | undefined): string | null {
  const trimmed = provider?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function readTimeUnixMs(
  session: AgentActivitySession,
  status: WorkspaceAgentActivityStatus,
  fallbackUnixMs: number
): number {
  if (status === "completed" || status === "failed") {
    return session.endedAtUnixMs ?? session.updatedAtUnixMs ?? fallbackUnixMs;
  }
  return fallbackUnixMs;
}

function stripTrailingParentheticalEmailFromLabel(label: string): string {
  return label
    .trim()
    .replace(/\s*\([^)]*@[^)]+\)\s*$/u, "")
    .trim();
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
