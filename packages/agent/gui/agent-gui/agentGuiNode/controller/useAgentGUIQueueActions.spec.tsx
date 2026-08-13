import { act, renderHook, waitFor } from "@testing-library/react";
import {
  createAgentSessionEngine,
  selectEngineQueuedPrompt
} from "@tutti-os/agent-activity-core";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIRuntime } from "../../../agentActivityRuntime";
import { createTestEngineCommandPort } from "../../../shared/testing/createTestAgentSessionEngine";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import { agentComposerDraftImages } from "../model/agentComposerDraft";
import { useAgentGUIQueueActions } from "./useAgentGUIQueueActions";

describe("useAgentGUIQueueActions", () => {
  it("does not promote queued compact to guidance", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: async () => undefined
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    sessionEngine.dispatch({
      agentSessionId: "session-1",
      prompt: {
        id: "queued-compact",
        content: [{ type: "text", text: "/compact" }],
        createdAtUnixMs: 1
      },
      type: "queue/enqueued",
      workspaceId: "workspace-1"
    });
    const dispatch = vi.spyOn(sessionEngine, "dispatch");
    const { result } = renderHook(() =>
      useAgentGUIQueueActions({
        activeConversationIdRef: { current: "session-1" },
        agentActivityRuntime: {} as AgentGUIRuntime,
        sessionEngine,
        setDraftByScopeKey: vi.fn(),
        workspaceId: "workspace-1"
      })
    );

    act(() => result.current.sendQueuedPromptNext("queued-compact"));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps send-next available for non-compact slash commands", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: async () => undefined
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    sessionEngine.dispatch({
      agentSessionId: "session-1",
      prompt: {
        id: "queued-review",
        content: [{ type: "text", text: "/review" }],
        createdAtUnixMs: 1
      },
      type: "queue/enqueued",
      workspaceId: "workspace-1"
    });
    const dispatch = vi.spyOn(sessionEngine, "dispatch");
    const { result } = renderHook(() =>
      useAgentGUIQueueActions({
        activeConversationIdRef: { current: "session-1" },
        agentActivityRuntime: {} as AgentGUIRuntime,
        sessionEngine,
        setDraftByScopeKey: vi.fn(),
        workspaceId: "workspace-1"
      })
    );

    act(() => result.current.sendQueuedPromptNext("queued-review"));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        promptId: "queued-review",
        type: "queue/sendNowRequested"
      })
    );
  });

  it("rehydrates a path-backed queued image when editing it", async () => {
    let resolveRead:
      | ((asset: { data: string; mimeType: string }) => void)
      | null = null;
    const readPromptAsset = vi.fn(
      () =>
        new Promise<{ data: string; mimeType: string }>((resolve) => {
          resolveRead = resolve;
        })
    );
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: async () => undefined
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    sessionEngine.dispatch({
      agentSessionId: "session-1",
      prompt: {
        id: "queued-1",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            name: "image.png",
            path: "/agent-prompt-assets/image.png"
          }
        ],
        createdAtUnixMs: 1
      },
      type: "queue/enqueued",
      workspaceId: "workspace-1"
    });

    const rendered = renderHook(() => {
      const [drafts, setDrafts] = useState<Record<string, AgentComposerDraft>>(
        {}
      );
      return {
        drafts,
        actions: useAgentGUIQueueActions({
          activeConversationIdRef: { current: "session-1" },
          agentActivityRuntime: {
            readPromptAsset
          } as unknown as AgentGUIRuntime,
          sessionEngine,
          setDraftByScopeKey: setDrafts,
          workspaceId: "workspace-1"
        })
      };
    });

    act(() => rendered.result.current.actions.editQueuedPrompt("queued-1"));

    expect(
      agentComposerDraftImages(
        rendered.result.current.drafts["session:session-1"]!
      )[0]
    ).toMatchObject({
      path: "/agent-prompt-assets/image.png",
      previewUrl: ""
    });
    expect(readPromptAsset).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      mimeType: "image/png",
      name: "image.png",
      path: "/agent-prompt-assets/image.png"
    });
    expect(
      selectEngineQueuedPrompt(
        sessionEngine.getSnapshot(),
        "session-1",
        "queued-1"
      )
    ).toBeNull();

    await act(async () => {
      resolveRead?.({ data: "cmVzdG9yZWQ=", mimeType: "image/png" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        agentComposerDraftImages(
          rendered.result.current.drafts["session:session-1"]!
        )[0]?.previewUrl
      ).toBe("data:image/png;base64,cmVzdG9yZWQ=")
    );
  });
});
