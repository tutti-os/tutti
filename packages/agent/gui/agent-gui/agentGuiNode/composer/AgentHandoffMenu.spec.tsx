import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentGUIAgentTarget } from "../../../types";
import { AgentHandoffMenu } from "./AgentHandoffMenu";

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
  });
});

describe("AgentHandoffMenu", () => {
  it("renders self and shared ownership and selects the exact target", async () => {
    const onSelect = vi.fn();
    render(
      <AgentHandoffMenu
        labels={labels}
        targets={targets}
        triggerLabel="Handoff"
        onSelect={onSelect}
      />
    );

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Handoff" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3);
    const selfTarget = options[0]!;
    const sharedTarget = options[1]!;
    const offlineTarget = options[2]!;
    expect(selfTarget).toHaveTextContent("Research Codex");
    expect(sharedTarget).toHaveTextContent("Claude Code");
    expect(selfTarget).toBeEnabled();
    expect(sharedTarget).toBeEnabled();
    expect(within(selfTarget).getByText("My Agent")).toBeVisible();
    expect(within(sharedTarget).getByText("Lin · Shared Agent")).toBeVisible();
    expect(offlineTarget).toHaveTextContent("Offline Agent");
    expect(offlineTarget).toHaveAttribute("aria-disabled", "true");

    fireEvent.pointerDown(sharedTarget, { button: 0, ctrlKey: false });
    fireEvent.click(sharedTarget);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(targets[1]);
  });

  it("supports an icon-only trigger and owns hover animation state", () => {
    const onParentClick = vi.fn();
    const { container } = render(
      <div onClick={onParentClick}>
        <AgentHandoffMenu
          iconOnly
          isolateTriggerEvents
          labels={labels}
          targets={targets.slice(0, 2)}
          onSelect={vi.fn()}
        />
      </div>
    );

    const trigger = screen.getByRole("combobox", { name: "Handoff" });
    expect(trigger).not.toHaveTextContent("Handoff");
    expect(
      container.querySelector(".agent-gui-node__composer-handoff-icon")
    ).not.toHaveAttribute("data-playing");

    fireEvent.mouseEnter(trigger);
    expect(
      container.querySelector(".agent-gui-node__composer-handoff-icon")
    ).toHaveAttribute("data-playing", "true");

    fireEvent.mouseLeave(trigger);
    expect(
      container.querySelector(".agent-gui-node__composer-handoff-icon")
    ).not.toHaveAttribute("data-playing");

    fireEvent.click(trigger);
    expect(onParentClick).not.toHaveBeenCalled();
  });
});

const labels = {
  action: "Handoff",
  menu: "Choose an agent for handoff",
  self: "My Agent",
  shared: "Shared Agent",
  tooltip: "Hand off to another agent"
};

const targets: readonly AgentGUIAgentTarget[] = [
  target({
    targetId: "target-self",
    label: "Research Codex",
    ownership: "self"
  }),
  target({
    targetId: "target-shared",
    label: "Claude Code",
    ownerLabel: "Lin",
    ownership: "shared",
    badge: { iconUrl: "owner.png", label: "Lin" }
  }),
  target({
    targetId: "target-offline",
    label: "Offline Agent",
    ownership: "self",
    disabled: true
  })
];

function target(
  input: Pick<AgentGUIAgentTarget, "label" | "targetId"> &
    Partial<AgentGUIAgentTarget>
): AgentGUIAgentTarget {
  return {
    agentTargetId: input.targetId,
    provider: "codex",
    ref: { kind: "agent-directory", provider: "codex" },
    iconUrl: "agent.png",
    ...input
  };
}
