import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorComposerMenu,
  type ConnectorComposerItem
} from "./ConnectorComposerMenu";

afterEach(cleanup);

const labels = {
  connectors: "Connectors",
  connected: "Authorized",
  connect: "Connect",
  authorize: "Authorize",
  empty: "No connectors available",
  loading: "Loading connectors…",
  more: "View more connectors",
  selected: "Selected"
};

function connector(
  key: string,
  status: ConnectorComposerItem["status"],
  selected = false
): ConnectorComposerItem {
  return {
    connectorKey: key,
    name: `Connector ${key}`,
    status,
    selected
  };
}

describe("ConnectorComposerMenu", () => {
  it("shows loading instead of an empty state while the first catalog request is pending", async () => {
    render(
      <ConnectorComposerMenu
        items={[]}
        disabled={false}
        labels={labels}
        loading
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });

    expect(
      await screen.findByTestId("connector-market-composer-loading")
    ).toHaveTextContent("Loading connectors…");
    expect(
      screen.queryByText("No connectors available")
    ).not.toBeInTheDocument();
  });

  it("keeps the last successful connector list visible during a refresh", async () => {
    render(
      <ConnectorComposerMenu
        items={[connector("github", "connected")]}
        disabled={false}
        labels={labels}
        loading
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });

    expect(
      await screen.findByTestId("connector-market-composer-item-github")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-market-composer-loading")
    ).not.toBeInTheDocument();
  });

  it("summarizes authorized connectors without requiring draft selection", () => {
    const connectedConnectors = Array.from({ length: 5 }, (_, index) => ({
      ...connector(`connected-${index}`, "connected"),
      iconUrl: `/connector-${index}.png`
    }));
    render(
      <ConnectorComposerMenu
        items={connectedConnectors}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
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

  it("shows runtime state versus setup actions and opens the catalog footer", async () => {
    const onOpenConnector = vi.fn();
    const onOpenMarket = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConnectorComposerMenu
        items={[
          connector("github", "connected"),
          connector("notion", "authorization_required"),
          connector("lark", "setup_required")
        ]}
        disabled={false}
        labels={labels}
        onOpenChange={onOpenChange}
        onOpenConnector={onOpenConnector}
        onOpenMarket={onOpenMarket}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });

    const connected = await screen.findByTestId(
      "connector-market-composer-item-github"
    );
    expect(
      screen.getByTestId("connector-market-composer-status-github")
    ).toBeChecked();
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
    expect(onOpenMarket).toHaveBeenCalledOnce();
    expect(
      screen.queryByTestId("connector-market-composer-more")
    ).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("distinguishes authorized connectors from composer selection", async () => {
    const onSelectConnector = vi.fn();
    const rendered = render(
      <ConnectorComposerMenu
        items={[connector("notion", "connected")]}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
        onSelectConnector={onSelectConnector}
      />
    );

    expect(
      screen.getByTestId("connector-market-composer-preview-notion")
    ).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });
    const authorized = await screen.findByTestId(
      "connector-market-composer-item-notion"
    );
    expect(
      screen.getByTestId("connector-market-composer-status-notion")
    ).toBeChecked();
    expect(authorized).not.toHaveAttribute("data-disabled");
    fireEvent.pointerDown(authorized, { button: 0, ctrlKey: false });
    expect(onSelectConnector).toHaveBeenCalledWith("notion", true);

    rendered.rerender(
      <ConnectorComposerMenu
        items={[connector("notion", "connected", true)]}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
        onSelectConnector={onSelectConnector}
      />
    );
    expect(
      screen.getByTestId("connector-market-composer-preview-notion")
    ).toBeInTheDocument();
  });

  it("replaces connected state with authorize when connector status refreshes", async () => {
    const props = {
      disabled: false,
      labels,
      onOpenConnector: vi.fn(),
      onOpenMarket: vi.fn()
    };
    const rendered = render(
      <ConnectorComposerMenu
        {...props}
        items={[connector("lark-cli", "connected")]}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });
    expect(
      await screen.findByTestId("connector-market-composer-status-lark-cli")
    ).toBeChecked();

    rendered.rerender(
      <ConnectorComposerMenu
        {...props}
        items={[connector("lark-cli", "authorization_required")]}
      />
    );

    expect(
      screen.queryByTestId("connector-market-composer-status-lark-cli")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("connector-market-composer-item-lark-cli")
    ).toHaveTextContent("Authorize");
  });

  it("renders an installed but stopped connector as switched off", async () => {
    render(
      <ConnectorComposerMenu
        items={[connector("linear", "disabled")]}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });

    expect(
      await screen.findByTestId("connector-market-composer-status-linear")
    ).not.toBeChecked();
  });

  it("limits the quick connector projection to ten catalog entries", async () => {
    const connectors = Array.from({ length: 12 }, (_, index) =>
      connector(`connector-${index}`, "setup_required")
    );
    render(
      <ConnectorComposerMenu
        items={connectors}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
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

  it("prioritizes connected connectors before applying the quick menu limit", async () => {
    const setupRequiredConnectors = Array.from({ length: 10 }, (_, index) =>
      connector(`setup-${index}`, "setup_required")
    );
    render(
      <ConnectorComposerMenu
        items={[
          ...setupRequiredConnectors,
          connector("connected-after-limit", "connected")
        ]}
        disabled={false}
        labels={labels}
        onOpenConnector={vi.fn()}
        onOpenMarket={vi.fn()}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Connectors" }), {
      button: 0,
      ctrlKey: false
    });

    const quickItems = await screen.findAllByTestId(
      /^connector-market-composer-item-/
    );
    expect(quickItems).toHaveLength(10);
    expect(quickItems[0]).toHaveAttribute(
      "data-testid",
      "connector-market-composer-item-connected-after-limit"
    );
    expect(
      screen.queryByTestId("connector-market-composer-item-setup-9")
    ).not.toBeInTheDocument();
  });
});
