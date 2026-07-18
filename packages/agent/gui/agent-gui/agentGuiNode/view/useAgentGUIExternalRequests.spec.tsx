import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { AGENT_CONVERSATION_COPY_MAX_EMBEDDED_IMAGE_BYTES } from "../model/agentConversationCopy";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import { useAgentGUIExternalRequests } from "./useAgentGUIExternalRequests";

type Conversation = AgentGUINodeViewModel["rail"]["conversations"][number];

const LABELS = {
  conversationCopyFile: "File",
  conversationCopyImage: "Image",
  conversationCopyImagesOmitted:
    "{{count}} image(s) omitted — copy them individually",
  conversationCopyInProgress: "Copying conversation…",
  conversationCopyMentionPrefix: "@",
  conversationCopyPreviousMessages: "{{count}} previous messages",
  copiedToClipboard: "Copied",
  copyFailed: "Copy failed",
  sessionActionUnavailable: "Session action unavailable",
  untitledConversationTitle: "Untitled"
};

const originalAgentHostApi = window.agentHostApi;
const runtimeWindow = window as unknown as {
  agentActivityRuntime?: AgentActivityRuntime;
};
const originalAgentActivityRuntime = runtimeWindow.agentActivityRuntime;

afterEach(() => {
  window.agentHostApi = originalAgentHostApi;
  runtimeWindow.agentActivityRuntime = originalAgentActivityRuntime;
  vi.unstubAllGlobals();
  delete (window.navigator as { clipboard?: unknown }).clipboard;
});

function makeConversation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agentTargetId: "target-1",
    cwd: "/workspace/project",
    id: "session-1",
    title: "Session 1",
    ...overrides
  } as unknown as Conversation;
}

function makeViewModel(input: {
  activeConversation?: Conversation | null;
  conversations?: Conversation[];
}) {
  return {
    rail: {
      activeConversation: input.activeConversation ?? null,
      conversations: input.conversations ?? []
    },
    shell: { workspaceId: "workspace-1" }
  } as unknown as AgentGUINodeViewModel;
}

function installHostApi() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const toastError = vi.fn();
  const toastInfo = vi.fn();
  const toastSuccess = vi.fn();
  window.agentHostApi = {
    ...(window.agentHostApi ?? {}),
    clipboard: { writeText },
    toast: { error: toastError, info: toastInfo, success: toastSuccess }
  } as unknown as typeof window.agentHostApi;
  return { toastError, toastInfo, toastSuccess, writeText };
}

function installRuntime(
  options: {
    messages?: unknown[];
    readSessionAttachment?: (input: {
      agentSessionId: string;
      attachmentId: string;
      workspaceId: string;
    }) => Promise<{ data: string; mimeType: string }>;
    reject?: boolean;
  } = {}
) {
  const listSessionMessages = options.reject
    ? vi.fn().mockRejectedValue(new Error("load failed"))
    : vi.fn().mockResolvedValue({
        hasMore: false,
        latestVersion: 1,
        messages: options.messages ?? [
          {
            agentSessionId: "session-1",
            kind: "message",
            messageId: "message-1",
            occurredAtUnixMs: 1,
            payload: { content: "Full answer" },
            role: "assistant",
            sequence: 1,
            turnId: "turn-1",
            version: 1
          }
        ]
      });
  runtimeWindow.agentActivityRuntime = {
    listSessionMessages,
    ...(options.readSessionAttachment
      ? { readSessionAttachment: options.readSessionAttachment }
      : {})
  } as unknown as AgentActivityRuntime;
  return { listSessionMessages };
}

class ClipboardItemStub {
  constructor(public readonly items: Record<string, Blob>) {}
}

// jsdom's Blob has no .text(), so specs read flavors through FileReader.
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(blob);
  });
}

function installWebClipboard(options: { reject?: boolean } = {}) {
  const write = options.reject
    ? vi.fn().mockRejectedValue(new Error("write denied"))
    : vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("ClipboardItem", ClipboardItemStub);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { write }
  });
  return { write };
}

function baseProps(
  overrides: Partial<Parameters<typeof useAgentGUIExternalRequests>[0]> = {}
): Parameters<typeof useAgentGUIExternalRequests>[0] {
  return {
    createConversationDisabled: true,
    labels: LABELS,
    newConversationRequestSequence: null,
    previewMode: false,
    requestCreateConversation: vi.fn(),
    requestRenameConversation: vi.fn(),
    sessionActionRequest: null,
    uiLanguage: "en",
    viewModel: makeViewModel({}),
    ...overrides
  };
}

describe("useAgentGUIExternalRequests session actions", () => {
  it("executes rename against the conversation the request targets", () => {
    installHostApi();
    const active = makeConversation({ id: "session-1" });
    const other = makeConversation({ id: "session-2" });
    const requestRenameConversation = vi.fn();
    const props = baseProps({
      requestRenameConversation,
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active, other]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "rename",
        agentSessionId: "session-2",
        sequence: 1
      }
    });

    expect(requestRenameConversation).toHaveBeenCalledTimes(1);
    expect(requestRenameConversation).toHaveBeenCalledWith(other);
  });

  it("falls back to the active conversation when the request carries no session id", () => {
    installHostApi();
    const active = makeConversation({ id: "session-1" });
    const requestRenameConversation = vi.fn();
    const props = baseProps({
      requestRenameConversation,
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "rename",
        agentSessionId: null,
        sequence: 1
      }
    });

    expect(requestRenameConversation).toHaveBeenCalledWith(active);
  });

  it("consumes each request sequence exactly once", () => {
    installHostApi();
    const active = makeConversation();
    const requestRenameConversation = vi.fn();
    const props = baseProps({
      requestRenameConversation,
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    const request = {
      action: "rename" as const,
      agentSessionId: null,
      sequence: 1
    };
    rerender({ ...props, sessionActionRequest: request });
    rerender({ ...props, sessionActionRequest: request });
    expect(requestRenameConversation).toHaveBeenCalledTimes(1);

    rerender({
      ...props,
      sessionActionRequest: { ...request, sequence: 2 }
    });
    expect(requestRenameConversation).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable instead of executing while the rail interaction lock is held", () => {
    const { toastError } = installHostApi();
    const active = makeConversation();
    const requestRenameConversation = vi.fn();
    const props = baseProps({
      requestRenameConversation,
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender, result } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });
    result.current.registerRailInteractionLockProbe(() => true);

    rerender({
      ...props,
      sessionActionRequest: {
        action: "rename",
        agentSessionId: null,
        sequence: 1
      }
    });

    expect(requestRenameConversation).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(LABELS.sessionActionUnavailable);
  });

  it("reports unavailable when the target conversation is not loaded", () => {
    const { toastError, writeText } = installHostApi();
    installRuntime();
    const props = baseProps({
      viewModel: makeViewModel({ activeConversation: null, conversations: [] })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: "session-ghost",
        sequence: 1
      }
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(LABELS.sessionActionUnavailable);
  });

  it("signals the copy is running before history finishes loading", async () => {
    const { toastInfo } = installHostApi();
    installRuntime();
    const active = makeConversation({ id: "session-1" });
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    expect(toastInfo).toHaveBeenCalledWith(LABELS.conversationCopyInProgress);
  });

  it("writes the copy value for the targeted conversation and reports success", async () => {
    const { toastSuccess, writeText } = installHostApi();
    installRuntime();
    const active = makeConversation({ id: "session-1" });
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(LABELS.copiedToClipboard);
    });
    expect(writeText).toHaveBeenCalledWith("# Session 1\n\nFull answer");
  });

  it("writes text/plain markdown plus text/html with inline images when ClipboardItem is available", async () => {
    const { toastSuccess, writeText } = installHostApi();
    const { write } = installWebClipboard();
    installRuntime({
      messages: [
        {
          agentSessionId: "session-1",
          kind: "message",
          messageId: "message-1",
          occurredAtUnixMs: 1,
          payload: {
            content: [
              { text: "Full answer", type: "text" },
              {
                data: "QUFB",
                mimeType: "image/png",
                name: "shot.png",
                type: "image"
              }
            ]
          },
          role: "assistant",
          sequence: 1,
          turnId: "turn-1",
          version: 1
        }
      ]
    });
    const active = makeConversation({ id: "session-1" });
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(LABELS.copiedToClipboard);
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0] as [ClipboardItemStub[]];
    expect(items).toHaveLength(1);
    const flavors = items[0]!.items;
    // The plain flavor stays lean (no base64); only the HTML flavor embeds
    // the image bytes.
    expect(await readBlobText(flavors["text/plain"]!)).toBe(
      "# Session 1\n\nFull answer\n\n**shot.png**"
    );
    const html = await readBlobText(flavors["text/html"]!);
    expect(html).toContain(
      '<img src="data:image/png;base64,QUFB" alt="shot.png"'
    );
    expect(html).toContain("Full answer");
  });

  it("keeps attachment references in text/plain while text/html embeds the bytes", async () => {
    const { toastSuccess, writeText } = installHostApi();
    const { write } = installWebClipboard();
    const readSessionAttachment = vi.fn().mockResolvedValue({
      data: "QkJC",
      mimeType: "image/png"
    });
    installRuntime({
      messages: [
        {
          agentSessionId: "session-1",
          kind: "tool_call",
          messageId: "tool-1",
          occurredAtUnixMs: 1,
          payload: {
            toolName: "ImageGeneration",
            status: "completed",
            output: [
              {
                type: "image",
                attachmentId: "attachment-9",
                mimeType: "image/png"
              }
            ]
          },
          role: "assistant",
          sequence: 1,
          turnId: "turn-1",
          version: 1
        }
      ],
      readSessionAttachment
    });
    const active = makeConversation({ id: "session-1" });
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(LABELS.copiedToClipboard);
    });
    expect(readSessionAttachment).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      attachmentId: "attachment-9",
      workspaceId: "workspace-1"
    });
    expect(writeText).not.toHaveBeenCalled();
    const [items] = write.mock.calls[0] as [ClipboardItemStub[]];
    const text = await readBlobText(items[0]!.items["text/plain"]!);
    expect(text).toContain("![Image](<attachment:attachment-9>)");
    expect(text).not.toContain("data:");
    const html = await readBlobText(items[0]!.items["text/html"]!);
    expect(html).toContain('<img src="data:image/png;base64,QkJC"');
  });

  it("reports omitted oversized images through the info toast instead of the plain copied toast", async () => {
    const { toastInfo, toastSuccess, writeText } = installHostApi();
    // Smallest unpadded base64 payload above the 2 MiB per-image embed cap.
    const oversized = "A".repeat(
      4 * Math.ceil((AGENT_CONVERSATION_COPY_MAX_EMBEDDED_IMAGE_BYTES + 1) / 3)
    );
    installRuntime({
      messages: [
        {
          agentSessionId: "session-1",
          kind: "tool_call",
          messageId: "tool-1",
          occurredAtUnixMs: 1,
          payload: {
            toolName: "ImageGeneration",
            status: "completed",
            output: [
              {
                type: "image",
                attachmentId: "attachment-9",
                mimeType: "image/png"
              }
            ]
          },
          role: "assistant",
          sequence: 1,
          turnId: "turn-1",
          version: 1
        }
      ],
      readSessionAttachment: vi.fn().mockResolvedValue({
        data: oversized,
        mimeType: "image/png"
      })
    });
    const active = makeConversation({ id: "session-1" });
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalledWith(
        "1 image(s) omitted — copy them individually"
      );
    });
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(
      "# Session 1\n\n![Image](<attachment:attachment-9>)"
    );
  });

  it("falls back to the host text clipboard when the dual-format write is denied", async () => {
    const { toastError, toastSuccess, writeText } = installHostApi();
    installWebClipboard({ reject: true });
    installRuntime();
    const active = makeConversation({ id: "session-1" });
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(LABELS.copiedToClipboard);
    });
    expect(writeText).toHaveBeenCalledWith("# Session 1\n\nFull answer");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("copies the session mention link for the quote variant without loading history", async () => {
    const { toastSuccess, writeText } = installHostApi();
    const { listSessionMessages } = installRuntime();
    const active = makeConversation({ id: "session-1" });
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-reference",
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(LABELS.copiedToClipboard);
    });
    expect(writeText).toHaveBeenCalledWith(
      "[@Session 1](mention://agent-session/session-1?agentTargetId=target-1&workspaceId=workspace-1)"
    );
    expect(listSessionMessages).not.toHaveBeenCalled();
  });

  it("reports copy failure instead of writing when history loading fails", async () => {
    const { toastError, writeText } = installHostApi();
    installRuntime({ reject: true });
    const active = makeConversation();
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: null,
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(LABELS.copyFailed);
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports copy failure when the host clipboard cannot write", async () => {
    const toastError = vi.fn();
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      clipboard: {},
      toast: { error: toastError, success: vi.fn() }
    } as unknown as typeof window.agentHostApi;
    installRuntime();
    const active = makeConversation();
    const props = baseProps({
      viewModel: makeViewModel({
        activeConversation: active,
        conversations: [active]
      })
    });
    const { rerender } = renderHook(useAgentGUIExternalRequests, {
      initialProps: props
    });

    rerender({
      ...props,
      sessionActionRequest: {
        action: "copy-markdown",
        agentSessionId: null,
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(LABELS.copyFailed);
    });
  });
});
