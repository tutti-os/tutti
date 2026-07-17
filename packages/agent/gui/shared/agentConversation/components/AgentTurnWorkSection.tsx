import type { JSX, ReactNode } from "react";
import { BareIconButton } from "@tutti-os/ui-system/components";
import { ChevronDownIcon } from "@tutti-os/ui-system/icons";
import { useTranslation } from "../../../i18n/index";
import { CollapsibleReveal } from "./CollapsibleReveal";
import type { AgentTurnDisclosureStore } from "./AgentTurnDisclosureContext";
import { useElapsedSeconds } from "./useElapsedSeconds";
import {
  formatAgentTurnDuration,
  type AgentTurnDuration,
  type AgentTurnStopPresentation,
  type AgentTurnTiming,
  type AgentTurnWorkSectionModel,
  type AgentTurnWorkSectionRow
} from "./agentTurnWorkSectionModel";

interface AgentTurnWorkSectionProps {
  model: AgentTurnWorkSectionModel;
  sessionId: string;
  turnKey: string;
  showDivider?: boolean;
  disclosureStore: AgentTurnDisclosureStore;
  renderRow: (
    row: AgentTurnWorkSectionRow["row"],
    rowIndex: number,
    renderKey?: string
  ) => JSX.Element;
}

export function AgentTurnWorkSection({
  model,
  sessionId,
  turnKey,
  showDivider = false,
  disclosureStore,
  renderRow
}: AgentTurnWorkSectionProps): JSX.Element {
  const { t } = useTranslation();
  const disclosureKey = `${sessionId}:${turnKey}`;
  const expanded = model.collapseEligible
    ? (disclosureStore.expandedOverrides[disclosureKey] ?? false)
    : true;

  const toggleLabel = expanded
    ? t("agentHost.agentGui.collapseTurnWork")
    : t("agentHost.agentGui.expandTurnWork");

  return (
    <div className="grid min-w-0" data-agent-turn-work-section={turnKey}>
      {showDivider ? (
        <div
          className="mb-4 h-px w-full flex-none bg-[var(--line-2,var(--tutti-line-2))]"
          data-testid="agent-transcript-turn-divider"
          aria-hidden="true"
        />
      ) : null}
      {model.leadingRows.length > 0 ? (
        <div className="mb-4 grid gap-4">
          {renderRows(model.leadingRows, renderRow)}
        </div>
      ) : null}
      <div
        className="flex min-h-6 items-center gap-0.5 text-[12px] text-[var(--text-tertiary)]"
        data-agent-turn-work-header={turnKey}
      >
        <AgentTurnDurationLabel
          timing={model.timing}
          stopPresentation={model.stopPresentation}
        />
        {model.collapseEligible ? (
          <BareIconButton
            size="sm"
            aria-label={toggleLabel}
            aria-expanded={expanded}
            title={toggleLabel}
            onClick={() =>
              disclosureStore.setExpandedOverride(disclosureKey, !expanded)
            }
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={`transition-transform duration-150 ${
                expanded ? "rotate-0" : "-rotate-90"
              }`}
            />
          </BareIconButton>
        ) : null}
      </div>
      {model.sections.map((section, sectionIndex) => {
        const content = renderRows(section.rows, renderRow);
        if (section.kind !== "work" || !model.collapseEligible) {
          const firstRow = section.rows[0];
          return (
            <div
              key={`${section.kind}:${firstRow?.renderKey ?? firstRow?.row.id ?? sectionIndex}`}
              className="grid gap-4 pt-4"
            >
              {content}
            </div>
          );
        }
        const firstRow = section.rows[0];
        return (
          <CollapsibleReveal
            key={`work:${firstRow?.renderKey ?? firstRow?.row.id ?? sectionIndex}`}
            expanded={expanded}
            innerClassName="grid gap-4 pt-4"
          >
            {content}
          </CollapsibleReveal>
        );
      })}
    </div>
  );
}

function renderRows(
  rows: readonly AgentTurnWorkSectionRow[],
  renderRow: AgentTurnWorkSectionProps["renderRow"]
): ReactNode {
  return rows.map(({ row, rowIndex, renderKey }) =>
    renderRow(row, rowIndex, renderKey)
  );
}

function AgentTurnDurationLabel({
  timing,
  stopPresentation
}: {
  timing: AgentTurnTiming;
  stopPresentation: AgentTurnStopPresentation;
}): JSX.Element {
  const { t } = useTranslation();
  const liveElapsedSeconds = useElapsedSeconds(
    timing.kind === "live" ? timing.startedAtUnixMs : null
  );
  const elapsedSeconds =
    timing.kind === "live" ? (liveElapsedSeconds ?? 0) : timing.elapsedSeconds;
  return (
    <span>
      {translateDuration(t, timing.kind, elapsedSeconds, stopPresentation)}
    </span>
  );
}

function translateDuration(
  t: ReturnType<typeof useTranslation>["t"],
  kind: AgentTurnTiming["kind"],
  elapsedSeconds: number,
  stopPresentation: AgentTurnStopPresentation
): string {
  const duration = formatAgentTurnDuration(elapsedSeconds);
  if (kind === "settled" && stopPresentation) {
    return translateStoppedDuration(t, duration, stopPresentation);
  }
  return kind === "live"
    ? translateLiveDuration(t, duration)
    : translateSettledDuration(t, duration);
}

function translateStoppedDuration(
  t: ReturnType<typeof useTranslation>["t"],
  duration: AgentTurnDuration,
  presentation: Exclude<AgentTurnStopPresentation, null>
): string {
  return presentation === "historical"
    ? translateHistoricalStoppedDuration(t, duration)
    : translateUserStoppedDuration(t, duration);
}

function translateUserStoppedDuration(
  t: ReturnType<typeof useTranslation>["t"],
  duration: AgentTurnDuration
): string {
  if (duration.kind === "seconds") {
    return t("agentHost.agentGui.turnStoppedSeconds", {
      seconds: duration.seconds
    });
  }
  if (duration.kind === "minutes") {
    return t("agentHost.agentGui.turnStoppedMinutes", {
      minutes: duration.minutes
    });
  }
  return t("agentHost.agentGui.turnStoppedMinutesSeconds", {
    minutes: duration.minutes,
    seconds: duration.seconds
  });
}

function translateHistoricalStoppedDuration(
  t: ReturnType<typeof useTranslation>["t"],
  duration: AgentTurnDuration
): string {
  if (duration.kind === "seconds") {
    return t("agentHost.agentGui.turnHistoricallyStoppedSeconds", {
      seconds: duration.seconds
    });
  }
  if (duration.kind === "minutes") {
    return t("agentHost.agentGui.turnHistoricallyStoppedMinutes", {
      minutes: duration.minutes
    });
  }
  return t("agentHost.agentGui.turnHistoricallyStoppedMinutesSeconds", {
    minutes: duration.minutes,
    seconds: duration.seconds
  });
}

function translateLiveDuration(
  t: ReturnType<typeof useTranslation>["t"],
  duration: AgentTurnDuration
): string {
  if (duration.kind === "seconds") {
    return t("agentHost.agentGui.turnProcessedSeconds", {
      seconds: duration.seconds
    });
  }
  if (duration.kind === "minutes") {
    return t("agentHost.agentGui.turnProcessedMinutes", {
      minutes: duration.minutes
    });
  }
  return t("agentHost.agentGui.turnProcessedMinutesSeconds", {
    minutes: duration.minutes,
    seconds: duration.seconds
  });
}

function translateSettledDuration(
  t: ReturnType<typeof useTranslation>["t"],
  duration: AgentTurnDuration
): string {
  if (duration.kind === "seconds") {
    return t("agentHost.agentGui.turnTotalSeconds", {
      seconds: duration.seconds
    });
  }
  if (duration.kind === "minutes") {
    return t("agentHost.agentGui.turnTotalMinutes", {
      minutes: duration.minutes
    });
  }
  return t("agentHost.agentGui.turnTotalMinutesSeconds", {
    minutes: duration.minutes,
    seconds: duration.seconds
  });
}
