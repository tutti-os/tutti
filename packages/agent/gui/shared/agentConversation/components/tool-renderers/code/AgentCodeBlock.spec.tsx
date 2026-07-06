import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
