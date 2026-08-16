import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import { ComposerConnectorsMenu } from "./ComposerConnectorsMenu";

const labels = {
  connectors: "Connectors",
  connectorConnected: "Connected",
  connectorConnect: "Connect",
  connectorAuthorize: "Authorize",
  connectorEmpty: "No connectors available",
  connectorMore: "View more connectors"
};

function connector(
  key: string,
  status: AgentGUIProviderSkillOption["status"]
): AgentGUIProviderSkillOption {
  return {
    connectorKey: key,
    kind: "connector",
    name: `Connector ${key}`,
    sourceKind: "connector",
    status,
    trigger: `/${key}`
  };
}

describe("ComposerConnectorsMenu", () => {
  it("summarizes connected connectors in a compact preview group", () => {
    const connectedConnectors = Array.from({ length: 5 }, (_, index) => ({
      ...connector(`connected-${index}`, "available"),
      iconUrl: `/connector-${index}.png`
    }));
    render(
      <ComposerConnectorsMenu
        connectors={connectedConnectors}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenConnectors={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("connector-market-composer-preview-connected-0")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("connector-market-composer-preview-connected-2")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-market-composer-preview-connected-3")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("connector-market-composer-preview-count")
    ).toHaveTextContent("+2");
  });

  it("shows connected versus connect actions and opens the catalog footer", async () => {
    const onOpenConnector = vi.fn();
    const onOpenConnectors = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ComposerConnectorsMenu
        connectors={[
          connector("github", "available"),
          connector("notion", "authRequired"),
          connector("lark", "setupRequired")
        ]}
        disabled={false}
        labels={labels}
        onOpenChange={onOpenChange}
        onOpenConnector={onOpenConnector}
        onOpenConnectors={onOpenConnectors}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });

    const connected = await screen.findByTestId(
      "connector-market-composer-item-github"
    );
    expect(connected).toHaveTextContent("Connected");
    expect(
      screen.getByTestId("connector-market-composer-status-github")
    ).toHaveClass("ml-auto");
    expect(connected).toHaveAttribute("data-disabled");
    expect(
      screen.getByTestId("connector-market-composer-item-notion")
    ).toHaveTextContent("Authorize");
    const connectAction = screen.getByTestId(
      "connector-market-composer-item-lark"
    );
    fireEvent.pointerDown(connectAction, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });
    expect(onOpenConnector).toHaveBeenCalledWith("lark");
    expect(onOpenConnector).toHaveBeenCalledOnce();
    expect(
      screen.queryByTestId("connector-market-composer-item-lark")
    ).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });
    fireEvent.pointerDown(
      await screen.findByTestId("connector-market-composer-more"),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    expect(onOpenConnectors).toHaveBeenCalledOnce();
    expect(
      screen.queryByTestId("connector-market-composer-more")
    ).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("replaces connected state with authorize when connector status refreshes", async () => {
    const props = {
      disabled: false,
      labels,
      onOpenConnector: vi.fn(),
      onOpenConnectors: vi.fn()
    };
    const rendered = render(
      <ComposerConnectorsMenu
        {...props}
        connectors={[connector("lark-cli", "available")]}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });
    expect(
      await screen.findByTestId("connector-market-composer-status-lark-cli")
    ).toHaveTextContent("Connected");

    rendered.rerender(
      <ComposerConnectorsMenu
        {...props}
        connectors={[connector("lark-cli", "authRequired")]}
      />
    );

    expect(
      screen.queryByTestId("connector-market-composer-status-lark-cli")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("connector-market-composer-item-lark-cli")
    ).toHaveTextContent("Authorize");
  });

  it("limits the quick connector projection to ten catalog entries", async () => {
    const connectors = Array.from({ length: 12 }, (_, index) =>
      connector(`connector-${index}`, "setupRequired")
    );
    render(
      <ComposerConnectorsMenu
        connectors={[
          {
            name: "Ordinary skill",
            sourceKind: "personal",
            trigger: "$skill"
          },
          ...connectors
        ]}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenConnectors={vi.fn()}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });

    expect(
      await screen.findByTestId("connector-market-composer-item-connector-9")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-market-composer-item-connector-10")
    ).not.toBeInTheDocument();
  });
});
