import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "./AgentComposer.types";
import { ComposerPrimaryCapabilityControl } from "./ComposerPrimaryCapabilityControl";

const labels = {
  addContentConnectors: "Connectors",
  addContentConnectorConnected: "Connected",
  addContentConnectorSelected: "Selected",
  addContentConnectorConnect: "Connect",
  addContentConnectorAuthorize: "Authorize",
  addContentConnectorEmpty: "No connectors available",
  addContentConnectorLoading: "Loading connectors…",
  addContentConnectorMore: "View more connectors",
  tuttiModeDescription: "Coordinate work",
  tuttiModeLabel: "Tutti Mode"
} as AgentComposerProps["labels"];

describe("ComposerPrimaryCapabilityControl", () => {
  it("shows Tutti Mode when connectors are disabled", () => {
    render(
      <ComposerPrimaryCapabilityControl
        availableSkills={[]}
        connectorsVisible={false}
        disabled={false}
        isTuttiModeActive={false}
        isTuttiModeUpdating={false}
        labels={labels}
        loading={false}
        onCapabilitySettingsRequest={vi.fn()}
        onConnectorSelected={vi.fn()}
        onTuttiModeChange={vi.fn()}
        selectedConnectorKeys={[]}
        tuttiModeSupported={true}
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-tutti-mode-toggle")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-market-composer-trigger")
    ).not.toBeInTheDocument();
  });

  it("shows only connectors when connectors are enabled", () => {
    const onRetryComposerOptions = vi.fn();
    render(
      <ComposerPrimaryCapabilityControl
        availableSkills={[]}
        connectorsVisible
        disabled={false}
        isTuttiModeActive={false}
        isTuttiModeUpdating={false}
        labels={labels}
        loading
        onRetryComposerOptions={onRetryComposerOptions}
        onCapabilitySettingsRequest={vi.fn()}
        onConnectorSelected={vi.fn()}
        onTuttiModeChange={vi.fn()}
        selectedConnectorKeys={[]}
        tuttiModeSupported={true}
      />
    );

    expect(
      screen.getByTestId("connector-market-composer-trigger")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-composer-tutti-mode-toggle")
    ).not.toBeInTheDocument();
    fireEvent.pointerDown(
      screen.getByTestId("connector-market-composer-trigger"),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    expect(onRetryComposerOptions).toHaveBeenCalledWith({
      section: "connectors"
    });
    expect(
      screen.getByTestId("connector-market-composer-loading")
    ).toHaveTextContent("Loading connectors…");
  });
});
