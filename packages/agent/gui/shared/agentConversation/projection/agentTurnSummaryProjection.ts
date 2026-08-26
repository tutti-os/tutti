import type {
  WorkspaceAgentSessionDetailToolCall,
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "../../workspaceAgentSessionDetailViewModel";
import type {
  AgentTurnSummaryPatchBatchVM,
  AgentTurnSummaryPatchChangeVM,
  AgentTurnSummaryFileVM,
  AgentTurnSummaryRowVM
} from "../contracts/agentTurnSummaryRowVM";
import { inferAgentPatchChangeType } from "../rules/agentPatchMetadata";
import { isAgentUnifiedDiffText } from "../rules/agentUnifiedDiffValidation";
import {
  fileChangeEntriesFromChanges,
  fileChangeTypeValue
} from "../../workspaceAgentFileChangePayload";
import {
  applyShortestUniqueFileLabels,
  arrayValue,
  firstFileChangeValue,
  firstNonEmptyString,
  firstPresentString,
  isFailedToolStatus,
  literalStringValue,
  nestedTaskStepsFromPayload,
  nestedTaskStepStatusKind,
  normalizedFilePath,
  normalizeChangeType,
  objectValue,
  splitFilePath,
  stringValue
} from "./agentTurnSummaryFileProjection";

interface AgentTurnSummaryProjectionOptions {
  defaultCwd?: string | null;
  workspaceRoot?: string | null;
  occurredAtUnixMs?: number | null;
}

/**
 * Projects the response-tail file list from durable turn state. Tool calls are
 * consulted only for executable Undo/Reapply patch batches; they never infer
 * which files changed or whether a change was create/modify/delete.
 */
export function projectAgentTurnSummaryRows(
  detail: WorkspaceAgentSessionDetailViewModel
): AgentTurnSummaryRowVM[] {
  const transcriptTurnsById = new Map(
    detail.turns.map((turn) => [turn.id, turn])
  );
  return (detail.sessionTurns ?? []).flatMap((turn) => {
    const transcriptTurn = transcriptTurnsById.get(turn.turnId);
    if (
      !isSettledTurnSummaryVisible(detail, turn.turnId, turn.phase) ||
      !turn.fileChanges ||
      !transcriptTurn
    ) {
      return [];
    }
    return projectAgentTurnSummaryRowForTurn(transcriptTurn, turn.fileChanges, {
      defaultCwd: detail.cwd,
      workspaceRoot: detail.workspaceRoot,
      occurredAtUnixMs: turn.updatedAtUnixMs
    });
  });
}

function isSettledTurnSummaryVisible(
  detail: WorkspaceAgentSessionDetailViewModel,
  turnId: string,
  phase: string
): boolean {
  if (phase !== "settled") return false;
  const activeTurn = detail.session.activeTurn;
  if (activeTurn?.turnId === turnId && activeTurn.phase !== "settled") {
    return false;
  }
  return (
    detail.showProcessingIndicator !== true ||
    detail.turns.at(-1)?.id !== turnId
  );
}

export function projectAgentTurnSummaryRowForTurn(
  turn: WorkspaceAgentSessionDetailTurn,
  fileChanges: Record<string, unknown> | null,
  options: AgentTurnSummaryProjectionOptions = {}
): AgentTurnSummaryRowVM[] {
  const files = canonicalTurnFiles(turn.id, fileChanges, options);
  if (files.length === 0) {
    return [];
  }
  const visiblePaths = new Set(files.map((file) => file.path));
  const candidatePatchBatches = patchBatchesFromCalls(
    turnToolCallsForSummary(turn),
    options
  );
  const coveredPaths = new Set(
    candidatePatchBatches.flatMap((batch) =>
      batch.changes.map((change) => change.path)
    )
  );
  const hasCompletePatchCoverage =
    candidatePatchBatches.length > 0 &&
    candidatePatchBatches.every((batch) =>
      batch.changes.every((change) => visiblePaths.has(change.path))
    ) &&
    files.every((file) => coveredPaths.has(file.path));
  const patchBatches = hasCompletePatchCoverage ? candidatePatchBatches : [];
  const createdCount = files.filter(
    (file) => file.changeType === "created"
  ).length;
  return [
    {
      kind: "turn-summary",
      id: `turn-summary:${turn.id}`,
      turnId: turn.id,
      files,
      ...(patchBatches.length > 0 ? { patchBatches } : {}),
      fileCount: files.length,
      modifiedCount: files.length - createdCount,
      createdCount,
      occurredAtUnixMs: options.occurredAtUnixMs ?? null
    }
  ];
}

function canonicalTurnFiles(
  turnId: string,
  fileChanges: Record<string, unknown> | null,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryFileVM[] {
  const byPath = new Map<string, AgentTurnSummaryFileVM>();
  for (const [index, value] of (
    arrayValue(objectValue(fileChanges)?.files) ?? []
  ).entries()) {
    const file = objectValue(value);
    const path = normalizedFilePath(
      firstNonEmptyString(
        stringValue(file?.path),
        stringValue(file?.filePath),
        stringValue(file?.file_path)
      ),
      options
    );
    if (!file || !path) {
      continue;
    }
    const parts = splitFilePath(path);
    const rawDiff = firstRawString(
      file?.diff,
      file?.patch,
      file?.unifiedDiff,
      file?.unified_diff
    );
    const unifiedDiff = firstValidUnifiedDiff(
      file?.diff,
      file?.patch,
      file?.unifiedDiff,
      file?.unified_diff
    );
    const explicitChangeType = normalizeChangeType(fileChangeTypeValue(file));
    let oldString = firstPresentString(
      literalStringValue(file.oldString),
      literalStringValue(file.old_string)
    );
    let newString = firstPresentString(
      literalStringValue(file.newString),
      literalStringValue(file.new_string)
    );
    let content = literalStringValue(file.content);
    const changeType =
      explicitChangeType ??
      (unifiedDiff ? inferAgentPatchChangeType(unifiedDiff) : "modified");
    if (unifiedDiff === null && rawDiff !== null) {
      if (changeType === "created") {
        content ??= rawDiff;
        newString ??= rawDiff;
      } else if (changeType === "deleted") {
        oldString ??= rawDiff;
        newString ??= "";
        content = null;
      } else if (oldString === null && newString === null && content === null) {
        content = rawDiff;
      }
    }
    byPath.set(path, {
      label: path,
      path,
      fileName: parts.fileName,
      directory: parts.directory,
      changeType,
      toolName: null,
      messageId: `turn-summary:${turnId}:file:${index + 1}`,
      unifiedDiff,
      oldString,
      newString,
      content,
      occurredAtUnixMs: options.occurredAtUnixMs ?? null
    });
  }
  return applyShortestUniqueFileLabels([...byPath.values()]);
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
  return [...callsById.values()];
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
    : patchBatchFromPayload(call.id, call.payload ?? null, null, null, options);
  const output = objectValue(call.payload?.output);
  const nestedBatches = nestedTaskStepsFromPayload(
    call.payload,
    output
  ).flatMap((value, index) => {
    const step = objectValue(value);
    if (
      !step ||
      isFailedToolStatus(
        nestedTaskStepStatusKind(step, call.statusKind ?? null)
      )
    ) {
      return [];
    }
    return patchBatchFromPayload(
      stringValue(step.toolUseId) ??
        stringValue(step.id) ??
        `${call.id}:step:${index + 1}`,
      objectValue(step.payload),
      objectValue(step.toolInput) ?? objectValue(step.tool_input),
      objectValue(step.toolResult) ?? objectValue(step.tool_result),
      options
    );
  });
  return [...directBatch, ...nestedBatches];
}

function patchBatchFromPayload(
  id: string,
  payload: Record<string, unknown> | null,
  toolInput: Record<string, unknown> | null,
  toolOutput: Record<string, unknown> | null,
  options: AgentTurnSummaryProjectionOptions
): AgentTurnSummaryPatchBatchVM[] {
  const metadata = objectValue(payload?.metadata);
  const input = toolInput ?? objectValue(payload?.input);
  const output = toolOutput ?? objectValue(payload?.output);
  const canonicalFileChanges = objectValue(payload?.fileChanges);
  const changes = firstFileChangeValue(
    canonicalFileChanges?.files,
    output?.changes,
    payload?.changes,
    input?.changes
  );
  const sourcePatchChanges = patchChangesFromChangeMap(changes);
  const patchChanges = sourcePatchChanges.flatMap((change) => {
    const path = normalizedFilePath(change.path, options);
    return path ? [{ ...change, path }] : [];
  });
  if (
    patchChanges.length === 0 ||
    patchChanges.length !== sourcePatchChanges.length
  ) {
    return [];
  }
  return [
    {
      cwd:
        firstNonEmptyString(
          stringValue(payload?.cwd),
          stringValue(input?.cwd),
          stringValue(output?.cwd),
          stringValue(metadata?.cwd),
          options.defaultCwd ?? null
        ) ?? null,
      toolCallId: id,
      changes: patchChanges
    }
  ];
}

function patchChangesFromChangeMap(
  changes: unknown
): AgentTurnSummaryPatchChangeVM[] {
  const entries = fileChangeEntriesFromChanges(changes);
  const patchChanges = entries.flatMap((entry) => {
    const change = entry.change;
    const path = entry.path.trim();
    if (!path) {
      return [];
    }
    const changeType = normalizeChangeType(fileChangeTypeValue(change));
    const rawDiff = firstRawString(
      change.unified_diff,
      change.unifiedDiff,
      change.diff,
      change.patch
    );
    const unifiedDiff = firstValidUnifiedDiff(
      change.unified_diff,
      change.unifiedDiff,
      change.diff,
      change.patch
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
    if (changeType === "created" && oldString === null && newString !== null) {
      oldString = "";
    }
    if (changeType === "deleted" && oldString === null && newString !== null) {
      oldString = newString;
      newString = "";
    }
    if (changeType === "deleted" && newString === null && oldString !== null) {
      newString = "";
    }
    const content = firstPresentString(
      changeType === "deleted" ? null : explicitContent,
      changeType === "created" ? (newString ?? rawDiff) : null
    );
    const resolvedChangeType =
      changeType ??
      (unifiedDiff ? inferAgentPatchChangeType(unifiedDiff) : "modified");
    if (
      resolvedChangeType === "modified" &&
      !unifiedDiff &&
      (oldString === null || newString === null)
    ) {
      return [];
    }
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
        path,
        changeType: resolvedChangeType,
        unifiedDiff,
        oldString,
        newString,
        content
      }
    ];
  });
  return patchChanges.length === entries.length ? patchChanges : [];
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
    if (typeof value === "string" && isAgentUnifiedDiffText(value)) {
      return value;
    }
  }
  return null;
}
