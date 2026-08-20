import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { RichTextMentionServiceProvider } from "@tutti-os/ui-rich-text/editor";
import {
  createRichTextMentionService,
  type RichTextMentionService
} from "@tutti-os/ui-rich-text/service";
import type {
  RichTextMentionResolved,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";
import {
  registerAgentCustomMentionKind,
  resetAgentCustomMentionKindsForTests
} from "../../../shared/agentCustomMentionKinds";
import { AgentTargetPresentationProvider } from "../../../shared/AgentTargetPresentationContext";
import { AgentRichTextEditor } from "./AgentRichTextEditor";
import type { AgentRichTextEditorHandle } from "./AgentRichTextEditor.types";
import { isAgentRichTextAbsolutePathPasteCandidate } from "./agentRichTextEditorSupport";

describe("isAgentRichTextAbsolutePathPasteCandidate", () => {
  it("accepts a single absolute path", () => {
    expect(isAgentRichTextAbsolutePathPasteCandidate("/workspace/a.txt")).toBe(
      true
    );
    expect(
      isAgentRichTextAbsolutePathPasteCandidate(" /Users/me/a.txt\n")
    ).toBe(true);
  });

  it("rejects quoted, spaced, relative, and multi-path pastes", () => {
    expect(
      isAgentRichTextAbsolutePathPasteCandidate('" /workspace/a.txt"')
    ).toBe(false);
    expect(
      isAgentRichTextAbsolutePathPasteCandidate("/workspace/my file.txt")
    ).toBe(false);
    expect(isAgentRichTextAbsolutePathPasteCandidate("workspace/a.txt")).toBe(
      false
    );
    expect(
      isAgentRichTextAbsolutePathPasteCandidate(
        "/workspace/a.txt\n/workspace/b.txt"
      )
    ).toBe(false);
  });
});

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

  it("inserts a resolved absolute path as a file mention", async () => {
    const onResolvePastedPath = vi.fn().mockResolvedValue({
      kind: "file",
      path: "/host/Users/me/demo.txt",
      displayName: "demo.txt"
    });
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onResolvePastedPath={onResolvePastedPath}
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
        getData: (type: string) =>
          type === "text/plain" ? "/Users/me/demo.txt" : ""
      }
    });

    await waitFor(() =>
      expect(onResolvePastedPath).toHaveBeenCalledWith("/Users/me/demo.txt")
    );
    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0]).toContain(
        "[@demo.txt](/host/Users/me/demo.txt)"
      )
    );
  });

  it("falls back to plain text when absolute path resolution returns null", async () => {
    const onResolvePastedPath = vi.fn().mockResolvedValue(null);
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onResolvePastedPath={onResolvePastedPath}
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
        getData: (type: string) =>
          type === "text/plain" ? "/missing/path.txt" : ""
      }
    });

    await waitFor(() =>
      expect(onResolvePastedPath).toHaveBeenCalledWith("/missing/path.txt")
    );
    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0]).toBe("/missing/path.txt")
    );
  });

  it("falls back to plain text when absolute path resolution rejects", async () => {
    const onResolvePastedPath = vi
      .fn()
      .mockRejectedValue(new Error("host unavailable"));
    const onChange = vi.fn();
    const rendered = render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        onChange={onChange}
        onSubmit={vi.fn()}
        onResolvePastedPath={onResolvePastedPath}
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
        getData: (type: string) =>
          type === "text/plain" ? "/Users/me/demo.txt" : ""
      }
    });

    await waitFor(() =>
      expect(onResolvePastedPath).toHaveBeenCalledWith("/Users/me/demo.txt")
    );
    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0]).toBe("/Users/me/demo.txt")
    );
  });

  it("routes pasted images through file preparation when prompt images are unsupported", async () => {
    const onPasteFiles = vi.fn();
    const onPasteImages = vi.fn();
    const onPromptImagesUnsupported = vi.fn();
    const image = new File(["image"], "screen.png", { type: "image/png" });
    const rendered = render(
      <AgentRichTextEditor
        value=""
        disabled={false}
        placeholder="Prompt"
        promptImagesSupported={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onPasteFiles={onPasteFiles}
        onPasteImages={onPasteImages}
        onPromptImagesUnsupported={onPromptImagesUnsupported}
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
        files: [image],
        getData: () => ""
      }
    });

    expect(onPasteFiles).toHaveBeenCalledWith([image]);
    expect(onPasteImages).not.toHaveBeenCalled();
    expect(onPromptImagesUnsupported).not.toHaveBeenCalled();
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

describe("AgentRichTextEditor Agent mention presentation", () => {
  it("uses the target directory icon for a restored session mention", async () => {
    const iconUrl = "data:image/png;base64,gemini";
    const href =
      "mention://agent-session/session-1?agentTargetId=extension%3Agemini&workspaceId=workspace-1";
    const { container } = render(
      <AgentTargetPresentationProvider
        agentTargets={[
          {
            agentTargetId: "extension:gemini",
            iconUrl,
            name: "Gemini CLI",
            provider: "acp:gemini",
            workspaceId: "workspace-1"
          }
        ]}
      >
        <AgentRichTextEditor
          value={`Review [@Gemini session](${href})`}
          disabled={false}
          placeholder="Prompt"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </AgentTargetPresentationProvider>
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-agent-mention-kind="session"] img')
      ).toHaveAttribute("src", iconUrl)
    );
  });

  it("keeps the target catalog presentation over a stale mention-service result", async () => {
    const currentIconUrl = "data:image/png;base64,current-codex";
    const staleIconUrl = "data:image/png;base64,stale-provider";
    const resolveMention = vi.fn(() => ({
      label: "Stale Agent",
      presentation: {
        agentProviderId: "stale-provider",
        iconUrl: staleIconUrl
      }
    }));
    const provider: RichTextTriggerProvider<string> = {
      id: "agent-target",
      trigger: "@",
      query: () => [],
      getItemKey: (item) => item,
      getItemLabel: (item) => item,
      toInsertResult: (item) => ({ kind: "text", text: item }),
      resolveMention
    };
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const rendered = render(
      <RichTextMentionServiceProvider service={mentionService}>
        <AgentTargetPresentationProvider
          agentTargets={[
            {
              agentTargetId: "shared-agent:current",
              iconUrl: currentIconUrl,
              name: "Current Agent",
              provider: "codex",
              workspaceId: "workspace-1"
            }
          ]}
        >
          <AgentRichTextEditor
            value="[@Canonical Agent](mention://agent-target/shared-agent:current?workspaceId=workspace-1)"
            disabled={false}
            placeholder="Prompt"
            onChange={vi.fn()}
            onSubmit={vi.fn()}
          />
        </AgentTargetPresentationProvider>
      </RichTextMentionServiceProvider>
    );

    await waitFor(() => expect(resolveMention).toHaveBeenCalled());
    const mention = rendered.container.querySelector(
      '[data-agent-mention-kind="agent-target"]'
    );
    expect(mention).toHaveTextContent("Current Agent");
    expect(mention?.querySelector("img")).toHaveAttribute(
      "src",
      currentIconUrl
    );
    expect(rendered.container.innerHTML).not.toContain(staleIconUrl);

    mentionService.dispose();
  });

  it("falls back to the canonical label and semantic icon when a resolved mention becomes missing", async () => {
    let resolved: RichTextMentionResolved | null = {
      label: "Resolved Weather",
      presentation: { iconUrl: "https://icons.example/weather.png" }
    };
    const provider = createWorkspaceAppMentionProvider(() => resolved);
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const identity = {
      providerId: "workspace-app",
      entityId: "weather",
      label: "Weather",
      scope: { workspaceId: "workspace-1" }
    };
    const rendered = render(
      <RichTextMentionServiceProvider service={mentionService}>
        <AgentRichTextEditor
          value="[@Weather](mention://workspace-app/weather?workspaceId=workspace-1)"
          disabled={false}
          placeholder="Prompt"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </RichTextMentionServiceProvider>
    );

    await waitFor(() => {
      const mention = rendered.container.querySelector(
        '[data-agent-mention-kind="workspace-app"]'
      );
      expect(mention).toHaveTextContent("Resolved Weather");
      expect(mention?.querySelector("img")).toHaveAttribute(
        "src",
        "https://icons.example/weather.png"
      );
    });

    resolved = null;
    act(() => mentionService.invalidate(identity));

    await waitFor(() => {
      const mention = rendered.container.querySelector(
        '[data-agent-mention-kind="workspace-app"]'
      );
      expect(mention).toHaveTextContent("Weather");
      expect(mention?.querySelector("img")).toBeNull();
    });

    mentionService.dispose();
  });

  it("drops a resolved icon when the provider no longer returns one", async () => {
    let resolved: RichTextMentionResolved | null = {
      label: "Resolved Weather",
      presentation: { iconUrl: "https://icons.example/weather.png" }
    };
    const provider = createWorkspaceAppMentionProvider(() => resolved);
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const identity = {
      providerId: "workspace-app",
      entityId: "weather",
      label: "Weather",
      scope: { workspaceId: "workspace-1" }
    };
    const rendered = render(
      <RichTextMentionServiceProvider service={mentionService}>
        <AgentRichTextEditor
          value="[@Weather](mention://workspace-app/weather?workspaceId=workspace-1)"
          disabled={false}
          placeholder="Prompt"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </RichTextMentionServiceProvider>
    );

    await waitFor(() =>
      expect(
        rendered.container.querySelector(
          '[data-agent-mention-kind="workspace-app"] img'
        )
      ).toHaveAttribute("src", "https://icons.example/weather.png")
    );

    resolved = { label: "Resolved Weather" };
    act(() => mentionService.invalidate(identity));

    await waitFor(() =>
      expect(
        rendered.container.querySelector(
          '[data-agent-mention-kind="workspace-app"] img'
        )
      ).toBeNull()
    );

    mentionService.dispose();
  });

  it("detaches from a removed mention service and stops resolving", async () => {
    const resolveMention = vi.fn(() => ({
      label: "Resolved Weather",
      presentation: { iconUrl: "https://icons.example/weather.png" }
    }));
    const provider = createWorkspaceAppMentionProvider(resolveMention);
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const identity = {
      providerId: "workspace-app",
      entityId: "weather",
      label: "Weather",
      scope: { workspaceId: "workspace-1" }
    };
    const editor = (service: RichTextMentionService | null) => (
      <RichTextMentionServiceProvider
        service={service as RichTextMentionService}
      >
        <AgentRichTextEditor
          value="[@Weather](mention://workspace-app/weather?workspaceId=workspace-1)"
          disabled={false}
          placeholder="Prompt"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </RichTextMentionServiceProvider>
    );
    const rendered = render(editor(mentionService));

    await waitFor(() =>
      expect(
        rendered.container.querySelector(
          '[data-agent-mention-kind="workspace-app"]'
        )
      ).toHaveTextContent("Resolved Weather")
    );
    const callsBeforeRemoval = resolveMention.mock.calls.length;

    rendered.rerender(editor(null));
    await waitFor(() => {
      const mention = rendered.container.querySelector(
        '[data-agent-mention-kind="workspace-app"]'
      );
      expect(mention).toHaveTextContent("Weather");
      expect(mention?.querySelector("img")).toBeNull();
    });

    act(() => mentionService.invalidate(identity));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolveMention).toHaveBeenCalledTimes(callsBeforeRemoval);

    mentionService.dispose();
  });

  it("does not resolve existing mentions again after ordinary text input", async () => {
    const provider = createWorkspaceAppMentionProvider(() => ({
      label: "Resolved Weather"
    }));
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const resolve = vi.spyOn(mentionService, "resolve");
    const ref = createRef<AgentRichTextEditorHandle>();
    const rendered = render(
      <RichTextMentionServiceProvider service={mentionService}>
        <AgentRichTextEditor
          ref={ref}
          value="[@Weather](mention://workspace-app/weather?workspaceId=workspace-1)"
          disabled={false}
          placeholder="Prompt"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </RichTextMentionServiceProvider>
    );

    await waitFor(() =>
      expect(rendered.container).toHaveTextContent("Resolved Weather")
    );
    const callsBeforeInput = resolve.mock.calls.length;
    act(() => {
      ref.current?.focusAtEnd();
      ref.current?.insertPlainTextAtSelection("!");
    });
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[contenteditable="true"]')
      ).toHaveTextContent("Weather!")
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledTimes(callsBeforeInput);
    mentionService.dispose();
  });

  it("resolves multiple mentions with linear call fan-out", async () => {
    const provider = createWorkspaceAppMentionProvider((identity) => ({
      label: `Resolved ${identity.entityId}`
    }));
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const resolve = vi.spyOn(mentionService, "resolve");
    const mentionCount = 10;
    const value = Array.from(
      { length: mentionCount },
      (_, index) =>
        `[@App ${index}](mention://workspace-app/app-${index}?workspaceId=workspace-1)`
    ).join(" ");
    const rendered = render(
      <RichTextMentionServiceProvider service={mentionService}>
        <AgentRichTextEditor
          value={value}
          disabled={false}
          placeholder="Prompt"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </RichTextMentionServiceProvider>
    );

    await waitFor(() =>
      expect(
        rendered.container.querySelectorAll(
          '[data-node-view-wrapper][data-agent-mention-kind="workspace-app"]'
        )
      ).toHaveLength(mentionCount)
    );
    await waitFor(() =>
      expect(rendered.container).toHaveTextContent("Resolved app-9")
    );

    expect(resolve).toHaveBeenCalledTimes(mentionCount);
    mentionService.dispose();
  });
});

function createWorkspaceAppMentionProvider(
  resolveMention: NonNullable<RichTextTriggerProvider<string>["resolveMention"]>
): RichTextTriggerProvider<string> {
  return {
    id: "workspace-app",
    trigger: "@",
    query: () => [],
    getItemKey: (item) => item,
    getItemLabel: (item) => item,
    toInsertResult: (item) => ({ kind: "text", text: item }),
    resolveMention
  };
}

describe("AgentRichTextEditor prompt insertion", () => {
  it("drops a late mention resolution after the controlled draft is replaced", async () => {
    let resolveOldMention: ((value: RichTextMentionResolved) => void) | null =
      null;
    const oldMentionResolution = new Promise<RichTextMentionResolved>(
      (resolve) => {
        resolveOldMention = resolve;
      }
    );
    const resolveMention = vi.fn((identity) =>
      identity.entityId === "app-a" ? oldMentionResolution : null
    );
    const provider: RichTextTriggerProvider<string> = {
      id: "workspace-app",
      trigger: "@",
      query: () => [],
      getItemKey: (item) => item,
      getItemLabel: (item) => item,
      toInsertResult: (item) => ({ kind: "text", text: item }),
      resolveMention
    };
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const ref = createRef<AgentRichTextEditorHandle>();
    const onChange = vi.fn();
    const draftA =
      "[@App A](mention://workspace-app/app-a?workspaceId=workspace-1)";
    const draftB =
      "[@App B](mention://workspace-app/app-b?workspaceId=workspace-1)";
    const editor = (value: string, contentScopeKey: string) => (
      <RichTextMentionServiceProvider service={mentionService}>
        <AgentRichTextEditor
          ref={ref}
          contentScopeKey={contentScopeKey}
          disabled={false}
          onChange={onChange}
          onSubmit={vi.fn()}
          placeholder="Prompt"
          value={value}
        />
      </RichTextMentionServiceProvider>
    );
    const rendered = render(editor(draftA, "session-a"));
    await waitFor(() =>
      expect(resolveMention).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: "app-a" })
      )
    );

    rendered.rerender(editor(draftB, "session-b"));
    await waitFor(() =>
      expect(
        rendered.container.querySelector('[data-agent-mention-href*="app-b"]')
      ).not.toBeNull()
    );
    onChange.mockClear();
    act(() => {
      ref.current?.focusAtEnd();
      ref.current?.insertPlainTextAtSelection("!");
    });
    expect(onChange).toHaveBeenLastCalledWith(`${draftB}!`);

    await act(async () => {
      resolveOldMention?.({
        label: "Stale App",
        presentation: { iconUrl: "https://icons.example/stale.png" }
      });
      await oldMentionResolution;
    });

    await waitFor(() =>
      expect(
        rendered.container.querySelector('[contenteditable="true"]')
      ).toHaveTextContent("App B!")
    );
    expect(rendered.container.innerHTML).not.toContain(
      "https://icons.example/stale.png"
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    rendered.unmount();
    mentionService.dispose();
  });

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

  it("preserves the current selection when the controlled value changes in the same draft scope", async () => {
    const ref = createRef<AgentRichTextEditorHandle>();
    const onChange = vi.fn();
    const props = {
      contentScopeKey: "session-a",
      disabled: false,
      onChange,
      onSubmit: vi.fn(),
      placeholder: "Prompt"
    };
    const rendered = render(
      <AgentRichTextEditor ref={ref} value="hello world" {...props} />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const editor = rendered.container.querySelector<HTMLElement>(
      '[contenteditable="true"]'
    );
    const textNode = editor?.querySelector("p")?.firstChild;
    expect(textNode).not.toBeNull();

    act(() => {
      editor?.focus();
      const selection = window.getSelection();
      if (selection && textNode) {
        const range = document.createRange();
        range.setStart(textNode, 6);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editor?.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      }
    });

    rendered.rerender(
      <AgentRichTextEditor ref={ref} value="hello brave world" {...props} />
    );
    act(() => {
      ref.current?.insertPlainTextAtSelection("X");
    });

    expect(onChange).toHaveBeenLastCalledWith("hello Xbrave world");
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
