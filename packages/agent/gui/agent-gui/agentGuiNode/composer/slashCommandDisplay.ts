import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import { labelForSlashCommand } from "../model/agentSlashCommands";
import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";
import type { AgentComposerProps } from "./AgentComposer.types";

export function slashCommandDescriptionForDisplay(
  command: AgentSessionCommand,
  labels: Pick<
    AgentComposerProps["labels"],
    | "slashCommandCompactDescription"
    | "slashCommandContextDescription"
    | "slashCommandFastDescription"
    | "slashCommandGoalDescription"
    | "slashCommandInitDescription"
    | "slashCommandPlanDescription"
    | "slashCommandReviewDescription"
    | "slashCommandStatusDescription"
    | "slashCommandUsageDescription"
  >
): string | undefined {
  switch (command.name.trim().toLowerCase()) {
    case "compact":
      return labels.slashCommandCompactDescription;
    case "context":
      return labels.slashCommandContextDescription;
    case "fast":
      return labels.slashCommandFastDescription;
    case "goal":
      return labels.slashCommandGoalDescription;
    case "init":
      return labels.slashCommandInitDescription;
    case "plan":
      return labels.slashCommandPlanDescription;
    case "review":
      return labels.slashCommandReviewDescription;
    case "status":
      return labels.slashCommandStatusDescription;
    case "usage":
      return labels.slashCommandUsageDescription;
    default:
      return command.description;
  }
}

export function slashCommandLabelForDisplay(
  command: AgentSessionCommand,
  labels: Pick<
    AgentComposerProps["labels"],
    | "slashCommandCompactLabel"
    | "slashCommandContextLabel"
    | "slashCommandFastLabel"
    | "slashCommandGoalLabel"
    | "slashCommandInitLabel"
    | "slashCommandPlanLabel"
    | "slashCommandReviewLabel"
    | "slashCommandStatusLabel"
    | "slashCommandUsageLabel"
  >,
  uiLanguage: UiLanguage
): { primaryLabel?: string; secondaryLabel?: string } {
  const canonicalLabel = labelForSlashCommand(command);
  const primaryLabel = localizedSlashCommandLabel(command, labels);
  return uiLanguage === "en" || primaryLabel === canonicalLabel
    ? { primaryLabel }
    : { primaryLabel, secondaryLabel: canonicalLabel };
}

function localizedSlashCommandLabel(
  command: AgentSessionCommand,
  labels: Pick<
    AgentComposerProps["labels"],
    | "slashCommandCompactLabel"
    | "slashCommandContextLabel"
    | "slashCommandFastLabel"
    | "slashCommandGoalLabel"
    | "slashCommandInitLabel"
    | "slashCommandPlanLabel"
    | "slashCommandReviewLabel"
    | "slashCommandStatusLabel"
    | "slashCommandUsageLabel"
  >
): string {
  switch (command.name.trim().toLowerCase()) {
    case "compact":
      return labels.slashCommandCompactLabel;
    case "context":
      return labels.slashCommandContextLabel;
    case "fast":
      return labels.slashCommandFastLabel;
    case "goal":
      return labels.slashCommandGoalLabel;
    case "init":
      return labels.slashCommandInitLabel;
    case "plan":
      return labels.slashCommandPlanLabel;
    case "review":
      return labels.slashCommandReviewLabel;
    case "status":
      return labels.slashCommandStatusLabel;
    case "usage":
      return labels.slashCommandUsageLabel;
    default:
      return labelForSlashCommand(command);
  }
}
