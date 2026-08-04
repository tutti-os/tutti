export type AgentProcessingPhase =
  | "preparing"
  | "submitting"
  | "waiting_response"
  | "thinking"
  | "generating"
  | "using_tool"
  | "waiting_tool"
  | "reconnecting"
  | "waiting_continuation";

export type AgentProcessingRuntimeState =
  | "connected"
  | "reconnecting"
  | "unavailable";

export interface AgentProcessingRowVM {
  kind: "processing";
  id: string;
  turnId: string | null;
  label?: string | null;
  phase: AgentProcessingPhase;
  startedAtUnixMs: number | null;
  lastProgressAtUnixMs: number | null;
  occurredAtUnixMs: number | null;
}
