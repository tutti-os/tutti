import { resolveWorkspaceFilePathCandidate } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type {
  WorkspaceAgentSessionDetailToolCall,
  WorkspaceAgentSessionDetailViewModel,
  WorkspaceAgentSessionDetailTurn
} from "../../workspaceAgentSessionDetailViewModel";
import type {
  AgentTurnSummaryPatchBatchVM,
  AgentTurnSummaryPatchChangeVM,
  AgentTurnSummaryFileVM,
  AgentTurnSummaryRowVM
} from "../contracts/agentTurnSummaryRowVM";
import {
  extractAgentPatchPath,
  inferAgentPatchChangeType
} from "../rules/agentPatchMetadata";
import {
  fileChangeEntriesFromChanges,
  fileChangeTypeValue
} from "../../workspaceAgentFileChangePayload";

type AgentTurnSummaryChangeType = AgentTurnSummaryFileVM["changeType"];

interface AgentTurnSummaryProjectionOptions {
  defaultCwd?: string | null;
  workspaceRoot?: string | null;
}

export function projectAgentTurnSummaryRows(
  detail: WorkspaceAgentSessionDetailViewModel
): AgentTurnSummaryRowVM[] {
  const options = {
    defaultCwd: detail.cwd,
    workspaceRoot: detail.workspaceRoot
  };
  const rows = detail.turns.flatMap((turn) =>
    projectAgentTurnSummaryRowForTurn(turn, options)
  );
  if (rows.length > 0) {
    return rows;
  }
  if (detail.activity.changedFiles.length === 0) {
    return [];
  }
  const files = detail.activity.changedFiles.flatMap((file) => {
    const path = normalizedActivityFilePath(file.path, options);
    if (!path) {
      return [];
    }
    const parts = splitFilePath(path);
    return {
      label: path,
      path,
      fileName: parts.fileName,
      directory: parts.directory,
      changeType: "modified" as const,
      toolName: null,
      messageId: "turn-summary:activity",
      occurredAtUnixMs:
        detail.session.updatedAtUnixMs ?? detail.session.createdAtUnixMs ?? null
    };
  });
  if (files.length === 0) {
    return [];
  }
  const labeledFiles = applyShortestUniqueFileLabels(files);
  return [
    {
      kind: "turn-summary",
      id: "turn-summary:activity",
      turnId: detail.turns.at(-1)?.id ?? "turn:activity",
      files: labeledFiles,
      fileCount: labeledFiles.length,
      modifiedCount: labeledFiles.length,
      createdCount: 0,
      occurredAtUnixMs:
        detail.session.updatedAtUnixMs ?? detail.session.createdAtUnixMs ?? null
    }
  ];
}

function normalizedActivityFilePath(
  value: string | null,
  options: AgentTurnSummaryProjectionOptions
): string | null {
  const path = value?.trim() ?? "";
  return path &&
    !isStructuredPayloadPath(path) &&
    !isIgnoredFilePath(path) &&
    resolveWorkspaceFilePathCandidate({
      path,
      workspaceRoot: options.workspaceRoot
    })
    ? path
    : null;
}

export function projectAgentTurnSummaryRowForTurn(
  turn: WorkspaceAgentSessionDetailTurn,
  options: AgentTurnSummaryProjectionOptions = {}
): AgentTurnSummaryRowVM[] {
  const summaryCalls = turnToolCallsForSummary(turn);
  const files = applyShortestUniqueFileLabels(
    dedupeFiles(summaryCalls.flatMap((call) => filesFromCall(call, options)))
  );
  if (files.length === 0) {
    return [];
  }
  const patchBatches = patchBatchesFromCalls(summaryCalls, options);
  const fileCount = files.length;
  const createdCount = files.filter(
    (file) => file.changeType === "created"
  ).length;
  const modifiedCount = fileCount - createdCount;
  const occurredAtUnixMs =
    files
      .map((file) => file.occurredAtUnixMs ?? 0)
      .reduce((latest, value) => (value > latest ? value : latest), 0) || null;
  return [
    {
      kind: "turn-summary",
      id: `turn-summary:${turn.id}`,
      turnId: turn.id,
      files,
      ...(patchBatches.length > 0 ? { patchBatches } : {}),
      fileCount,
      modifiedCount,
      createdCount,
      occurredAtUnixMs
    }
  ];
}

function turnToolCallsForSummary(
  turn: WorkspaceAgentSessionDetailTurn
): WorkspaceAgentSessionDetailToolCall[] {
  const callsById = new Map<string, WorkspaceAgentSessionDetailToolCall>();
  for (const call of turn.toolCalls) {
    callsById.set(call.id, call);
  }
  for (const item of turn.agentItems) {
    if (item.kind !== "tool-calls") {
      continue;
    }
    for (const call of item.toolCalls) {
      callsById.set(call.id, call);
    }
    for (const entry of item.groupEntries ?? []) {
      if (entry.kind === "tool-call") {
        callsById.set(entry.call.id, entry.call);
      }
    }
  }
  return Array.from(callsById.values());
}

function filesFromCall(
  call: WorkspaceAgentSessionDetailToolCall,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryFileVM[] {
  const toolState = objectValue(call.payload?.tool_state);
  const input =
    objectValue(call.payload?.input) ??
    objectValue(toolState?.input) ??
    summaryPathInput(call.summary, options);
  const output =
    objectValue(call.payload?.output) ?? objectValue(toolState?.output);
  const error =
    objectValue(call.payload?.error) ?? objectValue(toolState?.error);
  const nestedTaskSteps = nestedTaskStepsFromPayload(call.payload, output);

  const directChanges = extractFileChanges({
    id: call.id,
    toolName: call.toolName,
    statusKind: call.statusKind ?? null,
    occurredAtUnixMs: call.occurredAtUnixMs ?? null,
    payload: call.payload ?? null,
    input,
    output,
    error,
    options
  });
  const nestedChanges = nestedTaskSteps.flatMap((value, index) => {
    const step = objectValue(value);
    if (!step) {
      return [];
    }
    return extractFileChanges({
      id:
        stringValue(step.toolUseId) ??
        stringValue(step.id) ??
        `${call.id}:step:${index + 1}`,
      toolName:
        stringValue(step.toolName) ??
        stringValue(step.tool_name) ??
        stringValue(step.name) ??
        null,
      statusKind: nestedTaskStepStatusKind(step, call.statusKind ?? null),
      occurredAtUnixMs:
        numberValue(step.occurredAtUnixMs) ??
        numberValue(step.occurred_at_unix_ms) ??
        call.occurredAtUnixMs ??
        null,
      payload: objectValue(step.payload),
      input: objectValue(step.toolInput) ?? objectValue(step.tool_input),
      output: objectValue(step.toolResult) ?? objectValue(step.tool_result),
      error: objectValue(step.toolError) ?? objectValue(step.tool_error),
      options
    });
  });
  return [...directChanges, ...nestedChanges];
}

function patchBatchesFromCalls(
  calls: readonly WorkspaceAgentSessionDetailToolCall[],
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryPatchBatchVM[] {
  return calls.flatMap((call) => patchBatchesFromCall(call, options));
}

function patchBatchesFromCall(
  call: WorkspaceAgentSessionDetailToolCall,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryPatchBatchVM[] {
  const directBatch = isFailedToolStatus(call.statusKind ?? null)
    ? []
    : patchBatchFromPayload({
        id: call.id,
        payload: call.payload ?? null,
        toolInput: null,
        toolOutput: null,
        toolError: null,
        options
      });
  const output = objectValue(call.payload?.output);
  const nestedTaskSteps = nestedTaskStepsFromPayload(call.payload, output);
  const nestedBatches = nestedTaskSteps.flatMap((value, index) => {
    const step = objectValue(value);
    if (!step) {
      return [];
    }
    if (
      isFailedToolStatus(
        nestedTaskStepStatusKind(step, call.statusKind ?? null)
      )
    ) {
      return [];
    }
    return patchBatchFromPayload({
      id:
        stringValue(step.toolUseId) ??
        stringValue(step.id) ??
        `${call.id}:step:${index + 1}`,
      payload: objectValue(step.payload),
      toolInput: objectValue(step.toolInput) ?? objectValue(step.tool_input),
      toolOutput: objectValue(step.toolResult) ?? objectValue(step.tool_result),
      toolError: objectValue(step.toolError) ?? objectValue(step.tool_error),
      options
    });
  });
  return [...directBatch, ...nestedBatches];
}

function patchBatchFromPayload(input: {
  id: string;
  payload: Record<string, unknown> | null;
  toolInput: Record<string, unknown> | null;
  toolOutput: Record<string, unknown> | null;
  toolError: Record<string, unknown> | null;
  options: AgentTurnSummaryProjectionOptions;
}): AgentTurnSummaryPatchBatchVM[] {
  const toolState = objectValue(input.payload?.tool_state);
  const metadata = objectValue(input.payload?.metadata);
  const payloadInput =
    input.toolInput ??
    objectValue(input.payload?.input) ??
    objectValue(toolState?.input);
  const payloadOutput =
    input.toolOutput ??
    objectValue(input.payload?.output) ??
    objectValue(toolState?.output);
  const rawInput = objectValue(payloadInput?.rawInput);
  const changes = firstFileChangeValue(
    payloadOutput?.changes,
    input.payload?.changes,
    payloadInput?.changes,
    rawInput?.changes
  );
  const patchChanges = patchChangesFromChangeMap(changes);
  if (patchChanges.length === 0) {
    return [];
  }
  return [
    {
      cwd:
        firstNonEmptyString(
          stringValue(input.payload?.cwd),
          stringValue(payloadInput?.cwd),
          stringValue(rawInput?.cwd),
          stringValue(payloadOutput?.cwd),
          stringValue(metadata?.cwd),
          input.options.defaultCwd ?? null
        ) ?? null,
      toolCallId: input.id,
      changes: patchChanges
    }
  ];
}

function patchChangesFromChangeMap(
  changes: unknown
): AgentTurnSummaryPatchChangeVM[] {
  return fileChangeEntriesFromChanges(changes).flatMap((entry) => {
    const change = entry.change;
    const normalizedPath = entry.path.trim();
    if (!normalizedPath) {
      return [];
    }
    const normalizedType = normalizeChangeType(fileChangeTypeValue(change));
    const unifiedDiff =
      firstNonEmptyString(
        stringValue(change.unified_diff),
        stringValue(change.unifiedDiff),
        stringValue(change.diff),
        stringValue(change.patch)
      ) ?? null;
    let oldString = firstPresentString(
      literalStringValue(change.old_string),
      literalStringValue(change.oldString)
    );
    const explicitContent = literalStringValue(change.content);
    let newString = firstPresentString(
      literalStringValue(change.new_string),
      literalStringValue(change.newString),
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
    const content = firstPresentString(
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
    return [
      {
        path: normalizedPath,
        changeType: normalizedType ?? inferAgentPatchChangeType(unifiedDiff),
        unifiedDiff,
        oldString,
        newString,
        content
      }
    ];
  });
}

function summaryPathInput(
  summary: string,
  options: AgentTurnSummaryProjectionOptions
): Record<string, unknown> | null {
  const path = normalizedFilePath(summary, options);
  return path ? { path, summaryPathFallback: true } : null;
}

function extractFileChanges(input: {
  id: string;
  toolName: string | null | undefined;
  statusKind: string | null;
  occurredAtUnixMs: number | null;
  payload: Record<string, unknown> | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  options: AgentTurnSummaryProjectionOptions;
}): AgentTurnSummaryFileVM[] {
  const normalizedToolName = normalizeToolName(input.toolName);
  const payload = input.payload;
  const metadata = objectValue(payload?.metadata);
  const rawInput = objectValue(input.input?.rawInput);
  const inputLocations = arrayValue(input.input?.locations);
  const payloadLocations = arrayValue(payload?.locations);
  const payloadPaths = arrayValue(payload?.paths);
  const structuredWriteTool = isStructuredWriteTool(
    normalizedToolName,
    payload,
    metadata
  );
  if (!isFileChangeTool(normalizedToolName, structuredWriteTool)) {
    return [];
  }
  if (isFailedToolStatus(input.statusKind)) {
    return [];
  }
  const changes = firstFileChangeValue(
    input.output?.changes,
    payload?.changes,
    input.input?.changes,
    rawInput?.changes
  );

  const filesFromMetadata = collectMetadataFiles(
    input.id,
    input.toolName ?? null,
    input.occurredAtUnixMs,
    arrayValue(objectValue(payload?.fileChanges)?.files),
    firstNonEmptyString(
      stringValue(input.input?.patch),
      stringValue(input.output?.patch),
      stringValue(payload?.patch),
      stringValue(metadata?.patch)
    ),
    firstPresentString(
      literalStringValue(input.output?.oldString),
      literalStringValue(input.output?.old_string),
      literalStringValue(input.input?.oldString),
      literalStringValue(input.input?.old_string)
    ),
    firstPresentString(
      literalStringValue(input.output?.newString),
      literalStringValue(input.output?.new_string),
      literalStringValue(input.input?.newString),
      literalStringValue(input.input?.new_string)
    ),
    firstPresentString(
      literalStringValue(input.output?.content),
      literalStringValue(input.input?.content)
    ),
    input.options
  );
  if (filesFromMetadata.length > 0) {
    return filesFromMetadata;
  }

  const filesFromChangeMap = collectChangeMapFiles(
    input.id,
    input.toolName ?? null,
    input.occurredAtUnixMs,
    changes,
    input.options
  );
  if (filesFromChangeMap.length > 0) {
    return filesFromChangeMap;
  }

  const filesFromContentDiff = collectContentDiffFiles(
    input.id,
    input.toolName ?? null,
    input.occurredAtUnixMs,
    arrayValue(input.output?.content) ??
      arrayValue(payload?.content) ??
      arrayValue(input.input?.content),
    changes,
    input.options
  );
  if (filesFromContentDiff.length > 0) {
    return filesFromContentDiff;
  }

  const summaryFallbackPath =
    input.input?.summaryPathFallback === true
      ? stringValue(input.input?.path)
      : null;
  const explicitInputPath = summaryFallbackPath
    ? null
    : stringValue(input.input?.path);
  const filePath =
    firstNonEmptyString(
      firstPathValue(payloadPaths),
      stringValue(input.input?.file_path),
      stringValue(input.input?.filePath),
      explicitInputPath,
      stringValue(input.input?.notebook_path),
      stringValue(input.output?.file_path),
      stringValue(input.output?.filePath),
      stringValue(input.output?.path),
      stringValue(input.output?.notebook_path),
      firstLocationPath(inputLocations),
      firstLocationPath(payloadLocations)
    ) ??
    extractAgentPatchPath(
      firstNonEmptyString(
        stringValue(input.input?.patch),
        stringValue(input.output?.patch)
      )
    ) ??
    summaryFallbackPath;
  const normalizedFilePathValue = normalizedFilePath(filePath, input.options);
  if (!normalizedFilePathValue) {
    return [];
  }

  const patch =
    firstNonEmptyString(
      stringValue(input.input?.patch),
      stringValue(input.output?.patch),
      stringValue(payload?.patch),
      stringValue(metadata?.patch),
      stringValue(input.output?.content)
    ) ?? null;
  const oldString = firstPresentString(
    literalStringValue(input.output?.oldString),
    literalStringValue(input.output?.old_string),
    literalStringValue(input.input?.oldString),
    literalStringValue(input.input?.old_string)
  );
  const newString = firstPresentString(
    literalStringValue(input.output?.newString),
    literalStringValue(input.output?.new_string),
    literalStringValue(input.input?.newString),
    literalStringValue(input.input?.new_string)
  );
  const content = firstPresentString(
    literalStringValue(input.input?.content),
    literalStringValue(rawInput?.content),
    literalStringValue(input.input?.new_source),
    literalStringValue(input.output?.content),
    literalStringValue(input.output?.new_source)
  );
  const explicitChangeType =
    normalizeChangeType(
      firstNonEmptyString(
        stringValue(payload?.fileChangeKind),
        stringValue(metadata?.fileChangeKind),
        stringValue(input.input?.fileChangeKind),
        stringValue(input.output?.fileChangeKind)
      )
    ) ?? null;
  const changeType =
    explicitChangeType ??
    ((normalizedToolName === "write" || normalizedToolName === "writefile"
      ? "created"
      : normalizedToolName === "notebookedit"
        ? "created"
        : inferAgentPatchChangeType(patch)) as AgentTurnSummaryChangeType);

  return [
    buildFileChange({
      id: input.id,
      toolName: input.toolName ?? null,
      path: normalizedFilePathValue,
      changeType,
      unifiedDiff: patch,
      oldString,
      newString,
      content,
      occurredAtUnixMs: input.occurredAtUnixMs
    })
  ];
}

function isFileChangeTool(
  normalizedToolName: string,
  structuredWriteTool: boolean
): boolean {
  switch (normalizedToolName) {
    case "write":
    case "writefile":
    case "edit":
    case "editfile":
    case "multiedit":
    case "applypatch":
    case "notebookedit":
      return true;
    case "bash":
    case "execcommand":
      return structuredWriteTool;
    default:
      return false;
  }
}

function isStructuredWriteTool(
  normalizedToolName: string,
  payload: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null
): boolean {
  if (normalizedToolName !== "bash" && normalizedToolName !== "execcommand") {
    return false;
  }
  const activityKind = firstNonEmptyString(
    stringValue(payload?.activityKind),
    stringValue(metadata?.activityKind)
  );
  if (
    activityKind === "write_file" ||
    activityKind === "edit_file" ||
    activityKind === "delete_file"
  ) {
    return true;
  }
  return (
    normalizeChangeType(
      firstNonEmptyString(
        stringValue(payload?.fileChangeKind),
        stringValue(metadata?.fileChangeKind)
      )
    ) !== null
  );
}

function collectMetadataFiles(
  messageId: string,
  toolName: string | null,
  occurredAtUnixMs: number | null,
  files: unknown[] | null,
  patch: string | null,
  oldString: string | null,
  newString: string | null,
  content: string | null,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryFileVM[] {
  if (!files || files.length === 0) {
    return [];
  }
  return files.flatMap((value, index) => {
    const file = objectValue(value);
    const path = normalizedFilePath(stringValue(file?.path), options);
    if (!path) {
      return [];
    }
    const change = normalizeChangeType(stringValue(file?.change));
    return [
      buildFileChange({
        id: `${messageId}:${index + 1}`,
        toolName,
        path,
        changeType: change ?? inferAgentPatchChangeType(patch),
        unifiedDiff: patch,
        oldString,
        newString,
        content,
        occurredAtUnixMs
      })
    ];
  });
}

function collectChangeMapFiles(
  messageId: string,
  toolName: string | null,
  occurredAtUnixMs: number | null,
  changes: unknown,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryFileVM[] {
  return fileChangeEntriesFromChanges(changes).flatMap((entry) => {
    const change = entry.change;
    const normalizedPath = normalizedFilePath(entry.path, options);
    if (!normalizedPath) {
      return [];
    }
    const normalizedType = normalizeChangeType(fileChangeTypeValue(change));
    const unifiedDiff = firstNonEmptyString(
      stringValue(change.unified_diff),
      stringValue(change.unifiedDiff),
      stringValue(change.diff),
      stringValue(change.patch)
    );
    let oldString = firstPresentString(
      literalStringValue(change.old_string),
      literalStringValue(change.oldString)
    );
    const explicitContent = literalStringValue(change.content);
    let newString = firstPresentString(
      literalStringValue(change.new_string),
      literalStringValue(change.newString),
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
    const content = firstPresentString(
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
    return [
      buildFileChange({
        id: `${messageId}:change:${entry.index + 1}`,
        toolName,
        path: normalizedPath,
        changeType: normalizedType ?? inferAgentPatchChangeType(unifiedDiff),
        unifiedDiff,
        oldString,
        newString,
        content,
        occurredAtUnixMs
      })
    ];
  });
}

function collectContentDiffFiles(
  messageId: string,
  toolName: string | null,
  occurredAtUnixMs: number | null,
  contentItems: unknown[] | null,
  changes: unknown,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryFileVM[] {
  if (!contentItems) {
    return [];
  }
  const changesByPath = new Map(
    fileChangeEntriesFromChanges(changes).map((entry) => [
      entry.path,
      entry.change
    ])
  );
  return contentItems.flatMap((value, index) => {
    const item = objectValue(value);
    if (!item) {
      return [];
    }
    const type = stringValue(item.type);
    if (type && type !== "diff") {
      return [];
    }
    const path = normalizedFilePath(stringValue(item.path), options);
    if (!path) {
      return [];
    }
    const relatedChange = changesByPath.get(path) ?? null;
    const normalizedType = normalizeChangeType(
      relatedChange ? fileChangeTypeValue(relatedChange) : null
    );
    const unifiedDiff = firstNonEmptyString(
      stringValue(item.diff),
      stringValue(item.patch),
      stringValue(relatedChange?.unified_diff),
      stringValue(relatedChange?.unifiedDiff)
    );
    let oldString = firstPresentString(
      literalStringValue(item.oldText),
      literalStringValue(item.oldString),
      literalStringValue(relatedChange?.old_string),
      literalStringValue(relatedChange?.oldString)
    );
    const relatedContent = literalStringValue(relatedChange?.content);
    let newString = firstPresentString(
      literalStringValue(item.newText),
      literalStringValue(item.newString),
      literalStringValue(relatedChange?.new_string),
      literalStringValue(relatedChange?.newString),
      relatedContent
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
    const explicitContent = firstPresentString(
      literalStringValue(item.content),
      relatedContent
    );
    const inferredType =
      normalizedType ??
      inferChangeTypeFromToolContent(
        toolName,
        normalizedType === "deleted" ? null : explicitContent,
        oldString,
        newString
      );
    if (
      inferredType === "created" &&
      oldString === null &&
      newString !== null
    ) {
      oldString = "";
    }
    const content = firstPresentString(
      inferredType === "deleted" ? null : explicitContent,
      inferredType === "created" ? newString : null
    );
    if (
      !unifiedDiff &&
      oldString === null &&
      newString === null &&
      content === null
    ) {
      return [];
    }
    return [
      buildFileChange({
        id: `${messageId}:content:${index + 1}`,
        toolName,
        path,
        changeType: inferredType ?? inferAgentPatchChangeType(unifiedDiff),
        unifiedDiff,
        oldString,
        newString,
        content,
        occurredAtUnixMs
      })
    ];
  });
}

function buildFileChange(input: {
  id: string;
  toolName: string | null;
  path: string;
  changeType: AgentTurnSummaryChangeType;
  unifiedDiff: string | null;
  oldString: string | null;
  newString: string | null;
  content: string | null;
  occurredAtUnixMs: number | null;
}): AgentTurnSummaryFileVM {
  const parts = splitFilePath(input.path);
  return {
    label: input.path,
    path: input.path,
    fileName: parts.fileName,
    directory: parts.directory,
    changeType: input.changeType,
    toolName: input.toolName,
    messageId: input.id,
    unifiedDiff: input.unifiedDiff,
    oldString: input.oldString,
    newString: input.newString,
    content: input.content,
    occurredAtUnixMs: input.occurredAtUnixMs
  };
}

function normalizedFilePath(
  value: string | null,
  options: AgentTurnSummaryProjectionOptions = {}
): string | null {
  const path = value?.trim() ?? "";
  if (!path || isStructuredPayloadPath(path) || isIgnoredFilePath(path)) {
    return null;
  }
  return resolveWorkspaceFilePathCandidate({
    path,
    workspaceRoot: options.workspaceRoot
  })
    ? path
    : null;
}

function isIgnoredFilePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath === "/dev/null" || normalizedPath === "NUL";
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

function dedupeFiles(
  files: AgentTurnSummaryFileVM[]
): AgentTurnSummaryFileVM[] {
  const byPath = new Map<string, AgentTurnSummaryFileVM>();
  files.forEach((file) => {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
      return;
    }
    if (existing.changeType === "deleted" && file.changeType === "created") {
      byPath.set(file.path, {
        ...file,
        changeType: "modified",
        unifiedDiff: null,
        oldString:
          existing.oldString ??
          existing.content ??
          existing.unifiedDiff ??
          null,
        newString: file.newString ?? file.content ?? file.unifiedDiff ?? null,
        content: null
      });
      return;
    }
    if (file.changeType === "deleted" || existing.changeType === "deleted") {
      byPath.set(file.path, file);
      return;
    }
    if (existing.changeType === "modified" && file.changeType === "created") {
      byPath.set(file.path, file);
      return;
    }
    if (detailScore(file) > detailScore(existing)) {
      byPath.set(file.path, file);
    }
  });
  return [...byPath.values()];
}

function applyShortestUniqueFileLabels(
  files: AgentTurnSummaryFileVM[]
): AgentTurnSummaryFileVM[] {
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

function detailScore(file: AgentTurnSummaryFileVM): number {
  let score = 0;
  if (file.unifiedDiff) {
    score += 4;
  }
  if (file.oldString || file.newString) {
    score += 3;
  }
  if (file.content) {
    score += 2;
  }
  if (file.toolName) {
    score += 1;
  }
  return score;
}

function splitFilePath(path: string): {
  fileName: string;
  directory: string | null;
} {
  const normalized = path.trim();
  const parts = splitPathSegments(normalized);
  if (parts.length <= 1) {
    return { fileName: parts[0] ?? normalized, directory: null };
  }
  return {
    fileName: parts.at(-1) ?? normalized,
    directory: parts.slice(0, -1).join("/")
  };
}

function splitPathSegments(path: string): string[] {
  return path.trim().split(/[\\/]/).filter(Boolean);
}

function normalizeChangeType(
  value: string | null
): AgentTurnSummaryChangeType | null {
  switch ((value ?? "").trim().toLowerCase()) {
    case "add":
    case "added":
    case "create":
    case "created":
    case "new":
      return "created";
    case "modify":
    case "modified":
    case "update":
    case "updated":
      return "modified";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "deleted";
    default:
      return null;
  }
}

function inferChangeTypeFromToolContent(
  toolName: string | null,
  content: string | null,
  oldString: string | null,
  newString: string | null
): "modified" | "created" | null {
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName === "write" || normalizedToolName === "writefile") {
    return content !== null || newString !== null ? "created" : null;
  }
  if (oldString !== null || newString !== null) {
    return "modified";
  }
  return null;
}

function normalizeToolName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[_\s-]+/g, "")
    .trim()
    .toLowerCase();
}

function isFailedToolStatus(value: string | null): boolean {
  switch (normalizeToolName(value)) {
    case "failed":
    case "failure":
    case "error":
    case "errored":
      return true;
    default:
      return false;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstFileChangeValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (fileChangeEntriesFromChanges(value).length > 0) {
      return value;
    }
  }
  return null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function nestedTaskStepsFromPayload(
  payload: Record<string, unknown> | null,
  output: Record<string, unknown> | null
): unknown[] {
  const metadata = objectValue(payload?.metadata);
  return (
    arrayValue(metadata?.steps) ??
    arrayValue(output?.steps) ??
    arrayValue(payload?.steps) ??
    []
  );
}

function nestedTaskStepStatusKind(
  step: Record<string, unknown>,
  fallback: string | null
): string | null {
  return (
    firstNonEmptyString(
      stringValue(step.statusKind),
      stringValue(step.status),
      stringValue(step.toolStatus)
    ) ??
    fallback ??
    null
  );
}

function firstLocationPath(value: unknown[] | null): string | null {
  if (!value) {
    return null;
  }
  for (const item of value) {
    const record = objectValue(item);
    const path = stringValue(record?.path);
    if (path) {
      return path;
    }
  }
  return null;
}

function firstPathValue(value: unknown[] | null): string | null {
  if (!value) {
    return null;
  }
  for (const item of value) {
    const path = stringValue(item);
    if (path) {
      return path;
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function literalStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstPresentString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}
