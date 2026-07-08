import type { AgentToolCallVM } from "../../../contracts/agentToolCallVM";
import {
  extractAgentPatchPath,
  inferAgentPatchChangeType
} from "../../../rules/agentPatchMetadata";
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
  const rawInput =
    recordValue(call.input?.rawInput) ?? recordValue(payloadInput?.rawInput);
  const inputLocations =
    arrayValue(call.locations) ??
    arrayValue(call.input?.locations) ??
    arrayValue(payloadInput?.locations);
  const fromStructuredPatch = structuredPatchFiles(
    call.output?.structuredPatch ??
      payloadOutput?.structuredPatch ??
      call.payload?.structuredPatch
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
    call.payload?.fileChanges ?? payloadOutput?.fileChanges
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

  const fromContentDiff = contentDiffFiles(
    call.content ??
      call.output?.content ??
      payloadOutput?.content ??
      call.input?.content ??
      payloadInput?.content ??
      call.payload?.content,
    call.output?.changes ??
      payloadOutput?.changes ??
      call.input?.changes ??
      payloadInput?.changes,
    call.toolName
  );
  if (fromContentDiff.length > 0) {
    return fromContentDiff;
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
  const unifiedDiff = firstString(
    stringValue(call.output?.patch),
    stringValue(payloadOutput?.patch),
    stringValue(call.output?.diff),
    stringValue(payloadOutput?.diff)
  );
  const path = firstString(
    inputPath,
    unifiedDiff ? extractAgentPatchPath(unifiedDiff) : null
  );
  if (!path) {
    return [];
  }

  const content = firstString(
    stringValue(call.input?.content),
    stringValue(payloadInput?.content),
    stringValue(rawInput?.content)
  );
  const oldString = firstString(
    stringValue(call.input?.old_string),
    stringValue(payloadInput?.old_string),
    stringValue(call.output?.oldString),
    stringValue(payloadOutput?.oldString)
  );
  const newString = firstString(
    stringValue(call.input?.new_string),
    stringValue(payloadInput?.new_string),
    stringValue(call.output?.newString),
    stringValue(payloadOutput?.newString)
  );
  const changeType = inferFileChangeType(
    call.toolName,
    unifiedDiff,
    content,
    oldString,
    newString
  );
  const normalizedUnifiedDiff =
    !unifiedDiff && oldString !== null && newString !== null
      ? syntheticUnifiedDiff(path, changeType, oldString, newString)
      : unifiedDiff;
  const lineStats = fileChangeStats(
    changeType,
    normalizedUnifiedDiff,
    content,
    oldString,
    newString
  );

  return [
    {
      path,
      changeType,
      language: languageForPath(path),
      content,
      oldString,
      newString,
      unifiedDiff: normalizedUnifiedDiff,
      added: lineStats.added,
      removed: lineStats.removed
    }
  ];
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
    const diff = firstString(
      stringValue(patch?.diff),
      stringValue(patch?.patch)
    );
    if (!path) {
      return [];
    }
    const oldString = firstString(
      stringValue(patch?.oldString),
      stringValue(patch?.old_string)
    );
    const newString = firstString(
      stringValue(patch?.newString),
      stringValue(patch?.new_string)
    );
    const content = firstString(stringValue(patch?.content), newString);
    if (!diff && !oldString && !newString && !content) {
      return [];
    }
    const changeType = firstKnownChangeType(
      normalizeChangeType(stringValue(patch?.kind)),
      normalizeChangeType(stringValue(patch?.change)),
      inferFileChangeType(null, diff, content, oldString, newString)
    );
    const stats = fileChangeStats(
      changeType,
      diff,
      content,
      oldString,
      newString
    );
    return [
      {
        path,
        changeType,
        language: languageForPath(path),
        content,
        oldString,
        newString,
        unifiedDiff: diff,
        added: stats.added,
        removed: stats.removed
      }
    ];
  });
}

function detailedDiffFiles(value: unknown): AgentFileChangeRenderData[] {
  const diff = stringValue(value);
  if (!diff) {
    return [];
  }
  const path = diffPath(diff);
  if (!path) {
    return [];
  }
  const stats = diffLineStats(diff);
  const changeType = inferFileChangeType(null, diff, null, null, null);
  return [
    {
      path,
      changeType,
      language: languageForPath(path),
      content: null,
      oldString: null,
      newString: null,
      unifiedDiff: diff,
      added: stats.added,
      removed: stats.removed
    }
  ];
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
    if (!path) {
      return [];
    }
    const unifiedDiff = firstString(
      stringValue(file?.diff),
      stringValue(file?.patch),
      stringValue(file?.unifiedDiff),
      stringValue(file?.unified_diff)
    );
    const oldString = firstString(
      stringValue(file?.oldString),
      stringValue(file?.old_string)
    );
    const newString = firstString(
      stringValue(file?.newString),
      stringValue(file?.new_string)
    );
    const content = firstString(stringValue(file?.content), newString);
    const changeType = firstKnownChangeType(
      normalizeChangeType(stringValue(file?.change)),
      normalizeChangeType(stringValue(file?.kind)),
      inferFileChangeType(null, unifiedDiff, content, oldString, newString)
    );
    const stats = fileChangeStats(
      changeType,
      unifiedDiff,
      content,
      oldString,
      newString
    );
    return [
      {
        path,
        changeType,
        language: languageForPath(path),
        content,
        oldString,
        newString,
        unifiedDiff,
        added: stats.added,
        removed: stats.removed
      }
    ];
  });
}

function changeMapFiles(value: unknown): AgentFileChangeRenderData[] {
  return fileChangeEntriesFromChanges(value).flatMap((entry) => {
    const change = entry.change;
    const normalizedPath = entry.path.trim();
    if (!normalizedPath) {
      return [];
    }
    const unifiedDiff = firstString(
      stringValue(change.unified_diff),
      stringValue(change.unifiedDiff),
      stringValue(change.diff),
      stringValue(change.patch)
    );
    const explicitContent = stringValue(change.content);
    const normalizedType = normalizeChangeType(fileChangeTypeValue(change));
    let oldString = firstString(
      stringValue(change.old_string),
      stringValue(change.oldString)
    );
    let newString = firstString(
      stringValue(change.new_string),
      stringValue(change.newString),
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
    const content = firstString(
      normalizedType === "deleted" ? null : explicitContent,
      normalizedType === "created" ? newString : null
    );
    if (
      !unifiedDiff &&
      oldString === null &&
      newString === null &&
      content === null
    ) {
      return [];
    }
    const changeType = firstKnownChangeType(
      normalizedType,
      inferFileChangeType(null, unifiedDiff, content, oldString, newString)
    );
    const normalizedUnifiedDiff =
      !unifiedDiff && oldString !== null && newString !== null
        ? syntheticUnifiedDiff(normalizedPath, changeType, oldString, newString)
        : unifiedDiff;
    const stats = fileChangeStats(
      changeType,
      normalizedUnifiedDiff,
      content,
      oldString,
      newString
    );
    return [
      {
        path: normalizedPath,
        changeType,
        language: languageForPath(normalizedPath),
        content,
        oldString,
        newString,
        unifiedDiff: normalizedUnifiedDiff,
        added: stats.added,
        removed: stats.removed
      }
    ];
  });
}

function contentDiffFiles(
  value: unknown,
  changesValue: unknown,
  toolName: string | null
): AgentFileChangeRenderData[] {
  const items = arrayValue(value);
  if (!items) {
    return [];
  }
  const changesByPath = new Map(
    fileChangeEntriesFromChanges(changesValue).map((entry) => [
      entry.path,
      entry.change
    ])
  );
  return items.flatMap((item) => {
    const record = recordValue(item);
    if (!record) {
      return [];
    }
    const type = stringValue(record.type);
    if (type && type !== "diff") {
      return [];
    }
    const path = stringValue(record.path);
    if (!path) {
      return [];
    }
    const relatedChange = changesByPath.get(path) ?? null;
    const unifiedDiff = firstString(
      stringValue(record.diff),
      stringValue(record.patch),
      stringValue(relatedChange?.unified_diff),
      stringValue(relatedChange?.unifiedDiff)
    );
    const normalizedType = normalizeChangeType(
      relatedChange ? fileChangeTypeValue(relatedChange) : null
    );
    let oldString = firstString(
      stringValue(record.oldText),
      stringValue(record.oldString),
      stringValue(relatedChange?.old_string),
      stringValue(relatedChange?.oldString)
    );
    let newString = firstString(
      stringValue(record.newText),
      stringValue(record.newString),
      stringValue(relatedChange?.new_string),
      stringValue(relatedChange?.newString),
      stringValue(relatedChange?.content)
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
    const explicitContent = firstString(
      stringValue(record.content),
      stringValue(relatedChange?.content)
    );
    const changeType = firstKnownChangeType(
      normalizedType,
      inferFileChangeType(
        toolName,
        unifiedDiff,
        normalizedType === "deleted" ? null : explicitContent,
        oldString,
        newString
      )
    );
    if (changeType === "created" && oldString === null && newString !== null) {
      oldString = "";
    }
    const content = firstString(
      changeType === "deleted" ? null : explicitContent,
      changeType === "created" ? newString : null
    );
    if (
      !unifiedDiff &&
      oldString === null &&
      newString === null &&
      content === null
    ) {
      return [];
    }
    const normalizedUnifiedDiff =
      !unifiedDiff && oldString !== null && newString !== null
        ? syntheticUnifiedDiff(path, changeType, oldString, newString)
        : unifiedDiff;
    const stats = fileChangeStats(
      changeType,
      normalizedUnifiedDiff,
      content,
      oldString,
      newString
    );
    return [
      {
        path,
        changeType,
        language: languageForPath(path),
        content,
        oldString,
        newString,
        unifiedDiff: normalizedUnifiedDiff,
        added: stats.added,
        removed: stats.removed
      }
    ];
  });
}

function inferFileChangeType(
  toolName: string | null,
  unifiedDiff: string | null,
  content: string | null,
  oldString: string | null,
  newString: string | null
): AgentFileChangeRenderData["changeType"] {
  if (unifiedDiff) {
    return inferAgentPatchChangeType(unifiedDiff);
  }
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName === "write" && (content || newString)) {
    return "created";
  }
  if (normalizedToolName === "edit" || oldString || newString) {
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

function diffLineStats(value: string | null): {
  added: number;
  removed: number;
} {
  if (!value) {
    return { added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  value.split("\n").forEach((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) {
      return;
    }
    if (line.startsWith("+")) {
      added += 1;
      return;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  });
  return { added, removed };
}

function fileChangeStats(
  changeType: AgentFileChangeRenderData["changeType"],
  unifiedDiff: string | null,
  content: string | null,
  oldString: string | null,
  newString: string | null
): { added: number; removed: number } {
  if (unifiedDiff) {
    return diffLineStats(unifiedDiff);
  }
  if (changeType === "created") {
    return { added: countTextLines(content ?? newString), removed: 0 };
  }
  if (changeType === "deleted") {
    return { added: 0, removed: countTextLines(oldString) };
  }
  return { added: 0, removed: 0 };
}

function countTextLines(value: string | null): number {
  if (!value) {
    return 0;
  }
  const normalized = value.trimEnd();
  return normalized ? normalized.split("\n").length : 0;
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
