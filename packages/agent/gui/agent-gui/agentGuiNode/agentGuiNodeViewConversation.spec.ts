import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { AgentGUIConversationSummary } from "./model/agentGuiConversationModel";
import {
  ConversationMeta,
  filterConversationSectionsBySearchMatches,
  groupConversations
} from "./agentGuiNodeViewConversation";

describe("groupConversations", () => {
  it("places pinned conversations in a top pinned section ordered by pin time", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const conversations: AgentGUIConversationSummary[] = [
      conversation("project-chat", nowMs - 1000, {
        project: project("/workspace/app", "App")
      }),
      conversation("older-pinned", nowMs - 3 * 24 * 60 * 60 * 1000, {
        pinnedAtUnixMs: nowMs - 2000
      }),
      conversation("newer-pinned", nowMs - 24 * 60 * 60 * 1000, {
        pinnedAtUnixMs: nowMs - 1000
      })
    ];

    const groups = groupConversations(conversations, labels);

    expect(groups.map((group) => group.id)).toEqual([
      "pinned",
      "project:/workspace/app"
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["pinned", "project"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual([
      "newer-pinned",
      "older-pinned"
    ]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["project-chat"]);
  });

  it("groups unpinned conversations by project updated time", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const conversations: AgentGUIConversationSummary[] = [
      conversation("older-app-chat", nowMs - 1000, {
        project: project("/workspace/app", "App"),
        sortTimeUnixMs: nowMs - 2_000
      }),
      conversation("newer-site-chat", nowMs - 10_000, {
        project: project("/workspace/site", "Site"),
        sortTimeUnixMs: nowMs - 20_000
      }),
      conversation("older-sort-pinned", nowMs, {
        pinnedAtUnixMs: 1,
        sortTimeUnixMs: 1
      }),
      conversation("unmatched-chat", nowMs - 3_000, {
        sortTimeUnixMs: nowMs - 3_000
      }),
      conversation("newer-sort-pinned", nowMs - 1000, {
        pinnedAtUnixMs: 1,
        sortTimeUnixMs: 2
      })
    ];

    const groups = groupConversations(conversations, labels, [
      project("/workspace/app", "App", { updatedAtUnixMs: nowMs - 100_000 }),
      project("/workspace/site", "Site", { updatedAtUnixMs: nowMs - 50_000 })
    ]);

    expect(groups.map((group) => group.id)).toEqual([
      "pinned",
      "project:/workspace/site",
      "project:/workspace/app",
      "conversations"
    ]);
    expect(groups.map((group) => group.kind)).toEqual([
      "pinned",
      "project",
      "project",
      "conversations"
    ]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual([
      "newer-sort-pinned",
      "older-sort-pinned"
    ]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual([
      "newer-site-chat"
    ]);
    expect(groups[2]?.items.map((item) => item.id)).toEqual(["older-app-chat"]);
    expect(groups[3]?.items.map((item) => item.id)).toEqual(["unmatched-chat"]);
    expect(groups[3]?.label).toBe("Chats");
  });

  it("keeps user project sections visible when they have no conversations", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const conversations: AgentGUIConversationSummary[] = [
      conversation("app-chat", nowMs, {
        project: project("/workspace/app", "App"),
        sortTimeUnixMs: nowMs
      })
    ];

    const groups = groupConversations(
      conversations,
      labels,
      [project("/workspace/app", "App"), project("/workspace/empty", "Empty")],
      { includeEmptyConversations: true }
    );

    expect(groups.map((group) => group.id)).toEqual([
      "project:/workspace/app",
      "project:/workspace/empty",
      "conversations"
    ]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["app-chat"]);
    expect(groups[1]?.items).toEqual([]);
    expect(groups[1]?.label).toBe("Empty");
    expect(groups[2]?.items).toEqual([]);
    expect(groups[2]?.label).toBe("Chats");
  });

  it("keeps the conversations section visible when it has no conversations", () => {
    const groups = groupConversations([], labels, [], {
      includeEmptyConversations: true
    });

    expect(groups.map((group) => group.id)).toEqual(["conversations"]);
    expect(groups[0]?.items).toEqual([]);
    expect(groups[0]?.label).toBe("Chats");
  });

  it("removes empty rail sections after applying search matches", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const matching = conversation("hello-friend", nowMs, {
      project: project("/workspace/app", "App")
    });
    const unrelated = conversation("other-chat", nowMs - 1_000, {
      project: project("/workspace/other", "Other")
    });
    const sections = groupConversations(
      [matching, unrelated],
      labels,
      [
        project("/workspace/app", "App"),
        project("/workspace/empty", "Empty"),
        project("/workspace/other", "Other")
      ],
      { includeEmptyConversations: true }
    );

    const filtered = filterConversationSectionsBySearchMatches(sections, [
      matching
    ]);

    expect(filtered.map((section) => section.id)).toEqual([
      "project:/workspace/app"
    ]);
    expect(filtered[0]?.items.map((item) => item.id)).toEqual(["hello-friend"]);
  });
});

describe("ConversationMeta", () => {
  it("displays the same sort time used by conversation ordering", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const item = conversation("updated-newer-sort-older", nowMs - 60 * 1000, {
      sortTimeUnixMs: nowMs - 5 * 60 * 1000
    });

    render(
      createElement(ConversationMeta, {
        item,
        nowMs,
        labels: relativeLabels
      })
    );

    expect(
      screen.getByTestId("agent-gui-conversation-meta-updated-newer-sort-older")
    ).toHaveTextContent("5 minutes");
  });
});

const labels = {
  sectionPinned: "Pinned",
  sectionConversations: "Chats"
};

const relativeLabels = {
  relativeTimeJustNow: "Just now",
  relativeTimeMinutes: (value: number) => `${value} minutes`,
  relativeTimeHours: (value: number) => `${value} hours`,
  relativeTimeDays: (value: number) => `${value} days`,
  relativeTimeMonths: (value: number) => `${value} months`,
  relativeTimeYears: (value: number) => `${value} years`
};

function conversation(
  id: string,
  updatedAtUnixMs: number,
  overrides: Partial<AgentGUIConversationSummary> = {}
): AgentGUIConversationSummary {
  return {
    id,
    provider: "codex",
    title: id,
    status: "ready",
    cwd: "/workspace",
    updatedAtUnixMs,
    ...overrides
  };
}

function project(
  path: string,
  label: string,
  overrides: Partial<NonNullable<AgentGUIConversationSummary["project"]>> = {}
) {
  return {
    id: path,
    path,
    label,
    ...overrides
  };
}
