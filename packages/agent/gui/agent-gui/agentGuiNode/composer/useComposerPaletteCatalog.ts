import { useMemo, type RefObject } from "react";
import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type {
  AgentGUIComposerSettingsVM,
  AgentGUIProviderSkillOption
} from "../model/agentGuiNodeTypes";
import type { AgentRichTextEditorHandle } from "../agentRichText/AgentRichTextEditor";
import type { AgentCapabilityTokenOption } from "../agentRichText/agentCapabilityTokenExtension";
import type {
  AgentComposerCapabilityMenuState,
  AgentComposerProps
} from "./AgentComposer.types";
import {
  filterSlashCommands,
  labelForSlashCommand
} from "../model/agentSlashCommands";
import {
  labelForProviderSkill,
  skillDescriptionForDisplay,
  skillTriggerForPrefix
} from "../model/agentSkillOptions";
import {
  filterProviderSkillsForTrigger,
  getAgentComposerTriggerQueryMatch,
  getPromptStartSlashCommandQuery
} from "../model/agentComposerTriggerQueries";
import {
  resolveSlashCommandsForProvider,
  type AgentSlashCommand,
  type AgentSlashCommandCapability
} from "../model/agentSlashCommandProviderPolicy";
import {
  slashCommandDescriptionForDisplay,
  slashCommandLabelForDisplay
} from "./slashCommandDisplay";
import type { AgentSlashPaletteEntry } from "../AgentSlashCommandPalette";

interface UseComposerPaletteCatalogInput {
  provider: string;
  isGoalModeActive: boolean;
  goalSupported: boolean;
  paletteDraftPrompt: string;
  availableCommands: readonly AgentSessionCommand[];
  availableSkills: readonly AgentGUIProviderSkillOption[];
  hasCompactableContext: boolean;
  compactSupported: boolean | null;
  composerSettings: AgentGUIComposerSettingsVM;
  capabilityMenuState?: AgentComposerCapabilityMenuState;
  capabilityControlsReadOnly: boolean;
  labels: AgentComposerProps["labels"];
  uiLanguage: UiLanguage;
  editorHandleRef: RefObject<AgentRichTextEditorHandle | null>;
}

function isSlashCommandCapability(
  command: AgentSlashCommand
): command is AgentSlashCommandCapability {
  return "kind" in command && command.kind === "capability";
}

export function useComposerPaletteCatalog({
  provider,
  isGoalModeActive,
  goalSupported,
  paletteDraftPrompt,
  availableCommands,
  availableSkills,
  hasCompactableContext,
  compactSupported,
  composerSettings,
  capabilityMenuState,
  capabilityControlsReadOnly,
  labels,
  uiLanguage,
  editorHandleRef
}: UseComposerPaletteCatalogInput) {
  // Host menu state means desktop can present and configure computer use.
  // Daemon support can be false while cua-driver is not ready; launch still
  // goes through the daemon readiness clamp.
  const computerExecutable = Boolean(composerSettings.supportsComputerUse);
  const computerPresentationSupported =
    computerExecutable ||
    capabilityMenuState?.computerUse?.presentationSupported === true;
  const slashQuery = isGoalModeActive
    ? null
    : getPromptStartSlashCommandQuery(paletteDraftPrompt);
  const slashCommandPolicy = composerSettings.slashCommandPolicy;
  const promptBeforeSelection =
    editorHandleRef.current?.getPromptTextBeforeSelection() ?? "";
  const skillQueryDraft = promptBeforeSelection || paletteDraftPrompt;
  const skillQueryMatch = getAgentComposerTriggerQueryMatch(skillQueryDraft);
  const presentationSkills = useMemo(
    () =>
      capabilityMenuState?.connectors?.enabled === false
        ? availableSkills.filter(
            (skill) =>
              skill.sourceKind !== "connector" && skill.kind !== "connector"
          )
        : availableSkills,
    [availableSkills, capabilityMenuState?.connectors?.enabled]
  );
  const resolvedSlashCommands = useMemo(
    () =>
      resolveSlashCommandsForProvider({
        provider,
        policy: slashCommandPolicy,
        commands: availableCommands,
        hasCompactableContext,
        compactSupported,
        planSupported: composerSettings.supportsPlanMode,
        browserSupported: Boolean(composerSettings.supportsBrowser),
        computerSupported: computerPresentationSupported,
        tuttiSupported: capabilityMenuState?.tuttiMode?.enabled === true
      }).filter(
        (command) =>
          goalSupported || command.name.trim().toLowerCase() !== "goal"
      ),
    [
      availableCommands,
      compactSupported,
      composerSettings.supportsPlanMode,
      composerSettings.supportsBrowser,
      computerPresentationSupported,
      capabilityMenuState?.tuttiMode?.enabled,
      hasCompactableContext,
      goalSupported,
      provider,
      slashCommandPolicy
    ]
  );
  const filteredCommands = useMemo(
    () =>
      slashQuery === null
        ? []
        : filterSlashCommands(resolvedSlashCommands, slashQuery),
    [resolvedSlashCommands, slashQuery]
  );
  const filteredSkills = useMemo(
    () =>
      skillQueryMatch === null
        ? []
        : filterProviderSkillsForTrigger({
            skills: presentationSkills,
            query: skillQueryMatch.query,
            triggerPrefix: skillQueryMatch.prefix
          }),
    [presentationSkills, skillQueryMatch]
  );
  const availableCapabilities = useMemo<AgentCapabilityTokenOption[]>(() => {
    if (capabilityControlsReadOnly) {
      return [];
    }
    const entries: AgentCapabilityTokenOption[] = [];
    if (composerSettings.supportsBrowser) {
      entries.push({
        capability: "browserUse",
        label: labels.browserUseCapabilityLabel,
        name: "browser",
        trigger: "/browser"
      });
    }
    if (computerPresentationSupported) {
      entries.push({
        capability: "computerUse",
        label: labels.computerUseCapabilityLabel,
        name: "computer",
        trigger: "/computer"
      });
    }
    return entries;
  }, [
    capabilityControlsReadOnly,
    composerSettings.supportsBrowser,
    computerPresentationSupported,
    labels.browserUseCapabilityLabel,
    labels.computerUseCapabilityLabel
  ]);
  const slashPaletteEntries = useMemo<AgentSlashPaletteEntry[]>(() => {
    const commandEntries: AgentSlashPaletteEntry[] =
      filteredCommands.flatMap<AgentSlashPaletteEntry>((command) => {
        if (isSlashCommandCapability(command)) {
          const browserConnectionMode =
            capabilityMenuState?.browserUse?.connectionMode ?? null;
          const computerUseInstalled =
            capabilityMenuState?.computerUse?.installed ?? null;
          const computerUseAuthorization =
            capabilityMenuState?.computerUse?.authorization ?? null;
          const capLabel =
            command.capability === "tutti"
              ? labels.tuttiModeLabel
              : command.capability === "computerUse"
                ? labels.computerUseCapabilityLabel
                : labels.browserUseCapabilityLabel;
          const capDescription =
            command.capability === "tutti"
              ? labels.tuttiModeDescription
              : command.capability === "computerUse"
                ? computerUseInstalled === false
                  ? labels.computerUseCapabilitySetupRequiredDescription
                  : computerUseAuthorization === "needs-authorization"
                    ? labels.computerUseCapabilityAuthorizationRequiredDescription
                    : computerUseAuthorization === "unknown"
                      ? labels.computerUseCapabilityAuthorizationUnknownDescription
                      : labels.computerUseCapabilityDescription
                : browserConnectionMode === "autoConnect"
                  ? labels.browserUseCapabilityDescriptionAutoConnect
                  : browserConnectionMode === "isolated"
                    ? labels.browserUseCapabilityDescriptionIsolated
                    : labels.browserUseCapabilityDescription;
          const capSettingsLabel =
            command.capability === "tutti"
              ? labels.tuttiModeLabel
              : command.capability === "computerUse"
                ? labels.computerUseCapabilitySettingsLabel
                : labels.browserUseCapabilitySettingsLabel;
          const capabilityEntry: AgentSlashPaletteEntry = {
            type: "capability",
            key: `capability:${command.capability}`,
            label: capLabel,
            description: capDescription,
            settingsAriaLabel: capSettingsLabel,
            // Tutti Mode has no inline settings surface (its "settings" button
            // was a no-op), so omit the label to drop the button entirely; the
            // row body still toggles the capability.
            settingsLabel:
              command.capability === "tutti"
                ? undefined
                : labels.capabilityInlineSettingsLabel,
            disabled: capabilityControlsReadOnly,
            selectAction:
              command.capability === "computerUse" &&
              (!computerExecutable ||
                computerUseInstalled === false ||
                (computerUseInstalled === true &&
                  (computerUseAuthorization === "needs-authorization" ||
                    computerUseAuthorization === "unknown")))
                ? "settings"
                : "capability",
            capability: command
          };
          return [capabilityEntry];
        }
        const commandDescription = slashCommandDescriptionForDisplay(
          command,
          labels
        );
        const commandEntry: AgentSlashPaletteEntry = {
          type: "command",
          key: `command:${command.name}`,
          label: labelForSlashCommand(command),
          ...slashCommandLabelForDisplay(command, labels, uiLanguage),
          ...(commandDescription ? { description: commandDescription } : {}),
          command
        };
        return [commandEntry];
      });
    const skillEntries: AgentSlashPaletteEntry[] = filteredSkills.map(
      (skill) => {
        const trigger = skillTriggerForPrefix(skill, skillQueryMatch?.prefix);
        return {
          type: "skill",
          key: `skill:${trigger}`,
          label: labelForProviderSkill(skill, skillQueryMatch?.prefix),
          ...(skillDescriptionForDisplay(skill.description)
            ? { description: skillDescriptionForDisplay(skill.description) }
            : {}),
          skill
        };
      }
    );
    const connectorEntries = skillEntries.filter(
      (entry) =>
        entry.type === "skill" &&
        (entry.skill.sourceKind === "connector" ||
          entry.skill.kind === "connector")
    );
    const nonConnectorSkillEntries = skillEntries.filter(
      (entry) => !connectorEntries.includes(entry)
    );
    return [
      ...commandEntries,
      ...connectorEntries,
      ...nonConnectorSkillEntries
    ];
  }, [
    capabilityMenuState?.browserUse?.connectionMode,
    capabilityMenuState?.computerUse?.authorization,
    capabilityMenuState?.computerUse?.installed,
    computerExecutable,
    capabilityControlsReadOnly,
    filteredCommands,
    filteredSkills,
    labels.browserUseCapabilityDescription,
    labels.browserUseCapabilityDescriptionAutoConnect,
    labels.browserUseCapabilityDescriptionIsolated,
    labels.browserUseCapabilityLabel,
    labels.capabilityInlineSettingsLabel,
    labels.browserUseCapabilitySettingsLabel,
    labels.computerUseCapabilityDescription,
    labels.computerUseCapabilityAuthorizationRequiredDescription,
    labels.computerUseCapabilityAuthorizationUnknownDescription,
    labels.computerUseCapabilitySetupRequiredDescription,
    labels.computerUseCapabilityLabel,
    labels.computerUseCapabilitySettingsLabel,
    labels.tuttiModeDescription,
    labels.tuttiModeLabel,
    labels.slashCommandCompactLabel,
    labels.slashCommandContextLabel,
    labels.slashCommandFastLabel,
    labels.slashCommandGoalLabel,
    labels.slashCommandInitLabel,
    labels.slashCommandPlanLabel,
    labels.slashCommandReviewLabel,
    labels.slashCommandStatusLabel,
    labels.slashCommandUsageLabel,
    labels.slashCommandCompactDescription,
    labels.slashCommandContextDescription,
    labels.slashCommandFastDescription,
    labels.slashCommandGoalDescription,
    labels.slashCommandInitDescription,
    labels.slashCommandPlanDescription,
    labels.slashCommandReviewDescription,
    labels.slashCommandStatusDescription,
    labels.slashCommandUsageDescription,
    uiLanguage,
    skillQueryMatch?.prefix
  ]);
  return {
    availableCapabilities,
    filteredSkills,
    resolvedSlashCommands,
    skillQueryMatch,
    slashPaletteEntries,
    slashQuery,
    slashCommandPolicy,
    promptBeforeSelection
  };
}
