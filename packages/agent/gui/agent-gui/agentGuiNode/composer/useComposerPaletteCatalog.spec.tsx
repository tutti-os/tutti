import { createRef } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentRichTextEditorHandle } from "../agentRichText/AgentRichTextEditor";
import type {
  AgentGUIComposerSettingsVM,
  AgentGUIProviderSkillOption
} from "../model/agentGuiNodeTypes";
import type { AgentComposerProps } from "./AgentComposer.types";
import { useComposerPaletteCatalog } from "./useComposerPaletteCatalog";

describe("useComposerPaletteCatalog", () => {
  it("keeps ordinary skills and connectors selectable while preserving native plugins", () => {
    const regularSkill: AgentGUIProviderSkillOption = {
      name: "review",
      trigger: "$review",
      sourceKind: "personal",
      kind: "skill"
    };
    const connector: AgentGUIProviderSkillOption = {
      name: "linear",
      trigger: "$linear",
      sourceKind: "connector",
      kind: "connector"
    };
    const browserPlugin: AgentGUIProviderSkillOption = {
      name: "Browser",
      trigger: "$browser",
      sourceKind: "plugin",
      kind: "plugin",
      semantic: "browserUse",
      status: "available"
    };
    const computerPlugin: AgentGUIProviderSkillOption = {
      name: "Computer",
      trigger: "",
      sourceKind: "plugin",
      kind: "plugin",
      semantic: "computerUse",
      status: "setupRequired"
    };

    const { result } = renderHook(() =>
      useComposerPaletteCatalog({
        provider: "claude-code",
        isGoalModeActive: false,
        goalSupported: false,
        paletteDraftPrompt: "$",
        availableCommands: [],
        availableSkills: [
          regularSkill,
          connector,
          browserPlugin,
          computerPlugin
        ],
        hasCompactableContext: false,
        compactSupported: false,
        composerSettings: composerSettings(),
        capabilityControlsReadOnly: false,
        labels: labels(),
        uiLanguage: "en",
        editorHandleRef: createRef<AgentRichTextEditorHandle>()
      })
    );

    expect(result.current.slashPaletteEntries).toEqual([
      {
        type: "skill",
        key: "skill:$review",
        label: "review",
        skill: regularSkill
      },
      {
        type: "skill",
        key: "skill:$linear",
        label: "linear",
        skill: connector
      },
      {
        type: "plugin",
        key: "plugin:browserUse",
        label: "Browser",
        selectAction: "insert",
        disabled: false,
        plugin: browserPlugin
      },
      {
        type: "plugin",
        key: "plugin:computerUse",
        label: "Computer",
        selectAction: "settings",
        disabled: false,
        plugin: computerPlugin
      }
    ]);
  });
});

function composerSettings(): AgentGUIComposerSettingsVM {
  return {
    slashCommandPolicy: null,
    supportsPlanMode: false,
    supportsBrowser: false,
    supportsComputerUse: false
  } as AgentGUIComposerSettingsVM;
}

function labels(): AgentComposerProps["labels"] {
  return {
    browserUseCapabilityLabel: "Browser",
    computerUseCapabilityLabel: "Computer"
  } as AgentComposerProps["labels"];
}
