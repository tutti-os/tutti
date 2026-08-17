import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerDraftAttachments } from "./ComposerDraftAttachments";

describe("ComposerDraftAttachments", () => {
  it("renders and removes a semantic connector selection", () => {
    const removeConnector = vi.fn();
    render(
      <ComposerDraftAttachments
        availableSkills={[
          {
            connectorKey: "notion",
            iconUrl: "https://example.test/notion.png",
            kind: "connector",
            name: "Notion",
            sourceKind: "connector",
            status: "available",
            trigger: "/notion"
          }
        ]}
        draftConnectors={[{ connectorKey: "notion" }]}
        draftImages={[]}
        draftLargeTexts={[]}
        removeLabel="Remove"
        onExpandLargeText={vi.fn()}
        onRemoveConnector={removeConnector}
        onRemoveImage={vi.fn()}
        onRemoveLargeText={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-connector-drafts")
    ).toHaveTextContent("Notion");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeConnector).toHaveBeenCalledWith("notion");
  });
});
