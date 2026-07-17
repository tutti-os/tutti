import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "../AgentComposer";
import { AgentGUIEmptyHeroTuttiToggle } from "./AgentGUIEmptyState";

function composerProps(
  overrides: Record<string, unknown> = {}
): AgentComposerProps {
  return {
    tuttiModeActive: false,
    tuttiModeUpdating: false,
    onTuttiModeChange: vi.fn(),
    labels: {
      tuttiModeLabel: "Tutti mode",
      tuttiModeDescription: "Plan first, then orchestrate agents"
    },
    ...overrides
  } as unknown as AgentComposerProps;
}

describe("AgentGUIEmptyHeroTuttiToggle", () => {
  it("arms tutti mode through the pre-session activation callback", () => {
    const onTuttiModeChange = vi.fn();
    render(
      <AgentGUIEmptyHeroTuttiToggle
        composerProps={composerProps({ onTuttiModeChange })}
      />
    );

    expect(screen.getByText("Tutti mode")).toBeInTheDocument();
    expect(
      screen.getByText("Plan first, then orchestrate agents")
    ).toBeInTheDocument();
    const toggle = screen.getByTestId("agent-gui-hero-tutti-toggle-switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onTuttiModeChange).toHaveBeenCalledWith(true);
  });

  it("reflects the armed state and disarms on toggle off", () => {
    const onTuttiModeChange = vi.fn();
    render(
      <AgentGUIEmptyHeroTuttiToggle
        composerProps={composerProps({
          tuttiModeActive: true,
          onTuttiModeChange
        })}
      />
    );

    const toggle = screen.getByTestId("agent-gui-hero-tutti-toggle-switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(onTuttiModeChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing without an activation callback", () => {
    render(
      <AgentGUIEmptyHeroTuttiToggle
        composerProps={composerProps({ onTuttiModeChange: undefined })}
      />
    );
    expect(
      screen.queryByTestId("agent-gui-hero-tutti-toggle")
    ).not.toBeInTheDocument();
  });

  it("disables the switch while the activation update is pending", () => {
    render(
      <AgentGUIEmptyHeroTuttiToggle
        composerProps={composerProps({ tuttiModeUpdating: true })}
      />
    );
    expect(
      screen.getByTestId("agent-gui-hero-tutti-toggle-switch")
    ).toBeDisabled();
  });
});
