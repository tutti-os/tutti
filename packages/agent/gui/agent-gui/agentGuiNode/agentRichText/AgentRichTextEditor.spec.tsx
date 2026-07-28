import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  registerAgentCustomMentionKind,
  resetAgentCustomMentionKindsForTests
} from "../../../shared/agentCustomMentionKinds";
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

describe("AgentRichTextEditor prompt insertion", () => {
  it("ignores stale controlled echoes while a transition catches up", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const props = {
      disabled: false,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      placeholder: "Prompt"
    };
    const rendered = render(
      <AgentRichTextEditor ref={ref} value="a" {...props} />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    act(() => {
      ref.current?.focusAtEnd();
      ref.current?.insertPlainTextAtSelection("b");
      ref.current?.insertPlainTextAtSelection("c");
    });
    expect(
      rendered.container.querySelector('[contenteditable="true"]')
    ).toHaveTextContent("abc");

    rendered.rerender(<AgentRichTextEditor ref={ref} value="ab" {...props} />);
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[contenteditable="true"]')
      ).toHaveTextContent("abc")
    );

    rendered.rerender(<AgentRichTextEditor ref={ref} value="abc" {...props} />);
    rendered.rerender(
      <AgentRichTextEditor ref={ref} value="replacement" {...props} />
    );
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[contenteditable="true"]')
      ).toHaveTextContent("replacement")
    );
  });

  it("does not mistake an old local value for an echo after the draft scope changes", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const props = {
      disabled: false,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      placeholder: "Prompt"
    };
    const rendered = render(
      <AgentRichTextEditor
        ref={ref}
        contentScopeKey="session-a"
        value="a"
        {...props}
      />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    act(() => {
      ref.current?.focusAtEnd();
      ref.current?.insertPlainTextAtSelection("b");
      ref.current?.insertPlainTextAtSelection("c");
    });
    expect(
      rendered.container.querySelector('[contenteditable="true"]')
    ).toHaveTextContent("abc");

    rendered.rerender(
      <AgentRichTextEditor
        ref={ref}
        contentScopeKey="session-b"
        value="ab"
        {...props}
      />
    );

    await waitFor(() =>
      expect(
        rendered.container.querySelector('[contenteditable="true"]')
      ).toHaveTextContent("ab")
    );
  });

  it("invalidates layout after a programmatic document update", async () => {
    const onContentLayoutInvalidated = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value="hello"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onContentLayoutInvalidated={onContentLayoutInvalidated}
        onSubmit={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[contenteditable="true"]')
      ).not.toBeNull()
    );
    onContentLayoutInvalidated.mockClear();

    rendered.rerender(
      <AgentRichTextEditor
        value={"hello\nworld"}
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onContentLayoutInvalidated={onContentLayoutInvalidated}
        onSubmit={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(onContentLayoutInvalidated).toHaveBeenCalledTimes(1)
    );
  });

  it("does not open mention suggestions for a restored controlled value", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const onFileMentionSuggestionChange = vi.fn();
    const props = {
      disabled: false,
      onChange: vi.fn(),
      onFileMentionSuggestionChange,
      onSubmit: vi.fn(),
      placeholder: "Prompt"
    };
    const rendered = render(
      <AgentRichTextEditor ref={ref} value="" {...props} />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    onFileMentionSuggestionChange.mockClear();

    rendered.rerender(
      <AgentRichTextEditor
        ref={ref}
        value="@tutti-os/workbench-electron 得新增包是吗"
        {...props}
      />
    );

    await waitFor(() =>
      expect(
        rendered.container.querySelector('[contenteditable="true"]')
      ).toHaveTextContent("@tutti-os/workbench-electron 得新增包是吗")
    );
    act(() => ref.current?.focusAtEnd());

    expect(
      onFileMentionSuggestionChange.mock.calls.some(
        ([suggestion]) => suggestion !== null
      )
    ).toBe(false);
    expect(rendered.container.querySelector(".suggestion")).toBeNull();

    onFileMentionSuggestionChange.mockClear();
    const editor = rendered.container.querySelector<HTMLElement>(
      '[contenteditable="true"]'
    );
    expect(editor).not.toBeNull();
    fireEvent.keyDown(editor!, { key: "x" });
    act(() => ref.current?.insertPlainTextAtSelection("x"));

    expect(onFileMentionSuggestionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "tutti-os/workbench-electron 得新增包是吗x"
      })
    );
  });

  it("inserts multiline plain text at the current selection without submitting", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const onChange = vi.fn();
    const onContentLayoutInvalidated = vi.fn();
    const onSubmit = vi.fn();
    render(
      <AgentRichTextEditor
        ref={ref}
        value="hello"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onContentLayoutInvalidated={onContentLayoutInvalidated}
        onSubmit={onSubmit}
      />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    let nextPrompt: string | null = null;
    act(() => {
      ref.current?.focusAtEnd();
      nextPrompt =
        ref.current?.insertPlainTextAtSelection("\nworld 👋") ?? null;
    });

    expect(nextPrompt).toBe("hello\nworld 👋");
    expect(onChange).toHaveBeenLastCalledWith("hello\nworld 👋");
    expect(onContentLayoutInvalidated).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("replaces the selected range", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        ref={ref}
        value="hello world"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const editor = rendered.container.querySelector<HTMLElement>(
      '[contenteditable="true"]'
    );
    expect(editor).not.toBeNull();

    act(() => {
      editor?.focus();
      const selection = window.getSelection();
      const textNode = editor?.querySelector("p")?.firstChild;
      if (selection && textNode) {
        const range = document.createRange();
        range.setStart(textNode, 6);
        range.setEnd(textNode, 11);
        selection.removeAllRanges();
        selection.addRange(range);
        editor?.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      }
    });

    let nextPrompt: string | null = null;
    act(() => {
      nextPrompt = ref.current?.insertPlainTextAtSelection("Tutti") ?? null;
    });
    expect(nextPrompt).toBe("hello Tutti");
    expect(onChange).toHaveBeenLastCalledWith("hello Tutti");
  });
});

describe("AgentRichTextEditor mention clipboard", () => {
  it("round-trips a built-in mention through text/plain and text/html", async () => {
    const prompt = "Read [@report.md](/workspace/report.md) next";
    const copied = await copyEditorPrompt(prompt);

    expect(copied["text/plain"]).toBe(prompt);
    expect(copied["text/html"]).toContain("data-agent-file-mention");
    expect(copied["text/html"]).toContain("/workspace/report.md");
    expect(await pasteEditorPrompt(copied)).toBe(prompt);
  });

  it("round-trips a registered custom mention without losing its href", async () => {
    registerAgentCustomMentionKind({
      kind: "external-note",
      present: (mention) => ({
        name: mention.label,
        summary: mention.scope?.preview
      })
    });
    try {
      const prompt =
        "Use [@Note A](mention://external-note/note-a?preview=hello&spaceId=space-1)";
      const copied = await copyEditorPrompt(prompt);

      expect(copied["text/plain"]).toBe(prompt);
      expect(copied["text/html"]).toContain("data-agent-mention-kind");
      expect(copied["text/html"]).toContain("external-note");
      expect(await pasteEditorPrompt(copied)).toBe(prompt);
    } finally {
      resetAgentCustomMentionKindsForTests();
    }
  });
});

async function copyEditorPrompt(
  prompt: string
): Promise<Record<string, string>> {
  const rendered = render(
    <AgentRichTextEditor
      value={prompt}
      disabled={false}
      placeholder="Prompt"
      onChange={vi.fn()}
      onSubmit={vi.fn()}
    />
  );
  const editor = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLElement>(
      '[contenteditable="true"]'
    );
    expect(element).not.toBeNull();
    return element!;
  });
  selectEditorContents(editor);
  const copied: Record<string, string> = {};
  fireEvent.copy(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => copied[type] ?? "",
      setData: (type: string, value: string) => {
        copied[type] = value;
      }
    }
  });
  rendered.unmount();
  return copied;
}

async function pasteEditorPrompt(
  clipboard: Record<string, string>
): Promise<string> {
  const onChange = vi.fn<(value: string) => void>();
  const rendered = render(
    <AgentRichTextEditor
      value=""
      disabled={false}
      placeholder="Prompt"
      onChange={onChange}
      onSubmit={vi.fn()}
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
      files: [],
      getData: (type: string) => clipboard[type] ?? ""
    }
  });
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  const result = onChange.mock.calls.at(-1)?.[0] ?? "";
  rendered.unmount();
  return result;
}

function selectEditorContents(editor: HTMLElement): void {
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
}
