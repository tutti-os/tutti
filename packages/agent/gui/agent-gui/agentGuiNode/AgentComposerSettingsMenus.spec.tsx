import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentPermissionModeDropdown } from "./AgentComposerSettingsMenus";
import type { AgentGUIComposerSettingsVM } from "./model/agentGuiNodeTypes";

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
  });
});

describe("AgentPermissionModeDropdown", () => {
  it("dispatches one settings change for one permission selection", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentPermissionModeDropdown
        composerSettings={composerSettings()}
        labels={{
          loadingOptions: "Loading permission modes",
          permissionLabel: "Permission mode"
        }}
        onSettingsChange={onSettingsChange}
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Permission mode" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    const option = await screen.findByRole("option", { name: "Accept edits" });
    fireEvent.pointerDown(option, { button: 0, ctrlKey: false });
    fireEvent.click(option);

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith({
      permissionModeId: "acceptEdits",
      planMode: false
    });
  });
});

function composerSettings(): AgentGUIComposerSettingsVM {
  return {
    availableModels: [],
    availablePermissionModes: [
      { label: "Default", value: "default" },
      { label: "Accept edits", value: "acceptEdits" }
    ],
    availableReasoningEfforts: [],
    availableSpeeds: [],
    draftSettings: {
      browserUse: true,
      computerUse: true,
      model: null,
      permissionModeId: "default",
      planMode: false,
      reasoningEffort: null,
      speed: null
    },
    isSettingsLoading: false,
    modelUnavailable: true,
    permissionModeUnavailable: false,
    planExclusiveWithPermissionMode: true,
    reasoningUnavailable: true,
    selectedPermissionModeValue: "default",
    sessionSettings: null,
    speedUnavailable: true,
    supportsModel: false,
    supportsPermissionMode: true,
    supportsPlanMode: true,
    supportsReasoningEffort: false,
    supportsSpeed: false
  };
}
