import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentGUIComposerSettingsVM } from "../model/agentGuiNodeTypes";
import type { AgentComposerProps } from "./AgentComposer.types";
import { skillPresentationEntries } from "./skillPresentationEntries";
import { useComposerPaletteCatalog } from "./useComposerPaletteCatalog";

const SKILL = {
  kind: "skill" as const,
  name: "sites:sites-building",
  path: "/plugins/sites/skills/build/SKILL.md",
  sourceKind: "bundled" as const,
  trigger: "$sites:sites-building"
};
const SKILL_ENTRY_ID = skillPresentationEntries([SKILL])[0]?.entryId ?? "";

describe("useComposerPaletteCatalog native inventory compatibility", () => {
  it("keeps existing slash and dollar Skill presentation plus legacy Browser and Computer without a native snapshot", () => {
    const slash = renderCatalog("/", new Set());
    expect(slash.result.current.filteredSkills).toEqual([SKILL]);
    expect(
      slash.result.current.availableCapabilities.map(({ name }) => name)
    ).toEqual(["browser", "computer"]);
    expect(
      slash.result.current.resolvedSlashCommands.map((command) => command.name)
    ).toEqual(expect.arrayContaining(["browser", "computer"]));

    const dollar = renderCatalog("$", new Set([SKILL_ENTRY_ID]));
    expect(dollar.result.current.filteredSkills).toEqual([SKILL]);
  });
});

function renderCatalog(
  paletteDraftPrompt: string,
  hiddenSlashSkillEntryIds: ReadonlySet<string>
) {
  return renderHook(() =>
    useComposerPaletteCatalog({
      availableCommands: [],
      availableSkills: [SKILL],
      capabilityControlsReadOnly: false,
      compactSupported: null,
      composerSettings: {
        slashCommandPolicy: null,
        supportsBrowser: true,
        supportsComputerUse: true,
        supportsPlanMode: false
      } as AgentGUIComposerSettingsVM,
      editorHandleRef: { current: null },
      hasCompactableContext: true,
      hiddenSlashSkillEntryIds,
      isGoalModeActive: false,
      goalSupported: true,
      labels: {
        browserUseCapabilityAuthorizationRequiredDescription: "",
        browserUseCapabilityDescription: "",
        browserUseCapabilityDescriptionAutoConnect: "",
        browserUseCapabilityDescriptionIsolated: "",
        browserUseCapabilityLabel: "Browser",
        browserUseCapabilitySettingsLabel: "",
        capabilityInlineSettingsLabel: "",
        computerUseCapabilityAuthorizationRequiredDescription: "",
        computerUseCapabilityAuthorizationUnknownDescription: "",
        computerUseCapabilityDescription: "",
        computerUseCapabilityLabel: "Computer",
        computerUseCapabilitySettingsLabel: "",
        computerUseCapabilitySetupRequiredDescription: "",
        slashCommandCompactDescription: "",
        slashCommandCompactLabel: "",
        slashCommandContextDescription: "",
        slashCommandContextLabel: "",
        slashCommandFastDescription: "",
        slashCommandFastLabel: "",
        slashCommandGoalDescription: "",
        slashCommandGoalLabel: "",
        slashCommandInitDescription: "",
        slashCommandInitLabel: "",
        slashCommandPlanDescription: "",
        slashCommandPlanLabel: "",
        slashCommandReviewDescription: "",
        slashCommandReviewLabel: "",
        slashCommandStatusDescription: "",
        slashCommandStatusLabel: "",
        slashCommandUsageDescription: "",
        slashCommandUsageLabel: "",
        tuttiModeDescription: "",
        tuttiModeLabel: ""
      } as unknown as AgentComposerProps["labels"],
      nativeCapabilities: [],
      paletteDraftPrompt,
      provider: "codex",
      uiLanguage: "en"
    })
  );
}
