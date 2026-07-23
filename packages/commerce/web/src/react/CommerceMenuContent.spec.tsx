import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommerceMenuState } from "../index";
import {
  CommerceMenuContent,
  type CommerceMenuLabels
} from "./CommerceMenuContent";
import { MembershipBadge } from "./MembershipBadge";
import { MembershipTierIcon } from "./MembershipTierIcon";

const labels: CommerceMenuLabels = {
  member: "Membership",
  upgradeMembership: "Upgrade",
  rechargeCredits: "Recharge",
  viewCreditPlans: "View plans",
  creditsBalance: "Credits",
  accountCenter: "Account center",
  loading: "Loading",
  unavailable: "Unavailable",
  dataUnavailable: "Some data is unavailable"
};

afterEach(cleanup);

function state(
  membershipAccess: CommerceMenuState["membershipAccess"]
): CommerceMenuState {
  return {
    membershipLabel: "Basic",
    membershipAccess,
    creditsLabel: "20",
    loading: false,
    dataUnavailable: false,
    links: {
      planUrl: "https://example.test/plans",
      usageUrl: "https://example.test/usage",
      settingsUrl: "https://example.test/settings"
    },
    onOpenExternal: vi.fn()
  };
}

describe("CommerceMenuContent", () => {
  it("renders Basic with the Tutti Lite visual asset", () => {
    render(<MembershipTierIcon tierKey="basic" />);
    expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
      "data-membership-tier-visual",
      "lite"
    );
  });

  it("renders the canonical Basic visual inside the shared membership badge", () => {
    render(<MembershipBadge label="Basic" tierKey="basic" />);
    expect(screen.getByText("Basic").parentElement).toHaveAttribute(
      "data-commerce-membership-badge",
      "true"
    );
    expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
      "data-membership-tier-visual",
      "lite"
    );
  });

  it("does not invent a free visual for an unknown tier", () => {
    const { container } = render(<MembershipTierIcon tierKey="unknown" />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["free", "Upgrade"],
    ["inactive", "Upgrade"],
    ["active", "Recharge"],
    ["unknown", "View plans"]
  ] as const)("renders the %s membership action", (access, actionLabel) => {
    render(<CommerceMenuContent state={state(access)} labels={labels} />);
    expect(screen.getByText(actionLabel)).toBeInTheDocument();
  });

  it("does not invoke an empty Host URL", () => {
    const menuState = state("active");
    menuState.links.planUrl = "";
    render(<CommerceMenuContent state={menuState} labels={labels} />);
    expect(screen.getByText("Membership").closest("button")).toBeDisabled();
  });

  it("uses Host links without embedding a Commerce destination", () => {
    const menuState = state("active");
    render(<CommerceMenuContent state={menuState} labels={labels} />);
    fireEvent.click(screen.getByText("Membership"));
    expect(menuState.onOpenExternal).toHaveBeenCalledWith(
      "https://example.test/plans"
    );
  });

  it("reports rejected Host actions without leaking an unhandled rejection", async () => {
    const menuState = state("active");
    const error = new Error("open failed");
    menuState.onOpenExternal = vi.fn().mockRejectedValue(error);
    menuState.onActionError = vi.fn();
    render(<CommerceMenuContent state={menuState} labels={labels} />);
    fireEvent.click(screen.getByText("Membership"));
    await vi.waitFor(() => {
      expect(menuState.onActionError).toHaveBeenCalledWith(error);
    });
  });

  it("disables every Host action whose link is unavailable", () => {
    const menuState = state("active");
    menuState.links = { planUrl: "", usageUrl: "", settingsUrl: "" };
    render(<CommerceMenuContent state={menuState} labels={labels} />);
    expect(screen.getByText("Membership").closest("button")).toBeDisabled();
    expect(screen.getByText("Credits").closest("button")).toBeDisabled();
    expect(screen.getByText("Account center").closest("button")).toBeDisabled();
  });

  it("shows loading and sanitized unavailability without inferring membership", () => {
    const menuState = state("unknown");
    menuState.membershipLabel = "";
    menuState.creditsLabel = null;
    menuState.loading = true;
    menuState.dataUnavailable = true;
    render(<CommerceMenuContent state={menuState} labels={labels} />);
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.getByText("Some data is unavailable")).toBeInTheDocument();
    expect(screen.getByText("View plans")).toBeInTheDocument();
    expect(screen.queryByText("upstream secret")).not.toBeInTheDocument();
  });
});
