import { fileChangePathsFromChanges } from "./workspaceAgentFileChangePayload";
import type {
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type {
  CollectWorkspaceAgentGeneratedFilesOptions,
  WorkspaceAgentChangedFile
} from "./workspaceAgentActivityListTypes";
import { workspaceAgentSessionMessageAliases } from "./workspaceAgentActivityListOrdering";

export interface WorkspaceAgentGeneratedFilesSource {
  sessionMessagesById: Readonly<Record<string, AgentActivityMessage[]>>;
  sessions: readonly AgentActivitySession[];
}

export function collectWorkspaceAgentGeneratedFiles(
  source: WorkspaceAgentGeneratedFilesSource,
  options: CollectWorkspaceAgentGeneratedFilesOptions = {}
): WorkspaceAgentChangedFile[] {
  const sessionCwdFilter = normalizeComparablePath(options.sessionCwd ?? "");
  const workspaceRoot =
    sessionCwdFilter ||
    normalizeComparablePath(options.workspaceRoot ?? "") ||
    resolveWorkspaceRootFromSessions(source.sessions);
  const sessions = sessionCwdFilter
    ? source.sessions.filter(
        (session) =>
          normalizeComparablePath(session.cwd ?? "") === sessionCwdFilter
      )
    : source.sessions;
  const filesByPath = new Map<string, WorkspaceAgentChangedFile>();

  for (const session of sessions) {
    const sessionCwd =
      normalizeComparablePath(session.cwd ?? "") || workspaceRoot;
    const normalizePath = createAgentGeneratedFilePathNormalizer({
      sessionCwd,
      workspaceRoot
    });
    const messages = resolveWorkspaceAgentSessionMessages(
      source.sessionMessagesById,
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

type ChangedFilePathNormalizer = (value: unknown) => string | null;

interface ChangedFileCollectionOptions {
  requireSuccessfulFileChangeTool?: boolean;
}

export function changedFilesForSession(
  messages: readonly AgentActivityMessage[],
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
  message: AgentActivityMessage,
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
  sessions: readonly AgentActivitySession[]
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
  messages: readonly AgentActivityMessage[],
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
  message: AgentActivityMessage
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

function normalizeToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
