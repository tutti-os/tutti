import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_WINDOW_TOP_MARGIN } from "../../workspaceDesktop/constants";
import { ComposerFloatingMenuSurface } from "./ComposerFloatingMenuSurface";

describe("ComposerFloatingMenuSurface", () => {
  it("keeps a fixed-height menu clear of the workspace window's traffic-light header even when the anchor sits near the top of the viewport", () => {
    const anchorRef = createRef<HTMLDivElement>();
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 90,
          height: 30,
          left: 12,
          right: 200,
          top: 60,
          width: 188,
          x: 12,
          y: 60,
          toJSON: () => ({})
        }) as DOMRect
    );
    document.body.appendChild(anchor);
    anchorRef.current = anchor;

    render(
      <ComposerFloatingMenuSurface
        anchorRef={anchorRef}
        maxHeight={320}
        open
        placement="fixed-height"
        testId="composer-floating-menu-surface"
      >
        <div>menu content</div>
      </ComposerFloatingMenuSurface>
    );

    const surface = screen.getByTestId("composer-floating-menu-surface");
    const top = Number.parseFloat(surface.style.top);
    expect(top).toBeGreaterThanOrEqual(DESKTOP_WINDOW_TOP_MARGIN);

    anchor.remove();
  });
});
