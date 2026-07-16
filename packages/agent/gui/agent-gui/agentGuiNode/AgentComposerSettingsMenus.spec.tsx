import { render } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPermissionModeDropdown } from "./AgentComposerSettingsMenus";
import type { AgentGUIComposerSettingsVM } from "./model/agentGuiNodeTypes";

describe("AgentPermissionModeDropdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays controlled while permission settings resolve", () => {
    const consoleWarn = vi.spyOn(console, "warn");
    const view = render(
      <TooltipProvider>
        <AgentPermissionModeDropdown
          composerSettings={composerSettings(null, true)}
          labels={{
            permissionLabel: "Permission",
            loadingOptions: "Loading",
            optionsLoadFailed: "Failed to load",
            optionsLoadFailedRetry: "Options failed to load. Click to retry."
          }}
          onSettingsChange={vi.fn()}
        />
      </TooltipProvider>
    );
    const loadingTrigger = view.getByRole("combobox", {
      name: "Permission"
    });

    view.rerender(
      <TooltipProvider>
        <AgentPermissionModeDropdown
          composerSettings={composerSettings("full-access")}
          labels={{
            permissionLabel: "Permission",
            loadingOptions: "Loading",
            optionsLoadFailed: "Failed to load",
            optionsLoadFailedRetry: "Options failed to load. Click to retry."
          }}
          onSettingsChange={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(view.getByRole("combobox", { name: "Permission" })).toBe(
      loadingTrigger
    );

    view.rerender(
      <TooltipProvider>
        <AgentPermissionModeDropdown
          composerSettings={composerSettings(null, true)}
          labels={{
            permissionLabel: "Permission",
            loadingOptions: "Loading",
            optionsLoadFailed: "Failed to load",
            optionsLoadFailedRetry: "Options failed to load. Click to retry."
          }}
          onSettingsChange={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(view.getByRole("combobox", { name: "Permission" })).toBe(
      loadingTrigger
    );
    expect(
      consoleWarn.mock.calls.some((call) =>
        String(call[0]).includes(
          "Select is changing from uncontrolled to controlled"
        )
      )
    ).toBe(false);
  });

  it("renders a recoverable error state that retries the options load", () => {
    const onRetryOptions = vi.fn();
    const view = render(
      <TooltipProvider>
        <AgentPermissionModeDropdown
          composerSettings={{
            ...composerSettings(null, false),
            availablePermissionModes: [],
            settingsLoadFailed: true
          }}
          labels={{
            permissionLabel: "Permission",
            loadingOptions: "Loading",
            optionsLoadFailed: "Failed to load",
            optionsLoadFailedRetry: "Options failed to load. Click to retry."
          }}
          onRetryOptions={onRetryOptions}
          onSettingsChange={vi.fn()}
        />
      </TooltipProvider>
    );

    const retryButton = view.getByRole("button", { name: "Permission" });
    expect(retryButton.textContent).toContain("Failed to load");
    retryButton.click();
    expect(onRetryOptions).toHaveBeenCalledTimes(1);
  });
});

function composerSettings(
  selectedPermissionModeValue: string | null,
  isSettingsLoading = false
): AgentGUIComposerSettingsVM {
  return {
    sessionSettings: null,
    draftSettings: {
      model: null,
      reasoningEffort: null,
      speed: null,
      planMode: false,
      permissionModeId: selectedPermissionModeValue
    },
    supportsModel: false,
    supportsReasoningEffort: false,
    supportsSpeed: false,
    supportsPermissionMode: true,
    supportsPlanMode: false,
    isSettingsLoading,
    modelUnavailable: false,
    reasoningUnavailable: false,
    speedUnavailable: false,
    permissionModeUnavailable: false,
    selectedPermissionModeValue,
    availableModels: [],
    availableReasoningEfforts: [],
    availableSpeeds: [],
    availablePermissionModes: isSettingsLoading
      ? []
      : [{ value: "full-access", label: "Full access" }]
  };
}
