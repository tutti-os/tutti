import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentTerminalBlock } from "./AgentTerminalBlock";

describe("AgentTerminalBlock", () => {
  it("renders a command-only call with the same header fill and no divider", () => {
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
    expect(
      container.querySelector(
        ".workspace-agents-status-panel__detail-tool-terminal"
      )?.className
    ).toContain("bg-[var(--background-panel)]");
    expect(row?.className).toContain("bg-[var(--transparency-block)]");
    expect(row?.className).not.toContain("border-b");
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
    expect(
      scrollArea?.querySelector(
        ".workspace-agents-status-panel__detail-scroll-region"
      )?.className
    ).toContain("max-h-[160px]");
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

  it("wraps long command and output text inside the terminal card", () => {
    const longCommand =
      "sed -n '1,220p' /home/tsh-runtime/.codex/skills/.system/imagegen/SKILL.md";
    const longOutput =
      "thread 'main' panicked at /home/runner/.cargo/git/checkouts/codex-9eee5d47/bubblewrap is unavailable";

    const { container } = render(
      <AgentTerminalBlock
        command={longCommand}
        stdout=""
        stderr={longOutput}
        exitCode={1}
        durationMs={1000}
        status="failed"
      />
    );

    const command = container.querySelector(
      '[data-agent-terminal-command="true"]'
    );
    const output = container.querySelector("pre");

    expect(command?.className).toContain("whitespace-pre-wrap");
    expect(command?.className).toContain("[overflow-wrap:anywhere]");
    expect(command?.className).not.toContain("truncate");
    expect(output?.className).toContain("max-w-full");
    expect(output?.className).toContain("whitespace-pre-wrap");
    expect(output?.className).toContain("[overflow-wrap:anywhere]");
    expect(output?.className).not.toContain("min-w-max");
    expect(
      output?.closest(".workspace-agents-status-panel__detail-scroll-region")
        ?.className
    ).toContain("text-[var(--state-danger)]");
  });

  it("renders a copy button when there is output", () => {
    render(
      <AgentTerminalBlock
        command="echo hello"
        stdout="hello"
        stderr=""
        exitCode={0}
        durationMs={100}
        status="completed"
      />
    );

    expect(screen.getByTestId("agent-terminal-copy")).toBeInTheDocument();
  });

  it("does not render a copy button when there is no output", () => {
    render(
      <AgentTerminalBlock
        command="echo hello"
        stdout=""
        stderr=""
        exitCode={0}
        durationMs={100}
        status="completed"
      />
    );

    expect(screen.queryByTestId("agent-terminal-copy")).toBeNull();
  });

  it("copies output text to clipboard on copy button click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <AgentTerminalBlock
        command="echo hello"
        stdout="hello world"
        stderr=""
        exitCode={0}
        durationMs={100}
        status="completed"
      />
    );

    screen.getByTestId("agent-terminal-copy").click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("hello world");
    });
  });
});
