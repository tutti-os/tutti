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
});
