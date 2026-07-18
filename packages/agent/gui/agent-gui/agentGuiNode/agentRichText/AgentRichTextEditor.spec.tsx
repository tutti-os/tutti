import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentRichTextEditor } from "./AgentRichTextEditor";
import type { AgentRichTextEditorHandle } from "./AgentRichTextEditor.types";

describe("AgentRichTextEditor file paste", () => {
  it("dispatches images and regular files from one paste", async () => {
    const onPasteFiles = vi.fn();
    const onPasteImages = vi.fn();
    const image = new File(["image"], "screen.png", { type: "image/png" });
    const document = new File(["document"], "notes.md", {
      type: "text/markdown"
    });
    const rendered = render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onPasteFiles={onPasteFiles}
        onPasteImages={onPasteImages}
      />
    );

    const editor = await waitFor(() => {
      const element = rendered.container.querySelector<HTMLElement>(
        '[contenteditable="true"]'
      );
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.paste(editor, {
      clipboardData: {
        files: [image, document],
        getData: () => ""
      }
    });

    expect(onPasteFiles).toHaveBeenCalledWith([document]);
    await waitFor(() =>
      expect(onPasteImages).toHaveBeenCalledWith([
        expect.objectContaining({ name: "screen.png", mimeType: "image/png" })
      ])
    );
  });

  it("inserts, updates, and removes a composer file inside the editor", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        ref={ref}
        value=""
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove file"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    act(() =>
      ref.current?.insertComposerFiles([
        { id: "file-1", name: "report.pdf", status: "uploading" }
      ])
    );

    expect(
      rendered.container.querySelector('[data-uploading="true"]')
    ).not.toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.stringContaining("mention://composer-file/file-1")
    );

    act(() =>
      ref.current?.updateComposerFiles([
        {
          errorCode: "file_too_large",
          id: "file-1",
          name: "report.pdf",
          status: "error"
        }
      ])
    );
    const failedMention = rendered.container.querySelector(
      '[data-upload-error="true"]'
    );
    expect(failedMention).not.toBeNull();
    expect(failedMention?.textContent).toBe("report.pdf");
    expect(failedMention).toHaveAttribute("title", "File is too large");
    expect(failedMention).toHaveAttribute(
      "aria-label",
      "report.pdf, File is too large"
    );

    fireEvent.mouseDown(rendered.getByLabelText("Remove file"));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
  });
});
