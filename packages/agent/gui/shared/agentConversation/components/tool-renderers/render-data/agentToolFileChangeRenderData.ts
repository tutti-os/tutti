import type { AgentToolCallVM } from "../../../contracts/agentToolCallVM";
import {
  extractAgentPatchPath,
  inferAgentPatchChangeType
} from "../../../rules/agentPatchMetadata";
import {
  agentFileChangeStats,
  isAgentUnifiedDiff
} from "../file-diff/agentUnifiedDiff";
import {
  fileChangeEntriesFromChanges,
  fileChangeTypeValue
} from "../../../../workspaceAgentFileChangePayload";

export interface AgentFileChangeRenderData {
  path: string;
  changeType: "created" | "modified" | "deleted" | "unknown";
  language: string | null;
  content: string | null;
  oldString: string | null;
  newString: string | null;
  unifiedDiff: string | null;
  added: number;
  removed: number;
}

export function getFileChangeRenderData(
  call: AgentToolCallVM
): AgentFileChangeRenderData[] {
  const payloadInput = recordValue(call.payload?.input);
  const payloadOutput = recordValue(call.payload?.output);
  const inputLocations =
    arrayValue(call.locations) ??
    arrayValue(call.input?.locations) ??
    arrayValue(payloadInput?.locations);
  const fromStructuredPatch = structuredPatchFiles(
    call.output?.structuredPatch ??
      payloadOutput?.structuredPatch ??
      call.payload?.structuredPatch ??
      call.output?.files ??
      payloadOutput?.files
  );
  if (fromStructuredPatch.length > 0) {
    return fromStructuredPatch;
  }

  const fromDetailedContent = detailedDiffFiles(
    call.output?.detailedContent ??
      payloadOutput?.detailedContent ??
      call.payload?.detailedContent
  );
  if (fromDetailedContent.length > 0) {
    return fromDetailedContent;
  }

  const fromFileChanges = fileChangesFiles(
    call.input?.fileChanges ??
      call.payload?.fileChanges ??
      payloadOutput?.fileChanges
  );
  if (fromFileChanges.length > 0) {
    return fromFileChanges;
  }

  const fromChangeMap = changeMapFiles(
    call.output?.changes ??
      payloadOutput?.changes ??
      call.input?.changes ??
      payloadInput?.changes
  );
  if (fromChangeMap.length > 0) {
    return fromChangeMap;
  }

  const inputPath = firstString(
    stringValue(call.input?.file_path),
    stringValue(call.input?.filePath),
    stringValue(call.input?.path),
    stringValue(payloadInput?.file_path),
    stringValue(payloadInput?.filePath),
    stringValue(payloadInput?.path),
    firstLocationPath(inputLocations)
  );
  const diffValues = [
    call.output?.patch,
    payloadOutput?.patch,
    call.output?.diff,
    payloadOutput?.diff
  ];
  const rawDiff = firstRawString(...diffValues);
  const path = firstString(
    inputPath,
    rawDiff ? extractAgentPatchPath(rawDiff) : null
  );
  if (!path) {
    return [];
  }

  const content = firstFileString(call.input?.content, payloadInput?.content);
  const oldString = firstFileString(
    call.input?.old_string,
    call.input?.oldString,
    payloadInput?.old_string,
    payloadInput?.oldString,
    call.output?.oldString,
    payloadOutput?.oldString
  );
  const newString = firstFileString(
    call.input?.new_string,
    call.input?.newString,
    payloadInput?.new_string,
    payloadInput?.newString,
    call.output?.newString,
    payloadOutput?.newString
  );
  const rendered = normalizeFileChangeRenderData({
    path,
    toolName: call.toolName,
    allowSyntheticDiff: true,
    diffValues,
    content,
    oldString,
    newString
  });
  return rendered ? [rendered] : [];
}

function structuredPatchFiles(value: unknown): AgentFileChangeRenderData[] {
  const patches = arrayValue(value);
  if (!patches) {
    return [];
  }
  return patches.flatMap((item) => {
    const patch = recordValue(item);
    const path = firstString(
      stringValue(patch?.filePath),
      stringValue(patch?.path)
    );
    if (!path) {
      return [];
    }
    const rendered = normalizeFileChangeRenderData({
      path,
      explicitChangeType: normalizeChangeType(fileChangeTypeValue(patch ?? {})),
      allowSyntheticDiff: false,
      diffValues: [patch?.diff, patch?.patch],
      content: firstFileString(patch?.content),
      oldString: firstFileString(patch?.oldString, patch?.old_string),
      newString: firstFileString(patch?.newString, patch?.new_string)
    });
    return rendered ? [rendered] : [];
  });
}

function detailedDiffFiles(value: unknown): AgentFileChangeRenderData[] {
  const diff = firstRawString(value);
  if (diff === null) {
    return [];
  }
  const path = diffPath(diff);
  if (!path) {
    return [];
  }
  const rendered = normalizeFileChangeRenderData({
    path,
    diffValues: [diff],
    content: null,
    oldString: null,
    newString: null
  });
  return rendered ? [rendered] : [];
}

function fileChangesFiles(value: unknown): AgentFileChangeRenderData[] {
  const record = recordValue(value);
  const files = arrayValue(record?.files);
  if (!files) {
    return [];
  }
  return files.flatMap((item) => {
    const file = recordValue(item);
    const path = stringValue(file?.path);
    if (!file || !path) {
      return [];
    }
    const rendered = normalizeFileChangeRenderData({
      path,
      explicitChangeType: normalizeChangeType(fileChangeTypeValue(file)),
      diffValues: [
        file?.diff,
        file?.patch,
        file?.unifiedDiff,
        file?.unified_diff
      ],
      content: firstFileString(file?.content),
      oldString: firstFileString(file?.oldString, file?.old_string),
      newString: firstFileString(file?.newString, file?.new_string)
    });
    return rendered ? [rendered] : [];
  });
}

function normalizeFileChangeRenderData({
  path,
  toolName = null,
  explicitChangeType = "unknown",
  allowSyntheticDiff = false,
  diffValues,
  content: initialContent,
  oldString: initialOldString,
  newString: initialNewString
}: {
  path: string;
  toolName?: string | null;
  explicitChangeType?: AgentFileChangeRenderData["changeType"];
  allowSyntheticDiff?: boolean;
  diffValues: unknown[];
  content: string | null;
  oldString: string | null;
  newString: string | null;
}): AgentFileChangeRenderData | null {
  const rawDiff = firstRawString(...diffValues);
  const unifiedDiff = firstValidUnifiedDiff(...diffValues);
  let content = initialContent;
  let oldString = initialOldString;
  let newString = initialNewString;
  let changeType = firstKnownChangeType(
    explicitChangeType,
    inferFileChangeType(toolName, unifiedDiff, content, oldString, newString)
  );

  if (unifiedDiff === null && rawDiff !== null) {
    switch (changeType) {
      case "created":
        if (newString === null && content === null) {
          newString = fileTextValue(rawDiff);
        }
        content ??= newString;
        break;
      case "deleted":
        if (oldString === null && content === null) {
          oldString = fileTextValue(rawDiff);
        }
        if (oldString !== null && newString === null) {
          newString = "";
        }
        content = null;
        break;
      default:
        if (oldString === null && newString === null && content === null) {
          content = fileTextValue(rawDiff);
        }
        break;
    }
    if (changeType === "unknown" && content !== null) {
      changeType = "modified";
    }
  }
  if (changeType === "created" && content === null && newString !== null) {
    content = newString;
  }

  const normalizedUnifiedDiff =
    allowSyntheticDiff &&
    unifiedDiff === null &&
    oldString !== null &&
    newString !== null
      ? syntheticUnifiedDiff(path, changeType, oldString, newString)
      : unifiedDiff;
  if (
    normalizedUnifiedDiff === null &&
    content === null &&
    oldString === null &&
    newString === null &&
    changeType === "unknown"
  ) {
    return null;
  }
  const stats = fileChangeStats(
    changeType,
    normalizedUnifiedDiff,
    content,
    oldString,
    newString
  );
  return {
    path,
    changeType,
    language: languageForPath(path),
    content,
    oldString,
    newString,
    unifiedDiff: normalizedUnifiedDiff,
    added: stats.added,
    removed: stats.removed
  };
}

function changeMapFiles(value: unknown): AgentFileChangeRenderData[] {
  return fileChangeEntriesFromChanges(value).flatMap((entry) => {
    const change = entry.change;
    const normalizedPath = entry.path.trim();
    if (!normalizedPath) {
      return [];
    }
    const normalizedType = normalizeChangeType(fileChangeTypeValue(change));
    const explicitContent = firstFileString(change.content);
    let oldString = firstFileString(change.old_string, change.oldString);
    let newString = firstFileString(
      change.new_string,
      change.newString,
      explicitContent
    );
    if (
      normalizedType === "created" &&
      oldString === null &&
      newString !== null
    ) {
      oldString = "";
    }
    if (
      normalizedType === "deleted" &&
      oldString === null &&
      newString !== null
    ) {
      oldString = newString;
      newString = "";
    }
    if (
      normalizedType === "deleted" &&
      newString === null &&
      oldString !== null
    ) {
      newString = "";
    }
    const content = firstFileString(
      normalizedType === "deleted" ? null : explicitContent,
      normalizedType === "created" ? newString : null
    );
    const rendered = normalizeFileChangeRenderData({
      path: normalizedPath,
      explicitChangeType: normalizedType ?? "unknown",
      allowSyntheticDiff: true,
      diffValues: [
        change.unified_diff,
        change.unifiedDiff,
        change.diff,
        change.patch
      ],
      content,
      oldString,
      newString
    });
    return rendered ? [rendered] : [];
  });
}

function inferFileChangeType(
  toolName: string | null,
  unifiedDiff: string | null,
  content: string | null,
  oldString: string | null,
  newString: string | null
): AgentFileChangeRenderData["changeType"] {
  if (unifiedDiff && isAgentUnifiedDiff(unifiedDiff)) {
    return inferAgentPatchChangeType(unifiedDiff);
  }
  const normalizedToolName = normalizeToolName(toolName);
  if (
    normalizedToolName === "write" &&
    (content !== null || newString !== null)
  ) {
    return "created";
  }
  if (
    normalizedToolName === "edit" ||
    oldString !== null ||
    newString !== null
  ) {
    return "modified";
  }
  return "unknown";
}

function normalizeChangeType(
  value: string | null
): AgentFileChangeRenderData["changeType"] {
  switch ((value ?? "").trim().toLowerCase()) {
    case "add":
    case "create":
    case "created":
    case "added":
      return "created";
    case "edit":
    case "modify":
    case "modified":
    case "change":
    case "changed":
    case "update":
    case "updated":
      return "modified";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "deleted";
    default:
      return "unknown";
  }
}

function firstKnownChangeType(
  ...values: Array<AgentFileChangeRenderData["changeType"]>
): AgentFileChangeRenderData["changeType"] {
  for (const value of values) {
    if (value !== "unknown") {
      return value;
    }
  }
  return "unknown";
}

function diffPath(value: string): string | null {
  const match = value.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  return match?.[2]?.trim() ?? match?.[1]?.trim() ?? null;
}

function fileChangeStats(
  changeType: AgentFileChangeRenderData["changeType"],
  unifiedDiff: string | null,
  content: string | null,
  oldString: string | null,
  newString: string | null
): { added: number; removed: number } {
  return agentFileChangeStats({
    changeType,
    unifiedDiff,
    content,
    oldString,
    newString
  });
}

function syntheticUnifiedDiff(
  path: string,
  changeType: AgentFileChangeRenderData["changeType"],
  oldString: string,
  newString: string
): string {
  const oldLines = patchLines(oldString);
  const newLines = patchLines(newString);
  switch (changeType) {
    case "created":
      return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 +1,${newLines.length} @@`,
        ...newLines.map((line) => `+${line}`)
      ].join("\n");
    case "deleted":
      return [
        `diff --git a/${path} b/${path}`,
        "deleted file mode 100644",
        `--- a/${path}`,
        "+++ /dev/null",
        `@@ -1,${oldLines.length} +0,0 @@`,
        ...oldLines.map((line) => `-${line}`)
      ].join("\n");
    default:
      return [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`)
      ].join("\n");
  }
}

function patchLines(value: string): string[] {
  if (!value) {
    return [];
  }
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  return normalized ? normalized.split("\n") : [];
}

function languageForPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "go":
      return "go";
    case "md":
      return "markdown";
    case "json":
      return "json";
    default:
      return extension || null;
  }
}

function normalizeToolName(value: string | null): string {
  return (value ?? "")
    .trim()
    .replace(/[_\s-]+/g, "")
    .toLowerCase();
}

function firstString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstRawString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function firstValidUnifiedDiff(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && isAgentUnifiedDiff(value)) {
      return value;
    }
  }
  return null;
}

function firstFileString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      return fileTextValue(value);
    }
  }
  return null;
}

function fileTextValue(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed : value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function firstLocationPath(value: unknown[] | null): string | null {
  if (!value) {
    return null;
  }
  for (const item of value) {
    const record = recordValue(item);
    const path = stringValue(record?.path);
    if (path) {
      return path;
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
