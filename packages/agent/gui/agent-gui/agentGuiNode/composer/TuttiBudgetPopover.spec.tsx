import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TuttiBudgetPopover } from "./TuttiBudgetPopover";

const labels = {
  title: "Tutti preferences",
  effectLabel: "Effect",
  speedLabel: "Speed",
  previewTitle: "Expected behavior",
  previewHint: "Effect sets the floor; speed finds the fastest suitable model.",
  previewCost: "Economical",
  previewBalance: "Balanced",
  previewPowerful: "Powerful",
  modelPreferenceLabel: "Model choice",
  modelPreferenceCost: "Economical",
  modelPreferenceBalance: "Balanced",
  modelPreferencePowerful: "Most capable",
  modelPreferenceFastestSuitable: "Fastest suitable",
  parallelismLabel: "Parallel target",
  parallelismValue: (count: number) =>
    count === 1 ? "1 agent" : `Up to ${count} agents`
};

function renderPopover({ effect = 50, speed = 50 } = {}) {
  const onEffectChange = vi.fn();
  const onSpeedChange = vi.fn();
  render(
    <TuttiBudgetPopover
      effect={effect}
      speed={speed}
      labels={labels}
      onEffectChange={onEffectChange}
      onSpeedChange={onSpeedChange}
    >
      <button type="button">Tutti</button>
    </TuttiBudgetPopover>
  );
  return { onEffectChange, onSpeedChange };
}

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
  return screen.getByText("Tutti preferences");
}

describe("TuttiBudgetPopover", () => {
  it("opens with independent sliders seeded from effective preferences", () => {
    renderPopover({ effect: 62, speed: 81 });
    openPopover();

    expect(screen.getByRole("slider", { name: "Effect" })).toHaveAttribute(
      "aria-valuenow",
      "62"
    );
    expect(screen.getByRole("slider", { name: "Speed" })).toHaveAttribute(
      "aria-valuenow",
      "81"
    );
  });

  it("shows a concise model strategy and the speed-derived parallel target", () => {
    renderPopover({ effect: 67, speed: 66 });
    openPopover();
    expect(
      document.querySelector("[data-agent-tutti-budget-parallelism]")
    ).toHaveTextContent("Up to 3 agents");
    expect(
      document.querySelector("[data-agent-tutti-budget-model-preference]")
    ).toHaveTextContent("Most capable");

    fireEvent.keyDown(screen.getByRole("slider", { name: "Speed" }), {
      key: "ArrowRight"
    });
    expect(
      document.querySelector("[data-agent-tutti-budget-model-preference]")
    ).toHaveTextContent("Fastest suitable");
    expect(
      document.querySelector("[data-agent-tutti-budget-parallelism]")
    ).toHaveTextContent("Up to 3 agents");
  });

  it("raises the parallel target at the next speed band", () => {
    renderPopover({ effect: 67, speed: 74 });
    openPopover();

    fireEvent.keyDown(screen.getByRole("slider", { name: "Speed" }), {
      key: "ArrowRight"
    });
    expect(
      document.querySelector("[data-agent-tutti-budget-parallelism]")
    ).toHaveTextContent("Up to 4 agents");
  });

  it("applies each slider movement immediately and keeps the popup open", () => {
    const { onEffectChange, onSpeedChange } = renderPopover();
    openPopover();

    fireEvent.keyDown(screen.getByRole("slider", { name: "Effect" }), {
      key: "ArrowRight"
    });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Speed" }), {
      key: "ArrowRight"
    });

    expect(onEffectChange).toHaveBeenCalledWith(51);
    expect(onSpeedChange).toHaveBeenCalledWith(51);
    expect(screen.getByText("Tutti preferences")).toBeInTheDocument();
  });

  it("reseeds both drafts from effective values on every open", () => {
    renderPopover({ effect: 40, speed: 60 });
    openPopover();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Effect" }), {
      key: "ArrowRight"
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    openPopover();

    expect(screen.getByRole("slider", { name: "Effect" })).toHaveAttribute(
      "aria-valuenow",
      "40"
    );
    expect(screen.getByRole("slider", { name: "Speed" })).toHaveAttribute(
      "aria-valuenow",
      "60"
    );
  });

  it("escape closes only the popup and prevents the default", () => {
    renderPopover();
    openPopover();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    expect(screen.queryByText("Tutti preferences")).toBeNull();
  });
});
