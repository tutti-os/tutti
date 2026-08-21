import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from "@tutti-os/ui-system";
import type { CommerceMenuState } from "../index";
import {
  AgentConfigCommerceContent,
  type AgentConfigCommerceLabels
} from "./AgentConfigCommerceContent";

const labels: AgentConfigCommerceLabels = {
  account: "Tutti Agent account",
  membership: "Membership",
  creditsBalance: "Credits",
  refresh: "Refresh",
  refreshing: "Refreshing",
  freeMembership: "Free",
  accountCenter: "Account center",
  loading: "Loading",
  unavailable: "Unavailable",
  dataUnavailable: "Some account data is unavailable"
};

afterEach(cleanup);

function state(overrides: Partial<CommerceMenuState> = {}): CommerceMenuState {
  return {
    membershipLabel: "Pro",
    membershipAccess: "active",
    creditsLabel: "42.50",
    loading: false,
    dataUnavailable: false,
    links: {
      planUrl: "https://example.test/plan",
      usageUrl: "https://example.test/usage",
      settingsUrl: "https://example.test/settings"
    },
    onOpenExternal: vi.fn(),
    ...overrides
  };
}

function CommerceMenuHarness({
  menuState,
  onRefresh
}: {
  menuState: CommerceMenuState;
  onRefresh: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>More</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AgentConfigCommerceContent
          accountName="Mia"
          labels={labels}
          onRefresh={onRefresh}
          presentation="menu"
          state={menuState}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("AgentConfigCommerceContent", () => {
  it("registers account actions and keeps the menu open while refreshing", () => {
    const menuState = state();
    const onRefresh = vi.fn();
    render(<CommerceMenuHarness menuState={menuState} onRefresh={onRefresh} />);

    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Membership Pro" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders account, clickable credits, membership, and account center", () => {
    const menuState = state();
    const onRefresh = vi.fn();
    render(
      <AgentConfigCommerceContent
        accountName="Mia"
        state={menuState}
        labels={labels}
        onRefresh={onRefresh}
      />
    );

    expect(screen.getByText("Mia")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-config-commerce-credits")
    ).toHaveTextContent("42.50");
    expect(screen.getByText("Pro")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Credits 42.50" }));
    fireEvent.click(screen.getByRole("button", { name: "Membership Pro" }));
    fireEvent.click(screen.getByText("Account center"));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(menuState.onOpenExternal).toHaveBeenNthCalledWith(
      1,
      "https://example.test/usage"
    );
    expect(menuState.onOpenExternal).toHaveBeenNthCalledWith(
      2,
      "https://example.test/plan"
    );
    expect(menuState.onOpenExternal).toHaveBeenNthCalledWith(
      3,
      "https://example.test/settings"
    );
  });

  it("reports rejected Host external actions", async () => {
    const onActionError = vi.fn();
    const menuState = state({
      onOpenExternal: vi.fn().mockRejectedValue(new Error("open failed")),
      onActionError
    });
    render(
      <AgentConfigCommerceContent
        accountName="Mia"
        state={menuState}
        labels={labels}
        onRefresh={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Membership Pro" }));

    await waitFor(() => expect(onActionError).toHaveBeenCalledOnce());
  });

  it("shows initial loading and disables duplicate refreshes", () => {
    render(
      <AgentConfigCommerceContent
        accountName={null}
        state={state({
          membershipLabel: "",
          creditsLabel: null,
          loading: true
        })}
        labels={labels}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getAllByText("Loading")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Refreshing" })).toBeDisabled();
  });

  it("keeps refresh available when the credits destination is missing", () => {
    const menuState = state({
      links: {
        planUrl: "https://example.test/plan",
        usageUrl: "",
        settingsUrl: "https://example.test/settings"
      }
    });
    const onRefresh = vi.fn();
    render(
      <AgentConfigCommerceContent
        accountName="Mia"
        state={menuState}
        labels={labels}
        onRefresh={onRefresh}
      />
    );

    const creditsButton = screen.getByRole("button", {
      name: "Credits 42.50"
    });
    expect(creditsButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();

    fireEvent.click(creditsButton);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(menuState.onOpenExternal).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("can omit the account identity row for compact Agent config menus", () => {
    render(
      <AgentConfigCommerceContent
        accountName="Mia"
        showAccountIdentity={false}
        state={state()}
        labels={labels}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.queryByText("Tutti Agent account")).not.toBeInTheDocument();
    expect(screen.queryByText("Mia")).not.toBeInTheDocument();
    expect(screen.getByText("Credits")).toBeInTheDocument();
    expect(screen.getByText("Membership")).toBeInTheDocument();
  });

  it("uses the free membership fallback without inventing a paid tier", () => {
    render(
      <AgentConfigCommerceContent
        accountName="Mia"
        state={state({ membershipAccess: "free", membershipLabel: "" })}
        labels={labels}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Membership Free" })
    ).toBeInTheDocument();
  });
});
