import { act, renderHook } from "@testing-library/react";
import type { AgentActivityMessagePage } from "@tutti-os/agent-activity-core";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import { useAgentConversationMessagePaging } from "./useAgentConversationMessagePaging";

describe("useAgentConversationMessagePaging", () => {
  it("binds the AgentGUI runtime to the shared message controller", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      messages: [],
      sessionMessageWindows: [
        {
          agentSessionId: "session-1",
          hasOlderMessages: true,
          oldestLoadedVersion: 5
        }
      ],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    });
    const listSessionMessages = vi.fn().mockResolvedValue({
      hasMore: false,
      latestVersion: 1,
      messages: [
        {
          agentSessionId: "session-1",
          kind: "text",
          messageId: "message-1",
          occurredAtUnixMs: 1,
          payload: {},
          role: "assistant",
          sequence: 1,
          turnId: "turn-1",
          version: 1
        }
      ]
    });
    const onOlderPageLoadingChanged = vi.fn();
    const { result, unmount } = renderHook(() =>
      useAgentConversationMessagePaging({
        diagnostics: { error: vi.fn(), page: vi.fn() },
        getActiveSessionId: () => "session-1",
        isMounted: () => true,
        onOlderPageLoadingChanged,
        runtime: {
          listSessionMessages
        } as unknown as AgentActivityRuntime,
        sessionEngine: engine,
        workspaceId: "workspace-1"
      })
    );

    await act(async () => {
      await result.current.loadOlderMessages();
    });

    expect(listSessionMessages).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      beforeVersion: 5,
      cache: false,
      limit: 100,
      order: "desc",
      signal: expect.any(AbortSignal),
      workspaceId: "workspace-1"
    });
    expect(onOlderPageLoadingChanged.mock.calls).toEqual([
      [false],
      [true],
      [false]
    ]);

    unmount();
    engine.dispose();
  });

  it("disposes its request-owning controller on unmount", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      messages: [],
      sessionMessageWindows: [
        {
          agentSessionId: "session-1",
          hasOlderMessages: true,
          oldestLoadedVersion: 5
        }
      ],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    });
    let requestSignal!: AbortSignal;
    let resolvePage!: (page: AgentActivityMessagePage) => void;
    const { result, unmount } = renderHook(() =>
      useAgentConversationMessagePaging({
        diagnostics: { error: vi.fn(), page: vi.fn() },
        getActiveSessionId: () => "session-1",
        isMounted: () => true,
        onOlderPageLoadingChanged: vi.fn(),
        runtime: {
          listSessionMessages: ({ signal }: { signal: AbortSignal }) => {
            requestSignal = signal;
            return new Promise<AgentActivityMessagePage>((resolve) => {
              resolvePage = resolve;
            });
          }
        } as unknown as AgentActivityRuntime,
        sessionEngine: engine,
        workspaceId: "workspace-1"
      })
    );

    let request!: Promise<void>;
    act(() => {
      request = result.current.loadOlderMessages();
    });
    expect(requestSignal.aborted).toBe(false);

    unmount();
    await Promise.resolve();
    expect(requestSignal.aborted).toBe(true);
    resolvePage({ hasMore: false, latestVersion: 0, messages: [] });
    await request;

    engine.dispose();
  });

  it("remains usable after the Strict Mode lifecycle probe", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      messages: [],
      sessionMessageWindows: [
        {
          agentSessionId: "session-1",
          hasOlderMessages: true,
          oldestLoadedVersion: 5
        }
      ],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    });
    const listSessionMessages = vi.fn().mockResolvedValue({
      hasMore: false,
      latestVersion: 1,
      messages: []
    });
    const { result, unmount } = renderHook(
      () =>
        useAgentConversationMessagePaging({
          diagnostics: { error: vi.fn(), page: vi.fn() },
          getActiveSessionId: () => "session-1",
          isMounted: () => true,
          onOlderPageLoadingChanged: vi.fn(),
          runtime: {
            listSessionMessages
          } as unknown as AgentActivityRuntime,
          sessionEngine: engine,
          workspaceId: "workspace-1"
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>{children}</StrictMode>
        )
      }
    );

    await act(async () => {
      await result.current.loadOlderMessages();
    });

    expect(listSessionMessages).toHaveBeenCalledOnce();
    unmount();
    engine.dispose();
  });
});
