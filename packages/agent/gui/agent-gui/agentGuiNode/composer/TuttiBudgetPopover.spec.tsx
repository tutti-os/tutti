import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TuttiBudgetPopover } from "./TuttiBudgetPopover";

const labels = {
  title: "Tutti orchestration",
  intensityLabel: "Orchestration intensity",
  previewTitle: "Planner tendency",
  previewHint:
    "The exact model, total task count, and safe parallelism are inferred from the request and selected Skills.",
  previewCost: "Cost",
  previewBalance: "Balance",
  previewPowerful: "Powerful",
  modelStrengthLabel: "Model strength",
  modelStrengthCost: "Economical",
  modelStrengthBalance: "Balanced",
  modelStrengthPowerful: "Most capable",
  agentCountLabel: "Parallel Agents",
  agentCountCost: "1",
  agentCountBalance: "2–3",
  agentCountPowerful: "Up to 4",
  confirm: "Confirm",
  cancel: "Cancel"
};

function renderPopover({ intensity = 50 } = {}) {
  const onConfirm = vi.fn();
  render(
    <TuttiBudgetPopover
      intensity={intensity}
      labels={labels}
      onConfirm={onConfirm}
    >
      <button type="button">Tutti</button>
    </TuttiBudgetPopover>
  );
  return { onConfirm };
}

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
  return screen.getByText("Tutti orchestration");
}

describe("TuttiBudgetPopover", () => {
  it("opens on badge click with a slider seeded from the effective intensity", () => {
    renderPopover({ intensity: 62 });
    expect(screen.queryByText("Tutti orchestration")).toBeNull();

    openPopover();

    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "62");
    expect(
      screen.getAllByRole("slider", { name: "Orchestration intensity" })
    ).toHaveLength(1);
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getAllByText("Balance").length).toBeGreaterThan(0);
    expect(screen.getByText("Powerful")).toBeInTheDocument();
  });

  it("links slider changes to the planning tendency, model strength, and Agent count", () => {
    renderPopover({ intensity: 33 });
    openPopover();

    const preview = document.querySelector("[data-agent-tutti-budget-preview]");
    const slider = document.querySelector(
      "[data-agent-tutti-budget-intensity-slider]"
    );
    expect(preview).toHaveAttribute("data-agent-tutti-budget-preview", "cost");
    expect(slider).toHaveAttribute(
      "data-agent-tutti-budget-slider-tone",
      "cost"
    );
    expect(
      document.querySelector("[data-agent-tutti-budget-model-strength]")
    ).toHaveTextContent("Economical");
    expect(
      document.querySelector("[data-agent-tutti-budget-agent-count]")
    ).toHaveTextContent("1");

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Orchestration intensity" }),
      { key: "ArrowRight" }
    );

    expect(preview).toHaveAttribute(
      "data-agent-tutti-budget-preview",
      "balance"
    );
    expect(slider).toHaveAttribute(
      "data-agent-tutti-budget-slider-tone",
      "balance"
    );
    expect(preview).toHaveTextContent("Balance");
    expect(
      document.querySelector("[data-agent-tutti-budget-model-strength]")
    ).toHaveTextContent("Balanced");
    expect(
      document.querySelector("[data-agent-tutti-budget-agent-count]")
    ).toHaveTextContent("2–3");
    expect(
      document.querySelector("[data-agent-tutti-budget-preview-marker]")
    ).not.toBeInTheDocument();
  });

  it("shows the powerful tendency at the upper intensity band", () => {
    renderPopover({ intensity: 67 });
    openPopover();

    const preview = document.querySelector("[data-agent-tutti-budget-preview]");
    expect(preview).toHaveAttribute(
      "data-agent-tutti-budget-preview",
      "powerful"
    );
    expect(preview).toHaveTextContent("Powerful");
    expect(
      document.querySelector("[data-agent-tutti-budget-model-strength]")
    ).toHaveTextContent("Most capable");
    expect(
      document.querySelector("[data-agent-tutti-budget-agent-count]")
    ).toHaveTextContent("Up to 4");
  });

  it("defers slider movement to the draft and commits on confirm", () => {
    const { onConfirm } = renderPopover({ intensity: 50 });
    openPopover();

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Orchestration intensity" }),
      { key: "ArrowRight" }
    );

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Tutti orchestration")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(51);
    expect(screen.queryByText("Tutti orchestration")).toBeNull();
  });

  it("cancel closes the popup without committing the draft", () => {
    const { onConfirm } = renderPopover({ intensity: 50 });
    openPopover();

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Orchestration intensity" }),
      { key: "ArrowRight" }
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText("Tutti orchestration")).toBeNull();
  });

  it("reseeds the draft from the effective value on every open", () => {
    const { onConfirm } = renderPopover({ intensity: 50 });
    openPopover();
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Orchestration intensity" }),
      { key: "ArrowRight" }
    );
    fireEvent.keyDown(document.body, { key: "Escape" });

    openPopover();

    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "50");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not close on outside pointerdown", () => {
    renderPopover();
    openPopover();

    fireEvent.pointerDown(document.body);

    expect(screen.getByText("Tutti orchestration")).toBeInTheDocument();
  });

  it("escape closes only the popup and prevents the default so it cannot leak", () => {
    const { onConfirm } = renderPopover();
    openPopover();

    const defaultAllowed = fireEvent.keyDown(document.body, {
      key: "Escape"
    });

    expect(defaultAllowed).toBe(false);
    expect(screen.queryByText("Tutti orchestration")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
