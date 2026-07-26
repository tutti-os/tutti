import { useMemo } from "react";
import type { AgentConversationVM } from "../contracts/agentConversationVM";

export function useAgentTranscriptEditRetryRowId(
  rows: readonly AgentConversationVM["rows"][number][],
  eligibleTurnId: string | undefined
): string | null {
  return useMemo(
    () => resolveAgentTranscriptEditRetryRowId(rows, eligibleTurnId),
    [eligibleTurnId, rows]
  );
}

export function resolveAgentTranscriptEditRetryRowId(
  rows: readonly AgentConversationVM["rows"][number][],
  eligibleTurnId: string | undefined
): string | null {
  if (!eligibleTurnId) {
    return null;
  }
  return (
    rows.find(
      (row) =>
        row.kind === "message" &&
        row.speaker === "user" &&
        row.turnId === eligibleTurnId &&
        row.rawFirstTextBlock !== null &&
        row.rawFirstTextBlock !== undefined
    )?.id ?? null
  );
}
