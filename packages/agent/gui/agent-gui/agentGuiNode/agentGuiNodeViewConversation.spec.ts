import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { AgentGUIConversationSummary } from "./model/agentGuiConversationModel";
import {
  ConversationMeta,
  filterConversationSectionsBySearchMatches
} from "./agentGuiNodeViewConversation";

describe("filterConversationSectionsBySearchMatches", () => {
  it("removes sections without exact conversation id matches", () => {
    const matching = conversation("matching", 2);
    const unrelated = conversation("unrelated", 1);

    const filtered = filterConversationSectionsBySearchMatches(
      [
        {
          id: "project:app",
          kind: "project",
          label: "App",
          project: null,
          items: [matching]
        },
        {
          id: "conversations",
          kind: "conversations",
          label: "Chats",
          project: null,
          items: [unrelated]
        }
      ],
      [matching]
    );

    expect(filtered.map((section) => section.id)).toEqual(["project:app"]);
    expect(filtered[0]?.items.map((item) => item.id)).toEqual(["matching"]);
  });
});

describe("ConversationMeta", () => {
  it("uses a prominent spinner stroke for working conversations", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const item = conversation("working", nowMs, { status: "working" });

    render(
      createElement(ConversationMeta, {
        item,
        nowMs,
        labels: relativeLabels
      })
    );

    const spinner = screen.getByTestId("agent-gui-conversation-spinner");
    expect(
      spinner.querySelectorAll('circle[stroke-width="2.25"]')
    ).toHaveLength(2);
  });

  it("keeps waiting background work in the running presentation", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const item = conversation("background-waiting", nowMs, {
      status: "waiting",
      needsUserAction: false
    });

    render(
      createElement(ConversationMeta, {
        item,
        nowMs,
        labels: relativeLabels
      })
    );

    expect(
      screen.getByTestId("agent-gui-conversation-meta-background-waiting")
    ).toHaveAttribute("data-kind", "loading");
    expect(screen.getByTestId("agent-gui-conversation-spinner")).toBeVisible();
  });

  it("shows the ask indicator whenever a conversation needs user action", () => {
    const nowMs = new Date("2026-06-05T12:00:00Z").getTime();
    const item = conversation("user-action-waiting", nowMs, {
      status: "working",
      needsUserAction: true
    });

    render(
      createElement(ConversationMeta, {
        item,
        nowMs,
        labels: relativeLabels
      })
    );

    expect(
      screen.getByTestId("agent-gui-conversation-meta-user-action-waiting")
    ).toHaveAttribute("data-kind", "waiting");
    expect(
      screen.queryByTestId("agent-gui-conversation-spinner")
    ).not.toBeInTheDocument();
  });

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
