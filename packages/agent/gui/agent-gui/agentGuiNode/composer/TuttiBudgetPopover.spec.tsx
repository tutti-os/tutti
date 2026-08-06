import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TuttiBudgetPopover } from "./TuttiBudgetPopover";

const labels = {
  title: "Tutti preferences",
  effectLabel: "Effect",
  speedLabel: "Speed",
  previewHint: "Effect sets the floor; speed finds the fastest suitable model.",
  previewCost: "Economical",
  previewBalance: "Balanced",
  previewPowerful: "Powerful",
  modelPreferenceLabel: "Model choice",
  modelPreferenceCost: "Economical",
  modelPreferenceBalance: "Balanced",
  modelPreferencePowerful: "Most capable",
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
    // The model strategy label follows effect only; speed drives the
    // parallel target.
    expect(
      document.querySelector("[data-agent-tutti-budget-model-preference]")
    ).toHaveTextContent("Most capable");
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

  it("positions the pad handle from the current effect and speed", () => {
    renderPopover({ effect: 40, speed: 80 });
    openPopover();

    const handle = document.querySelector<HTMLElement>(
      "[data-agent-tutti-preference-handle]"
    );
    expect(handle).not.toBeNull();
    // Horizontal axis is speed; vertical axis is effect with top = 100.
    expect(handle?.style.left).toContain("0.8");
    expect(handle?.style.top).toContain("0.6");
  });

  it("maps a pad press to both axes and applies it immediately", () => {
    const { onEffectChange, onSpeedChange } = renderPopover({
      effect: 50,
      speed: 50
    });
    openPopover();

    const pad = document.querySelector("[data-agent-tutti-preference-pad]");
    expect(pad).not.toBeNull();
    vi.spyOn(pad as Element, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 200,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);

    fireEvent(
      pad as Element,
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 150,
        clientY: 50
      })
    );

    expect(onSpeedChange).toHaveBeenCalledWith(75);
    expect(onEffectChange).toHaveBeenCalledWith(75);
    expect(screen.getByText("Tutti preferences")).toBeInTheDocument();
  });

  it("keeps applying pad drags while the pointer stays pressed", () => {
    const { onEffectChange, onSpeedChange } = renderPopover({
      effect: 50,
      speed: 50
    });
    openPopover();

    const pad = document.querySelector(
      "[data-agent-tutti-preference-pad]"
    ) as Element;
    vi.spyOn(pad, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 200,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);

    fireEvent(
      pad,
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 100,
        clientY: 100
      })
    );
    fireEvent(
      pad,
      new MouseEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        clientX: 200,
        clientY: 200
      })
    );

    expect(onSpeedChange).toHaveBeenLastCalledWith(100);
    expect(onEffectChange).toHaveBeenLastCalledWith(0);

    onEffectChange.mockClear();
    onSpeedChange.mockClear();
    fireEvent(
      pad,
      new MouseEvent("pointermove", {
        bubbles: true,
        buttons: 0,
        clientX: 0,
        clientY: 0
      })
    );
    expect(onEffectChange).not.toHaveBeenCalled();
    expect(onSpeedChange).not.toHaveBeenCalled();
  });
});
