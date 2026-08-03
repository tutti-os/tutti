import { useMemo, type RefObject } from "react";
import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type {
  AgentGUIComposerSettingsVM,
  AgentGUIProviderSkillOption
} from "../model/agentGuiNodeTypes";
import type { AgentHostComposerCapability } from "../../../host/agentHostApi";
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
import {
  shouldHideSkillPresentationEntry,
  skillPresentationEntries
} from "./skillPresentationEntries";

const EMPTY_HIDDEN_SLASH_SKILL_ENTRY_IDS = new Set<string>();

interface UseComposerPaletteCatalogInput {
  provider: string;
  isGoalModeActive: boolean;
  goalSupported: boolean;
  paletteDraftPrompt: string;
  availableCommands: readonly AgentSessionCommand[];
  availableSkills: readonly AgentGUIProviderSkillOption[];
  hiddenSlashSkillEntryIds?: ReadonlySet<string>;
  nativeCapabilities?: readonly AgentHostComposerCapability[];
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
  hiddenSlashSkillEntryIds = EMPTY_HIDDEN_SLASH_SKILL_ENTRY_IDS,
  nativeCapabilities = [],
  hasCompactableContext,
  compactSupported,
  composerSettings,
  capabilityMenuState,
  capabilityControlsReadOnly,
  labels,
  uiLanguage,
  editorHandleRef
}: UseComposerPaletteCatalogInput) {
  const slashQuery = isGoalModeActive
    ? null
    : getPromptStartSlashCommandQuery(paletteDraftPrompt);
  const slashCommandPolicy = composerSettings.slashCommandPolicy;
  const promptBeforeSelection =
    editorHandleRef.current?.getPromptTextBeforeSelection() ?? "";
  const skillQueryDraft = promptBeforeSelection || paletteDraftPrompt;
  const skillQueryMatch = getAgentComposerTriggerQueryMatch(skillQueryDraft);
  const availableSkillEntries = useMemo(
    () => skillPresentationEntries(availableSkills),
    [availableSkills]
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
        // Native inventory is presentation-only in this PR. Existing Browser
        // and Computer slash/token execution stays unchanged until the
        // turn-scoped native invocation lifecycle lands independently.
        browserSupported: Boolean(composerSettings.supportsBrowser),
        computerSupported: Boolean(composerSettings.supportsComputerUse),
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
      composerSettings.supportsComputerUse,
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
  const filteredSkillEntries = useMemo(() => {
    if (skillQueryMatch === null) {
      return [];
    }
    const normalizedQuery = skillQueryMatch.query.trim().toLowerCase();
    return availableSkillEntries.filter((entry) => {
      if (
        shouldHideSkillPresentationEntry({
          entryId: entry.entryId,
          hiddenSlashSkillEntryIds,
          prefix: skillQueryMatch.prefix
        })
      ) {
        return false;
      }
      const trigger = skillTriggerForPrefix(
        entry.skill,
        skillQueryMatch.prefix
      );
      if (!normalizedQuery) {
        return true;
      }
      const description = entry.skill.description?.trim().toLowerCase() ?? "";
      return (
        entry.skill.name.trim().toLowerCase().startsWith(normalizedQuery) ||
        trigger.trim().toLowerCase().slice(1).startsWith(normalizedQuery) ||
        description.includes(normalizedQuery)
      );
    });
  }, [availableSkillEntries, hiddenSlashSkillEntryIds, skillQueryMatch]);
  const filteredSkills = useMemo(
    () => filteredSkillEntries.map((entry) => entry.skill),
    [filteredSkillEntries]
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
    if (composerSettings.supportsComputerUse) {
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
    composerSettings.supportsComputerUse,
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
              (computerUseInstalled === false ||
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
    const nativeCapabilityEntries: AgentSlashPaletteEntry[] =
      slashQuery === null
        ? []
        : nativeCapabilitiesForSlashPresentation(
            nativeCapabilities,
            resolvedSlashCommands
          )
            // Browser and Computer already have selectable, provider-neutral
            // capability rows. Keeping a second, disabled native row next to
            // them makes the same command appear unavailable even though its
            // established token and submit path still work. Sites has no
            // legacy row, so it remains the inventory-only presentation.
            .filter((capability) =>
              nativeCapabilityMatchesSlashQuery(capability, slashQuery)
            )
            .map((capability) => ({
              type: "nativeCapability" as const,
              key: `native-capability:${capability.id}`,
              label: capability.label,
              ...(capability.description
                ? { description: capability.description }
                : {}),
              // This PR deliberately limits the catalog to presentation and
              // mapping. Turn-scoped invocation and Computer authorization
              // have a separate lifecycle PR.
              disabled: true as const,
              capability
            }));
    const skillEntries: AgentSlashPaletteEntry[] = filteredSkillEntries.map(
      (entry) => {
        const skill = entry.skill;
        return {
          type: "skill",
          key: entry.entryId,
          label: labelForProviderSkill(skill, skillQueryMatch?.prefix),
          ...(skillDescriptionForDisplay(skill.description)
            ? { description: skillDescriptionForDisplay(skill.description) }
            : {}),
          skill
        };
      }
    );
    return [...commandEntries, ...nativeCapabilityEntries, ...skillEntries];
  }, [
    capabilityMenuState?.browserUse?.connectionMode,
    capabilityMenuState?.computerUse?.authorization,
    capabilityMenuState?.computerUse?.installed,
    capabilityControlsReadOnly,
    filteredCommands,
    filteredSkillEntries,
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
    nativeCapabilities,
    resolvedSlashCommands,
    slashQuery,
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

function nativeCapabilityMatchesSlashQuery(
  capability: AgentHostComposerCapability,
  query: string
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return (
    capability.label.toLowerCase().includes(normalizedQuery) ||
    capability.semantic.toLowerCase().includes(normalizedQuery) ||
    capability.description?.toLowerCase().includes(normalizedQuery) === true
  );
}

export function nativeCapabilitiesForSlashPresentation(
  capabilities: readonly AgentHostComposerCapability[],
  commands: readonly AgentSlashCommand[]
): readonly AgentHostComposerCapability[] {
  return capabilities.filter(
    (capability) => !nativeCapabilityHasLegacySlashAction(capability, commands)
  );
}

function nativeCapabilityHasLegacySlashAction(
  capability: AgentHostComposerCapability,
  commands: readonly AgentSlashCommand[]
): boolean {
  const legacyCapability =
    capability.semantic === "browserUse"
      ? "browserUse"
      : capability.semantic === "computerUse"
        ? "computerUse"
        : null;
  return (
    legacyCapability !== null &&
    commands.some(
      (command) =>
        isSlashCommandCapability(command) &&
        command.capability === legacyCapability
    )
  );
}
