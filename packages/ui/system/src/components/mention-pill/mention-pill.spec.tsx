import { render, screen } from "@testing-library/react";
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

  it("keeps the removable action borderless", () => {
    render(
      <MentionPill
        kind="session"
        label="Design review"
        removable
        removeButtonProps={{ "aria-label": "Remove" }}
      />
    );

    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass(
      "size-5"
    );
    expect(screen.getByRole("button", { name: "Remove" })).not.toHaveClass(
      "rounded-sm",
      "hover:bg-transparency-block"
    );
  });
});
