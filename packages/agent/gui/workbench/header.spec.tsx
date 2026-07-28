import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGUIAgentTarget } from "../types";
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

  it.each([false, true])(
    "lazily renders exact Host target information for the session icon when collapsed is %s",
    async (isConversationRailCollapsed) => {
      const onHeaderPointerDown = vi.fn();
      const conversationAgentTarget: AgentGUIAgentTarget = {
        agentTargetId: "agent:shared",
        iconUrl: "shared-agent.png",
        label: "Shared Codex",
        provider: "codex",
        ref: { kind: "shared", provider: "codex" },
        targetId: "shared:codex"
      };
      const renderAgentTargetInfo = vi.fn(({ surface, target }) => (
        <div>{`${surface}:${target.agentTargetId}`}</div>
      ));
      render(
        <AgentGuiWorkbenchHeader
          conversationAgentTarget={conversationAgentTarget}
          conversationIconUrl="shared-agent.png"
          conversationTitle="Investigate skills"
          copy={{
            collapseConversationRail: "Collapse",
            expandConversationRail: "Expand",
            fallbackAgentLabel: "Agent",
            newConversation: "New conversation"
          }}
          hasConversation
          isConversationRailAutoCollapsed={false}
          isConversationRailCollapsed={isConversationRailCollapsed}
          nodeId="shared-agent-gui"
          renderAgentTargetInfo={renderAgentTargetInfo}
          showConversationRailToggle={false}
          showWindowControls={false}
          onPointerDown={onHeaderPointerDown}
          onToggleConversationRail={vi.fn()}
        />
      );

      expect(renderAgentTargetInfo).not.toHaveBeenCalled();

      const trigger = screen.getByRole("img", { name: "Shared Codex" });
      fireEvent.focus(trigger);
      const focusTooltip = await screen.findByRole("tooltip");
      expect(focusTooltip).toHaveTextContent("workbench-header:agent:shared");
      expect(trigger).toHaveAttribute("aria-describedby", focusTooltip.id);
      expect(trigger).toHaveAttribute("tabindex", "0");

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();

      fireEvent.blur(trigger);
      fireEvent.pointerDown(trigger);
      expect(onHeaderPointerDown).not.toHaveBeenCalled();
      fireEvent.pointerUp(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "workbench-header:agent:shared"
      );
      expect(renderAgentTargetInfo).toHaveBeenLastCalledWith({
        surface: "workbench-header",
        target: conversationAgentTarget
      });
    }
  );

  it("does not add interactive icon chrome without a Host renderer", () => {
    render(
      <AgentGuiWorkbenchHeader
        conversationAgentTarget={{
          agentTargetId: "agent:local",
          label: "Local Codex",
          provider: "codex",
          ref: { kind: "local", provider: "codex" },
          targetId: "local:codex"
        }}
        conversationIconUrl="local-agent.png"
        conversationTitle="Local session"
        copy={{
          collapseConversationRail: "Collapse",
          expandConversationRail: "Expand",
          fallbackAgentLabel: "Agent",
          newConversation: "New conversation"
        }}
        hasConversation
        isConversationRailAutoCollapsed={false}
        isConversationRailCollapsed={false}
        nodeId="local-agent-gui"
        showConversationRailToggle={false}
        showWindowControls={false}
        onToggleConversationRail={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Local Codex")).toBeNull();
    expect(
      screen.getByTestId("agent-gui-window-detail-title-icon")
    ).toBeInTheDocument();
  });
});
