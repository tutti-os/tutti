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
  it("hides the capability slot when connectors are disabled", () => {
    const { container } = render(
      <ComposerPrimaryCapabilityControl
        availableSkills={[]}
        connectorsVisible={false}
        disabled={false}
        labels={labels}
        loading={false}
        onCapabilitySettingsRequest={vi.fn()}
        onConnectorSelected={vi.fn()}
        selectedConnectorKeys={[]}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows only connectors when connectors are enabled", () => {
    const onRetryComposerOptions = vi.fn();
    render(
      <ComposerPrimaryCapabilityControl
        availableSkills={[]}
        connectorsVisible
        disabled={false}
        labels={labels}
        loading
        onRetryComposerOptions={onRetryComposerOptions}
        onCapabilitySettingsRequest={vi.fn()}
        onConnectorSelected={vi.fn()}
        selectedConnectorKeys={[]}
      />
    );

    expect(
      screen.getByTestId("connector-market-composer-trigger")
    ).toBeInTheDocument();
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
