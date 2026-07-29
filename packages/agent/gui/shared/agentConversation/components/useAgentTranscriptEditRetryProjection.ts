import { useMemo } from "react";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentUserMessageEditRetryControl } from "./AgentUserMessageEditRetry";

export interface AgentTranscriptEditRetryControl extends AgentUserMessageEditRetryControl {
  agentSessionId: string;
  eligibleTurnId: string;
}

export function editRetryControlsEqual(
  previous: AgentTranscriptEditRetryControl | undefined,
  next: AgentTranscriptEditRetryControl | undefined
): boolean {
  return (
    previous === next ||
    (previous?.agentSessionId === next?.agentSessionId &&
      previous?.eligibleTurnId === next?.eligibleTurnId &&
      previous?.pending === next?.pending &&
      previous?.onSubmit === next?.onSubmit &&
      previous?.labels.edit === next?.labels.edit &&
      previous?.labels.cancel === next?.labels.cancel &&
      previous?.labels.submit === next?.labels.submit)
  );
}

export function useAgentTranscriptEditRetryProjection(
  rows: readonly AgentConversationVM["rows"][number][],
  agentSessionId: string,
  editRetry: AgentTranscriptEditRetryControl | undefined
): {
  editableUserMessageRowId: string | null;
  scopedEditRetry: AgentTranscriptEditRetryControl | undefined;
} {
  const scopedEditRetry =
    editRetry?.agentSessionId.trim() === agentSessionId.trim()
      ? editRetry
      : undefined;
  return {
    editableUserMessageRowId: useAgentTranscriptEditRetryRowId(
      rows,
      scopedEditRetry?.eligibleTurnId
    ),
    scopedEditRetry
  };
}

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
