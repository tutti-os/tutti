import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TuttiPlanReviewBanner } from "./TuttiPlanReviewBanner";

const labels = {
  title: "Plan review",
  hint: "Send to accept · type feedback to request changes",
  hintReplan: "Intensity changed · send to re-plan at the new intensity",
  cancel: "Cancel plan"
};

const intensityPopoverLabels = {
  title: "Tutti intensity",
  intensityLabel: "Intensity",
  intensityMin: "Minimal",
  intensityMax: "Maximal",
  previewTitle: "Planner tendency",
  previewHint:
    "The exact model and task graph are inferred from the request and selected Skills.",
  previewCost: "Cost",
  previewBalance: "Balance",
  previewPowerful: "Powerful",
  modelStrengthLabel: "Model strength",
  modelStrengthCost: "Economical",
  modelStrengthBalance: "Balanced",
  modelStrengthPowerful: "Most capable",
  agentCountLabel: "Agent count",
  agentCountCost: "1",
  agentCountBalance: "2–3",
  agentCountPowerful: "Up to 4 parallel",
  confirm: "Confirm",
  cancel: "Cancel"
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

  it("hosts the intensity entry and flips the hint once diverged", () => {
    const { rerender } = render(
      <TuttiPlanReviewBanner
        labels={labels}
        planTitle="Plan"
        submitting={false}
        intensity={60}
        intensityDiverged={false}
        intensityPopoverLabels={intensityPopoverLabels}
        onIntensityChange={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const chip = screen.getByTestId("agent-gui-tutti-plan-banner-intensity");
    expect(chip).toHaveTextContent("60");
    expect(
      screen.getByTestId("agent-gui-tutti-plan-banner-description")
    ).toHaveTextContent(labels.hint);

    rerender(
      <TuttiPlanReviewBanner
        labels={labels}
        planTitle="Plan"
        submitting={false}
        intensity={85}
        intensityDiverged={true}
        intensityPopoverLabels={intensityPopoverLabels}
        onIntensityChange={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("agent-gui-tutti-plan-banner-intensity")
    ).toHaveTextContent("85");
    expect(
      screen.getByTestId("agent-gui-tutti-plan-banner-description")
    ).toHaveTextContent(labels.hintReplan);
  });

  it("omits the intensity entry without a change handler", () => {
    render(
      <TuttiPlanReviewBanner
        labels={labels}
        planTitle="Plan"
        submitting={false}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.queryByTestId("agent-gui-tutti-plan-banner-intensity")
    ).not.toBeInTheDocument();
  });
});
