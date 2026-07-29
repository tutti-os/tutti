import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentComposerDraftImagePreview } from "./AgentComposerDraftPreview";

describe("AgentComposerDraftImagePreview", () => {
  it("does not render an image element before a restored preview is hydrated", () => {
    const { container, rerender } = render(
      <AgentComposerDraftImagePreview
        image={{
          id: "restored-image",
          mimeType: "image/png",
          name: "image.png",
          path: "/agent-prompt-assets/image.png",
          previewUrl: ""
        }}
        onRemove={vi.fn()}
        removeLabel="Remove"
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-image-preview-pending")
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();

    rerender(
      <AgentComposerDraftImagePreview
        image={{
          id: "restored-image",
          mimeType: "image/png",
          name: "image.png",
          path: "/agent-prompt-assets/image.png",
          previewUrl: "data:image/png;base64,cmVzdG9yZWQ="
        }}
        onRemove={vi.fn()}
        removeLabel="Remove"
      />
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,cmVzdG9yZWQ="
    );
  });
});
