export type DelegatedTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type DelegatedTaskState = {
  parentToolUseId: string;
  turnId: string;
  input: Record<string, unknown>;
  agentId?: string;
  outputFile?: string;
  taskId?: string;
  subject?: string;
  description?: string;
  status: DelegatedTaskStatus;
  // Tool use id of the delegated task that launched this one, set when a
  // nested agent launch is observed inside a child stream.
  parentTaskToolUseId?: string;
};
