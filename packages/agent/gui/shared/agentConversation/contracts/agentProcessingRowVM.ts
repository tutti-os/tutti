import type { AgentActivityTurnTokenUsage } from "@tutti-os/agent-activity-core";

export type AgentProcessingRowPhase = "awaiting" | "streaming";

export interface AgentProcessingRowVM {
  kind: "processing";
  id: string;
  turnId: string | null;
  label?: string | null;
  occurredAtUnixMs: number | null;
  modelPhase?: AgentProcessingRowPhase;
  phaseStartedAtUnixMs?: number | null;
  tokenUsage?: AgentActivityTurnTokenUsage | null;
}
