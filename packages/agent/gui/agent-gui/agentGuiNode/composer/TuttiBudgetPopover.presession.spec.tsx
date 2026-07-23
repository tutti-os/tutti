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
      onConfirm={tuttiMode.setOrchestrationIntensity}
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

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]
    ).toMatchObject({ active: true, orchestrationIntensity: 50 });
    expect(
      document.querySelector("[data-agent-tutti-budget-popover]")
    ).toBeNull();
  });

  it("keeps a confirmed pre-session intensity and preview across reopen", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]
    ).toMatchObject({ active: true, orchestrationIntensity: 100 });

    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "100");
    expect(
      document.querySelector("[data-agent-tutti-budget-preview]")
    ).toHaveAttribute("data-agent-tutti-budget-preview", "powerful");
  });
});
