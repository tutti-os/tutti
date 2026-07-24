import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerTuttiModeChip } from "./ComposerTuttiModeChip";
import tuttiSnapStarsLightUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-light.png";
import tuttiSnapStarsLightActiveUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-light-active.png";
import tuttiSnapStarsDarkUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-dark.png";
import tuttiSnapStarsDarkActiveUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-dark-active.png";

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

  it("plays the snap-stars animation on hover and clears it on leave", async () => {
    render(<ComposerTuttiModeChip {...chipProps()} />);
    const chip = screen.getByTestId("agent-gui-composer-tutti-mode-toggle");
    const icon = chip.querySelector(
      ".agent-gui-node__composer-tutti-mode-icon"
    ) as HTMLElement;

    // No overlay until hovered.
    expect(icon).not.toHaveAttribute("data-snap-active", "true");
    expect(chip.querySelector("img")).toBeNull();

    fireEvent.mouseEnter(chip);
    expect(icon).toHaveAttribute("data-snap-active", "true");
    const overlay = chip.querySelector(
      ".agent-gui-node__composer-tutti-mode-icon-animated"
    ) as HTMLImageElement;
    expect(overlay).toBeInTheDocument();
    // The APNG fade-in flips on load.
    fireEvent.load(overlay);
    await waitFor(() => expect(overlay).toHaveAttribute("data-active", "true"));

    fireEvent.mouseLeave(chip);
    expect(icon).not.toHaveAttribute("data-snap-active", "true");
    expect(chip.querySelector("img")).toBeNull();
  });

  it("does not play the snap-stars animation while an update is pending", () => {
    render(<ComposerTuttiModeChip {...chipProps({ updating: true })} />);
    const chip = screen.getByTestId("agent-gui-composer-tutti-mode-toggle");
    fireEvent.mouseEnter(chip);
    const icon = chip.querySelector(
      ".agent-gui-node__composer-tutti-mode-icon"
    ) as HTMLElement;
    expect(icon).not.toHaveAttribute("data-snap-active", "true");
    expect(chip.querySelector("img")).toBeNull();
  });

  it("uses the light-idle APNG at rest in the light theme", () => {
    render(<ComposerTuttiModeChip {...chipProps()} />);
    const chip = screen.getByTestId("agent-gui-composer-tutti-mode-toggle");
    fireEvent.mouseEnter(chip);
    const overlay = chip.querySelector(
      ".agent-gui-node__composer-tutti-mode-icon-animated"
    ) as HTMLImageElement;
    expect(overlay.src).toContain(tuttiSnapStarsLightUrl);
  });

  it("uses the light-active APNG when armed in the light theme", () => {
    render(<ComposerTuttiModeChip {...chipProps({ active: true })} />);
    const chip = screen.getByTestId("agent-gui-composer-tutti-mode-toggle");
    fireEvent.mouseEnter(chip);
    const overlay = chip.querySelector(
      ".agent-gui-node__composer-tutti-mode-icon-animated"
    ) as HTMLImageElement;
    expect(overlay.src).toContain(tuttiSnapStarsLightActiveUrl);
  });

  it("switches to the dark-theme APNGs when the root data-theme is dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    try {
      render(<ComposerTuttiModeChip {...chipProps()} />);
      const chip = screen.getByTestId("agent-gui-composer-tutti-mode-toggle");
      fireEvent.mouseEnter(chip);
      const overlay = chip.querySelector(
        ".agent-gui-node__composer-tutti-mode-icon-animated"
      ) as HTMLImageElement;
      expect(overlay.src).toContain(tuttiSnapStarsDarkUrl);
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  });

  it("uses the dark-active APNG when armed in the dark theme", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    try {
      render(<ComposerTuttiModeChip {...chipProps({ active: true })} />);
      const chip = screen.getByTestId("agent-gui-composer-tutti-mode-toggle");
      fireEvent.mouseEnter(chip);
      const overlay = chip.querySelector(
        ".agent-gui-node__composer-tutti-mode-icon-animated"
      ) as HTMLImageElement;
      expect(overlay.src).toContain(tuttiSnapStarsDarkActiveUrl);
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  });
});
