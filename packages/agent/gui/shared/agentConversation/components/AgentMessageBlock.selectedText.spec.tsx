// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMessageBlock } from "./AgentMessageBlock";

afterEach(cleanup);

describe("AgentMessageBlock selected text", () => {
  it("renders a selected-text message as a compact reference chip", () => {
    render(
      <AgentMessageBlock
        workspaceRoot="/workspace"
        basePath="/workspace"
        row={{
          kind: "message",
          id: "row-user",
          turnId: "turn-1",
          speaker: "user",
          rawFirstTextBlock: null,
          messages: [
            {
              kind: "message-content",
              id: "message-user:selected-text",
              turnId: "turn-1",
              body: "",
              presentationKind: "content",
              contentKind: "selected-text",
              selectedText: {
                count: 1,
                texts: ["Selected source text"]
              },
              occurredAtUnixMs: 1
            }
          ],
          thinking: [],
          occurredAtUnixMs: 1
        }}
        thinkingLabel="Thinking"
      />
    );

    const chip = screen.getByTestId("agent-selected-text-chip");
    expect(chip.getAttribute("data-selected-text-count")).toBe("1");
    expect(chip).toHaveTextContent("1 selected file snippet");
    expect(chip).toHaveClass("rounded-[10px]");
    expect(chip).toHaveClass("bg-[var(--background-fronted)]");
    expect(screen.queryByText("Selected source text")).toBeNull();
  });

  it("does not expose the selected-text chip as an editable message target", () => {
    render(
      <AgentMessageBlock
        workspaceRoot="/workspace"
        basePath="/workspace"
        row={{
          kind: "message",
          id: "row-user",
          turnId: "turn-1",
          speaker: "user",
          rawFirstTextBlock: "> Selected source text",
          messages: [
            {
              kind: "message-content",
              id: "message-user:selected-text",
              turnId: "turn-1",
              body: "",
              presentationKind: "content",
              contentKind: "selected-text",
              selectedText: {
                count: 1,
                texts: ["Selected source text"]
              },
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
          onSubmit: async () => true
        }}
        thinkingLabel="Thinking"
      />
    );

    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});
