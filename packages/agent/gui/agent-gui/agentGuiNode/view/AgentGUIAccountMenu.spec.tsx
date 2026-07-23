import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentGUIAccountAvatar,
  AgentGUIAccountMenu,
  type AgentGUIAccountMenuLabels
} from "./AgentGUIAccountMenu";
import type { AgentGUIAccountMenuState } from "../accountMenuState";

const labels: AgentGUIAccountMenuLabels = {
  title: "Account",
  member: "Membership",
  upgradeMembership: "Upgrade membership",
  rechargeCredits: "Recharge credits",
  viewCreditPlans: "View credit options",
  creditsBalance: "Credits",
  accountCenter: "Account center",
  settings: "Settings",
  free: "Free",
  signIn: "Sign in",
  signOut: "Sign out",
  copyUserId: "Copy user ID",
  loading: "Loading",
  unavailable: "--",
  dataUnavailable: "Some data is unavailable"
};

function state(
  membershipAccess: AgentGUIAccountMenuState["membershipAccess"]
): AgentGUIAccountMenuState {
  return {
    user: { userId: "user-1", name: "Tutti User" },
    membershipLabel: "Pro",
    membershipAccess,
    creditsLabel: "128",
    loading: false,
    error: null,
    links: {
      planUrl: "https://example.test/plan",
      usageUrl: "https://example.test/usage",
      settingsUrl: "https://example.test/settings"
    },
    onOpenChange: vi.fn(),
    onLogin: vi.fn(),
    onOpenExternal: vi.fn()
  };
}

describe("AgentGUIAccountMenu", () => {
  it("shows recharge guidance for active members and uses Host links", () => {
    const menuState = state("active");
    render(
      <AgentGUIAccountMenu
        state={menuState}
        labels={labels}
        trigger={<button type="button">Open account</button>}
      />
    );

    fireEvent.click(screen.getByText("Open account"));
    expect(screen.getByText("Recharge credits")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy();
    fireEvent.click(screen.getByText("Membership"));
    expect(menuState.onOpenExternal).toHaveBeenCalledWith(
      "https://example.test/plan"
    );
  });

  it("fails closed to neutral guidance when membership access is unknown", () => {
    const menuState = state("unknown");
    menuState.membershipLabel = "";
    render(
      <AgentGUIAccountMenu
        state={menuState}
        labels={labels}
        trigger={<button type="button">Open account</button>}
      />
    );

    fireEvent.click(screen.getByText("Open account"));
    expect(screen.getByText("View credit options")).toBeTruthy();
    expect(screen.getByText("--")).toBeTruthy();
    expect(screen.queryByText("Free")).toBeNull();
  });

  it.each([
    ["free", "Upgrade membership"],
    ["inactive", "Upgrade membership"],
    ["active", "Recharge credits"]
  ] as const)(
    "shows the expected action for %s membership",
    (access, action) => {
      render(
        <AgentGUIAccountMenu
          state={state(access)}
          labels={labels}
          trigger={<button type="button">Open account</button>}
        />
      );

      fireEvent.click(screen.getByText("Open account"));
      expect(screen.getByText(action)).toBeTruthy();
    }
  );

  it("renders sign-in without exposing member actions when signed out", () => {
    const menuState = state("unknown");
    menuState.user = null;
    render(
      <AgentGUIAccountMenu
        state={menuState}
        labels={labels}
        trigger={<button type="button">Open account</button>}
      />
    );

    fireEvent.click(screen.getByText("Open account"));
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByText("Membership")).toBeNull();
  });

  it("disables Host actions when their links are unavailable", () => {
    const menuState = state("active");
    menuState.links = { planUrl: "", usageUrl: "", settingsUrl: "" };
    render(
      <AgentGUIAccountMenu
        state={menuState}
        labels={labels}
        trigger={<button type="button">Open account</button>}
      />
    );

    fireEvent.click(screen.getByText("Open account"));
    expect(screen.getByText("Membership").closest("button")).toBeDisabled();
    expect(screen.getByText("Credits").closest("button")).toBeDisabled();
    expect(screen.getByText("Account center").closest("button")).toBeDisabled();
  });

  it("shows loading and partial-error states without inferring membership", () => {
    const menuState = state("unknown");
    menuState.membershipLabel = "";
    menuState.creditsLabel = null;
    menuState.loading = true;
    menuState.partialError = true;
    render(
      <AgentGUIAccountMenu
        state={menuState}
        labels={labels}
        trigger={<button type="button">Open account</button>}
      />
    );

    fireEvent.click(screen.getByText("Open account"));
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.getByText("Some data is unavailable")).toBeTruthy();
    expect(screen.getByText("View credit options")).toBeTruthy();
  });

  it("delegates right-click user ID copying to the Host", async () => {
    const menuState = state("active");
    menuState.onCopyUserId = vi.fn();
    render(
      <AgentGUIAccountMenu
        state={menuState}
        labels={labels}
        trigger={
          <AgentGUIAccountAvatar state={menuState} label={labels.copyUserId}>
            <button type="button">Avatar</button>
          </AgentGUIAccountAvatar>
        }
      />
    );

    fireEvent.contextMenu(screen.getByText("Avatar"));
    fireEvent.click(await screen.findByText("Copy user ID"));
    expect(menuState.onCopyUserId).toHaveBeenCalledOnce();
  });
});
