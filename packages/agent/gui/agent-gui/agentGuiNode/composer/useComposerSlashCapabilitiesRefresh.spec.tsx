import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "./AgentComposer.types";
import { useComposerPaletteCatalog } from "./useComposerPaletteCatalog";
import { useComposerSlashCapabilitiesRefresh } from "./useComposerSlashCapabilitiesRefresh";

describe("useComposerSlashCapabilitiesRefresh", () => {
  it("refreshes capabilities again when slash search is reopened", () => {
    const onRetryComposerOptions = vi.fn();
    const { result, rerender } = renderHook(
      ({ isPaletteOpen, skillVisible }) => {
        useComposerSlashCapabilitiesRefresh({
          agentSessionId: "session-1",
          isPaletteOpen,
          onRetryComposerOptions,
          slashQuery: ""
        });
        return useComposerPaletteCatalog({
          provider: "codex",
          isGoalModeActive: false,
          goalSupported: true,
          paletteDraftPrompt: "/",
          availableCommands: [],
          availableSkills: skillVisible
            ? [
                {
                  kind: "skill",
                  name: "session-created",
                  sourceKind: "personal",
                  trigger: "$session-created"
                }
              ]
            : [],
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
          } as unknown as AgentComposerProps["composerSettings"],
          capabilityControlsReadOnly: false,
          labels: {} as AgentComposerProps["labels"],
          uiLanguage: "en",
          editorHandleRef: { current: null }
        });
      },
      { initialProps: { isPaletteOpen: true, skillVisible: false } }
    );

    expect(onRetryComposerOptions).toHaveBeenCalledTimes(1);
    rerender({ isPaletteOpen: false, skillVisible: false });
    rerender({ isPaletteOpen: true, skillVisible: false });
    expect(onRetryComposerOptions).toHaveBeenCalledTimes(2);
    expect(onRetryComposerOptions).toHaveBeenLastCalledWith({
      force: true,
      section: "capabilities"
    });

    rerender({ isPaletteOpen: true, skillVisible: true });
    expect(
      result.current.slashPaletteEntries.some(
        (entry) => entry.type === "skill" && entry.label === "session-created"
      )
    ).toBe(true);
    expect(onRetryComposerOptions).toHaveBeenCalledTimes(2);
  });
});
