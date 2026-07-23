import "@testing-library/jest-dom/vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import {
  resolveAgentGUITuttiModeDraftKey,
  useAgentGUITuttiModeActivation
} from "../controller/useAgentGUITuttiModeActivation";
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
  agentCountPowerful: "Up to 4"
};

function createTestEngine() {
  return createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: { execute: vi.fn(() => new Promise<never>(() => {})) },
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
      intensity={tuttiMode.orchestrationIntensity}
      labels={labels}
      onChange={tuttiMode.setOrchestrationIntensity}
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
      name: "Orchestration intensity"
    });
    fireEvent.click(slider);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    // Slider movement applies immediately through the workbench
    // click-capture guard and the popup stays open.
    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]
    ).toMatchObject({ active: true, orchestrationIntensity: 51 });
    expect(
      document.querySelector("[data-agent-tutti-budget-popover]")
    ).not.toBeNull();
  });

  it("keeps a committed pre-session intensity and preview across reopen", () => {
    const engine = createTestEngine();
    render(<PreSessionHarness engine={engine} />);

    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    const slider = screen.getByRole("slider", {
      name: "Orchestration intensity"
    });
    expect(slider).toHaveAttribute("aria-valuenow", "50");

    slider.focus();
    fireEvent.keyDown(slider, { key: "End" });
    expect(
      document.querySelector("[data-agent-tutti-budget-preview]")
    ).toHaveAttribute("data-agent-tutti-budget-preview", "powerful");

    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]
    ).toMatchObject({ active: true, orchestrationIntensity: 100 });

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "100");
    expect(
      document.querySelector("[data-agent-tutti-budget-preview]")
    ).toHaveAttribute("data-agent-tutti-budget-preview", "powerful");
  });
});
