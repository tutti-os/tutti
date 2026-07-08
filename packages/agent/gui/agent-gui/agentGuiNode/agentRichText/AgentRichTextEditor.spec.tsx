import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import {
  AgentRichTextEditor,
  isAgentRichTextLargeTextPaste,
  type AgentRichTextEditorHandle
} from "./AgentRichTextEditor";
import { AgentGuiI18nProvider } from "../../../i18n/index";
import type { AgentFileMentionSuggestionState } from "./agentFileMentionExtension";
import { writeWorkspaceFileDropData } from "../../terminalNode/workspaceFileDrop";

function clipboard(
  text: string,
  html = ""
): { getData: (type: string) => string } {
  return {
    getData: (type: string) =>
      type === "text/plain" ? text : type === "text/html" ? html : ""
  };
}

function writableClipboard(): {
  getData: (type: string) => string;
  setData: (type: string, value: string) => void;
} {
  const store = new Map<string, string>();
  return {
    getData: (type: string) => store.get(type) ?? "",
    setData: (type: string, value: string) => {
      store.set(type, value);
    }
  };
}

function createDataTransferStub(files: readonly File[] = []): DataTransfer {
  const store = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    types: [] as string[],
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file
    })),
    setData(format: string, data: string) {
      store.set(format, data);
      dataTransfer.types = [...store.keys()];
    },
    getData(format: string) {
      return store.get(format) ?? "";
    }
  };
  return dataTransfer as unknown as DataTransfer;
}

function createDataTransferFilesFallbackStub(
  files: readonly File[] = []
): DataTransfer {
  const dataTransfer = createDataTransferStub(files) as unknown as {
    items: Array<{ getAsFile: () => File | null }>;
  };
  dataTransfer.items = dataTransfer.items.map((item) => ({
    ...item,
    getAsFile: () => null
  }));
  return dataTransfer as unknown as DataTransfer;
}

function createProtectedFileDragDataTransferStub(
  files: readonly File[] = []
): DataTransfer {
  const dataTransfer = createDataTransferStub(files) as unknown as {
    files: readonly File[];
    items: Array<{ getAsFile: () => File | null }>;
    types: string[];
  };
  dataTransfer.files = [];
  dataTransfer.items = dataTransfer.items.map((item) => ({
    ...item,
    getAsFile: () => null
  }));
  dataTransfer.types = ["Files"];
  return dataTransfer as unknown as DataTransfer;
}

function selectEditorText(editor: HTMLElement, from: number, to: number): void {
  const textNode = editor.querySelector("p")?.firstChild;
  if (!textNode) {
    throw new Error("Editor text node not found.");
  }
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function selectEditorContents(editor: HTMLElement): void {
  const paragraph = editor.querySelector("p");
  if (!paragraph) {
    throw new Error("Editor paragraph not found.");
  }
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

describe("AgentRichTextEditor", () => {
  it("renders the placeholder on the empty editor paragraph so it shares the caret line box", async () => {
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const placeholderNode = editor.querySelector(
      ".agent-rich-text-placeholder-node"
    );

    expect(placeholderNode).not.toBeNull();
    expect(placeholderNode).toHaveAttribute(
      "data-agent-rich-text-placeholder",
      "Prompt"
    );
  });

  it("emits plain prompt text from paste input", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("hello\nworld")
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("hello\nworld"));
  });

  it("pastes non-image files as file mention chips", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        getReferenceForFile={(file) => ({
          path: `/workspace/docs/${file.name}`,
          kind: "file"
        })}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.paste(editor, {
      clipboardData: createDataTransferStub([
        new File(["readme"], "README.md", { type: "text/markdown" })
      ])
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[@README.md](/workspace/docs/README.md) "
      )
    );
    const mention = editor.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-mention-kind", "file");
    expect(mention).toHaveAttribute(
      "data-agent-mention-href",
      "/workspace/docs/README.md"
    );
  });

  it("pastes folders as directory mention chips", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        getReferenceForFile={(file) => ({
          path: `/workspace/docs/${file.name}`,
          kind: "folder"
        })}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.paste(editor, {
      clipboardData: createDataTransferStub([new File([""], "assets")])
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[@assets](/workspace/docs/assets/) "
      )
    );
    const mention = editor.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-file-entry-kind", "directory");
    expect(mention).toHaveAttribute("data-agent-file-visual-kind", "folder");
  });

  it("pastes files when clipboard items cannot resolve files but files are present", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        getReferenceForFile={(file) => ({
          path: `/workspace/docs/${file.name}`,
          kind: "file"
        })}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.paste(editor, {
      clipboardData: createDataTransferFilesFallbackStub([
        new File(["readme"], "README.md", { type: "text/markdown" })
      ])
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[@README.md](/workspace/docs/README.md) "
      )
    );
  });

  it("does not paste supported image files with empty MIME types as file mention chips", async () => {
    const getReferenceForFile = vi.fn((file: File) => ({
      path: `/workspace/docs/${file.name}`,
      kind: "file" as const
    }));
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        getReferenceForFile={getReferenceForFile}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.paste(editor, {
      clipboardData: createDataTransferStub([new File(["png"], "photo.png")])
    });

    expect(getReferenceForFile).not.toHaveBeenCalled();
    expect(editor.querySelector('[data-agent-file-mention="true"]')).toBeNull();
  });

  it("still pastes unsupported image-like files with empty MIME types as file mention chips", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        getReferenceForFile={(file) => ({
          path: `/workspace/docs/${file.name}`,
          kind: "file"
        })}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.paste(editor, {
      clipboardData: createDataTransferStub([new File(["gif"], "clip.gif")])
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[@clip.gif](/workspace/docs/clip.gif) "
      )
    );
  });

  it("pastes plain text after an existing reference mention", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value="[@package-lock.json](/workspace/package-lock.json) "
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("继续输入")
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[@package-lock.json](/workspace/package-lock.json) 继续输入"
      )
    );
  });

  it("detects long pasted text without inserting it inline", async () => {
    const onChange = vi.fn();
    const onPasteLargeText = vi.fn();
    const pastedText = Array.from({ length: 14 }, (_, index) => {
      return `line ${index + 1}`;
    }).join("\n");
    render(
      <AgentRichTextEditor
        value="before "
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onPasteLargeText={onPasteLargeText}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard(pastedText)
    });

    expect(onPasteLargeText).toHaveBeenCalledWith(pastedText);
    expect(onChange).not.toHaveBeenCalledWith(
      expect.stringContaining("line 1")
    );
  });

  it("keeps short pasted text inline when large text handling is available", async () => {
    const onChange = vi.fn();
    const onPasteLargeText = vi.fn();
    render(
      <AgentRichTextEditor
        value="before "
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onPasteLargeText={onPasteLargeText}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("short paste")
    });

    expect(onPasteLargeText).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith("before short paste")
    );
  });

  it("treats very long single-line paste as large text", () => {
    expect(isAgentRichTextLargeTextPaste("x".repeat(2_000))).toBe(true);
    expect(isAgentRichTextLargeTextPaste("x".repeat(1_999))).toBe(false);
  });

  it("copies selected reference mentions as prompt markdown", async () => {
    const clipboardData = writableClipboard();
    render(
      <AgentRichTextEditor
        value="Use [@package-lock.json](/workspace/package-lock.json) now"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    selectEditorContents(editor);
    fireEvent.copy(editor, { clipboardData });

    expect(clipboardData.getData("text/plain")).toBe(
      "Use [@package-lock.json](/workspace/package-lock.json) now"
    );
  });

  it("renders known skill triggers as atomic prompt tokens", async () => {
    render(
      <AgentRichTextEditor
        value="Use /caveman and /compact"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        availableSkills={[
          {
            name: "caveman",
            trigger: "$caveman",
            sourceKind: "personal"
          }
        ]}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const skillToken = editor.querySelector('[data-agent-skill-token="true"]');
    expect(skillToken).not.toBeNull();
    expect(skillToken).toHaveTextContent("/caveman");
    expect(skillToken).toHaveAttribute("data-agent-skill-trigger", "/caveman");
    expect(editor).toHaveTextContent("/compact");
  });

  it("renders known capability triggers as atomic prompt tokens", async () => {
    const capabilityProps = {
      availableCapabilities: [
        {
          capability: "browserUse",
          label: "浏览器",
          name: "browser",
          trigger: "/browser"
        }
      ]
    };

    render(
      <AgentRichTextEditor
        {...capabilityProps}
        value="Use /browser and /compact"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const capabilityToken = editor.querySelector(
      '[data-agent-capability-token="true"]'
    );
    expect(capabilityToken).not.toBeNull();
    expect(capabilityToken).toHaveTextContent("/浏览器");
    expect(capabilityToken).toHaveAttribute(
      "data-agent-capability-trigger",
      "/browser"
    );
    expect(editor).toHaveTextContent("/compact");
  });

  it("selects a skill token before Backspace deletes it", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value="/caveman"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        availableSkills={[
          {
            name: "caveman",
            trigger: "$caveman",
            sourceKind: "personal"
          }
        ]}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const skillToken = editor.querySelector('[data-agent-skill-token="true"]');
    expect(skillToken).not.toBeNull();

    fireEvent.keyDown(editor, { key: "Backspace" });
    await waitFor(() =>
      expect(skillToken).toHaveClass("ProseMirror-selectednode")
    );
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Backspace" });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
  });

  it("selects a skill token before ArrowLeft skips over it", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value="/caveman"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        availableSkills={[
          {
            name: "caveman",
            trigger: "$caveman",
            sourceKind: "personal"
          }
        ]}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const skillToken = editor.querySelector('[data-agent-skill-token="true"]');
    expect(skillToken).not.toBeNull();

    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(skillToken).toHaveClass("ProseMirror-selectednode")
    );

    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(skillToken).not.toHaveClass("ProseMirror-selectednode")
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits prompt text when pasting known skill trigger tokens", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        availableSkills={[
          {
            name: "caveman",
            trigger: "$caveman",
            sourceKind: "personal"
          }
        ]}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("/caveman")
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("/caveman"));
  });

  it("shows composer text actions from the context menu", async () => {
    render(
      <AgentRichTextEditor
        value="hello"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.contextMenu(
      await screen.findByRole("textbox", { name: "Prompt" }),
      { clientX: 48, clientY: 72 }
    );

    expect(
      screen.getByRole("menu", { name: "Composer text actions" })
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Cut" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Paste" })).toBeEnabled();
  });

  it("pastes clipboard text from the composer context menu", async () => {
    const onChange = vi.fn();
    const readText = vi.fn().mockResolvedValue("hello /browser");
    Object.assign(navigator, {
      clipboard: {
        readText
      }
    });

    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        availableCapabilities={[
          {
            capability: "browserUse",
            label: "浏览器",
            name: "browser",
            trigger: "/browser"
          }
        ]}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.contextMenu(editor, { clientX: 48, clientY: 72 });
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Paste" }), {
      button: 0
    });

    await waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith("hello /browser")
    );
    await waitFor(() =>
      expect(
        editor.querySelector('[data-agent-capability-token="true"]')
      ).not.toBeNull()
    );
    expect(
      screen.queryByRole("menu", { name: "Composer text actions" })
    ).not.toBeInTheDocument();
  });

  it("cuts selected text from the composer context menu on pointer down", async () => {
    const onChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText
      }
    });

    render(
      <AgentRichTextEditor
        value="hello world"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await act(async () => {
      await Promise.resolve();
    });
    selectEditorText(editor, 0, "hello world".length);
    fireEvent.contextMenu(editor, { clientX: 48, clientY: 72 });
    expect(screen.getByRole("menuitem", { name: "Cut" })).toBeEnabled();
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Cut" }), {
      button: 0
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello world"));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
    expect(
      screen.queryByRole("menu", { name: "Composer text actions" })
    ).not.toBeInTheDocument();
  });

  it("submits on Enter, sends guidance on Cmd+Enter, and ignores Enter during IME composition", async () => {
    const onSubmit = vi.fn();
    const onSubmitGuidance = vi.fn();
    render(
      <AgentRichTextEditor
        value="hello"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onSubmitGuidance={onSubmitGuidance}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmitGuidance).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmitGuidance).toHaveBeenCalledTimes(1);
  });

  it("scrolls the composer to the caret after Shift+Enter inserts a new line", async () => {
    const onChange = vi.fn();
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        window.setTimeout(() => callback(0), 0);
        return 1;
      });

    try {
      render(
        <AgentRichTextEditor
          value={"one\ntwo\nthree"}
          disabled={false}
          placeholder="Prompt"
          onChange={onChange}
          onSubmit={vi.fn()}
        />
      );

      const editor = await screen.findByRole("textbox", { name: "Prompt" });
      Object.defineProperty(editor, "clientHeight", {
        configurable: true,
        value: 48
      });
      Object.defineProperty(editor, "scrollHeight", {
        configurable: true,
        value: 120
      });
      editor.scrollTop = 0;

      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith("one\ntwo\nthree\n")
      );
      await waitFor(() => expect(editor.scrollTop).toBe(72));
    } finally {
      requestAnimationFrameSpy.mockRestore();
    }
  });

  it("does not submit on Enter while disabled", async () => {
    const onSubmit = vi.fn();
    render(
      <AgentRichTextEditor
        value="hello"
        disabled={true}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    fireEvent.keyDown(await screen.findByRole("textbox", { name: "Prompt" }), {
      key: "Enter"
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("lets the palette consume command keys before submit handling", async () => {
    const onSubmit = vi.fn();
    const onKeyDownForPalette = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return true;
    });
    render(
      <AgentRichTextEditor
        value="/"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onKeyDownForPalette={onKeyDownForPalette}
      />
    );

    fireEvent.keyDown(await screen.findByRole("textbox", { name: "Prompt" }), {
      key: "Enter"
    });

    expect(onKeyDownForPalette).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not open file mention suggestions after pasted at queries", async () => {
    const onFileMentionSuggestionChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={onFileMentionSuggestionChange}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("@readme")
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveTextContent(
        "@readme"
      )
    );
    expect(onFileMentionSuggestionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: "readme", text: "@readme" })
    );

    onFileMentionSuggestionChange.mockClear();
    rendered.rerender(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={onFileMentionSuggestionChange}
      />
    );
    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("a@b.com")
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveTextContent(
        "a@b.com"
      )
    );
    expect(onFileMentionSuggestionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: "b.com" })
    );
  });

  it("opens file mention suggestions after pasting a bare at trigger", async () => {
    const onFileMentionSuggestionChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={onFileMentionSuggestionChange}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("@")
    });

    await waitFor(() =>
      expect(onFileMentionSuggestionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "", text: "@" })
      )
    );
  });

  it("opens file mention suggestions from the imperative mention palette handle", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const onFileMentionSuggestionChange = vi.fn();
    render(
      <AgentRichTextEditor
        ref={ref}
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={onFileMentionSuggestionChange}
      />
    );

    await screen.findByRole("textbox", { name: "Prompt" });
    act(() => {
      ref.current?.openMentionPalette();
    });

    await waitFor(() =>
      expect(onFileMentionSuggestionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "", text: "@" })
      )
    );
  });

  it("does not open file mention suggestions after a slash path segment", async () => {
    const onFileMentionSuggestionChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={onFileMentionSuggestionChange}
      />
    );

    fireEvent.paste(await screen.findByRole("textbox", { name: "Prompt" }), {
      clipboardData: clipboard("hello/@readme")
    });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveTextContent(
        "hello/@readme"
      )
    );
    expect(onFileMentionSuggestionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: "readme" })
    );
  });

  it("syncs external value changes without emitting another change", async () => {
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value="alpha"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    expect(editor.textContent).toContain("alpha");

    rendered.rerender(
      <AgentRichTextEditor
        value="beta"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    await waitFor(() => expect(editor.textContent).toContain("beta"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hydrates controlled file mention markdown as mention chips", async () => {
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value="Read [@README.md](/workspace/docs/README.md)"
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(editor).toHaveTextContent("Read README.md"));
    expect(
      editor.querySelector('[data-agent-file-mention="true"]')
    ).toHaveAttribute("data-agent-mention-kind", "file");
    expect(
      editor.querySelector(".tsh-agent-object-token__main")?.textContent
    ).toBe("README.md");
    expect(
      editor.querySelector(
        '[data-agent-file-mention="true"][data-agent-mention-kind="file"] button[aria-label="Remove mention"]'
      )
    ).not.toBeNull();
    expect(editor).not.toHaveTextContent(
      "[@README.md](/workspace/docs/README.md)"
    );
    expect(editor).not.toHaveTextContent("@README.md");

    rendered.rerender(
      <AgentRichTextEditor
        value="Read [@README.md](/workspace/docs/README.md)"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    await waitFor(() => expect(editor).toHaveTextContent("Read README.md"));
    expect(
      editor.querySelector(".tsh-agent-object-token__main")?.textContent
    ).toBe("README.md");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps line-start caret anchors out of copied prompt text", async () => {
    const clipboardData = writableClipboard();
    render(
      <AgentRichTextEditor
        value={
          "[@README.md](/workspace/docs/README.md)\n[@docs](/workspace/docs)"
        }
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(editor).toHaveTextContent("README.md"));
    selectEditorContents(editor);
    fireEvent.copy(editor, { clipboardData });
    expect(clipboardData.getData("text/plain")).not.toContain("\u200B");
    expect(clipboardData.getData("text/plain")).toBe(
      "[@README.md](/workspace/docs/README.md)\n[@docs](/workspace/docs)"
    );
  });

  it("skips line-start caret anchors when navigating right into a mention", async () => {
    const onChange = vi.fn();
    const ref = createRef<AgentRichTextEditorHandle>();
    render(
      <AgentRichTextEditor
        ref={ref}
        value="[@README.md](/workspace/docs/README.md)"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(editor).toHaveTextContent("README.md"));
    act(() => {
      ref.current?.focusAtStart();
    });
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    fireEvent.paste(editor, { clipboardData: clipboard("x") });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[@README.md](/workspace/docs/README.md)x"
      )
    );
  });

  it("skips line-start caret anchors when navigating left over a mention", async () => {
    const onChange = vi.fn();
    const ref = createRef<AgentRichTextEditorHandle>();
    render(
      <AgentRichTextEditor
        ref={ref}
        value="[@README.md](/workspace/docs/README.md)"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(editor).toHaveTextContent("README.md"));
    act(() => {
      ref.current?.focusAtEnd();
    });
    expect(ref.current?.getPromptTextBeforeSelection()).not.toBe("");
    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    expect(ref.current?.getPromptTextBeforeSelection()).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes hydrated file mentions through the icon hover remove button", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value="Read [@README.md](/workspace/docs/README.md) and [@notes.md](/workspace/docs/notes.md)"
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const firstFileMention = editor.querySelector(
      '[data-agent-file-mention="true"][data-agent-mention-kind="file"]'
    );
    const removeButton = firstFileMention?.querySelector(
      'button[aria-label="Remove mention"]'
    );

    expect(removeButton).not.toBeNull();
    fireEvent.mouseDown(removeButton!);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latestPrompt = onChange.mock.calls.at(-1)?.[0] as string;
    expect(latestPrompt).not.toContain("README.md");
    expect(latestPrompt).not.toContain("/workspace/docs/README.md");
    expect(latestPrompt).toContain("notes.md");
    expect(latestPrompt).toContain("/workspace/docs/notes.md");
  });

  it("hydrates issue and session mentions as unified entity chips without visible @ prefixes", async () => {
    render(
      <AgentRichTextEditor
        value={
          "继续 [@wang jomes · Codex · @README.md 看看项目文件](mention://agent-session/session-1?workspaceId=room-1) " +
          "再处理 [@修复 room status 批量接口](mention://workspace-issue/issue-1?workspaceId=room-1)"
        }
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const mentions = editor.querySelectorAll(
      '[data-agent-file-mention="true"]'
    );
    expect(mentions).toHaveLength(2);

    const sessionMention = mentions[0]!;
    expect(sessionMention).toHaveAttribute(
      "data-agent-mention-kind",
      "session"
    );
    expect(sessionMention).toHaveAttribute(
      "aria-label",
      "Session wang jomes & Codex README.md 看看项目文件"
    );
    expect(sessionMention).toHaveAttribute("data-slot", "mention-pill");
    expect(
      sessionMention.querySelector('button[aria-label="Remove mention"]')
    ).not.toBeNull();
    expect(sessionMention).toHaveTextContent(
      "wang jomes & Codex README.md 看看项目文件"
    );
    expect(sessionMention.textContent).not.toContain("·");
    expect(sessionMention.textContent).not.toContain("@");
    expect(sessionMention.textContent).not.toContain("Session");

    const issueMention = mentions[1]!;
    expect(issueMention).toHaveAttribute(
      "data-agent-mention-kind",
      "workspace-issue"
    );
    expect(issueMention).toHaveAttribute(
      "aria-label",
      "Task 修复 room status 批量接口"
    );
    expect(issueMention).toHaveAttribute("data-slot", "mention-pill");
    expect(
      issueMention.querySelector('button[aria-label="Remove mention"]')
    ).not.toBeNull();
    expect(issueMention).toHaveTextContent("修复 room status 批量接口");
    expect(issueMention.textContent).not.toContain("@");
    expect(issueMention.textContent).not.toContain("Issue");
  });

  it("localizes mention aria labels", async () => {
    render(
      <AgentGuiI18nProvider locale="zh-CN">
        <AgentRichTextEditor
          value={
            "继续 [@wang jomes · Codex · @README.md 看看项目文件](mention://agent-session/session-1?workspaceId=room-1) " +
            "再处理 [@修复 room status 批量接口](mention://workspace-issue/issue-1?workspaceId=room-1)"
          }
          disabled={false}
          placeholder="Prompt"
          removeMentionLabel="移除引用"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </AgentGuiI18nProvider>
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const mentions = editor.querySelectorAll(
      '[data-agent-file-mention="true"]'
    );

    expect(mentions[0]).toHaveAttribute(
      "aria-label",
      "会话 wang jomes & Codex README.md 看看项目文件"
    );
    expect(mentions[1]).toHaveAttribute(
      "aria-label",
      "任务 修复 room status 批量接口"
    );
  });

  it("removes hydrated session mentions through the mention pill remove button", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value={
          "继续 [@wang jomes · Codex · Current issue](mention://agent-session/session-1?workspaceId=room-1) " +
          "再处理 [@修复 room status 批量接口](mention://workspace-issue/issue-1?workspaceId=room-1)"
        }
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const sessionMention = editor.querySelector(
      '[data-agent-mention-kind="session"][data-slot="mention-pill"]'
    );
    const removeButton = sessionMention?.querySelector(
      'button[aria-label="Remove mention"]'
    );

    expect(removeButton).not.toBeNull();
    fireEvent.mouseDown(removeButton!);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latestPrompt = onChange.mock.calls.at(-1)?.[0] as string;
    expect(latestPrompt).not.toContain("mention://agent-session");
    expect(latestPrompt).not.toContain("wang jomes");
    expect(latestPrompt).toContain("mention://workspace-issue");
  });

  it("does not show mention remove buttons while disabled", async () => {
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value={
          "继续 [@wang jomes · Codex · Current issue](mention://agent-session/session-1?workspaceId=room-1) " +
          "再处理 [@修复 room status 批量接口](mention://workspace-issue/issue-1?workspaceId=room-1)"
        }
        disabled={true}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    expect(
      editor.querySelector('button[aria-label="Remove mention"]')
    ).toBeNull();

    rendered.rerender(
      <AgentRichTextEditor
        value={
          "继续 [@wang jomes · Codex · Current issue](mention://agent-session/session-1?workspaceId=room-1) " +
          "再处理 [@修复 room status 批量接口](mention://workspace-issue/issue-1?workspaceId=room-1)"
        }
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(
        editor.querySelector('button[aria-label="Remove mention"]')
      ).not.toBeNull()
    );

    rendered.rerender(
      <AgentRichTextEditor
        value={
          "继续 [@wang jomes · Codex · Current issue](mention://agent-session/session-1?workspaceId=room-1) " +
          "再处理 [@修复 room status 批量接口](mention://workspace-issue/issue-1?workspaceId=room-1)"
        }
        disabled={true}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(
        editor.querySelector('button[aria-label="Remove mention"]')
      ).toBeNull()
    );
  });

  it("shows the placeholder after removing the last mention from a visually empty prompt", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value="[@wang jomes · Codex · Current issue](mention://agent-session/session-1?workspaceId=room-1) "
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const removeButton = editor.querySelector(
      '[data-agent-mention-kind="session"][data-slot="mention-pill"] button[aria-label="Remove mention"]'
    );

    expect(removeButton).not.toBeNull();
    fireEvent.mouseDown(removeButton!);

    await waitFor(() =>
      expect(
        editor.querySelector(".agent-rich-text-placeholder-node")
      ).toHaveAttribute("data-agent-rich-text-placeholder", "Prompt")
    );
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("");
  });

  it("inserts workspace references as mention chips through the imperative handle", async () => {
    const onChange = vi.fn();
    const ref = createRef<AgentRichTextEditorHandle>();
    render(
      <AgentRichTextEditor
        ref={ref}
        value="Read "
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    await screen.findByRole("textbox", { name: "Prompt" });

    act(() => {
      ref.current?.insertWorkspaceReferences([
        {
          path: "/Users/test/project/tutti/docs/README.md",
          displayName: "README.md",
          kind: "file"
        }
      ]);
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "Read [@README.md](/Users/test/project/tutti/docs/README.md) "
      )
    );
  });

  it("does not render workspace app ids in mention chips", async () => {
    const appId = "app_665a8448-a202-41a6-96ab-de4f4194c0a6";
    render(
      <AgentRichTextEditor
        value={`[@天气查询](mention://workspace-app/${appId}?workspaceId=workspace-1)`}
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() =>
      expect(
        editor.querySelector('[data-agent-mention-kind="workspace-app"]')
      ).not.toBeNull()
    );

    const appMention = editor.querySelector(
      '[data-agent-mention-kind="workspace-app"]'
    );
    expect(appMention).toHaveTextContent("天气查询");
    expect(appMention).not.toHaveTextContent(appId);
    expect(appMention).toHaveAttribute(
      "data-agent-mention-href",
      `mention://workspace-app/${appId}?workspaceId=workspace-1`
    );
    expect(
      appMention?.querySelector(
        '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"]'
      )
    ).not.toBeNull();
    expect(
      appMention?.querySelector(
        '[data-agent-mention-app-icon="true"] .tsh-agent-object-token__kind-icon'
      )
    ).not.toBeNull();
  });

  it("renders agent target mention chips from markdown hrefs", async () => {
    render(
      <AgentRichTextEditor
        value="[@Claude Code](mention://agent-target/local:claude-code?workspaceId=workspace-1)"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() =>
      expect(
        editor.querySelector('[data-agent-mention-kind="agent-target"]')
      ).not.toBeNull()
    );

    const agentMention = editor.querySelector(
      '[data-agent-mention-kind="agent-target"]'
    );
    expect(agentMention).toHaveTextContent("Claude Code");
    expect(agentMention).toHaveAttribute(
      "data-agent-mention-kind",
      "agent-target"
    );
  });

  it("renders image file mention chips with dock preview thumbnails", async () => {
    let suggestionState: AgentFileMentionSuggestionState | null = null;
    render(
      <AgentRichTextEditor
        value="@"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={(state) => {
          suggestionState = state;
        }}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(suggestionState).not.toBeNull());

    act(() => {
      suggestionState?.command({
        kind: "file",
        href: "/workspace/diagram.png",
        path: "/workspace/diagram.png",
        name: "diagram.png",
        entryKind: "unknown",
        directoryPath: "/workspace",
        thumbnailUrl: "data:image/png;base64,thumb"
      });
    });

    await waitFor(() =>
      expect(
        editor.querySelector(
          '[data-agent-file-mention="true"][data-agent-mention-kind="file"] img'
        )
      ).not.toBeNull()
    );
    expect(
      editor.querySelector(
        '[data-agent-file-mention="true"][data-agent-mention-kind="file"] img'
      )
    ).toHaveAttribute("src", "data:image/png;base64,thumb");
    expect(
      editor.querySelector(".agent-gui-node__mention-file-thumb")
    ).not.toBeNull();
    expect(editor.querySelector(".tsh-agent-object-token__icon")).toBeNull();
  });

  it("renders non-image file mention chips with the default file icon", async () => {
    let suggestionState: AgentFileMentionSuggestionState | null = null;
    render(
      <AgentRichTextEditor
        value="@"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={(state) => {
          suggestionState = state;
        }}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(suggestionState).not.toBeNull());

    act(() => {
      suggestionState?.command({
        kind: "file",
        href: "/workspace/report.docx",
        path: "/workspace/report.docx",
        name: "report.docx",
        entryKind: "unknown",
        directoryPath: "/workspace",
        thumbnailUrl: "data:image/png;base64,thumb"
      });
    });

    await waitFor(() =>
      expect(
        editor.querySelector(
          '[data-agent-file-mention="true"][data-agent-mention-kind="file"] .tsh-agent-object-token__icon'
        )
      ).not.toBeNull()
    );
    expect(
      editor.querySelector('[data-agent-mention-file-thumb="true"]')
    ).toBeNull();
  });

  it("renders workspace app mention chips with the app icon", async () => {
    let suggestionState: AgentFileMentionSuggestionState | null = null;
    render(
      <AgentRichTextEditor
        value="@"
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onFileMentionSuggestionChange={(state) => {
          suggestionState = state;
        }}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(suggestionState).not.toBeNull());

    act(() => {
      suggestionState?.command({
        kind: "workspace-app",
        href: "mention://workspace-app/vibe-design?workspaceId=workspace-1",
        workspaceId: "workspace-1",
        targetId: "vibe-design",
        appId: "vibe-design",
        name: "Vibe Design",
        description: "Create prototypes",
        iconUrl: "tutti://workspace-apps/vibe-design/icon.png"
      });
    });

    await waitFor(() =>
      expect(
        editor.querySelector(
          '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"] img'
        )
      ).not.toBeNull()
    );
    expect(
      editor.querySelector(
        '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"] img'
      )
    ).toHaveAttribute("src", "tutti://workspace-apps/vibe-design/icon.png");
    expect(
      editor.querySelector(
        '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"] button[aria-label="Remove mention"]'
      )
    ).not.toBeNull();
  });

  it("preserves workspace app icon urls when pasting copied mention html", async () => {
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.paste(editor, {
      clipboardData: clipboard(
        "Daily Product Radar",
        [
          '<a data-agent-file-mention="true"',
          ' data-agent-mention-kind="workspace-app"',
          ' data-agent-mention-href="mention://workspace-app/daily-product-radar?workspaceId=workspace-1"',
          ' data-agent-mention-icon-url="tutti://workspace-apps/daily-product-radar/icon.png">',
          "Daily Product Radar",
          "</a>"
        ].join("")
      )
    });

    await waitFor(() =>
      expect(
        editor.querySelector(
          '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"] img'
        )
      ).not.toBeNull()
    );
    expect(
      editor.querySelector(
        '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"] img'
      )
    ).toHaveAttribute(
      "src",
      "tutti://workspace-apps/daily-product-radar/icon.png"
    );
  });

  it("removes workspace app mentions through the icon hover remove button", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value="Use [@Vibe Design](mention://workspace-app/vibe-design?workspaceId=workspace-1) now"
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const removeButton = editor.querySelector(
      '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"] button[aria-label="Remove mention"]'
    );

    expect(removeButton).not.toBeNull();
    fireEvent.mouseDown(removeButton!);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latestPrompt = onChange.mock.calls.at(-1)?.[0] as string;
    expect(latestPrompt).not.toContain("mention://workspace-app");
    expect(latestPrompt).not.toContain("Vibe Design");
  });

  it("only removes the targeted workspace app mention when the prompt contains multiple mention fields", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value={
          "[@AI Media Canvas](mention://workspace-app/ai-media-canvas?workspaceId=workspace-1)" +
          "[@Vibe Design](mention://workspace-app/vibe-design?workspaceId=workspace-1)"
        }
        disabled={false}
        placeholder="Prompt"
        removeMentionLabel="Remove mention"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const removeButtons = editor.querySelectorAll(
      '[data-slot="mention-pill"][data-agent-mention-kind="workspace-app"] button[aria-label="Remove mention"]'
    );

    expect(removeButtons).toHaveLength(2);
    fireEvent.mouseDown(removeButtons[0]!);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latestPrompt = onChange.mock.calls.at(-1)?.[0] as string;
    expect(latestPrompt).not.toContain("ai-media-canvas");
    expect(latestPrompt).not.toContain("AI Media Canvas");
    expect(latestPrompt).toContain("mention://workspace-app");
    expect(latestPrompt).toContain("vibe-design");
    expect(latestPrompt).toContain("Vibe Design");
  });

  it("preserves selected local folders as folder mentions in readonly hydration", async () => {
    const onChange = vi.fn();
    const ref = createRef<AgentRichTextEditorHandle>();
    const localFolderPath = "/Users/test/project/tutti/superpowers";
    const { unmount } = render(
      <AgentRichTextEditor
        ref={ref}
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    await screen.findByRole("textbox", { name: "Prompt" });

    act(() => {
      ref.current?.insertWorkspaceReferences([
        {
          path: localFolderPath,
          displayName: "superpowers",
          kind: "folder"
        }
      ]);
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[@superpowers](/Users/test/project/tutti/superpowers/) "
      )
    );

    unmount();
    render(
      <AgentRichTextEditor
        value="[@superpowers](/Users/test/project/tutti/superpowers/) "
        disabled={true}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const mention = editor.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute("data-agent-file-entry-kind", "directory");
    expect(mention).toHaveAttribute("data-agent-file-visual-kind", "folder");
    expect(
      mention?.querySelector('button[aria-label="Remove mention"]')
    ).toBeNull();
  });

  it("emits mention hrefs when clicking hydrated chips", async () => {
    const onLinkClick = vi.fn();
    render(
      <AgentRichTextEditor
        value="继续 [@wang jomes · Codex · 看看项目文件](mention://agent-session/session-1?workspaceId=room-1)"
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onLinkClick={onLinkClick}
      />
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    const mention = editor.querySelector('[data-agent-file-mention="true"]');
    expect(mention).toHaveAttribute(
      "data-agent-mention-href",
      "mention://agent-session/session-1?workspaceId=room-1"
    );

    fireEvent.click(mention as Element);

    expect(onLinkClick).toHaveBeenCalledWith(
      "mention://agent-session/session-1?workspaceId=room-1"
    );
  });

  it("inserts a dropped workspace mention into an empty editor", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const dataTransfer = createDataTransferStub();
    writeWorkspaceFileDropData(dataTransfer, [
      {
        path: "/workspace/docs/README.md",
        name: "README.md",
        kind: "file"
      }
    ]);

    fireEvent.dragOver(await screen.findByRole("textbox", { name: "Prompt" }), {
      dataTransfer
    });
    fireEvent.drop(screen.getByRole("textbox", { name: "Prompt" }), {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        "[@README.md](/workspace/docs/README.md) "
      )
    );
  });

  it("adds dropped system image files as prompt images", async () => {
    const onChange = vi.fn();
    const onPasteImages = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onPasteImages={onPasteImages}
      />
    );

    const dataTransfer = createDataTransferStub([
      new File(["image"], "diagram.png", { type: "image/png" })
    ]);
    const editor = await screen.findByRole("textbox", { name: "Prompt" });

    fireEvent.dragOver(editor, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");

    fireEvent.drop(editor, {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    await waitFor(() =>
      expect(onPasteImages).toHaveBeenCalledWith([
        {
          name: "diagram.png",
          mimeType: "image/png",
          data: "aW1hZ2U="
        }
      ])
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes dropped system non-image files to the composer upload path", async () => {
    const onChange = vi.fn();
    const onDropFiles = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onDropFiles={onDropFiles}
      />
    );

    const dataTransfer = createDataTransferStub([
      new File(["report"], "report.pdf", { type: "application/pdf" }),
      new File(["notes"], "notes.txt", { type: "text/plain" })
    ]);
    const editor = await screen.findByRole("textbox", { name: "Prompt" });

    fireEvent.dragOver(editor, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(editor, {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    expect(onDropFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: "report.pdf" }),
      expect.objectContaining({ name: "notes.txt" })
    ]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts protected system file drags before FileList is readable", async () => {
    const onDropFiles = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onDropFiles={onDropFiles}
      />
    );

    const dataTransfer = createProtectedFileDragDataTransferStub([
      new File(["report"], "report.pdf", { type: "application/pdf" })
    ]);
    const editor = await screen.findByRole("textbox", { name: "Prompt" });

    fireEvent.dragOver(editor, { dataTransfer });

    expect(dataTransfer.dropEffect).toBe("copy");
    expect(onDropFiles).not.toHaveBeenCalled();
  });

  it("keeps mixed system image and file drops in their separate composer paths", async () => {
    const onChange = vi.fn();
    const onPasteImages = vi.fn();
    const onDropFiles = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onPasteImages={onPasteImages}
        onDropFiles={onDropFiles}
      />
    );

    const dataTransfer = createDataTransferStub([
      new File(["image"], "diagram.png", { type: "image/png" }),
      new File(["report"], "report.pdf", { type: "application/pdf" })
    ]);
    const editor = await screen.findByRole("textbox", { name: "Prompt" });

    fireEvent.drop(editor, {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    expect(onDropFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: "report.pdf" })
    ]);
    await waitFor(() =>
      expect(onPasteImages).toHaveBeenCalledWith([
        {
          name: "diagram.png",
          mimeType: "image/png",
          data: "aW1hZ2U="
        }
      ])
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("inserts multiple dropped workspace mentions in drag order", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const dataTransfer = createDataTransferStub();
    writeWorkspaceFileDropData(dataTransfer, [
      {
        path: "/workspace/docs/README.md",
        name: "README.md",
        kind: "file"
      },
      {
        path: "/workspace/src",
        name: "src",
        kind: "directory"
      }
    ]);

    fireEvent.drop(await screen.findByRole("textbox", { name: "Prompt" }), {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        "[@README.md](/workspace/docs/README.md) [@src](/workspace/src) "
      )
    );
  });

  it("inserts dropped workspace mentions at the resolved drop position", async () => {
    const onChange = vi.fn();
    const posAtCoordsSpy = vi
      .spyOn(EditorView.prototype, "posAtCoords")
      .mockReturnValue({ pos: 7, inside: -1 });

    render(
      <AgentRichTextEditor
        value="hello world"
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const dataTransfer = createDataTransferStub();
    writeWorkspaceFileDropData(dataTransfer, [
      {
        path: "/workspace/docs/README.md",
        name: "README.md",
        kind: "file"
      }
    ]);

    fireEvent.drop(await screen.findByRole("textbox", { name: "Prompt" }), {
      dataTransfer,
      clientX: 48,
      clientY: 12
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        "hello [@README.md](/workspace/docs/README.md) world"
      )
    );
    posAtCoordsSpy.mockRestore();
  });

  it("ignores non-workspace drops", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.drop(await screen.findByRole("textbox", { name: "Prompt" }), {
      dataTransfer: createDataTransferStub()
    });

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Prompt" })
      ).toBeInTheDocument()
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("swallows malformed internal workspace drops instead of inserting plain text", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      "application/x-tsh-workspace-file-paths+json",
      JSON.stringify({
        entries: [{ path: "", name: "README.md", kind: "file" }]
      })
    );
    dataTransfer.setData("text/plain", "/workspace/docs/README.md");

    fireEvent.drop(await screen.findByRole("textbox", { name: "Prompt" }), {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Prompt" })
      ).toBeInTheDocument()
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Prompt" })
    ).not.toHaveTextContent("/workspace/docs/README.md");
  });

  it("ignores workspace drops while disabled", async () => {
    const onChange = vi.fn();
    render(
      <AgentRichTextEditor
        value=""
        disabled={true}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const dataTransfer = createDataTransferStub();
    writeWorkspaceFileDropData(dataTransfer, [
      {
        path: "/workspace/docs/README.md",
        name: "README.md",
        kind: "file"
      }
    ]);

    fireEvent.drop(await screen.findByRole("textbox", { name: "Prompt" }), {
      dataTransfer,
      clientX: 8,
      clientY: 8
    });

    expect(onChange).not.toHaveBeenCalled();
  });
});
