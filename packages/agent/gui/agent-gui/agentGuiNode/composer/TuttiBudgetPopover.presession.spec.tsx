import "@testing-library/jest-dom/vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestEngineCommandPort } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  resolveAgentGUITuttiModeDraftKey,
  useAgentGUITuttiModeActivation
} from "../controller/useAgentGUITuttiModeActivation";
import { TuttiBudgetPopover } from "./TuttiBudgetPopover";

const labels = {
  title: "Tutti preferences",
  effectLabel: "Effect",
  speedLabel: "Speed",
  previewHint:
    "The exact model, total task count, and safe parallelism are inferred from the request and selected Skills.",
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

function createTestEngine() {
  return createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: createTestEngineCommandPort({
      execute: vi.fn(() => new Promise<never>(() => {}))
    }),
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: { schedule: () => ({ cancel() {} }) }
  });
}

function PreSessionHarness({
  engine
}: {
  engine: ReturnType<typeof createTestEngine>;
}) {
  const tuttiMode = useAgentGUITuttiModeActivation({
    activeConversationId: null,
    draftKey: resolveAgentGUITuttiModeDraftKey("node-1"),
    engine,
    workspaceId: "workspace-1"
  });
  return (
    <TuttiBudgetPopover
      effect={tuttiMode.effect}
      speed={tuttiMode.speed}
      labels={labels}
      onEffectChange={tuttiMode.setEffect}
      onSpeedChange={tuttiMode.setSpeed}
    >
      <button className="nodrag" type="button">
        Tutti
      </button>
    </TuttiBudgetPopover>
  );
}

describe("TuttiBudgetPopover pre-session loop", () => {
  it("survives the workbench node-window click-capture guard", () => {
    const engine = createTestEngine();
    const guard = (event: ReactMouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".nodrag")) return;
      event.stopPropagation();
    };
    render(
      <div onClickCapture={guard}>
        <PreSessionHarness engine={engine} />
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    const popover = document.querySelector("[data-agent-tutti-budget-popover]");
    expect(popover?.classList.contains("nodrag")).toBe(true);

    const slider = screen.getByRole("slider", {
      name: "Effect"
    });
    fireEvent.click(slider);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    // Slider movement applies immediately through the workbench
    // click-capture guard and the popup stays open.
    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]
    ).toMatchObject({ active: true, effect: 51, speed: null });
    expect(
      document.querySelector("[data-agent-tutti-budget-popover]")
    ).not.toBeNull();
  });

  it("keeps a committed pre-session effect and preview across reopen", () => {
    const engine = createTestEngine();
    render(<PreSessionHarness engine={engine} />);

    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    const slider = screen.getByRole("slider", {
      name: "Effect"
    });
    expect(slider).toHaveAttribute("aria-valuenow", "50");

    slider.focus();
    fireEvent.keyDown(slider, { key: "End" });
    expect(
      document.querySelector("[data-agent-tutti-effect-tier]")
    ).toHaveAttribute("data-agent-tutti-effect-tier", "powerful");

    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]
    ).toMatchObject({ active: true, effect: 100, speed: null });

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    expect(screen.getByRole("slider", { name: "Effect" })).toHaveAttribute(
      "aria-valuenow",
      "100"
    );
    expect(
      document.querySelector("[data-agent-tutti-effect-tier]")
    ).toHaveAttribute("data-agent-tutti-effect-tier", "powerful");
  });
});
