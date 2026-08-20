import type { AgentConversationRailSummary } from "@tutti-os/agent-gui/conversation-rail-projection";
import {
  projectWorkspaceConversationRail,
  selectWorkspaceConversationRailSessionIds
} from "./workspaceConversationRailProjection";
import type { WorkspaceConversationRailMembership } from "./workspaceConversationRailService";

describe("projectWorkspaceConversationRail", () => {
  test("keeps server section order and exact section membership", () => {
    const sections = projectWorkspaceConversationRail({
      conversations: [
        conversation("recent", "conversations", 30),
        conversation("project", "project:/repo", 20),
        {
          ...conversation("pinned", "project:/repo", 10),
          pinnedAtUnixMs: 40
        }
      ],
      loadingMoreSectionId: null,
      memberships: [
        membership("pinned", "pinned", null, ["pinned"]),
        membership(
          "section:project:/repo",
          "project",
          "project:/repo",
          ["project"],
          "Repo"
        ),
        membership("section:conversations", "conversations", "conversations", [
          "recent"
        ])
      ]
    });

    expect(
      sections.map((section) => ({
        id: section.id,
        ids: section.items.map((item) => item.id),
        label: section.label
      }))
    ).toEqual([
      { id: "pinned", ids: ["pinned"], label: null },
      {
        id: "section:project:/repo",
        ids: ["project"],
        label: "Repo"
      },
      { id: "section:conversations", ids: ["recent"], label: null }
    ]);
  });

  test("places a newly reconciled conversation by its exact rail key", () => {
    const sections = projectWorkspaceConversationRail({
      conversations: [
        conversation("known", "project:/repo", 10),
        conversation("new", "project:/repo", 20)
      ],
      loadingMoreSectionId: null,
      memberships: [
        membership(
          "section:project:/repo",
          "project",
          "project:/repo",
          ["known"],
          "Repo"
        )
      ]
    });

    expect(sections[0]?.items.map((item) => item.id)).toEqual(["new", "known"]);
  });

  test("rehomes a conversation when server membership disagrees with its rail key", () => {
    const sections = projectWorkspaceConversationRail({
      conversations: [conversation("session-1", "project:/right", 20)],
      loadingMoreSectionId: null,
      memberships: [
        membership(
          "section:project:/wrong",
          "project",
          "project:/wrong",
          ["session-1"],
          "Wrong"
        ),
        membership(
          "section:project:/right",
          "project",
          "project:/right",
          [],
          "Right"
        )
      ]
    });

    expect(
      sections.map((section) => ({
        id: section.id,
        ids: section.items.map((item) => item.id)
      }))
    ).toEqual([{ id: "section:project:/right", ids: ["session-1"] }]);
  });

  test("does not classify a missing rail key as conversations", () => {
    const sections = projectWorkspaceConversationRail({
      conversations: [conversation("session-1", "", 20)],
      loadingMoreSectionId: null,
      memberships: [
        membership("section:conversations", "conversations", "conversations", [
          "session-1"
        ])
      ]
    });

    expect(sections).toEqual([]);
  });

  test("deduplicates canonical navigation ids across Rail memberships", () => {
    expect(
      selectWorkspaceConversationRailSessionIds([
        { sessionIds: ["session-1", "session-2"] },
        { sessionIds: ["session-1", "session-3"] }
      ])
    ).toEqual(["session-1", "session-2", "session-3"]);
  });
});

function conversation(
  id: string,
  railSectionKey: string,
  sortTimeUnixMs: number
): AgentConversationRailSummary {
  return {
    cwd: "/repo",
    id,
    provider: "codex",
    railSectionKey,
    sortTimeUnixMs,
    status: "ready",
    title: id,
    updatedAtUnixMs: sortTimeUnixMs
  };
}

function membership(
  id: string,
  kind: WorkspaceConversationRailMembership["kind"],
  sectionKey: string | null,
  sessionIds: string[],
  label: string | null = null
): WorkspaceConversationRailMembership {
  return {
    hasMore: false,
    id,
    kind,
    nextCursor: null,
    project: label
      ? {
          createdAtUnixMs: 1,
          id: "project-1",
          label,
          lastUsedAtUnixMs: 1,
          path: "/repo",
          pinnedAtUnixMs: 0,
          sectionKey: sectionKey!,
          updatedAtUnixMs: 1
        }
      : null,
    sectionKey,
    sessionIds,
    totalCount: sessionIds.length
  };
}
