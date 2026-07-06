import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentTerminalBlock } from "./AgentTerminalBlock";

describe("AgentTerminalBlock", () => {
  it("renders a command-only call without an output body", () => {
    const { container } = render(
      <AgentTerminalBlock
        command="find /home -path '*frontend-design*SKILL.md'"
        stdout=""
        stderr=""
        exitCode={0}
        durationMs={1000}
        status="completed"
      />
    );

    const command = container.querySelector(
      '[data-agent-terminal-command="true"]'
    );
    const row = command?.parentElement;

    expect(command?.textContent).toContain("frontend-design");
    expect(row).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders the long-output disclosure as the terminal output final line", () => {
    const stdout = Array.from(
      { length: 201 },
      (_, index) => `line ${index + 1}`
    ).join("\n");

    const { container } = render(
      <AgentTerminalBlock
        command="tutti-cli agent session-summary"
        stdout={stdout}
        stderr=""
        exitCode={0}
        durationMs={1000}
        status="completed"
      />
    );

    const disclosure = screen.getByRole("button", {
      name: /show full output/i
    });
    const output = container.querySelector("pre");
    const scrollArea = output?.closest(".agent-tool-scroll-area");
    const terminalCard = container.querySelector(
      ".workspace-agents-status-panel__detail-tool-terminal"
    );

    expect(output?.textContent).toContain("line 200");
    expect(disclosure.parentElement).toBe(
      scrollArea?.querySelector(
        ".workspace-agents-status-panel__detail-scroll-region"
      )
    );
    expect(output?.nextElementSibling).toBe(disclosure);
    expect(
      disclosure.closest(".workspace-agents-status-panel__detail-tool-terminal")
    ).toBe(terminalCard);
  });
});
