// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerDraftAttachments } from "./ComposerDraftAttachments";

describe("ComposerDraftAttachments", () => {
  it("groups mixed attachment types into one measured row", () => {
    render(
      <ComposerDraftAttachments
        draftImages={[
          {
            id: "image-1",
            name: "selection.png",
            mimeType: "image/png",
            previewUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
          }
        ]}
        draftLargeTexts={[]}
        draftQuotes={[
          { type: "quote", id: "quote-1", text: "First selection" }
        ]}
        removeLabel="Remove reference"
        onRemoveImage={vi.fn()}
        onRemoveLargeText={vi.fn()}
        onExpandLargeText={vi.fn()}
        onRemoveQuotes={vi.fn()}
      />
    );

    const wrapper = screen.getByTestId("agent-gui-composer-attachment-drafts");
    expect(wrapper.children).toHaveLength(2);
    expect(wrapper).toContainElement(
      screen.getByTestId("agent-gui-composer-quote-drafts")
    );
    expect(wrapper).toContainElement(
      screen.getByTestId("agent-gui-composer-image-drafts")
    );
  });

  it("renders selected transcript text as a removable annotation with previews", async () => {
    const onRemoveQuotes = vi.fn();
    render(
      <ComposerDraftAttachments
        draftImages={[]}
        draftLargeTexts={[]}
        draftQuotes={[
          { type: "quote", id: "quote-1", text: "First selection" },
          { type: "quote", id: "quote-2", text: "Second selection" }
        ]}
        removeLabel="Remove reference"
        onRemoveImage={vi.fn()}
        onRemoveLargeText={vi.fn()}
        onExpandLargeText={vi.fn()}
        onRemoveQuotes={onRemoveQuotes}
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-quote-drafts")
    ).toHaveTextContent("2 selected file snippets");
    const previewTrigger = screen.getByRole("button", {
      name: "2 selected file snippets"
    });
    const removeButton = screen.getByRole("button", {
      name: "Remove reference"
    });
    expect(previewTrigger).not.toContainElement(removeButton);
    fireEvent.click(previewTrigger);
    const preview = await screen.findByTestId(
      "agent-gui-composer-quote-preview"
    );
    expect(preview).toHaveAttribute("data-slot", "popover-content");
    expect(preview).toHaveAttribute("tabindex", "0");
    expect(preview).toHaveClass("overflow-y-auto", "overscroll-contain");
    expect(preview).toHaveTextContent("“First selection”“Second selection”");
    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByTestId("agent-gui-composer-quote-preview")
      ).toBeNull()
    );
    expect(previewTrigger).toHaveFocus();
    fireEvent.click(removeButton);
    expect(onRemoveQuotes).toHaveBeenCalledOnce();
  });
});
