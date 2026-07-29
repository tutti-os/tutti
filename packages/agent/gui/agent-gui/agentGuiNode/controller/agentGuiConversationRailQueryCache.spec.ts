import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import { describe, expect, it } from "vitest";
import type { ConversationRailQueryState } from "./agentConversationRailQueryModel";
import { replaceConversationRailFirstPages } from "./agentGuiConversationRailQueryCache";

describe("replaceConversationRailFirstPages", () => {
  it("preserves loaded tails and removes sessions moved by the same refresh", () => {
    const queryState: ConversationRailQueryState = {
      pending: false,
      reconcilingSessionIds: [],
      resolvedScopeKey: "all",
      sectionPageStates: new Map([
        [
          "project:a",
          {
            hasMore: true,
            isLoading: false,
            nextCursor: "a-cursor-2",
            totalCount: 4
          }
        ],
        [
          "project:b",
          {
            hasMore: true,
            isLoading: false,
            nextCursor: "b-cursor-2",
            totalCount: 3
          }
        ]
      ]),
      sections: [
        {
          id: "project:a",
          kind: "project",
          project: null,
          sessionIds: ["a-1", "a-2", "a-3"]
        },
        {
          id: "project:b",
          kind: "project",
          project: null,
          sessionIds: ["b-1", "b-2", "b-3"]
        }
      ]
    };

    const next = replaceConversationRailFirstPages({
      pages: [
        {
          id: "project:a",
          kind: "section",
          page: {
            hasMore: true,
            kind: "project",
            nextCursor: "a-cursor-1",
            sectionKey: "project:a",
            sessions: [
              session("a-1", "project:a"),
              session("b-1", "project:a")
            ],
            totalCount: 4
          }
        },
        {
          id: "project:b",
          kind: "section",
          page: {
            hasMore: true,
            kind: "project",
            nextCursor: "b-cursor-1",
            sectionKey: "project:b",
            sessions: [session("b-2", "project:b")],
            totalCount: 3
          }
        }
      ],
      queryState
    });

    expect(next.sections).toEqual([
      expect.objectContaining({
        id: "project:a",
        sessionIds: ["a-1", "b-1", "a-2", "a-3"]
      }),
      expect.objectContaining({
        id: "project:b",
        sessionIds: ["b-2", "b-3"]
      })
    ]);
    expect(next.sectionPageStates.get("project:a")).toEqual({
      hasMore: false,
      isLoading: false,
      nextCursor: null,
      totalCount: 4
    });
    expect(next.sectionPageStates.get("project:b")).toEqual({
      hasMore: true,
      isLoading: false,
      nextCursor: "b-cursor-2",
      totalCount: 3
    });
  });
});

function session(agentSessionId: string, railSectionKey: string) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId,
    agentTargetId: "local:codex",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    railSectionKey,
    title: agentSessionId,
    updatedAtUnixMs: 1,
    workspaceId: "test-workspace"
  });
}
