import type { WorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import type { AgentProcessingRowVM } from "../contracts/agentProcessingRowVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

export function projectAgentProcessingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  rows: readonly AgentTranscriptRowVM[]
): AgentProcessingRowVM | null {
  if (!detail.showProcessingIndicator) {
    return null;
  }
  const status = detail.session.status?.trim().toLowerCase() ?? "";
  if (!isWorkingSessionStatus(status)) {
    return null;
  }
  if (hasSpecificProgressRow(rows)) {
    return null;
  }
  // ponytail: detect compact turn to suppress generic "processing" label
  const lastPrompt = detail.turns.at(-1)?.userMessage?.body?.trim().toLowerCase() ?? "";
  return {
    kind: "processing",
    id: "processing",
    turnId: detail.turns.at(-1)?.id ?? null,
    label: lastPrompt === "/compact" ? "Compacting context…" : null,
    occurredAtUnixMs:
      detail.session.updatedAtUnixMs ?? detail.session.createdAtUnixMs ?? null
  };
}

function isWorkingSessionStatus(status: string): boolean {
  return status === "working";
}

function hasSpecificProgressRow(
  rows: readonly AgentTranscriptRowVM[]
): boolean {
  return rows.some((row) => {
    if (row.kind !== "tool-group") {
      return false;
    }
    return row.calls.some(
      (call) => call.statusKind === "working" || call.statusKind === "waiting"
    );
  });
}
