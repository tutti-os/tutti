import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Slider } from "./slider";

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

describe("Slider", () => {
  it("renders one thumb when no value is provided", () => {
    render(<Slider aria-label="Default intensity" />);

    expect(
      screen.getAllByRole("slider", { name: "Default intensity" })
    ).toHaveLength(1);
  });

  it("forwards a single-value accessible name to the focusable thumb", () => {
    render(<Slider aria-label="Reasoning intensity" defaultValue={[40]} />);

    expect(
      screen.getByRole("slider", { name: "Reasoning intensity" })
    ).toHaveAttribute("aria-valuenow", "40");
  });

  it("accepts caller-owned accessible names for a range", () => {
    render(
      <Slider
        defaultValue={[25, 75]}
        thumbAriaLabels={["Minimum intensity", "Maximum intensity"]}
      />
    );

    expect(
      screen.getByRole("slider", { name: "Minimum intensity" })
    ).toHaveAttribute("aria-valuenow", "25");
    expect(
      screen.getByRole("slider", { name: "Maximum intensity" })
    ).toHaveAttribute("aria-valuenow", "75");
  });

  it("supports keyboard changes and preserves the orientation class contract", () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <Slider
        aria-label="Intensity"
        defaultValue={[40]}
        onValueChange={onValueChange}
      />
    );

    fireEvent.keyDown(screen.getByRole("slider", { name: "Intensity" }), {
      key: "ArrowRight"
    });

    expect(onValueChange).toHaveBeenCalledWith([41]);
    expect(container.querySelector('[data-slot="slider-track"]')).toHaveClass(
      "data-[orientation=horizontal]:h-1"
    );
  });

  it("exposes disabled semantics on the thumb and ignores keyboard changes", () => {
    const onValueChange = vi.fn();
    render(
      <Slider
        aria-label="Intensity"
        defaultValue={[40]}
        disabled
        onValueChange={onValueChange}
      />
    );

    const thumb = screen.getByRole("slider", { name: "Intensity" });
    expect(thumb).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
