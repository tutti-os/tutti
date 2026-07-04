import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentQueuedPromptPanel } from "./AgentQueuedPromptPanel";

const labels = {
  queuedLabel: "Queued",
  sendQueuedPromptNext: "Send next",
  editQueuedPrompt: "Edit",
  deleteQueuedPrompt: "Delete",
  queuedPromptMoreActions: "More"
};

function textQueuedPrompt(id: string, text: string, createdAtUnixMs = 1) {
  return {
    id,
    content: [{ type: "text" as const, text }],
    createdAtUnixMs
  };
}

describe("AgentQueuedPromptPanel", () => {
  it("shows an expand cue only when queued content can expand", () => {
    const { rerender } = render(
      <AgentQueuedPromptPanel
        queuedPrompts={[textQueuedPrompt("queued-1", "short prompt")]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
      />
    );

    expect(
      screen.queryByTestId("agent-gui-composer-queued-prompt-expand-cue")
    ).toBeNull();

    rerender(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          textQueuedPrompt("queued-1", "short prompt"),
          textQueuedPrompt("queued-2", "second prompt", 2)
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-queued-prompt-expand-cue")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-composer-queued-prompt-expand-cue")
    ).toHaveClass("lucide-chevron-right");
  });

  it("shows an expand cue for a single queued prompt only when rendered text overflows", () => {
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(160);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(120);

    render(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          textQueuedPrompt(
            "queued-1",
            "single rendered line that overflows its visible row"
          )
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("agent-gui-composer-queued-prompt-expand-cue")
    ).toBeInTheDocument();

    scrollWidth.mockRestore();
    clientWidth.mockRestore();
  });

  it("renders queued mention prompts as entity tokens instead of raw markdown links", () => {
    const { container } = render(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          textQueuedPrompt(
            "queued-1",
            "[@2046494774160003072 & Claude Code Claude Code](mention://agent-session/session-1?workspaceId=room-1)"
          )
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
      />
    );

    expect(screen.getByText("Queued")).toBeInTheDocument();
    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "session");
    expect(mention).toHaveClass("tsh-agent-object-token");
    expect(mention).toHaveTextContent(
      "2046494774160003072 & Claude Code Claude Code"
    );
    expect(screen.queryByText(/mention:\/\/session/)).toBeNull();
  });

  it("renders queued workspace app mentions when query params follow the markdown link", () => {
    const iconUrl = "tutti://workspace-apps/ai-media-canvas/icon.png";
    const { container } = render(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          textQueuedPrompt(
            "queued-1",
            "local & Codex [@AI Media Canvas](mention://workspace-app/ai-media-canvas?workspaceId=workspace-1)"
          )
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        workspaceAppIcons={[
          {
            appId: "ai-media-canvas",
            iconUrl,
            workspaceId: "workspace-1"
          }
        ]}
      />
    );

    const mention = container.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "workspace-app");
    expect(mention).toHaveAttribute(
      "data-agent-mention-href",
      "mention://workspace-app/ai-media-canvas?workspaceId=workspace-1"
    );
    expect(
      mention?.querySelector('[data-agent-mention-app-icon="true"] img')
    ).toHaveAttribute("src", iconUrl);
    expect(mention).toHaveTextContent("AI Media Canvas");
    expect(screen.queryByText(/mention:\/\/workspace-app/)).toBeNull();
  });

  it("renders queued image prompt previews and routes edit", async () => {
    const onEditQueuedPrompt = vi.fn();
    const { container } = render(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          {
            id: "queued-1",
            content: [
              { type: "text", text: "describe this" },
              {
                type: "image",
                mimeType: "image/png",
                data: "aW1hZ2U=",
                name: "panel.png"
              }
            ],
            createdAtUnixMs: 1
          }
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={onEditQueuedPrompt}
      />
    );

    expect(screen.getByText("describe this")).toBeInTheDocument();
    expect(
      container.querySelector(".agent-gui-node__composer-queued-prompt-image")
    ).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");

    const moreButton = screen.getByRole("button", { name: "More" });
    fireEvent.pointerDown(moreButton, { button: 0, ctrlKey: false });
    fireEvent.click(moreButton);
    const editItem = await screen.findByRole("menuitem", { name: "Edit" });
    expect(editItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(editItem);
    expect(onEditQueuedPrompt).toHaveBeenCalledWith("queued-1");
  });

  it("allows queued image prompt previews to zoom", () => {
    render(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          {
            id: "queued-1",
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: "aW1hZ2U=",
                name: "panel.png"
              }
            ],
            createdAtUnixMs: 1
          }
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: /Zoom image/ })
    ).toBeInTheDocument();
  });

  it("emits queued mention link clicks without toggling the queue panel", () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          textQueuedPrompt(
            "queued-1",
            "[@2046494774160003072 & Claude Code Claude Code](mention://agent-session/session-1?workspaceId=room-1)"
          )
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onLinkClick={onLinkClick}
      />
    );

    const panel = container.querySelector("[data-expanded]");
    const mention = container.querySelector('[data-agent-file-mention="true"]');

    expect(panel).toHaveAttribute("data-expanded", "false");
    fireEvent.click(mention as Element);

    expect(onLinkClick).toHaveBeenCalledWith(
      "mention://agent-session/session-1?workspaceId=room-1"
    );
    expect(panel).toHaveAttribute("data-expanded", "false");
  });

  it("routes the edit action for a queued prompt", async () => {
    const onEditQueuedPrompt = vi.fn();
    render(
      <AgentQueuedPromptPanel
        queuedPrompts={[
          textQueuedPrompt("queued-1", "first queued prompt"),
          textQueuedPrompt("queued-2", "second queued prompt", 2)
        ]}
        drainingQueuedPromptId={null}
        labels={labels}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={onEditQueuedPrompt}
      />
    );

    const panel = screen
      .getByTestId("agent-gui-composer-queued-prompt-queued-1")
      .closest("[data-expanded]");
    expect(panel).toHaveAttribute("data-expanded", "false");

    const moreButtons = screen.getAllByRole("button", { name: "More" });
    fireEvent.pointerDown(moreButtons[1]!, { button: 0, ctrlKey: false });
    fireEvent.click(moreButtons[1]!);
    expect(panel).toHaveAttribute("data-expanded", "false");
    const editItem = await screen.findByRole("menuitem", { name: "Edit" });
    fireEvent.pointerDown(editItem, { button: 0, ctrlKey: false });
    fireEvent.click(editItem);

    expect(onEditQueuedPrompt).toHaveBeenCalledWith("queued-2");
    expect(onEditQueuedPrompt).toHaveBeenCalledTimes(1);
  });
});
