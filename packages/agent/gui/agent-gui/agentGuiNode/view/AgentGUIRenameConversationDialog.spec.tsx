import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIRenameConversationDialog } from "./AgentGUIRenameConversationDialog";

describe("AgentGUIRenameConversationDialog", () => {
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
        uiLanguage="en"
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
});

const RENAME_LABELS = {
  cancel: "Cancel",
  fallbackAgentTitle: "Agent",
  renameSessionDescription: "Rename conversation",
  renameSessionPlaceholder: "Conversation title",
  renameSessionSave: "Save",
  renameSessionTitle: "Rename"
} as AgentGUIViewLabels;
