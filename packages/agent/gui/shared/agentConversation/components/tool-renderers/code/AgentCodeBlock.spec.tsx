import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentCodeBlock } from "./AgentCodeBlock";

describe("AgentCodeBlock", () => {
  it("renders the long-content disclosure inside the code block", () => {
    const content = Array.from(
      { length: 121 },
      (_, index) => `line ${index + 1}`
    ).join("\n");

    render(
      <AgentCodeBlock content={content} collapsible flat showHeader={false} />
    );

    const disclosure = screen.getByRole("button", {
      name: /show full content/i
    });

    expect(
      disclosure.closest(".workspace-agents-status-panel__detail-tool-code")
    ).toBeTruthy();
    expect(disclosure.parentElement?.className).toContain(
      "workspace-agents-status-panel__detail-scroll-region"
    );
  });

  it("renders a copy button in the header when showHeader is true", () => {
    render(<AgentCodeBlock content="const x = 1" showHeader />);

    expect(screen.getByTestId("agent-code-block-copy")).toBeInTheDocument();
  });

  it("does not render a copy button when showHeader is false", () => {
    render(<AgentCodeBlock content="const x = 1" showHeader={false} />);

    expect(screen.queryByTestId("agent-code-block-copy")).toBeNull();
  });

  it("copies code content to clipboard on copy button click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<AgentCodeBlock content="const hello = 'world'" showHeader />);

    screen.getByTestId("agent-code-block-copy").click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const hello = 'world'");
    });
  });
});
