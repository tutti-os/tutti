import type { JSX } from "react";
import { LoaderCircle } from "lucide-react";
import type {
  AgentProcessingPhase,
  AgentProcessingRowVM
} from "../contracts/agentProcessingRowVM";
import { useElapsedSeconds } from "./useElapsedSeconds";

export interface AgentProcessingLabels {
  phases: Record<AgentProcessingPhase, string>;
  elapsedSeconds(seconds: number): string;
}

export function AgentProcessingRow({
  row,
  label,
  statusLabels,
  paused = false
}: {
  row: AgentProcessingRowVM;
  label: string;
  statusLabels?: AgentProcessingLabels;
  paused?: boolean;
}): JSX.Element {
  "use memo";
  const elapsedSeconds = useElapsedSeconds(row.startedAtUnixMs);
  const idleSeconds = useElapsedSeconds(row.lastProgressAtUnixMs);
  const phase = effectivePhase(row.phase, elapsedSeconds, idleSeconds);
  const phaseLabel = statusLabels?.phases[phase] ?? processingLabel(row, label);

  return (
    <div
      data-row-id={row.id}
      className="workspace-agents-status-panel__detail-processing flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] text-[var(--text-secondary)]"
      role="status"
      aria-live="polite"
      aria-label={phaseLabel}
      data-observation-gap={paused || undefined}
    >
      <LoaderCircle
        size={14}
        strokeWidth={2}
        aria-hidden="true"
        className="shrink-0 animate-spin"
      />
      <span className="truncate font-medium">{phaseLabel}</span>
      {statusLabels && elapsedSeconds !== null ? (
        <span className="shrink-0 text-[var(--text-tertiary)]">
          · {statusLabels.elapsedSeconds(elapsedSeconds)}
        </span>
      ) : null}
    </div>
  );
}

export function effectivePhase(
  phase: AgentProcessingPhase,
  elapsedSeconds: number | null,
  idleSeconds: number | null
): AgentProcessingPhase {
  if (phase === "reconnecting") return phase;
  if (phase === "submitting" && (elapsedSeconds ?? 0) >= 3) {
    return "waiting_response";
  }
  if (
    (phase === "thinking" ||
      phase === "generating" ||
      phase === "using_tool") &&
    (idleSeconds ?? 0) >= 3
  ) {
    return phase === "using_tool" ? "waiting_tool" : "waiting_continuation";
  }
  return phase;
}

function processingLabel(row: AgentProcessingRowVM, fallback: string): string {
  if (row.label?.trim()) {
    return row.label.trim();
  }
  return fallback;
}
