import { extractAgentMcpToolTarget } from "../agentMcpToolTarget";
import { fileChangePathsFromChanges } from "../workspaceAgentFileChangePayload";

export interface PromptToolDetail {
  kind: "command" | "directory" | "files" | "mcp" | "path" | "query" | "reason";
  value: string;
  meta?: string;
}

export function getPromptToolDetails(
  input: Record<string, unknown> | null
): PromptToolDetail[] {
  if (!input) {
    return [];
  }
  const mcpTarget = extractAgentMcpToolTarget({ input });
  const mcpDetails: PromptToolDetail[] = mcpTarget
    ? [
        {
          kind: "mcp",
          value: mcpTarget.displayName,
          ...(mcpTarget.instruction ? { meta: mcpTarget.instruction } : {})
        }
      ]
    : [];
  const detailInput = resolveToolDetailInput(input);
  const details: PromptToolDetail[] = [...mcpDetails];
  const fileChanges = fileChangePaths(detailInput);
  const fileChangePresentation = presentFileChangePaths(fileChanges);
  if (fileChanges.length > 0) {
    details.push({
      kind: "files",
      value: fileChangePresentation.value
    });
    if (fileChangePresentation.directory) {
      details.push({
        kind: "directory",
        value: fileChangePresentation.directory
      });
    }
  }
  const command =
    commandStringValue(detailInput.command) ??
    commandStringValue(detailInput.cmd);
  if (command) {
    details.push({
      kind: "command",
      value: command,
      ...(stringValue(detailInput.description)
        ? { meta: stringValue(detailInput.description) as string }
        : {})
    });
  }
  const filePath =
    stringValue(detailInput.grantRoot) ??
    stringValue(detailInput.file_path) ??
    stringValue(detailInput.filePath) ??
    stringValue(detailInput.path) ??
    stringValue(detailInput.notebook_path);
  if (filePath && !isRedundantFileChangePath(filePath, fileChanges)) {
    const lineRange = formatLineRange(detailInput);
    details.push({
      kind: "path",
      value: filePath,
      ...(lineRange ? { meta: lineRange } : {})
    });
  }
  const query =
    stringValue(detailInput.query) ??
    stringValue(detailInput.search_query) ??
    stringValue(detailInput.searchQuery) ??
    stringValue(detailInput.pattern);
  if (query) {
    details.push({
      kind: "query",
      value: query
    });
  }
  const reason = stringValue(detailInput.reason);
  if (reason) {
    details.push({
      kind: "reason",
      value: reason
    });
  }
  return details;
}

export function isPromptRequestIdTitle(value: string): boolean {
  return /^requestid\s*:/iu.test(value.trim());
}

function resolveToolDetailInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  if (fileChangePaths(input).length > 0) {
    return input;
  }
  const toolCall = objectValue(input.toolCall);
  return (
    firstObjectValue(input, [
      "command",
      "cmd",
      "reason",
      "grantRoot",
      "file_path",
      "filePath",
      "path",
      "notebook_path",
      "query",
      "search_query",
      "searchQuery",
      "pattern"
    ]) ??
    firstObjectValue(toolCall, [
      "input",
      "rawInput",
      "raw_input",
      "arguments",
      "args"
    ]) ??
    toolCall ??
    input
  );
}

function firstObjectValue(
  input: Record<string, unknown> | null,
  keys: readonly string[]
): Record<string, unknown> | null {
  if (!input) {
    return null;
  }
  if (keys.some((key) => stringValue(input[key]))) {
    return input;
  }
  for (const key of keys) {
    const value = objectValue(input[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function formatLineRange(input: Record<string, unknown>): string | null {
  const start = numericValue(input.startLine) ?? numericValue(input.start_line);
  const end = numericValue(input.endLine) ?? numericValue(input.end_line);
  if (start === null || end === null) {
    return null;
  }
  return start === end ? `L${start}` : `L${start}-${end}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function commandStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return stringValue(value);
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const shellFlag = stringValue(value[value.length - 2]);
  const shellCommand = stringValue(value[value.length - 1]);
  if ((shellFlag === "-c" || shellFlag === "-lc") && shellCommand) {
    return shellCommand;
  }
  const parts = value.flatMap((part) => {
    const text = stringValue(part);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join(" ") : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fileChangePaths(input: Record<string, unknown>): string[] {
  const candidates = [
    objectValue(input.fileChanges)?.files,
    input.fileChanges,
    input.files,
    input.changes
  ];
  for (const candidate of candidates) {
    const paths = fileChangePathsFromChanges(candidate);
    if (paths.length > 0) {
      return paths;
    }
  }
  return [];
}

function presentFileChangePaths(paths: readonly string[]): {
  directory: string | null;
  value: string;
} {
  const uniquePaths = Array.from(
    new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))
  );
  const directory = commonAbsoluteFileDirectory(uniquePaths);
  const displayPaths = directory
    ? uniquePaths.map((path) => relativePathFromDirectory(path, directory))
    : uniquePaths;
  if (displayPaths.length <= 3) {
    return { directory, value: displayPaths.join(", ") };
  }
  return {
    directory,
    value: `${displayPaths.slice(0, 3).join(", ")} +${displayPaths.length - 3} more`
  };
}

function commonAbsoluteFileDirectory(paths: readonly string[]): string | null {
  if (paths.length === 0) {
    return null;
  }
  const normalized = paths.map(normalizeDisplayPath);
  if (!normalized.every(isAbsoluteDisplayPath)) {
    return null;
  }
  const directories = normalized.map((path) =>
    path.slice(0, path.lastIndexOf("/"))
  );
  const firstParts = directories[0]?.split("/") ?? [];
  let sharedLength = firstParts.length;
  for (const directory of directories.slice(1)) {
    const parts = directory.split("/");
    sharedLength = Math.min(sharedLength, parts.length);
    while (
      sharedLength > 0 &&
      firstParts[sharedLength - 1] !== parts[sharedLength - 1]
    ) {
      sharedLength -= 1;
    }
  }
  const shared = firstParts.slice(0, sharedLength).join("/");
  return shared && shared !== "/" && !/^[A-Za-z]:$/u.test(shared)
    ? shared
    : null;
}

function relativePathFromDirectory(path: string, directory: string): string {
  const normalized = normalizeDisplayPath(path);
  const prefix = `${directory}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : path;
}

function isRedundantFileChangePath(
  path: string,
  fileChanges: readonly string[]
): boolean {
  const normalizedPath = normalizeDisplayPath(path);
  return fileChanges.some(
    (candidate) => normalizeDisplayPath(candidate) === normalizedPath
  );
}

function normalizeDisplayPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
}

function isAbsoluteDisplayPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//u.test(path);
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
