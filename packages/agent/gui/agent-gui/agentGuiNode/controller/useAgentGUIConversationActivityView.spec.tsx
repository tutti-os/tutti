import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationTypes";
import { createAgentGUIConversationActivityController } from "./agentGUIConversationActivityController";
import { useAgentGUIConversationActivityView } from "./useAgentGUIConversationActivityView";

describe("useAgentGUIConversationActivityView", () => {
  it("clears an active view when the host capability fails closed", () => {
    const activityController = createAgentGUIConversationActivityController();
    const rendered = renderHook(() =>
      useAgentGUIConversationActivityView({
        activityController,
        conversations: [CONVERSATION],
        hasConversationQuery: false
      })
    );

    act(() => {
      configure(activityController, [CONVERSATION]);
      rendered.result.current.toggle();
    });
    expect(rendered.result.current.enabled).toBe(true);

    act(() => configure(activityController, [], { available: false }));
    expect(rendered.result.current.enabled).toBe(false);
    expect(rendered.result.current.projection).toBeNull();

    act(() => configure(activityController, [CONVERSATION]));
    expect(rendered.result.current.enabled).toBe(false);
  });

  it("rebuilds instead of incrementally retaining idle sessions across identity changes", () => {
    const activityController = createAgentGUIConversationActivityController();
    const rendered = renderHook(
      ({ conversation }) =>
        useAgentGUIConversationActivityView({
          activityController,
          conversations: [conversation],
          hasConversationQuery: false
        }),
      {
        initialProps: {
          conversation: CONVERSATION
        }
      }
    );

    act(() => {
      configure(activityController, [CONVERSATION], {
        identityKey: "user-1:codex"
      });
      rendered.result.current.toggle();
    });
    expect(rendered.result.current.projection?.priorityIds).toEqual([
      "session-1"
    ]);

    const nextConversation = {
      ...CONVERSATION,
      id: "session-2",
      status: "ready" as const,
      title: "Session 2"
    };
    act(() =>
      configure(activityController, [nextConversation], {
        identityKey: "user-2:codex"
      })
    );
    rendered.rerender({
      conversation: nextConversation
    });
    expect(rendered.result.current.projection?.priorityIds).toEqual([]);
    expect(rendered.result.current.projection?.recentSections[0]?.ids).toEqual([
      "session-2"
    ]);
  });

  it("keeps an existing Priority row while a rail refresh omits its summary", () => {
    const activityController = createAgentGUIConversationActivityController();
    const rendered = renderHook(
      ({ conversations }) =>
        useAgentGUIConversationActivityView({
          activityController,
          conversations,
          hasConversationQuery: false
        }),
      {
        initialProps: { conversations: [CONVERSATION] }
      }
    );

    act(() => {
      configure(activityController, [CONVERSATION]);
      rendered.result.current.toggle();
    });
    expect(activityController.getSnapshot().enabled).toBe(true);
    expect(
      activityController.getSnapshot().conversationCache.get("session-1")
    ).toBe(CONVERSATION);
    act(() => configure(activityController, []));
    expect(
      activityController.getSnapshot().conversationCache.get("session-1")
    ).toBe(CONVERSATION);
    rendered.rerender({ conversations: [] });

    expect(rendered.result.current.projection?.priorityIds).toEqual([
      "session-1"
    ]);
    expect(rendered.result.current.conversationsById.get("session-1")).toBe(
      CONVERSATION
    );
  });

  it("does not render a cached Priority row after an Engine tombstone", () => {
    const activityController = createAgentGUIConversationActivityController();
    const rendered = renderHook(
      ({ conversations, deletedSessionIds }) =>
        useAgentGUIConversationActivityView({
          activityController,
          conversations,
          deletedSessionIds,
          hasConversationQuery: false
        }),
      {
        initialProps: {
          conversations: [CONVERSATION],
          deletedSessionIds: {}
        }
      }
    );

    act(() => {
      configure(activityController, [CONVERSATION]);
      rendered.result.current.toggle();
    });
    act(() =>
      configure(activityController, [], {
        deletedSessionIds: { "session-1": true }
      })
    );
    rendered.rerender({
      conversations: [],
      deletedSessionIds: { "session-1": true }
    });

    expect(rendered.result.current.projection?.priorityIds).toEqual([]);
    expect(rendered.result.current.conversationsById.has("session-1")).toBe(
      false
    );
  });

  it("preserves unchanged conversation objects when one root activity fact changes", () => {
    const conversations: AgentGUIConversationSummary[] = [
      {
        ...CONVERSATION,
        id: "changed",
        status: "ready" as const,
        title: "Changed"
      },
      {
        ...CONVERSATION,
        id: "unchanged",
        status: "ready" as const,
        title: "Unchanged"
      }
    ];
    const activityController = createAgentGUIConversationActivityController();
    const rendered = renderHook(
      ({ currentConversations }) =>
        useAgentGUIConversationActivityView({
          activityController,
          conversations: currentConversations,
          hasConversationQuery: false
        }),
      {
        initialProps: { currentConversations: conversations }
      }
    );
    act(() => configure(activityController, conversations));
    rendered.rerender({ currentConversations: conversations });
    const changedBefore =
      rendered.result.current.conversationsById.get("changed");
    const unchangedBefore =
      rendered.result.current.conversationsById.get("unchanged");
    const changedConversation = conversations[0];
    const unchangedConversation = conversations[1];
    if (!changedConversation || !unchangedConversation) {
      throw new Error("conversation fixture is incomplete");
    }

    const nextConversations: AgentGUIConversationSummary[] = [
      { ...changedConversation, status: "working" as const },
      unchangedConversation
    ];
    act(() => configure(activityController, nextConversations));
    rendered.rerender({
      currentConversations: nextConversations
    });

    expect(rendered.result.current.conversationsById.get("changed")).not.toBe(
      changedBefore
    );
    expect(rendered.result.current.conversationsById.get("unchanged")).toBe(
      unchangedBefore
    );
  });
});

function configure(
  controller: ReturnType<typeof createAgentGUIConversationActivityController>,
  conversations: readonly AgentGUIConversationSummary[],
  overrides: Partial<{
    available: boolean;
    deletedSessionIds: Readonly<Record<string, true>>;
    identityKey: string;
    scopeKey: string;
  }> = {}
): void {
  controller.configure({
    available: overrides.available ?? true,
    conversations,
    deletedSessionIds: overrides.deletedSessionIds,
    identityKey: overrides.identityKey ?? "workspace-1",
    scopeKey: overrides.scopeKey ?? "workspace-1"
  });
}

const CONVERSATION: AgentGUIConversationSummary = {
  cwd: "/workspace",
  id: "session-1",
  provider: "codex",
  sortTimeUnixMs: Date.now(),
  status: "working",
  title: "Session 1",
  updatedAtUnixMs: Date.now()
};
