import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGuiWorkbenchHeader } from "./header";

afterEach(cleanup);

describe("AgentGuiWorkbenchHeader conversation identity", () => {
  it.each([false, true])(
    "hides conversation identity without a conversation when collapsed is %s",
    (isConversationRailCollapsed) => {
      render(
        <AgentGuiWorkbenchHeader
          agentTitle="Leaked agent"
          conversationIconFallbackUrl="fallback-agent.png"
          conversationIconUrl="conversation-agent.png"
          conversationTitle="Leaked conversation"
          conversationTitleDisplayPrompt="Leaked rich conversation"
          copy={{
            collapseConversationRail: "Collapse",
            expandConversationRail: "Expand",
            fallbackAgentLabel: "Agent",
            newConversation: "New conversation",
            untitledConversation: "Untitled conversation"
          }}
          hasConversation={false}
          isConversationRailAutoCollapsed={false}
          isConversationRailCollapsed={isConversationRailCollapsed}
          nodeId="empty-agent-gui"
          secondaryAccessory={<span>Session-independent accessory</span>}
          showConversationRailToggle={false}
          showWindowControls={false}
          onToggleConversationRail={vi.fn()}
        />
      );

      expect(screen.queryByText("Leaked agent")).toBeNull();
      expect(screen.queryByText("Leaked conversation")).toBeNull();
      expect(screen.queryByText("Leaked rich conversation")).toBeNull();
      expect(screen.queryByTestId("agent-gui-window-detail-title")).toBeNull();
      expect(
        document.querySelector(
          '[data-testid^="agent-gui-window-detail-title-icon"]'
        )
      ).toBeNull();
      expect(
        document.querySelector('[data-testid^="agent-gui-window-session-icon"]')
      ).toBeNull();
      expect(screen.getByText("Session-independent accessory")).toBeTruthy();
    }
  );

  it("owns tool-sidebar layout independently from the native window shell", () => {
    const { container } = render(
      <AgentGuiWorkbenchHeader
        copy={{
          collapseConversationRail: "Collapse",
          expandConversationRail: "Expand",
          fallbackAgentLabel: "Agent",
          newConversation: "New conversation"
        }}
        isConversationRailAutoCollapsed={false}
        isConversationRailCollapsed={false}
        nodeId="host-owned-agent-gui"
        showConversationRailToggle={false}
        showWindowControls={false}
        toolSidebar={{
          actions: <span>Host-owned tools</span>,
          isSidebarOpen: true,
          layoutWidthPx: 432
        }}
        onToggleConversationRail={vi.fn()}
      />
    );

    const header = container.querySelector<HTMLElement>(
      "[data-agent-gui-workbench-header]"
    );
    expect(header).toHaveAttribute(
      "data-agent-gui-workbench-header-tool-sidebar",
      "true"
    );
    expect(
      header?.style.getPropertyValue("--agent-gui-tool-sidebar-layout-width")
    ).toBe("432px");
    expect(screen.getByText("Host-owned tools")).toBeTruthy();
  });
});
