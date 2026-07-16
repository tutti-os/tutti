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
  const patchBatches = patchBatchesFromCalls(
    turnToolCallsForSummary(turn),
    options
  ).flatMap((batch) => {
    const changes = batch.changes.filter((change) =>
      visiblePaths.has(change.path)
    );
    return changes.length > 0 ? [{ ...batch, changes }] : [];
  });
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
    byPath.set(path, {
      label: path,
      path,
      fileName: parts.fileName,
      directory: parts.directory,
      changeType:
        normalizeChangeType(
          firstNonEmptyString(
            stringValue(file.change),
            stringValue(file.type),
            stringValue(file.status)
          )
        ) ?? "modified",
      toolName: null,
      messageId: `turn-summary:${turnId}:file:${index + 1}`,
      unifiedDiff:
        firstNonEmptyString(
          stringValue(file.unifiedDiff),
          stringValue(file.unified_diff),
          stringValue(file.diff),
          stringValue(file.patch)
        ) ?? null,
      oldString: firstPresentString(
        literalStringValue(file.oldString),
        literalStringValue(file.old_string)
      ),
      newString: firstPresentString(
        literalStringValue(file.newString),
        literalStringValue(file.new_string)
      ),
      content: literalStringValue(file.content),
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
  const toolState = objectValue(payload?.tool_state);
  const metadata = objectValue(payload?.metadata);
  const input =
    toolInput ?? objectValue(payload?.input) ?? objectValue(toolState?.input);
  const output =
    toolOutput ??
    objectValue(payload?.output) ??
    objectValue(toolState?.output);
  const rawInput = objectValue(input?.rawInput);
  const changes = firstFileChangeValue(
    output?.changes,
    payload?.changes,
    input?.changes,
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
          stringValue(payload?.cwd),
          stringValue(input?.cwd),
          stringValue(rawInput?.cwd),
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
  return fileChangeEntriesFromChanges(changes).flatMap((entry) => {
    const change = entry.change;
    const path = entry.path.trim();
    if (!path) {
      return [];
    }
    const changeType = normalizeChangeType(fileChangeTypeValue(change));
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
    return [
      {
        path,
        changeType: changeType ?? inferAgentPatchChangeType(unifiedDiff),
        unifiedDiff,
        oldString,
        newString,
        content
      }
    ];
  });
}
