import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentGUIContentToast } from "./AgentGUIContentToast";

describe("AgentGUIContentToast", () => {
  it("anchors to the AgentGUI content node with theme-aware toast tokens", () => {
    render(<AgentGUIContentToast insetTopPx={80} message="Goal removed" />);

    const viewport = screen.getByTestId("agent-gui-content-toast-viewport");
    expect(viewport).toHaveClass(
      "absolute",
      "left-0",
      "w-full",
      "translate-x-0"
    );
    expect(viewport).not.toHaveClass("fixed", "left-1/2", "-translate-x-1/2");
    expect(viewport).toHaveStyle({ top: "80px" });
    const toast = screen.getByTestId("agent-gui-content-toast");
    expect(toast).toHaveClass(
      "bg-[var(--background-fronted)]",
      "text-[var(--text-primary)]",
      "border-[var(--line-2)]"
    );
    expect(toast).not.toHaveClass(
      "bg-[var(--toast-neutral-bg)]",
      "text-[var(--toast-neutral-fg)]",
      "border-[var(--toast-neutral-border)]"
    );
    expect(toast).toHaveTextContent("Goal removed");
  });
});
