import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationImageContextMenu } from "./ConversationImageContextMenu";

describe("ConversationImageContextMenu", () => {
  it("wraps children in a trigger element by default", () => {
    render(
      <ConversationImageContextMenu src="blob:preview">
        <img data-testid="image" alt="" />
      </ConversationImageContextMenu>
    );

    const trigger = document.querySelector(
      '[data-slot="context-menu-trigger"]'
    );
    expect(trigger).not.toBeNull();
    // The image is nested inside the wrapper trigger, not the trigger itself.
    expect(screen.getByTestId("image").getAttribute("data-slot")).not.toBe(
      "context-menu-trigger"
    );
    expect(trigger?.querySelector('[data-testid="image"]')).not.toBeNull();
  });

  it("attaches the trigger directly to the child when asChild is set", () => {
    render(
      <ConversationImageContextMenu src="blob:preview" asChild>
        <img data-testid="image" alt="" />
      </ConversationImageContextMenu>
    );

    // No extra wrapper: the image element itself becomes the trigger. This is
    // what lets the zoomed image keep its library-managed positioning.
    expect(screen.getByTestId("image").getAttribute("data-slot")).toBe(
      "context-menu-trigger"
    );
  });
});
