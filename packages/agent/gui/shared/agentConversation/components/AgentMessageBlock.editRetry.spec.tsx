// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMessageBlock } from "./AgentMessageBlock";

vi.mock("./AgentToolGroupRow", () => ({
  AgentToolGroupRow: () => null
}));

afterEach(cleanup);

describe("AgentMessageBlock edit retry", () => {
  it("prefills the exact first text block and submits only edited text with turn identity", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <AgentMessageBlock
        workspaceRoot="/workspace"
        basePath="/workspace"
        row={{
          kind: "message",
          id: "row-user",
          turnId: "turn-latest",
          speaker: "user",
          rawFirstTextBlock: "raw original",
          messages: [
            {
              kind: "message-content",
              id: "message-user",
              turnId: "turn-latest",
              body: "rendered original",
              presentationKind: "content",
              contentKind: "text",
              occurredAtUnixMs: 1
            }
          ],
          thinking: [],
          occurredAtUnixMs: 1
        }}
        editRetry={{
          pending: false,
          labels: {
            edit: "Edit message",
            cancel: "Cancel",
            submit: "Save and retry"
          },
          onSubmit
        }}
        thinkingLabel="Thinking"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = screen.getByRole("textbox", {
      name: "Edit message"
    }) as HTMLTextAreaElement;
    expect(editor.value).toBe("raw original");
    fireEvent.change(editor, { target: { value: "edited text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and retry" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        editedText: "edited text",
        turnId: "turn-latest"
      })
    );
  });

  it("keeps the edited draft when the durable command reports failure", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(
      <AgentMessageBlock
        workspaceRoot="/workspace"
        basePath="/workspace"
        row={{
          kind: "message",
          id: "row-user",
          turnId: "turn-latest",
          speaker: "user",
          rawFirstTextBlock: "raw original",
          messages: [
            {
              kind: "message-content",
              id: "message-user",
              turnId: "turn-latest",
              body: "rendered original",
              presentationKind: "content",
              contentKind: "text",
              occurredAtUnixMs: 1
            }
          ],
          thinking: [],
          occurredAtUnixMs: 1
        }}
        editRetry={{
          pending: false,
          labels: {
            edit: "Edit message",
            cancel: "Cancel",
            submit: "Save and retry"
          },
          onSubmit
        }}
        thinkingLabel="Thinking"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    fireEvent.change(editor, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and retry" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(
      (
        screen.getByRole("textbox", {
          name: "Edit message"
        }) as HTMLTextAreaElement
      ).value
    ).toBe("keep this draft");
  });
});
