import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGuiWorkbenchSessionMenu } from "./AgentGuiWorkbenchSessionMenu";

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
});
