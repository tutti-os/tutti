import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "../tooltip/tooltip";
import { MentionPill } from "./mention-pill";

describe("MentionPill", () => {
  it("keeps standalone tooltip context by default", () => {
    render(<MentionPill kind="file" label="README.md" />);

    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="tooltip-trigger"]')
    ).toBeInTheDocument();
  });

  it("can reuse an ancestor tooltip provider", () => {
    render(
      <TooltipProvider>
        <MentionPill
          kind="file"
          label="README.md"
          withTooltipProvider={false}
        />
      </TooltipProvider>
    );

    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="tooltip-trigger"]')
    ).toBeInTheDocument();
  });

  it("reveals the semantic fallback when a custom icon fails", () => {
    const { container } = render(
      <MentionPill
        iconUrl="https://example.test/missing.png"
        kind="app"
        label="Weather"
      />
    );
    const image = container.querySelector("img");

    expect(
      container.querySelector('[data-mention-pill-fallback-icon="true"]')
    ).not.toBeInTheDocument();

    fireEvent.error(image!);

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-mention-pill-fallback-icon="true"]')
    ).toBeInTheDocument();
  });
});
