import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentGUIComposerSettingsVM } from "../model/agentGuiNodeTypes";
import { resolveSlashCommandSubmitEffect } from "../model/agentSlashCommandProviderPolicy";
import type { AgentComposerProps } from "./AgentComposer.types";
import { useComposerPaletteCatalog } from "./useComposerPaletteCatalog";

describe("useComposerPaletteCatalog", () => {
  it("shows host-managed computer use as a capability while daemon readiness is false", () => {
    const { result } = renderHook(() =>
      useComposerPaletteCatalog({
        provider: "codex",
        isGoalModeActive: false,
        goalSupported: false,
        paletteDraftPrompt: "/",
        availableCommands: [],
        availableSkills: [],
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
        capabilityMenuState: {
          computerUse: {
            authorization: "authorized",
            installed: true,
            presentationSupported: true
          }
        },
        capabilityControlsReadOnly: false,
        labels: {
          computerUseCapabilityDescription: "Control the computer",
          computerUseCapabilityLabel: "Computer use",
          computerUseCapabilitySettingsLabel: "Computer use settings",
          capabilityInlineSettingsLabel: "Settings"
        } as AgentComposerProps["labels"],
        uiLanguage: "en",
        editorHandleRef: { current: null }
      })
    );

    expect(result.current.availableCapabilities).toEqual([
      {
        capability: "computerUse",
        label: "Computer use",
        name: "computer",
        trigger: "/computer"
      }
    ]);
    expect(
      result.current.slashPaletteEntries.find(
        (entry) => entry.key === "capability:computerUse"
      )
    ).toMatchObject({ selectAction: "settings", type: "capability" });
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "codex",
        policy: result.current.slashCommandPolicy,
        computerSupported: false,
        commands: result.current.resolvedSlashCommands,
        draft: "/computer click Confirm"
      })
    ).toBeNull();
  });

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

  it("removes connector entries immediately when the host disables them", () => {
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
        capabilityMenuState: { connectors: { enabled: false } },
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
    ).toEqual(["review"]);
  });

  it("shows /tutti only while the host Tutti Mode gate is enabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useComposerPaletteCatalog({
          provider: "codex",
          isGoalModeActive: false,
          goalSupported: false,
          paletteDraftPrompt: "/",
          availableCommands: [],
          availableSkills: [],
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
          capabilityMenuState: { tuttiMode: { enabled } },
          capabilityControlsReadOnly: false,
          labels: {
            tuttiModeDescription: "Coordinate work",
            tuttiModeLabel: "Tutti Mode"
          } as AgentComposerProps["labels"],
          uiLanguage: "en",
          editorHandleRef: { current: null }
        }),
      { initialProps: { enabled: false } }
    );

    const tuttiEntry = () =>
      result.current.slashPaletteEntries.find(
        (entry) => entry.key === "capability:tutti"
      );

    expect(tuttiEntry()).toBeUndefined();
    rerender({ enabled: true });
    expect(tuttiEntry()).toMatchObject({
      capability: { capability: "tutti", name: "tutti" },
      label: "Tutti Mode",
      type: "capability"
    });
    rerender({ enabled: false });
    expect(tuttiEntry()).toBeUndefined();
  });
});
