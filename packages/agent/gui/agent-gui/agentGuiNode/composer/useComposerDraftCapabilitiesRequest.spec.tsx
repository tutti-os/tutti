import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRichTextEditorHandle } from "../agentRichText/AgentRichTextEditor";
import { buildAgentComposerDraft } from "../model/agentComposerDraft";
import { useComposerDraftCapabilitiesRequest } from "./useComposerDraftCapabilitiesRequest";

describe("useComposerDraftCapabilitiesRequest", () => {
  it.each(["/", "$"])(
    "requests provider capabilities for a %s palette query",
    (trigger) => {
      const onDraftContentChange = vi.fn();
      const onRetryComposerOptions = vi.fn();
      const { result } = renderHook(() =>
        useComposerDraftCapabilitiesRequest({
          capabilitiesScopeKey: "draft\u0000codex\u0000local:codex",
          editorHandleRef: { current: null },
          onDraftContentChange,
          onRetryComposerOptions
        })
      );
      const draft = buildAgentComposerDraft({ prompt: trigger });

      act(() => result.current(draft, "draft-scope"));

      expect(onRetryComposerOptions).toHaveBeenCalledOnce();
      expect(onRetryComposerOptions).toHaveBeenCalledWith({
        section: "capabilities"
      });
      expect(onDraftContentChange).toHaveBeenCalledWith(draft, "draft-scope");
    }
  );

  it("does not request provider capabilities for ordinary text", () => {
    const onDraftContentChange = vi.fn();
    const onRetryComposerOptions = vi.fn();
    const { result } = renderHook(() =>
      useComposerDraftCapabilitiesRequest({
        capabilitiesScopeKey: "draft\u0000codex\u0000local:codex",
        editorHandleRef: { current: null },
        onDraftContentChange,
        onRetryComposerOptions
      })
    );

    act(() =>
      result.current(buildAgentComposerDraft({ prompt: "hello" }), "draft")
    );

    expect(onRetryComposerOptions).not.toHaveBeenCalled();
    expect(onDraftContentChange).toHaveBeenCalledOnce();
  });

  it("requests capabilities for a query before trailing draft text", () => {
    const onRetryComposerOptions = vi.fn();
    const { result } = renderHook(() =>
      useComposerDraftCapabilitiesRequest({
        capabilitiesScopeKey: "draft\u0000codex\u0000local:codex",
        editorHandleRef: {
          current: {
            getPromptTextBeforeSelection: () => "Please $"
          } as AgentRichTextEditorHandle
        },
        onDraftContentChange: vi.fn(),
        onRetryComposerOptions
      })
    );

    act(() =>
      result.current(
        buildAgentComposerDraft({ prompt: "Please $ review this" }),
        "draft"
      )
    );

    expect(onRetryComposerOptions).toHaveBeenCalledWith({
      section: "capabilities"
    });
  });

  it("requests capabilities again when a dollar query is reopened", () => {
    const onRetryComposerOptions = vi.fn();
    const { result } = renderHook(() =>
      useComposerDraftCapabilitiesRequest({
        capabilitiesScopeKey: "draft\u0000codex\u0000local:codex",
        editorHandleRef: { current: null },
        onDraftContentChange: vi.fn(),
        onRetryComposerOptions
      })
    );

    act(() =>
      result.current(buildAgentComposerDraft({ prompt: "$" }), "draft")
    );
    act(() =>
      result.current(buildAgentComposerDraft({ prompt: "hello" }), "draft")
    );
    act(() =>
      result.current(buildAgentComposerDraft({ prompt: "$" }), "draft")
    );

    expect(onRetryComposerOptions).toHaveBeenCalledTimes(2);
  });

  it("requests capabilities again for a new target and project scope", () => {
    const onRetryComposerOptions = vi.fn();
    let capabilitiesScopeKey = "workspace-agent:a\u0000/workspace/a";
    const { result, rerender } = renderHook(() =>
      useComposerDraftCapabilitiesRequest({
        capabilitiesScopeKey,
        editorHandleRef: { current: null },
        onDraftContentChange: vi.fn(),
        onRetryComposerOptions
      })
    );
    const draft = buildAgentComposerDraft({ prompt: "$" });

    act(() => result.current(draft, "draft"));
    capabilitiesScopeKey = "workspace-agent:b\u0000/workspace/b";
    rerender();
    act(() => result.current(draft, "draft"));

    expect(onRetryComposerOptions).toHaveBeenCalledTimes(2);
  });
});
