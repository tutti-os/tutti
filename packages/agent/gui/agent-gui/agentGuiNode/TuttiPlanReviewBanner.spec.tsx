import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TuttiPlanReviewBanner } from "./TuttiPlanReviewBanner";

const labels = {
  title: "Plan review",
  hint: "Send to accept · type feedback to request changes",
  cancel: "Cancel plan"
};

describe("TuttiPlanReviewBanner", () => {
  it("surfaces the plan title with the decision hint", () => {
    render(
      <TuttiPlanReviewBanner
        labels={labels}
        planTitle="Ship the durable workflow"
        submitting={false}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText("Plan review")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-tutti-plan-banner-description")
    ).toHaveTextContent(
      "Ship the durable workflow · Send to accept · type feedback to request changes"
    );
  });

  it("cancels the plan from the banner action, blocked while submitting", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <TuttiPlanReviewBanner
        labels={labels}
        planTitle="Plan"
        submitting={false}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <TuttiPlanReviewBanner
        labels={labels}
        planTitle="Plan"
        submitting={true}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("button", { name: "Cancel plan" })).toBeDisabled();
  });
});
