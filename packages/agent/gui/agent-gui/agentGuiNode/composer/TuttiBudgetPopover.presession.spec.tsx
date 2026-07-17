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
  confirm: "Confirm",
  cancel: "Cancel"
};

/**
 * P1 regression harness: the real engine-backed loop behind the composer chip
 * on a provider home with no session yet. Confirming an intensity must land
 * in the engine draft and seed the popup again on reopen, and the chip must
 * reopen the popup immediately after a confirm.
 */
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
  engine: ReturnType<typeof createAgentSessionEngine>;
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
      {/* The real chip lives inside the composer chrome's .nodrag subtree. */}
      <button className="nodrag" type="button">
        Tutti
      </button>
    </TuttiBudgetPopover>
  );
}

describe("TuttiBudgetPopover pre-session loop", () => {
  it("survives the workbench node-window click-capture guard (nodrag)", () => {
    // WorkspaceNodeWindow stops propagation of clicks whose target is not in
    // a `.nodrag` subtree. React capture handlers run for portaled children
    // through the fiber tree, so without `nodrag` on the popover content the
    // confirm button's click dies before its own handler (P1 regression).
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

  it("keeps a confirmed pre-session intensity across popup reopen", () => {
    const engine = createTestEngine();
    render(<PreSessionHarness engine={engine} />);

    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    const slider = screen.getByRole("slider", {
      name: "Orchestration intensity"
    });
    expect(slider).toHaveAttribute("aria-valuenow", "50");

    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "51");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const draftKey = resolveAgentGUITuttiModeDraftKey("node-1");
    expect(
      engine.getSnapshot().tuttiModeActivation.draftsByKey[draftKey]
    ).toMatchObject({ active: true, orchestrationIntensity: 51 });

    // Reopen immediately: the chip click right after confirm must open the
    // popup again, seeded with the persisted draft value.
    fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "51");
  });
});
