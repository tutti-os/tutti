import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGuiWorkbenchSessionMenu } from "./AgentGuiWorkbenchSessionMenu";
import { AgentGuiWorkbenchHeader } from "./header";

const copy = {
  copyAsMarkdown: "Copy as Markdown",
  copyAsReference: "Copy as reference",
  moreSessionActions: "More session actions",
  renameSession: "Rename session"
};

describe("AgentGuiWorkbenchSessionMenu", () => {
  it("dispatches copy once after the menu gesture and exposes only the supported copy variants", async () => {
    const onAction = vi.fn();
    const onHeaderPointerDown = vi.fn();
    render(
      <div onPointerDown={onHeaderPointerDown}>
        <AgentGuiWorkbenchSessionMenu copy={copy} onAction={onAction} />
      </div>
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: copy.moreSessionActions }),
      { button: 0, ctrlKey: false }
    );

    const markdown = await screen.findByRole("menuitem", {
      name: copy.copyAsMarkdown
    });
    expect(
      screen.getByRole("menuitem", { name: copy.copyAsReference })
    ).toBeTruthy();
    for (const removed of [
      "Copy deep link",
      "Copy session ID",
      "Copy working directory"
    ]) {
      expect(screen.queryByRole("menuitem", { name: removed })).toBeNull();
    }

    fireEvent.pointerDown(markdown, { button: 0 });
    expect(onHeaderPointerDown).not.toHaveBeenCalled();
    fireEvent.pointerUp(markdown, { button: 0 });
    fireEvent.click(markdown);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(onAction).toHaveBeenCalledWith("copy-markdown");
  });

  it("renders only the actions supported by a read-only host surface", async () => {
    const onAction = vi.fn();
    render(
      <AgentGuiWorkbenchSessionMenu
        actions={["copy-markdown", "copy-reference"]}
        copy={copy}
        onAction={onAction}
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: copy.moreSessionActions }),
      { button: 0, ctrlKey: false }
    );

    expect(
      await screen.findByRole("menuitem", { name: copy.copyAsMarkdown })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: copy.copyAsReference })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: copy.renameSession })
    ).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("renders host-defined actions before the built-in session actions", async () => {
    const onOpenSession = vi.fn();
    render(
      <AgentGuiWorkbenchSessionMenu
        actions={["copy-markdown", "copy-reference"]}
        additionalActions={[
          {
            id: "open-session",
            label: "Open session",
            onSelect: onOpenSession
          }
        ]}
        copy={copy}
        onAction={vi.fn()}
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: copy.moreSessionActions }),
      { button: 0, ctrlKey: false }
    );

    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems[0]).toHaveTextContent("Open session");
    expect(screen.getByRole("separator")).toBeTruthy();

    const openSession = screen.getByRole("menuitem", { name: "Open session" });
    fireEvent.pointerDown(openSession, { button: 0 });
    fireEvent.pointerUp(openSession, { button: 0 });
    fireEvent.click(openSession);
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledOnce());
  });

  it("lets the complete header constrain its session menu actions", async () => {
    render(
      <AgentGuiWorkbenchHeader
        copy={{
          collapseConversationRail: "Collapse",
          expandConversationRail: "Expand",
          fallbackAgentLabel: "Agent",
          newConversation: "New conversation",
          sessionMenu: copy
        }}
        conversationIconUrl="agent.png"
        conversationTitle="Shared session title"
        hasConversation
        isConversationRailAutoCollapsed
        isConversationRailCollapsed
        nodeId="activity-center-session-1"
        sessionMenuActions={["copy-markdown", "copy-reference"]}
        showConversationRailToggle={false}
        showWindowControls={false}
        onSessionAction={vi.fn()}
        onToggleConversationRail={vi.fn()}
      />
    );

    expect(screen.getByText("Shared session title")).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: copy.moreSessionActions }),
      { button: 0, ctrlKey: false }
    );

    expect(
      await screen.findByRole("menuitem", { name: copy.copyAsMarkdown })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: copy.renameSession })
    ).toBeNull();
  });
});
