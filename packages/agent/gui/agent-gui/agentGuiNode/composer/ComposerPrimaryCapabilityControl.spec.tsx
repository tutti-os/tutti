import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

function renderControl(
  overrides: Partial<
    Parameters<typeof ComposerPrimaryCapabilityControl>[0]
  > = {}
) {
  return render(
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
      tuttiModeSupported={false}
      {...overrides}
    />
  );
}

describe("ComposerPrimaryCapabilityControl", () => {
  it("hides every Tutti entry point when its host gate is off", () => {
    const { container } = renderControl();

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the Tutti switch and routes activation when its host gate is on", () => {
    const onTuttiModeChange = vi.fn();
    renderControl({ onTuttiModeChange, tuttiModeSupported: true });

    expect(
      screen.getByTestId("agent-gui-composer-tutti-mode-toggle")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-market-composer-trigger")
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByTestId("agent-gui-composer-tutti-mode-toggle-switch")
    );
    expect(onTuttiModeChange).toHaveBeenCalledWith(true);
  });

  it("shows the Tutti switch alongside connectors when both gates are on", () => {
    const onRetryComposerOptions = vi.fn();
    renderControl({
      connectorsVisible: true,
      loading: true,
      onRetryComposerOptions,
      tuttiModeSupported: true
    });

    expect(
      screen.getByTestId("connector-market-composer-trigger")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-composer-tutti-mode-toggle")
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

  it("routes the runtime switch to the host instead of draft selection", () => {
    const onCapabilitySettingsRequest = vi.fn();
    const onConnectorSelected = vi.fn();
    renderControl({
      availableSkills: [
        {
          connectorKey: "github",
          kind: "connector",
          name: "GitHub",
          sourceKind: "connector",
          status: "available",
          trigger: "/github"
        }
      ],
      connectorsVisible: true,
      onCapabilitySettingsRequest,
      onConnectorSelected
    });

    fireEvent.pointerDown(
      screen.getByTestId("connector-market-composer-trigger"),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    fireEvent.pointerDown(
      screen.getByTestId("connector-market-composer-status-github"),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );

    expect(onCapabilitySettingsRequest).toHaveBeenCalledWith({
      kind: "connector",
      connectorKey: "github",
      action: "set_runtime_enabled",
      enabled: false
    });
    expect(onConnectorSelected).not.toHaveBeenCalled();
  });

  it("routes setup-required connectors directly to installation", async () => {
    let completeInstall!: () => void;
    const onCapabilitySettingsRequest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeInstall = resolve;
        })
    );
    const onRetryComposerOptions = vi.fn();
    render(
      <ComposerPrimaryCapabilityControl
        availableSkills={[
          {
            connectorKey: "canva",
            kind: "connector",
            name: "Canva",
            sourceKind: "connector",
            status: "setupRequired",
            trigger: "/canva"
          }
        ]}
        connectorsVisible
        disabled={false}
        isTuttiModeActive={false}
        isTuttiModeUpdating={false}
        labels={labels}
        loading={false}
        onCapabilitySettingsRequest={onCapabilitySettingsRequest}
        onConnectorSelected={vi.fn()}
        onRetryComposerOptions={onRetryComposerOptions}
        selectedConnectorKeys={[]}
        tuttiModeSupported={false}
      />
    );

    fireEvent.pointerDown(
      screen.getByTestId("connector-market-composer-trigger"),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    const item = screen.getByTestId("connector-market-composer-item-canva");
    fireEvent.pointerDown(item, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });

    expect(onCapabilitySettingsRequest).toHaveBeenCalledWith({
      kind: "connector",
      connectorKey: "canva",
      action: "install"
    });
    expect(item).toHaveAttribute("aria-busy", "true");

    await act(async () => completeInstall());
    expect(onRetryComposerOptions).toHaveBeenCalledWith({
      section: "connectors"
    });
  });

  it("keeps a shared connector catalog inspectable without mutation or management actions", () => {
    const onCapabilitySettingsRequest = vi.fn();
    const onConnectorSelected = vi.fn();
    renderControl({
      availableSkills: [
        {
          connectorKey: "github",
          description: "Authorization required on the owner device.",
          kind: "connector",
          name: "GitHub",
          sourceKind: "connector",
          status: "authRequired",
          trigger: "/github"
        }
      ],
      connectorsReadOnly: true,
      connectorsVisible: true,
      onCapabilitySettingsRequest,
      onConnectorSelected,
      showConnectorViewMore: false
    });

    fireEvent.pointerDown(
      screen.getByTestId("connector-market-composer-trigger"),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    const item = screen.getByTestId("connector-market-composer-item-github");
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("GitHub");
    expect(item).not.toHaveTextContent(
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
