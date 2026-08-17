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
    | "slashCommandHelpDescription"
    | "slashCommandInitDescription"
    | "slashCommandMcpDescription"
    | "slashCommandPlanDescription"
    | "slashCommandReviewDescription"
    | "slashCommandStatusDescription"
    | "slashCommandTasksDescription"
    | "slashCommandUsageDescription"
  >
): string | undefined {
  const providerDescription = command.description?.trim()
    ? command.description
    : undefined;
  switch (command.name.trim().toLowerCase()) {
    case "compact":
      return labels.slashCommandCompactDescription;
    case "context":
      return labels.slashCommandContextDescription;
    case "fast":
      return labels.slashCommandFastDescription;
    case "goal":
      return labels.slashCommandGoalDescription;
    case "help":
      return providerDescription ?? labels.slashCommandHelpDescription;
    case "init":
      return labels.slashCommandInitDescription;
    case "mcp":
      return providerDescription ?? labels.slashCommandMcpDescription;
    case "plan":
      return labels.slashCommandPlanDescription;
    case "review":
      return labels.slashCommandReviewDescription;
    case "status":
      return labels.slashCommandStatusDescription;
    case "tasks":
      return providerDescription ?? labels.slashCommandTasksDescription;
    case "usage":
      return labels.slashCommandUsageDescription;
    default:
      return providerDescription;
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
    | "slashCommandHelpLabel"
    | "slashCommandInitLabel"
    | "slashCommandMcpLabel"
    | "slashCommandPlanLabel"
    | "slashCommandReviewLabel"
    | "slashCommandStatusLabel"
    | "slashCommandTasksLabel"
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
    | "slashCommandHelpLabel"
    | "slashCommandInitLabel"
    | "slashCommandMcpLabel"
    | "slashCommandPlanLabel"
    | "slashCommandReviewLabel"
    | "slashCommandStatusLabel"
    | "slashCommandTasksLabel"
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
    case "help":
      return labels.slashCommandHelpLabel ?? labelForSlashCommand(command);
    case "init":
      return labels.slashCommandInitLabel;
    case "mcp":
      return labels.slashCommandMcpLabel ?? labelForSlashCommand(command);
    case "plan":
      return labels.slashCommandPlanLabel;
    case "review":
      return labels.slashCommandReviewLabel;
    case "status":
      return labels.slashCommandStatusLabel;
    case "tasks":
      return labels.slashCommandTasksLabel ?? labelForSlashCommand(command);
    case "usage":
      return labels.slashCommandUsageLabel;
    default:
      return labelForSlashCommand(command);
  }
}
