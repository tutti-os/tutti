// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentGUITextSelectionActions,
  readAgentGUITextSelection
} from "./AgentGUITextSelectionActions";

function selectMessageText(root: HTMLElement) {
  const message = screen.getByTestId("message-text");
  const range = document.createRange();
  range.selectNodeContents(message);
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => ({
      bottom: 120,
      height: 20,
      left: 100,
      right: 260,
      top: 100,
      width: 160,
      x: 100,
      y: 100,
      toJSON: () => ({})
    })
  });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return readAgentGUITextSelection(root);
}

function renderActions(onAskInSide?: (text: string) => void) {
  const onAddToConversation = vi.fn();
  const onDismiss = vi.fn();
  const { container } = render(
    <div data-testid="timeline-root">
      <span data-testid="message-text">Selected answer text</span>
    </div>
  );
  const snapshot = selectMessageText(
    container.firstElementChild as HTMLElement
  );
  expect(snapshot).not.toBeNull();
  render(
    <AgentGUITextSelectionActions
      labels={{
        addToConversation: "Add to conversation",
        askInSide: "Ask in Side chat"
      }}
      snapshot={snapshot!}
      portalTarget={document.body}
      onAddToConversation={onAddToConversation}
      onAskInSide={onAskInSide}
      onDismiss={onDismiss}
    />
  );
  return { onAddToConversation, onDismiss };
}

describe("AgentGUITextSelectionActions", () => {
  it("routes selected transcript text to the main conversation or Side", () => {
    const onAskInSide = vi.fn();
    const { onAddToConversation, onDismiss } = renderActions(onAskInSide);

    fireEvent.click(
      screen.getByRole("button", { name: "Add to conversation" })
    );
    expect(onAddToConversation).toHaveBeenCalledWith("Selected answer text");
    expect(onDismiss).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Ask in Side chat" }));
    expect(onAskInSide).toHaveBeenCalledWith("Selected answer text");
  });

  it("hides the Side action when the exact live conversation lacks Side support", () => {
    renderActions();

    expect(
      screen.getByRole("button", { name: "Add to conversation" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Ask in Side chat" })
    ).toBeNull();
  });

  it("ignores selections outside the transcript", () => {
    const root = document.createElement("div");
    const outside = document.createTextNode("outside");
    document.body.append(root, outside);
    const range = document.createRange();
    range.selectNode(outside);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    expect(readAgentGUITextSelection(root)).toBeNull();
  });
});
