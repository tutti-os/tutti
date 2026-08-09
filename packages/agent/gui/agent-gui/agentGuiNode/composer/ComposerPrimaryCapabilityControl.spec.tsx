import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "./AgentComposer.types";
import { ComposerPrimaryCapabilityControl } from "./ComposerPrimaryCapabilityControl";

const labels = {
  addContentConnectors: "Connectors",
  addContentConnectorConnected: "Connected",
  addContentConnectorConnect: "Connect",
  addContentConnectorAuthorize: "Authorize",
  addContentConnectorEmpty: "No connectors available",
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
        onCapabilitySettingsRequest={vi.fn()}
        onTuttiModeChange={vi.fn()}
        tuttiModeSupported={true}
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-tutti-mode-toggle")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-composer-connectors-trigger")
    ).not.toBeInTheDocument();
  });

  it("shows only connectors when connectors are enabled", () => {
    render(
      <ComposerPrimaryCapabilityControl
        availableSkills={[]}
        connectorsVisible
        disabled={false}
        isTuttiModeActive={false}
        isTuttiModeUpdating={false}
        labels={labels}
        onCapabilitySettingsRequest={vi.fn()}
        onTuttiModeChange={vi.fn()}
        tuttiModeSupported={true}
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-connectors-trigger")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-composer-tutti-mode-toggle")
    ).not.toBeInTheDocument();
  });
});
