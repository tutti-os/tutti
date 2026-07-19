import type { JSX } from "react";
import { useTranslation, type TranslateFn } from "../../../i18n/index";
import type { AgentProcessingRowVM } from "../contracts/agentProcessingRowVM";
import { formatAgentTurnDuration } from "./agentTurnWorkSectionModel";
import { useElapsedSeconds } from "./useElapsedSeconds";

export function AgentProcessingRow({
  row,
  awaitingLabel,
  streamingLabel
}: {
  row: AgentProcessingRowVM;
  awaitingLabel: string;
  streamingLabel: string;
}): JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const elapsedSeconds = useElapsedSeconds(row.phaseStartedAtUnixMs ?? null);
  const phaseLabel =
    row.modelPhase === "streaming" ? streamingLabel : awaitingLabel;

  return (
    <div
      data-row-id={row.id}
      className="workspace-agents-status-panel__detail-processing inline-flex items-center gap-1.5"
    >
      <span className="inline-flex min-w-0 items-center gap-1 font-semibold">
        <span>{processingLabel(row, phaseLabel)}</span>
        <LoadingEllipsis />
      </span>
      {elapsedSeconds === null ? null : (
        <span className="workspace-agents-status-panel__detail-processing-elapsed">
          {formatPhaseDuration(t, elapsedSeconds)}
        </span>
      )}
      {row.tokenUsage ? (
        <span className="workspace-agents-status-panel__detail-processing-tokens">
          <span>↑ {formatCompactTokenCount(row.tokenUsage.inputTokens)}</span>
          <span>↓ {formatCompactTokenCount(row.tokenUsage.outputTokens)}</span>
        </span>
      ) : null}
    </div>
  );
}

function processingLabel(row: AgentProcessingRowVM, fallback: string): string {
  if (row.label?.trim()) {
    return row.label.trim();
  }
  return fallback;
}

function formatPhaseDuration(t: TranslateFn, elapsedSeconds: number): string {
  const duration = formatAgentTurnDuration(elapsedSeconds);
  if (duration.kind === "seconds") {
    return t("agentHost.agentGui.turnDurationShortSeconds", {
      seconds: duration.seconds
    });
  }
  if (duration.kind === "minutes") {
    return t("agentHost.agentGui.turnDurationShortMinutes", {
      minutes: duration.minutes
    });
  }
  return t("agentHost.agentGui.turnDurationShortMinutesSeconds", {
    minutes: duration.minutes,
    seconds: duration.seconds
  });
}

function formatCompactTokenCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (safe < 1_000) {
    return String(safe);
  }
  if (safe < 999_500) {
    return `${formatCompactMagnitude(safe / 1_000)}k`;
  }
  return `${formatCompactMagnitude(safe / 1_000_000)}m`;
}

function formatCompactMagnitude(value: number): string {
  if (value >= 100) {
    return String(Math.round(value));
  }
  return String(Math.round(value * 10) / 10);
}

function LoadingEllipsis(): JSX.Element {
  "use memo";
  return (
    <span
      className="tsh-inline-loading-ellipsis tsh-inline-loading-ellipsis--entry-timing"
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </span>
  );
}
