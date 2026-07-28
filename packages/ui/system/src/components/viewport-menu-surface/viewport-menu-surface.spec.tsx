import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ViewportMenuSurface } from "./viewport-menu-surface";

const originalElementsFromPoint = document.elementsFromPoint;

afterEach(() => {
  document.elementsFromPoint = originalElementsFromPoint;
});

describe("ViewportMenuSurface", () => {
  it("keeps viewport coordinates when a boundary requests a body portal", () => {
    const boundary = document.createElement("div");
    boundary.dataset.slot = "viewport-menu-boundary";
    boundary.dataset.viewportMenuPortalTarget = "body";
    boundary.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 380,
          height: 300,
          left: 100,
          right: 500,
          top: 80,
          width: 400,
          x: 100,
          y: 80,
          toJSON: () => ({})
        }) as DOMRect
    );
    document.body.append(boundary);
    document.elementsFromPoint = vi.fn(() => [boundary]);

    render(
      <ViewportMenuSurface
        open
        placement={{
          type: "point",
          point: { x: 150, y: 120 },
          estimatedSize: { height: 80, width: 120 }
        }}
      >
        menu
      </ViewportMenuSurface>
    );

    const surface = screen.getByText("menu");
    expect(surface.parentElement).toBe(document.body);
    expect(surface).toHaveStyle({ left: "150px", top: "120px" });

    boundary.remove();
  });
});
