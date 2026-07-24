import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentModelReasoningDropdown,
  AgentPermissionModeDropdown
} from "./AgentComposerSettingsMenus";
import type { AgentGUIComposerSettingsVM } from "./model/agentGuiNodeTypes";
import type { AgentComposerSettingsMenuLabels } from "./model/composerSettingsMenuModel";
import {
  CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY,
  isCodexFullAccessWarningAcknowledged
} from "./view/agentFullAccessWarningPreference";

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
  });
});

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("AgentModelReasoningDropdown", () => {
  it("favorites a model without selecting the parent menu item", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentModelReasoningDropdown
        composerSettings={composerModelSettings()}
        labels={modelSettingsLabels}
        modelHistoryTargetId="target-1"
        onSettingsChange={onSettingsChange}
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Model / Reasoning" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    const favoriteToggle = (
      await screen.findAllByRole("button", { name: "Add to favorites" })
    )[1]!;

    fireEvent.pointerDown(favoriteToggle, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });
    fireEvent.pointerUp(favoriteToggle, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Remove from favorites" })
    ).toHaveAttribute("data-favorited", "true");
    expect(
      globalThis.localStorage.getItem(
        "agent-gui:composer-model-favorites:target-1"
      )
    ).toBe('["gpt-5.4"]');
    expect(screen.getByText("Model selection")).toBeInTheDocument();
  });

  it("favorites a model through keyboard click activation", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentModelReasoningDropdown
        composerSettings={composerModelSettings()}
        labels={modelSettingsLabels}
        modelHistoryTargetId="target-1"
        onSettingsChange={onSettingsChange}
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Model / Reasoning" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    const favoriteToggle = (
      await screen.findAllByRole("button", { name: "Add to favorites" })
    )[1]!;

    fireEvent.click(favoriteToggle, { detail: 0 });

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Remove from favorites" })
    ).toHaveAttribute("data-favorited", "true");
    expect(
      globalThis.localStorage.getItem(
        "agent-gui:composer-model-favorites:target-1"
      )
    ).toBe('["gpt-5.4"]');
    expect(screen.getByText("Model selection")).toBeInTheDocument();
  });
});

describe("AgentPermissionModeDropdown", () => {
  it("dispatches one settings change for one permission selection", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentPermissionModeDropdown
        composerSettings={composerSettings()}
        provider="claude-code"
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

  it("requires confirmation before enabling Codex full access", async () => {
    const onLinkAction = vi.fn();
    const onSettingsChange = vi.fn();
    render(
      <AgentPermissionModeDropdown
        composerSettings={composerSettingsWithFullAccess()}
        onLinkAction={onLinkAction}
        provider="codex"
        labels={{
          loadingOptions: "Loading permission modes",
          permissionLabel: "Permission mode"
        }}
        onSettingsChange={onSettingsChange}
      />
    );

    await selectPermissionOption("Full access");

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Enable full access?" })
    ).toBeInTheDocument();

    const learnMoreLink = screen.getByRole("link", { name: "Learn more" });
    expect(learnMoreLink).toHaveClass("text-primary");
    fireEvent.click(learnMoreLink);
    expect(onLinkAction).toHaveBeenCalledWith({
      source: "agent-full-access-warning",
      type: "open-url",
      url: "https://deploymentsafety.openai.com/gpt-5-6"
    });

    fireEvent.click(screen.getByRole("button", { name: "Enable full access" }));

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith({
      permissionModeId: "full-access",
      planMode: false
    });
    expect(isCodexFullAccessWarningAcknowledged()).toBe(true);
    expect(
      globalThis.localStorage.getItem(
        CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY
      )
    ).toBe("1");
  });

  it("keeps full access selected after confirmation", async () => {
    function Harness() {
      const [permissionModeId, setPermissionModeId] = useState("read-only");
      const settings = composerSettingsWithFullAccess();
      settings.draftSettings.permissionModeId = permissionModeId;
      settings.selectedPermissionModeValue = permissionModeId;
      return (
        <AgentPermissionModeDropdown
          composerSettings={settings}
          provider="codex"
          labels={{
            loadingOptions: "Loading permission modes",
            permissionLabel: "Permission mode"
          }}
          onSettingsChange={(patch) => {
            if (patch.permissionModeId) {
              setPermissionModeId(patch.permissionModeId);
            }
          }}
        />
      );
    }

    render(<Harness />);
    await selectPermissionOption("Full access");
    fireEvent.click(screen.getByRole("button", { name: "Enable full access" }));

    expect(
      screen.getByRole("combobox", {
        hidden: true,
        name: "Permission mode"
      })
    ).toHaveTextContent("Full access");
  });

  it("keeps the current Codex mode when full access is canceled", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentPermissionModeDropdown
        composerSettings={composerSettingsWithFullAccess()}
        provider="codex"
        labels={{
          loadingOptions: "Loading permission modes",
          permissionLabel: "Permission mode"
        }}
        onSettingsChange={onSettingsChange}
      />
    );

    await selectPermissionOption("Full access");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("does not gate another provider's full-access mode", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentPermissionModeDropdown
        composerSettings={composerSettingsWithFullAccess()}
        provider="opencode"
        labels={{
          loadingOptions: "Loading permission modes",
          permissionLabel: "Permission mode"
        }}
        onSettingsChange={onSettingsChange}
      />
    );

    await selectPermissionOption("Full access");

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", { name: "Enable full access?" })
    ).not.toBeInTheDocument();
  });

  it("explains why permission changes are disabled during a running turn", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentPermissionModeDropdown
        composerSettings={composerSettings()}
        disabled
        disabledTooltip="Permissions cannot change during a running turn"
        provider="codex"
        labels={{
          loadingOptions: "Loading permission modes",
          permissionLabel: "Permission mode"
        }}
        onSettingsChange={onSettingsChange}
      />
    );

    const trigger = screen.getByRole("combobox", {
      name: "Permission mode"
    });
    expect(trigger).toBeDisabled();

    const tooltipTarget = trigger.parentElement;
    expect(tooltipTarget).not.toBeNull();
    fireEvent.pointerMove(tooltipTarget as HTMLElement, {
      pointerType: "mouse"
    });

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Permissions cannot change during a running turn"
    );
    expect(onSettingsChange).not.toHaveBeenCalled();
  });
});

async function selectPermissionOption(optionName: string): Promise<void> {
  fireEvent.pointerDown(
    screen.getByRole("combobox", { name: "Permission mode" }),
    { button: 0, ctrlKey: false, pointerType: "mouse" }
  );
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerDown(option, { button: 0, ctrlKey: false });
  fireEvent.click(option);
}

function composerSettingsWithFullAccess(): AgentGUIComposerSettingsVM {
  return {
    ...composerSettings(),
    availablePermissionModes: [
      { label: "Ask for approval", value: "read-only" },
      { label: "Full access", value: "full-access" }
    ],
    draftSettings: {
      ...composerSettings().draftSettings,
      permissionModeId: "read-only"
    },
    selectedPermissionModeValue: "read-only"
  };
}

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

function composerModelSettings(): AgentGUIComposerSettingsVM {
  return {
    ...composerSettings(),
    availableModels: [
      { label: "GPT-5.5", value: "gpt-5.5" },
      { label: "GPT-5.4", value: "gpt-5.4" }
    ],
    draftSettings: {
      ...composerSettings().draftSettings,
      model: "gpt-5.5"
    },
    modelUnavailable: false,
    selectedModelValue: "gpt-5.5",
    supportsModel: true
  };
}

const modelSettingsLabels: AgentComposerSettingsMenuLabels = {
  modelLabel: "Model",
  modelSelectionLabel: "Model selection",
  modelContextWindowSuffix: "context window",
  modelTooltipVersionLabel: "Version",
  defaultModel: "Default model",
  loadingOptions: "Loading…",
  inheritedUnavailable: "Unavailable",
  reasoningLabel: "Reasoning",
  reasoningDegreeLabel: "Reasoning degree",
  reasoningOptionDefault: "Default",
  reasoningOptionMinimal: "Minimal",
  reasoningOptionLow: "Low",
  reasoningOptionMedium: "Medium",
  reasoningOptionHigh: "High",
  reasoningOptionXHigh: "X-High",
  reasoningOptionMax: "Max",
  reasoningOptionUltra: "Ultra",
  speedLabel: "Speed",
  speedSelectionLabel: "Speed",
  speedOptionStandard: "Standard",
  speedOptionStandardDescription: "Standard speed",
  speedOptionFast: "Fast",
  speedOptionFastDescription: "Fast speed",
  permissionLabel: "Permission",
  planModeLabel: "Plan mode",
  modelDescriptions: {
    frontierComplexCoding: "Frontier",
    everydayCoding: "Everyday",
    smallFastCostEfficient: "Small",
    codingOptimized: "Coding",
    ultraFastCoding: "Ultra",
    professionalLongRunning: "Professional"
  }
};
