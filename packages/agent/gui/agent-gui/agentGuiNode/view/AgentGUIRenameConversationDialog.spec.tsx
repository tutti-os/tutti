import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIRenameConversationDialog } from "./AgentGUIRenameConversationDialog";

describe("AgentGUIRenameConversationDialog", () => {
  it("disarms a pointer action when the pointer leaves the button", () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentGUIRenameConversationDialog
        conversation={{
          cwd: "/workspace",
          id: "session-1",
          provider: "codex",
          status: "ready",
          title: "Session 1",
          updatedAtUnixMs: 1
        }}
        labels={RENAME_LABELS}
        open
        onOpenChange={() => {}}
        onRename={onRename}
      />
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Rename" }), {
      target: { value: "Dragged rename" }
    });
    const save = screen.getByRole("button", { name: "Save" });

    fireEvent.pointerDown(save, { button: 0 });
    fireEvent.pointerLeave(save);
    fireEvent.pointerUp(save, { button: 0 });

    expect(onRename).not.toHaveBeenCalled();
  });

  it("keeps assistive click-only activation", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentGUIRenameConversationDialog
        conversation={{
          cwd: "/workspace",
          id: "session-1",
          provider: "codex",
          status: "ready",
          title: "Session 1",
          updatedAtUnixMs: 1
        }}
        labels={RENAME_LABELS}
        open
        onOpenChange={() => {}}
        onRename={onRename}
      />
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Rename" }), {
      target: { value: "Assistive rename" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }), {
      detail: 0
    });

    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("session-1", "Assistive rename")
    );
  });

  it("does not place the untitled display fallback in the editable value", () => {
    render(
      <AgentGUIRenameConversationDialog
        conversation={{
          cwd: "/workspace",
          id: "session-1",
          provider: "codex",
          status: "ready",
          title: "",
          titleFallback: "untitled-conversation",
          updatedAtUnixMs: 1
        }}
        labels={RENAME_LABELS}
        open
        onOpenChange={() => {}}
        onRename={vi.fn()}
      />
    );

    expect(screen.getByRole("textbox", { name: "Rename" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps the saved title while the dialog closes", async () => {
    const conversation = {
      cwd: "/workspace",
      id: "session-1",
      provider: "codex" as const,
      status: "ready" as const,
      title: "Session 1",
      updatedAtUnixMs: 1
    };
    const { rerender } = render(
      <AgentGUIRenameConversationDialog
        conversation={conversation}
        labels={RENAME_LABELS}
        open
        onOpenChange={() => {}}
        onRename={vi.fn()}
      />
    );
    const input = screen.getByRole("textbox", { name: "Rename" });
    fireEvent.change(input, { target: { value: "Renamed session" } });

    rerender(
      <AgentGUIRenameConversationDialog
        conversation={null}
        labels={RENAME_LABELS}
        open={false}
        onOpenChange={() => {}}
        onRename={vi.fn()}
      />
    );

    await waitFor(() => expect(input).toHaveValue("Renamed session"));
  });
});

const RENAME_LABELS = {
  cancel: "Cancel",
  fallbackAgentTitle: "Agent",
  untitledConversationTitle: "Host untitled override",
  renameSessionDescription: "Rename conversation",
  renameSessionPlaceholder: "Conversation title",
  renameSessionSave: "Save",
  renameSessionTitle: "Rename"
} as AgentGUIViewLabels;
