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

  it("keeps a shared connector catalog inspectable without mutation or management actions", () => {
    const onCapabilitySettingsRequest = vi.fn();
    const onConnectorSelected = vi.fn();
    render(
      <ComposerPrimaryCapabilityControl
        availableSkills={[
          {
            connectorKey: "github",
            description: "Authorization required on the owner device.",
            kind: "connector",
            name: "GitHub",
            sourceKind: "connector",
            status: "authRequired",
            trigger: "/github"
          }
        ]}
        connectorsReadOnly
        connectorsVisible
        disabled={false}
        labels={labels}
        loading={false}
        onCapabilitySettingsRequest={onCapabilitySettingsRequest}
        onConnectorSelected={onConnectorSelected}
        selectedConnectorKeys={[]}
        showConnectorViewMore={false}
      />
    );

    fireEvent.pointerDown(
      screen.getByTestId("connector-market-composer-trigger"),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    const item = screen.getByTestId("connector-market-composer-item-github");
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(
      "Authorization required on the owner device."
    );
    expect(
      screen.queryByTestId("connector-market-composer-more")
    ).not.toBeInTheDocument();

    fireEvent.pointerDown(item, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });
    expect(onCapabilitySettingsRequest).not.toHaveBeenCalled();
    expect(onConnectorSelected).not.toHaveBeenCalled();
  });
});
