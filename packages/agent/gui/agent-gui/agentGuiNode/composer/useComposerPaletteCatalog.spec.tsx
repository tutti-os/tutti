import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentGUIComposerSettingsVM } from "../model/agentGuiNodeTypes";
import type { AgentComposerProps } from "./AgentComposer.types";
import { useComposerPaletteCatalog } from "./useComposerPaletteCatalog";

describe("useComposerPaletteCatalog", () => {
  it("places connector entries before ordinary skills", () => {
    const { result } = renderHook(() =>
      useComposerPaletteCatalog({
        provider: "codex",
        isGoalModeActive: false,
        goalSupported: false,
        paletteDraftPrompt: "/",
        availableCommands: [],
        availableSkills: [
          {
            name: "review",
            trigger: "$review",
            sourceKind: "project",
            kind: "skill"
          },
          {
            name: "GitHub",
            connectorKey: "github",
            iconUrl: "data:image/png;base64,Z2l0aHVi",
            trigger: "/github",
            sourceKind: "connector",
            kind: "connector",
            status: "available"
          }
        ],
        hasCompactableContext: false,
        compactSupported: false,
        composerSettings: {
          supportsPlanMode: false,
          supportsBrowser: false,
          supportsComputerUse: false,
          slashCommandPolicy: {
            fallbackCommands: [],
            commandEffects: [],
            commandCatalogAuthoritative: true
          }
        } as unknown as AgentGUIComposerSettingsVM,
        capabilityControlsReadOnly: false,
        labels: {} as AgentComposerProps["labels"],
        uiLanguage: "en",
        editorHandleRef: { current: null }
      })
    );

    expect(
      result.current.slashPaletteEntries
        .filter((entry) => entry.type === "skill")
        .map((entry) => entry.label)
    ).toEqual(["github", "review"]);
  });
});
