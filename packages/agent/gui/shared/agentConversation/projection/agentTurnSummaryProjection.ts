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
import {
  collectContentDiffFiles,
  buildFileChange,
  normalizedFilePath,
  isIgnoredFilePath,
  isStructuredPayloadPath,
  dedupeFiles,
  applyShortestUniqueFileLabels,
  splitFilePath,
  normalizeChangeType,
  normalizeToolName,
  isFailedToolStatus,
  objectValue,
  firstFileChangeValue,
  arrayValue,
  nestedTaskStepsFromPayload,
  nestedTaskStepStatusKind,
  firstLocationPath,
  firstPathValue,
  stringValue,
  literalStringValue,
  numberValue,
  firstNonEmptyString,
  firstPresentString
} from "./agentTurnSummaryFileProjection";

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
    const fileUnifiedDiff =
      firstNonEmptyString(
        stringValue(file?.diff),
        stringValue(file?.patch),
        stringValue(file?.unifiedDiff),
        stringValue(file?.unified_diff)
      ) ?? patch;
    const fileOldString =
      firstPresentString(
        literalStringValue(file?.oldString),
        literalStringValue(file?.old_string)
      ) ?? oldString;
    const fileNewString =
      firstPresentString(
        literalStringValue(file?.newString),
        literalStringValue(file?.new_string)
      ) ?? newString;
    const fileContent =
      firstPresentString(literalStringValue(file?.content)) ?? content;
    const change = normalizeChangeType(stringValue(file?.change));
    return [
      buildFileChange({
        id: `${messageId}:${index + 1}`,
        toolName,
        path,
        changeType: change ?? inferAgentPatchChangeType(fileUnifiedDiff),
        unifiedDiff: fileUnifiedDiff,
        oldString: fileOldString,
        newString: fileNewString,
        content: fileContent,
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
