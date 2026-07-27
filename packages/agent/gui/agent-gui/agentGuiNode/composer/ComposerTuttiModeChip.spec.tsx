import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerTuttiModeChip } from "./ComposerTuttiModeChip";

function chipProps(
  overrides: Record<string, unknown> = {}
): Parameters<typeof ComposerTuttiModeChip>[0] {
  return {
    active: false,
    updating: false,
    label: "Tutti Mode",
    description: "Plan first, then orchestrate agents",
    tuttiModeSupported: true,
    onTuttiModeChange: vi.fn(),
    ...overrides
  };
}

describe("ComposerTuttiModeChip", () => {
  it("arms tutti mode through the activation callback", () => {
    const onTuttiModeChange = vi.fn();
    render(<ComposerTuttiModeChip {...chipProps({ onTuttiModeChange })} />);

    expect(screen.getByText("Tutti Mode")).toBeInTheDocument();
    // The chip shows only icon + label + switch; the description stays a tooltip.
    expect(
      screen.queryByText("Plan first, then orchestrate agents")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-composer-tutti-mode-toggle")
    ).toHaveAttribute("title", "Plan first, then orchestrate agents");
    const toggle = screen.getByTestId(
      "agent-gui-composer-tutti-mode-toggle-switch"
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onTuttiModeChange).toHaveBeenCalledWith(true);
  });

  it("reflects the armed state and disarms on toggle off", () => {
    const onTuttiModeChange = vi.fn();
    render(
      <ComposerTuttiModeChip
        {...chipProps({ active: true, onTuttiModeChange })}
      />
    );

    const toggle = screen.getByTestId(
      "agent-gui-composer-tutti-mode-toggle-switch"
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(onTuttiModeChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing without an activation callback", () => {
    render(
      <ComposerTuttiModeChip {...chipProps({ onTuttiModeChange: undefined })} />
    );
    expect(
      screen.queryByTestId("agent-gui-composer-tutti-mode-toggle")
    ).not.toBeInTheDocument();
  });

  it("renders nothing when the host Tutti Mode capability is disabled or omitted", () => {
    render(
      <ComposerTuttiModeChip {...chipProps({ tuttiModeSupported: false })} />
    );
    expect(
      screen.queryByTestId("agent-gui-composer-tutti-mode-toggle")
    ).not.toBeInTheDocument();
  });

  it("disables the switch while the activation update is pending", () => {
    render(<ComposerTuttiModeChip {...chipProps({ updating: true })} />);
    expect(
      screen.getByTestId("agent-gui-composer-tutti-mode-toggle-switch")
    ).toBeDisabled();
  });
});
