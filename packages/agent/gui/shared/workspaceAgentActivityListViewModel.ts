import { normalizeAgentActivityDisplayStatus } from "@tutti-os/agent-activity-core";
import type { AgentHostUserInfo } from "./contracts/dto";
import { translate } from "../i18n/index";
import { fileChangePathsFromChanges } from "./workspaceAgentFileChangePayload";
import { normalizeAgentTitleText } from "./utils/agentTitleText";
import { workspaceAgentProviderLabel } from "./workspaceAgentProviderLabel";
import type { RoomShareMemberView } from "./roomShare";
import { resolveDisplayableWorkspaceAgentSessionTitle } from "./workspaceAgentSessionTitle";
import type { WorkspaceAgentToolCallDisplay } from "./workspaceAgentToolCallDisplay";
import {
  fallbackSummary,
  type WorkspaceAgentConversationPreviewLine,
  type WorkspaceAgentLatestActivityStatus
} from "./workspaceAgentLatestActivitySummary";
import { isWorkspaceAgentSyntheticControlMessage } from "./workspaceAgentSyntheticMessages";
import {
  isWorkspaceAgentActivityRuntimeSessionOrigin,
  type WorkspaceAgentActivityMessage,
  type WorkspaceAgentActivityPresence,
  type WorkspaceAgentActivitySession,
  type WorkspaceAgentActivitySnapshot
} from "./workspaceAgentActivityTypes";
import { resolveWorkspaceAgentSessionSortTimeUnixMs } from "./workspaceAgentSessionSortTime";

export type WorkspaceAgentActivityStatus = WorkspaceAgentLatestActivityStatus;

export interface WorkspaceAgentChangedFile {
  path: string;
  label: string;
}

export interface WorkspaceAgentActivityCard {
  id: string;
  sessionId: string;
  userId: string | null;
  userName: string;
  userAvatarUrl?: string;
  agentProvider: string;
  agentName: string;
  title: string;
  status: WorkspaceAgentActivityStatus;
  latestActivitySummary: string;
  /** User prompt + latest agent reply for task/issue execution cards; room status list uses single-line summary only. */
  conversationPreview?: WorkspaceAgentConversationPreviewLine[];
  latestActivityActorName?: string;
  toolCalls?: WorkspaceAgentToolCallDisplay[];
  changedFiles: WorkspaceAgentChangedFile[];
  sortTimeUnixMs: number;
  readTimeUnixMs?: number;
}

export interface WorkspaceAgentActivityListViewModel {
  activities: WorkspaceAgentActivityCard[];
}

export interface BuildWorkspaceAgentActivityListOptions {
  sessionMessagesById?: Record<string, WorkspaceAgentActivityMessage[]>;
  userProfilesById?: Record<string, AgentHostUserInfo>;
  fallbackMembers?: RoomShareMemberView[];
}

export interface CollectWorkspaceAgentGeneratedFilesOptions {
  workspaceRoot?: string | null;
  /** When set, only include files from sessions whose cwd matches this path. */
  sessionCwd?: string | null;
}

export function collectWorkspaceAgentGeneratedFiles(
  snapshot: WorkspaceAgentActivitySnapshot,
  options: CollectWorkspaceAgentGeneratedFilesOptions = {}
): WorkspaceAgentChangedFile[] {
  const sessionCwdFilter = normalizeComparablePath(options.sessionCwd ?? "");
  const workspaceRoot =
    sessionCwdFilter ||
    normalizeComparablePath(options.workspaceRoot ?? "") ||
    resolveWorkspaceRootFromSessions(snapshot.sessions);
  const sessions = sessionCwdFilter
    ? snapshot.sessions.filter(
        (session) =>
          normalizeComparablePath(session.cwd ?? "") === sessionCwdFilter
      )
    : snapshot.sessions;
  const filesByPath = new Map<string, WorkspaceAgentChangedFile>();

  for (const session of sessions) {
    const sessionCwd =
      normalizeComparablePath(session.cwd ?? "") || workspaceRoot;
    const normalizePath = createAgentGeneratedFilePathNormalizer({
      sessionCwd,
      workspaceRoot
    });
    const messages = resolveWorkspaceAgentSessionMessages(
      snapshot.sessionMessagesById,
      session
    );
    if (messages.length === 0) {
      continue;
    }
    for (const file of changedFilesForSession(messages, normalizePath, {
      requireSuccessfulFileChangeTool: true
    })) {
      filesByPath.set(file.path, file);
    }
    for (const path of imageGenerationPathsFromMessages(
      messages,
      normalizePath
    )) {
      if (filesByPath.has(path)) {
        continue;
      }
      filesByPath.set(path, {
        path,
        label: path.split("/").filter(Boolean).at(-1) ?? path
      });
    }
  }

  return applyShortestUniqueFileLabels([...filesByPath.values()]);
}

export function buildWorkspaceAgentActivityListViewModel(
  snapshot: WorkspaceAgentActivitySnapshot,
  options: BuildWorkspaceAgentActivityListOptions = {}
): WorkspaceAgentActivityListViewModel {
  const presencesById = new Map(
    snapshot.presences.map((presence) => [presence.id, presence])
  );

  const activities = snapshot.sessions
    .map((session): WorkspaceAgentActivityCard | null => {
      const presence =
        session.presenceId === undefined
          ? null
          : (presencesById.get(session.presenceId) ?? null);
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
      const resolvedSortTimeUnixMs = resolveWorkspaceAgentSessionSortTimeUnixMs(
        session,
        {
          messages
        }
      );
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
        title: resolveWorkspaceAgentActivityTitle(session, messages),
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

function shouldHideEmptyRuntimePlaceholderSession(
  session: WorkspaceAgentActivitySession,
  messages: readonly WorkspaceAgentActivityMessage[],
  status: WorkspaceAgentActivityStatus,
  options: BuildWorkspaceAgentActivityListOptions
): boolean {
  if (!isWorkspaceAgentActivityRuntimeSessionOrigin(session.sessionOrigin)) {
    return false;
  }
  if (messages.length > 0) {
    return false;
  }
  if (!hasLoadedSessionMessageRecord(session, options.sessionMessagesById)) {
    return false;
  }
  if (!isRuntimePlaceholderTerminalStatus(status)) {
    return false;
  }
  return resolveDisplayableWorkspaceAgentSessionTitle(session) === "";
}

function hasLoadedSessionMessageRecord(
  session: WorkspaceAgentActivitySession,
  sessionMessagesById:
    | Record<string, WorkspaceAgentActivityMessage[]>
    | undefined
): boolean {
  if (!sessionMessagesById) {
    return false;
  }
  return workspaceAgentSessionMessageAliases(session).some(
    (alias) => alias in sessionMessagesById
  );
}

function isRuntimePlaceholderTerminalStatus(
  status: WorkspaceAgentActivityStatus
): boolean {
  return status === "idle" || status === "completed" || status === "canceled";
}

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
  sessionMessagesById:
    | Record<string, WorkspaceAgentActivityMessage[]>
    | undefined,
  session: WorkspaceAgentActivitySession
): WorkspaceAgentActivityMessage[] {
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
  session: WorkspaceAgentActivitySession,
  presence: WorkspaceAgentActivityPresence | null,
  options: BuildWorkspaceAgentActivityListOptions
): Pick<WorkspaceAgentActivityCard, "userId" | "userName" | "userAvatarUrl"> {
  if (presence) {
    return resolveUserFromId(presence.userId ?? "", options);
  }

  const sessionUserId = session.userId?.trim() ?? "";
  if (sessionUserId) {
    return resolveUserFromId(sessionUserId, options);
  }

  const fallbackMember = selectFallbackMember(options.fallbackMembers ?? []);
  if (fallbackMember) {
    return {
      userId: fallbackMember.userId,
      userName: fallbackMember.label || "Unknown member",
      ...(fallbackMember.avatarUrl
        ? { userAvatarUrl: fallbackMember.avatarUrl }
        : {})
    };
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
  const profileAvatar = profile?.avatar?.trim();
  const rawName = profileName || userId || "Unknown member";

  return {
    userId,
    userName: stripTrailingParentheticalEmailFromLabel(rawName) || rawName,
    ...(profileAvatar ? { userAvatarUrl: profileAvatar } : {})
  };
}

function selectFallbackMember(
  members: RoomShareMemberView[]
): RoomShareMemberView | null {
  return (
    members.find((member) => member.role === "owner") ?? members[0] ?? null
  );
}

function resolveProvider(
  session: WorkspaceAgentActivitySession,
  presence: WorkspaceAgentActivityPresence | null
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

export function resolveWorkspaceAgentActivityStatus(
  session: WorkspaceAgentActivitySession
): WorkspaceAgentActivityStatus {
  const normalized = normalizeAgentActivityDisplayStatus(session.status, {
    currentPhase: session.currentPhase,
    turnLifecycleOutcome: session.turnLifecycle?.outcome,
    turnLifecyclePhase: session.turnLifecycle?.phase ?? session.turnPhase
  });
  switch (normalized) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "completed":
      return "completed";
    case "waiting":
      return "waiting";
    case "working":
      return "working";
    default:
      return "idle";
  }
}

export function resolveWorkspaceAgentActivityTitle(
  session: WorkspaceAgentActivitySession,
  messages: readonly WorkspaceAgentActivityMessage[] = []
): string {
  const sessionTitle = resolveDisplayableWorkspaceAgentSessionTitle(session);
  const userMessageTitle = firstUserMessageText(messages);
  if (
    sessionTitle &&
    !isProviderPlaceholderTitleForSession(sessionTitle, session)
  ) {
    return sessionTitle;
  }
  return userMessageTitle || sessionTitle || workspaceAgentUntitledTaskLabel();
}

function isProviderPlaceholderTitleForSession(
  title: string,
  session: WorkspaceAgentActivitySession
): boolean {
  const provider = normalizeProvider(session.provider);
  if (!provider) {
    return false;
  }
  const normalizedTitle = title.trim().toLowerCase();
  return (
    workspaceAgentProviderLabel(provider).toLowerCase() === normalizedTitle
  );
}

function resolveLatestActivity(
  messages: readonly WorkspaceAgentActivityMessage[],
  status: WorkspaceAgentActivityStatus,
  actors: { agentName: string; userName: string }
): { actorName: string; summary: string } {
  const latestMessage = latestDisplayableMessage(messages);
  if (latestMessage) {
    return {
      actorName:
        messageRole(latestMessage.message) === "user"
          ? actors.userName
          : actors.agentName,
      summary: latestMessage.text
    };
  }
  return {
    actorName: actors.agentName,
    summary: fallbackSummary(status)
  };
}

type ChangedFilePathNormalizer = (value: unknown) => string | null;

interface ChangedFileCollectionOptions {
  requireSuccessfulFileChangeTool?: boolean;
}

function changedFilesForSession(
  messages: readonly WorkspaceAgentActivityMessage[],
  normalizePath: ChangedFilePathNormalizer = defaultChangedFilePathNormalizer,
  options: ChangedFileCollectionOptions = {}
): WorkspaceAgentChangedFile[] {
  const changedFilesByPath = new Map<string, WorkspaceAgentChangedFile>();
  const appendPath = (path: string | null): void => {
    if (!path || changedFilesByPath.has(path)) {
      return;
    }
    changedFilesByPath.set(path, {
      path,
      label: path
    });
  };

  for (const message of messages) {
    for (const path of changedFilePathsFromMessage(
      message,
      normalizePath,
      options
    )) {
      appendPath(path);
    }
  }

  return applyShortestUniqueFileLabels(Array.from(changedFilesByPath.values()));
}

function changedFilePathsFromMessage(
  message: WorkspaceAgentActivityMessage,
  normalizePath: ChangedFilePathNormalizer = defaultChangedFilePathNormalizer,
  options: ChangedFileCollectionOptions = {}
): string[] {
  const isSuccessfulFileChangeTool = isSuccessfulFileChangeToolMessage(message);
  if (options.requireSuccessfulFileChangeTool && !isSuccessfulFileChangeTool) {
    return [];
  }
  const payload = objectValue(message.payload);
  const explicitFileChanges = fileChangePaths(
    arrayValue(objectValue(payload?.fileChanges)?.files),
    normalizePath
  );
  if (explicitFileChanges.length > 0) {
    return explicitFileChanges;
  }
  if (!isSuccessfulFileChangeTool) {
    return [];
  }

  const toolState = objectValue(payload?.tool_state);
  const input =
    objectValue(payload?.input) ?? objectValue(toolState?.input) ?? null;
  const output = objectValue(payload?.output);
  const paths = dedupeStrings([
    ...pathsValue(payload?.paths, normalizePath),
    ...pathsValue(output?.paths, normalizePath),
    ...pathsValue(input?.paths, normalizePath),
    ...changeMapPaths(payload?.changes, normalizePath),
    ...changeMapPaths(output?.changes, normalizePath),
    ...changeMapPaths(input?.changes, normalizePath),
    ...contentDiffPaths(payload?.content, normalizePath),
    ...contentDiffPaths(output?.content, normalizePath),
    ...contentDiffPaths(input?.content, normalizePath),
    stringValue(payload?.path),
    stringValue(payload?.filePath),
    stringValue(payload?.file_path),
    stringValue(input?.path),
    stringValue(input?.filePath),
    stringValue(input?.file_path),
    stringValue(output?.path),
    stringValue(output?.filePath),
    stringValue(output?.file_path)
  ]);
  return paths
    .map((path) => normalizePath(path))
    .filter((path): path is string => path !== null);
}

function defaultChangedFilePathNormalizer(value: unknown): string | null {
  return normalizedChangedFilePath(value);
}

function resolveWorkspaceRootFromSessions(
  sessions: readonly WorkspaceAgentActivitySession[]
): string {
  for (const session of sessions) {
    const cwd = normalizeComparablePath(session.cwd ?? "");
    if (cwd) {
      return cwd;
    }
  }
  return "";
}

function normalizeComparablePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function createAgentGeneratedFilePathNormalizer(input: {
  sessionCwd?: string | null;
  workspaceRoot?: string | null;
}): ChangedFilePathNormalizer {
  const workspaceRoot = input.workspaceRoot?.trim().replace(/\/+$/, "") ?? "";
  const sessionCwd =
    input.sessionCwd?.trim().replace(/\/+$/, "") || workspaceRoot;
  return (value: unknown) => {
    if (typeof value !== "string") {
      return null;
    }
    return resolveAgentGeneratedFilePath(value, workspaceRoot, sessionCwd);
  };
}

function resolveAgentGeneratedFilePath(
  rawPath: string,
  workspaceRoot: string,
  sessionCwd: string
): string | null {
  const path = rawPath.trim();
  if (!path || isStructuredPayloadPath(path)) {
    return null;
  }
  if (path.startsWith("/workspace/")) {
    return path;
  }
  if (isAgentStateGeneratedImagePath(path)) {
    return path;
  }
  if (isAbsoluteAgentGeneratedFilePath(path)) {
    if (
      workspaceRoot &&
      !isPathInsideOrEqual(path, workspaceRoot) &&
      !isAgentStateGeneratedImagePath(path)
    ) {
      return null;
    }
    return path.replace(/\\/g, "/");
  }

  const base = sessionCwd || workspaceRoot;
  if (!base) {
    return null;
  }
  const resolved = joinAgentGeneratedFilePath(base, path.replace(/^\.?\//, ""));
  if (
    workspaceRoot &&
    !isPathInsideOrEqual(resolved, workspaceRoot) &&
    !isAgentStateGeneratedImagePath(resolved)
  ) {
    return null;
  }
  return resolved;
}

function isAbsoluteAgentGeneratedFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot) {
    return false;
  }
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function joinAgentGeneratedFilePath(
  base: string,
  relativePath: string
): string {
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  return `${normalizedBase}/${normalizedRelative}`;
}

function imageGenerationPathsFromMessages(
  messages: readonly WorkspaceAgentActivityMessage[],
  normalizePath: ChangedFilePathNormalizer
): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    const payload = objectValue(message.payload);
    if (!payload) {
      continue;
    }
    const output = objectValue(payload.output);
    for (const uri of [
      ...imageGenerationUris(payload.content),
      ...imageGenerationUris(output?.content)
    ]) {
      const normalized = normalizePath(uri);
      if (normalized) {
        paths.push(normalized);
      }
    }
  }
  return dedupeStrings(paths);
}

function imageGenerationUris(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const uris: string[] = [];
  for (const item of value) {
    const record = objectValue(item);
    if (!record) {
      continue;
    }
    const type = stringValue(record.type)?.toLowerCase();
    const uri = stringValue(record.uri) ?? stringValue(record.path);
    if (!uri) {
      continue;
    }
    if (
      type === "image" ||
      uri.toLowerCase().includes("generated_images") ||
      /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(uri)
    ) {
      uris.push(uri);
    }
  }
  return uris;
}

function isAgentStateGeneratedImagePath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const stateRootIndex = segments.findIndex(
    (segment) => segment === ".tutti" || segment === ".tutti-dev"
  );
  if (stateRootIndex < 0) {
    return false;
  }
  const statePath = segments.slice(stateRootIndex);
  return (
    statePath[1] === "agent" &&
    statePath[2] === "runs" &&
    statePath.includes("generated_images")
  );
}

function normalizedChangedFilePath(
  value: unknown,
  options: { allowRelative?: boolean } = {}
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const path = value.trim();
  if (!path || isStructuredPayloadPath(path)) {
    return null;
  }
  if (!options.allowRelative && !path.startsWith("/workspace/")) {
    return null;
  }
  return path;
}

function applyShortestUniqueFileLabels(
  files: WorkspaceAgentChangedFile[]
): WorkspaceAgentChangedFile[] {
  const suffixByPath = shortestUniquePathSuffixByPath(
    files.map((file) => file.path)
  );
  return files.map((file) => ({
    ...file,
    label: suffixByPath.get(file.path) ?? file.label
  }));
}

function shortestUniquePathSuffixByPath(paths: string[]): Map<string, string> {
  const partsByPath = new Map(
    paths.map((path) => [path, splitPathSegments(path)])
  );
  const labels = new Map<string, string>();
  const unresolved = new Set(paths);

  for (let depth = 1; unresolved.size > 0; depth += 1) {
    const grouped = new Map<string, string[]>();

    for (const path of unresolved) {
      const parts = partsByPath.get(path) ?? [];
      const suffix = parts.slice(-Math.min(depth, parts.length)).join("/");
      const fallback = parts.at(-1) ?? path;
      const label = suffix || fallback;
      const group = grouped.get(label);
      if (group) {
        group.push(path);
      } else {
        grouped.set(label, [path]);
      }
    }

    let resolvedCount = 0;
    for (const [label, group] of grouped) {
      if (group.length !== 1) {
        continue;
      }
      const path = group[0];
      if (!path) {
        continue;
      }
      labels.set(path, label);
      unresolved.delete(path);
      resolvedCount += 1;
    }

    if (resolvedCount === 0) {
      for (const path of unresolved) {
        labels.set(path, path);
      }
      break;
    }
  }

  return labels;
}

function splitPathSegments(path: string): string[] {
  return path.trim().split(/[\\/]/).filter(Boolean);
}

function isSuccessfulFileChangeToolMessage(
  message: WorkspaceAgentActivityMessage
): boolean {
  if (normalizeToken(message.kind) !== "tool_call") {
    return false;
  }
  if (!isSuccessfulFileChangeStatus(message.status ?? undefined)) {
    return false;
  }
  const payload = objectValue(message.payload);
  if (!isSuccessfulFileChangePayloadStatus(payload)) {
    return false;
  }
  return hasFileChangeSignal(payload);
}

function isSuccessfulFileChangePayloadStatus(
  payload: Record<string, unknown> | null
): boolean {
  if (!payload) {
    return true;
  }
  if (!isSuccessfulFileChangeRecordStatus(payload)) {
    return false;
  }
  const output = objectValue(payload.output);
  if (output && !isSuccessfulFileChangeRecordStatus(output)) {
    return false;
  }
  return true;
}

function isSuccessfulFileChangeRecordStatus(
  record: Record<string, unknown>
): boolean {
  const status = stringValue(record.status);
  if (status && !isSuccessfulFileChangeStatus(status)) {
    return false;
  }
  const success = booleanValue(record.success);
  if (success === false) {
    return false;
  }
  return true;
}

function isSuccessfulFileChangeStatus(value: string | undefined): boolean {
  const normalizedStatus = normalizeToken(value);
  return (
    !normalizedStatus ||
    normalizedStatus === "completed" ||
    normalizedStatus === "success" ||
    normalizedStatus === "succeeded" ||
    normalizedStatus === "ok"
  );
}

function hasFileChangeSignal(payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return false;
  }
  const toolState = objectValue(payload.tool_state);
  return [
    payload,
    objectValue(payload.input),
    objectValue(payload.output),
    objectValue(toolState?.input)
  ].some((record) => record !== null && recordHasFileChangeToolSignal(record));
}

function recordHasFileChangeToolSignal(
  record: Record<string, unknown>
): boolean {
  const activityKind = stringValue(record.activityKind);
  if (
    activityKind &&
    isFileChangeNormalizedToolName(normalizeToolName(activityKind))
  ) {
    return true;
  }
  if (stringValue(record.fileChangeKind)) {
    return true;
  }
  const toolCall = objectValue(record.toolCall);
  const toolCallKind = normalizeToken(stringValue(toolCall?.kind) ?? undefined);
  if (
    toolCallKind === "write" ||
    toolCallKind === "edit" ||
    toolCallKind === "delete"
  ) {
    return true;
  }
  const toolName = normalizeToolName(
    stringValue(record.toolName) ??
      stringValue(record.title) ??
      stringValue(record.name) ??
      ""
  );
  return isFileChangeNormalizedToolName(toolName);
}

function isFileChangeNormalizedToolName(normalizedToolName: string): boolean {
  if (!normalizedToolName) {
    return false;
  }
  const exactMatches = new Set([
    "write",
    "writefile",
    "create",
    "createfile",
    "delete",
    "deletefile",
    "edit",
    "editfile",
    "multiedit",
    "applypatch",
    "move",
    "notebookedit"
  ]);
  if (exactMatches.has(normalizedToolName)) {
    return true;
  }
  for (const prefix of exactMatches) {
    if (normalizedToolName.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function fileChangePaths(
  files: readonly unknown[] | null,
  normalizePath: ChangedFilePathNormalizer = defaultChangedFilePathNormalizer
): string[] {
  if (!files) {
    return [];
  }
  return files
    .map((file) => normalizePath(objectValue(file)?.path))
    .filter((path): path is string => path !== null);
}

function changeMapPaths(
  value: unknown,
  normalizePath: ChangedFilePathNormalizer = defaultChangedFilePathNormalizer
): string[] {
  return fileChangePathsFromChanges(value)
    .map((path) => normalizePath(path))
    .filter((path): path is string => path !== null);
}

function contentDiffPaths(
  value: unknown,
  normalizePath: ChangedFilePathNormalizer = defaultChangedFilePathNormalizer
): string[] {
  const content = arrayValue(value);
  if (!content) {
    return [];
  }
  return content
    .map((entry) => {
      const record = objectValue(entry);
      if (!record || stringValue(record.type) !== "diff") {
        return null;
      }
      return normalizePath(record.path);
    })
    .filter((path): path is string => path !== null);
}

function pathsValue(
  value: unknown,
  normalizePath: ChangedFilePathNormalizer = defaultChangedFilePathNormalizer
): string[] {
  const paths = arrayValue(value);
  if (!paths) {
    return [];
  }
  return paths
    .map((path) => normalizePath(path))
    .filter((path): path is string => path !== null);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function dedupeStrings(values: Array<string | null>): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0
      )
    )
  ];
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("_", "")
    .replaceAll("-", "")
    .replaceAll(" ", "");
}

function isStructuredPayloadPath(path: string): boolean {
  if (/[\r\n]/.test(path)) {
    return true;
  }
  if (!path.startsWith("{") && !path.startsWith("[")) {
    return false;
  }
  try {
    JSON.parse(path);
    return true;
  } catch {
    return false;
  }
}

function readTimeUnixMs(
  session: WorkspaceAgentActivitySession,
  status: WorkspaceAgentActivityStatus,
  fallbackUnixMs: number
): number {
  if (status === "completed" || status === "failed") {
    return session.endedAtUnixMs ?? session.updatedAtUnixMs ?? fallbackUnixMs;
  }
  return fallbackUnixMs;
}

function firstUserMessageText(
  messages: readonly WorkspaceAgentActivityMessage[]
): string {
  const firstUserMessage = messages
    .map((message) => ({
      message,
      text: messageDisplayText(message),
      time: messageTime(message)
    }))
    .filter(
      (item) => messageRole(item.message) === "user" && item.text.length > 0
    )
    .sort((left, right) => {
      const timeDiff = (left.time ?? 0) - (right.time ?? 0);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return (
        (left.message.id ?? 0) - (right.message.id ?? 0) ||
        left.message.messageId.localeCompare(right.message.messageId)
      );
    })[0];

  return firstUserMessage?.text ?? "";
}

function latestDisplayableMessage(
  messages: readonly WorkspaceAgentActivityMessage[]
): {
  message: WorkspaceAgentActivityMessage;
  text: string;
  time?: number;
} | null {
  return (
    messages
      .map((message) => ({
        message,
        text: messageDisplayText(message),
        time: messageTime(message)
      }))
      .filter(
        (item) =>
          item.text.length > 0 &&
          normalizeToken(item.message.kind) !== "tool_call"
      )
      .sort((left, right) => {
        const timeDiff = (right.time ?? 0) - (left.time ?? 0);
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return (
          (right.message.id ?? 0) - (left.message.id ?? 0) ||
          right.message.messageId.localeCompare(left.message.messageId)
        );
      })[0] ?? null
  );
}

function messageDisplayText(message: WorkspaceAgentActivityMessage): string {
  const payload = message.payload ?? {};
  const text = normalizeAgentTitleText(
    compactText(
      stringValue(payload.displayPrompt) ||
        stringValue(payload.text) ||
        stringValue(payload.content) ||
        stringValue(payload.message) ||
        stringValue(payload.body) ||
        stringValue(payload.title) ||
        ""
    )
  );
  return isWorkspaceAgentSyntheticControlMessage(text) ? "" : text;
}

function messageRole(message: WorkspaceAgentActivityMessage): string {
  return normalizeToken(message.role);
}

function messageTime(
  message: WorkspaceAgentActivityMessage
): number | undefined {
  return (
    message.occurredAtUnixMs ??
    message.completedAtUnixMs ??
    message.startedAtUnixMs
  );
}

function normalizeToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function compareActivities(
  left: WorkspaceAgentActivityCard,
  right: WorkspaceAgentActivityCard
): number {
  const timeDiff = right.sortTimeUnixMs - left.sortTimeUnixMs;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function workspaceAgentUntitledTaskLabel(): string {
  return normalizeAgentTitleText(
    translate("agentHost.workspaceAgentsUntitledTask")
  );
}

function workspaceAgentSessionMessageAliases(
  session: WorkspaceAgentActivitySession
): string[] {
  const values = [
    session.syncState?.agentSessionId,
    session.agentSessionId,
    session.providerSessionId
  ];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    const normalized = value?.trim() ?? "";
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}

/** Remove trailing ` (user@host...)` that some APIs pack into names. */
function stripTrailingParentheticalEmailFromLabel(label: string): string {
  return label
    .trim()
    .replace(/\s*\([^)]*@[^)]+\)\s*$/u, "")
    .trim();
}
