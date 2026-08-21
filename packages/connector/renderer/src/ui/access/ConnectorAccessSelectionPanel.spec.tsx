import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorAccessSelectionPanel,
  type ConnectorAccessSelectionPanelProps,
  type ConnectorAccessSelectionState
} from "./ConnectorAccessSelectionPanel";

afterEach(cleanup);

const labels = {
  back: "Back",
  cancel: "Cancel",
  confirm: "Confirm access",
  description: "Choose which connectors this consumer may use",
  empty: "No connectors are available",
  error: "Connectors could not be loaded",
  loading: "Loading connectors",
  title: "Connector access"
};

const readyState: ConnectorAccessSelectionState = {
  status: "ready",
  items: [
    {
      connectorKey: "github",
      description: "Connected",
      iconUrl: "/github.png",
      name: "GitHub"
    },
    {
      connectorKey: "notion",
      description: "Installed",
      name: "Notion"
    }
  ]
};

function createProps(
  overrides: Partial<ConnectorAccessSelectionPanelProps> = {}
): ConnectorAccessSelectionPanelProps {
  return {
    labels,
    onBack: vi.fn(),
    onCancel: vi.fn(),
    onSelectionChange: vi.fn(),
    onSubmit: vi.fn(),
    selectedConnectorKeys: ["notion"],
    state: readyState,
    ...overrides
  };
}

describe("ConnectorAccessSelectionPanel", () => {
  it("presents loading without claiming the catalog is empty", () => {
    render(
      <ConnectorAccessSelectionPanel
        {...createProps({ state: { status: "loading" } })}
      />
    );

    expect(
      screen.getByRole("status", { name: "Loading connectors" })
    ).toBeInTheDocument();
    expect(screen.queryByText(labels.empty)).not.toBeInTheDocument();
    expect(screen.queryByText(labels.error)).not.toBeInTheDocument();
  });

  it("presents an explicit catalog error", () => {
    render(
      <ConnectorAccessSelectionPanel
        {...createProps({ state: { status: "error" } })}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(labels.error);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("presents an authoritative empty ready catalog", () => {
    render(
      <ConnectorAccessSelectionPanel
        {...createProps({ state: { items: [], status: "ready" } })}
      />
    );

    expect(screen.getByText(labels.empty)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders ready items and their controlled selection", () => {
    render(<ConnectorAccessSelectionPanel {...createProps()} />);

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "GitHub" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notion" })).toBeChecked();
  });

  it("emits the complete controlled selection without imposing host ordering", () => {
    const onSelectionChange = vi.fn();
    const props = createProps({ onSelectionChange });
    const rendered = render(<ConnectorAccessSelectionPanel {...props} />);

    fireEvent.click(screen.getByText("GitHub"));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["notion", "github"]);

    rendered.rerender(
      <ConnectorAccessSelectionPanel
        {...props}
        selectedConnectorKeys={["github", "notion"]}
      />
    );
    fireEvent.click(screen.getByText("Notion"));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["github"]);
  });

  it("keeps an individually disabled item visible and inert", () => {
    const onSelectionChange = vi.fn();
    render(
      <ConnectorAccessSelectionPanel
        {...createProps({
          onSelectionChange,
          state: {
            items: [
              {
                connectorKey: "github",
                description: "Unavailable for this consumer",
                disabled: true,
                name: "GitHub"
              }
            ],
            status: "ready"
          }
        })}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "GitHub" });
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: labels.confirm })).toBeEnabled();
  });

  it("blocks every interaction when the panel is disabled", () => {
    const props = createProps({ disabled: true });
    render(<ConnectorAccessSelectionPanel {...props} />);

    const controls = [
      screen.getByRole("button", { name: labels.back }),
      screen.getByRole("checkbox", { name: "GitHub" }),
      screen.getByRole("button", { name: labels.cancel }),
      screen.getByRole("button", { name: labels.confirm })
    ];
    for (const control of controls) {
      expect(control).toBeDisabled();
      fireEvent.click(control);
    }

    expect(props.onBack).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onSelectionChange).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("locks the panel and shows submit progress while busy", () => {
    const props = createProps({ busy: true });
    render(<ConnectorAccessSelectionPanel {...props} />);

    const panel = screen.getByRole("region", { name: labels.title });
    const submit = screen.getByRole("button", { name: labels.confirm });
    expect(panel).toHaveAttribute("aria-busy", "true");
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(submit.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: labels.back })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "GitHub" })).toBeDisabled();
    expect(screen.getByRole("button", { name: labels.cancel })).toBeDisabled();
  });

  it("dispatches navigation, cancellation, and submission independently", () => {
    const props = createProps();
    render(<ConnectorAccessSelectionPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: labels.back }));
    fireEvent.click(screen.getByRole("button", { name: labels.cancel }));
    fireEvent.click(screen.getByRole("button", { name: labels.confirm }));

    expect(props.onBack).toHaveBeenCalledOnce();
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });
});
