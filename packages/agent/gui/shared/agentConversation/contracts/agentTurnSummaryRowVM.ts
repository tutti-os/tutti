export interface AgentTurnSummaryFileVM {
  label: string;
  path: string;
  fileName: string;
  directory: string | null;
  changeType: "modified" | "created" | "deleted";
  toolName: string | null;
  messageId: string;
  unifiedDiff?: string | null;
  oldString?: string | null;
  newString?: string | null;
  content?: string | null;
  occurredAtUnixMs: number | null;
}

export interface AgentTurnSummaryPatchChangeVM {
  path: string;
  changeType: "modified" | "created" | "deleted";
  unifiedDiff?: string | null;
  oldString?: string | null;
  newString?: string | null;
  content?: string | null;
}

export interface AgentTurnSummaryPatchBatchVM {
  cwd: string | null;
  toolCallId: string;
  changes: AgentTurnSummaryPatchChangeVM[];
}

export interface AgentTurnSummaryRowVM {
  kind: "turn-summary";
  id: string;
  turnId: string;
  files: AgentTurnSummaryFileVM[];
  patchBatches?: AgentTurnSummaryPatchBatchVM[];
  fileCount: number;
  modifiedCount: number;
  createdCount: number;
  occurredAtUnixMs: number | null;
}
