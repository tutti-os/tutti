import { expect, test } from "vitest";
import {
  createAgentGUIConversationActivityActivation,
  localDayStartUnixMs,
  projectAgentGUIConversationActivity,
  reconcileAgentGUIConversationActivityActivation
} from "./agentGuiConversationActivityView.ts";
import type { AgentGUIConversationSummary } from "./agentGuiConversationTypes.ts";

const NOW = new Date(2026, 7, 6, 14, 30).getTime();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

test("activity activation ranks live priority and snapshots recent date buckets", () => {
  const activation = createAgentGUIConversationActivityActivation(
    [
      conversation("active", { status: "working", time: NOW - HOUR_MS }),
      conversation("recent", { time: NOW - 2 * HOUR_MS }),
      conversation("unread", {
        hasUnreadCompletion: true,
        time: NOW - 3 * HOUR_MS
      }),
      conversation("waiting", {
        needsUserAction: true,
        time: NOW - 4 * HOUR_MS
      }),
      conversation("old", { time: NOW - 8 * DAY_MS })
    ],
    NOW
  );

  expect(projectAgentGUIConversationActivity(activation)).toEqual({
    priorityIds: ["waiting", "unread", "active"],
    priorityReasonsById: new Map([
      ["waiting", "waiting"],
      ["unread", "unread"],
      ["active", "active"]
    ]),
    referenceDayStartUnixMs: localDayStartUnixMs(NOW),
    recentSections: [
      {
        dayStartUnixMs: localDayStartUnixMs(NOW),
        ids: ["recent"]
      }
    ]
  });
});

test("activity reconciliation retains members and frozen recency after live facts change", () => {
  const initial = createAgentGUIConversationActivityActivation(
    [
      conversation("waiting", { needsUserAction: true, time: NOW - HOUR_MS }),
      conversation("recent", { time: NOW - 2 * HOUR_MS })
    ],
    NOW
  );
  const reconciled = reconcileAgentGUIConversationActivityActivation(initial, [
    conversation("waiting", { time: NOW + HOUR_MS }),
    conversation("recent", { time: NOW + 2 * DAY_MS })
  ]);

  expect(projectAgentGUIConversationActivity(reconciled)).toEqual({
    priorityIds: ["waiting"],
    priorityReasonsById: new Map([["waiting", "waiting"]]),
    referenceDayStartUnixMs: localDayStartUnixMs(NOW),
    recentSections: [
      {
        dayStartUnixMs: localDayStartUnixMs(NOW),
        ids: ["recent"]
      }
    ]
  });
});

test("activity reconciliation keeps existing Priority members through a list refresh", () => {
  const initial = createAgentGUIConversationActivityActivation(
    [
      conversation("waiting", {
        needsUserAction: true,
        time: NOW - HOUR_MS
      }),
      conversation("unread", {
        hasUnreadCompletion: true,
        time: NOW - 2 * HOUR_MS
      })
    ],
    NOW
  );
  const refreshed = reconcileAgentGUIConversationActivityActivation(initial, [
    conversation("new-active", {
      status: "working",
      time: NOW + HOUR_MS
    })
  ]);

  expect(projectAgentGUIConversationActivity(refreshed).priorityIds).toEqual([
    "waiting",
    "unread",
    "new-active"
  ]);
  expect(refreshed.priority.slice(0, 2)).toEqual(initial.priority);
});

test("activity reconciliation does not move existing members when they become read", () => {
  const initial = createAgentGUIConversationActivityActivation(
    [
      conversation("waiting", {
        needsUserAction: true,
        time: NOW - HOUR_MS
      }),
      conversation("unread", {
        hasUnreadCompletion: true,
        time: NOW - 2 * HOUR_MS
      })
    ],
    NOW
  );
  const read = reconcileAgentGUIConversationActivityActivation(initial, [
    conversation("unread", { time: NOW + 2 * DAY_MS }),
    conversation("waiting", { time: NOW + DAY_MS })
  ]);

  expect(projectAgentGUIConversationActivity(read).priorityIds).toEqual([
    "waiting",
    "unread"
  ]);
  expect(read.priority.map((member) => member.priorityReason)).toEqual([
    "waiting",
    "unread"
  ]);
});

test("activity reconciliation admits only live late sessions and retains Priority members", () => {
  const initial = createAgentGUIConversationActivityActivation(
    [
      conversation("keep", { status: "working", time: NOW - HOUR_MS }),
      conversation("promote", { time: NOW - 2 * HOUR_MS })
    ],
    NOW
  );
  const reconciled = reconcileAgentGUIConversationActivityActivation(initial, [
    conversation("promote", {
      hasUnreadCompletion: true,
      time: NOW + HOUR_MS
    }),
    conversation("pushed-active", {
      status: "working",
      time: NOW + 2 * HOUR_MS
    }),
    conversation("pushed-idle", { time: NOW + 3 * HOUR_MS })
  ]);

  expect(projectAgentGUIConversationActivity(reconciled)).toEqual({
    priorityIds: ["promote", "pushed-active", "keep"],
    priorityReasonsById: new Map([
      ["promote", "unread"],
      ["pushed-active", "active"],
      ["keep", "active"]
    ]),
    recentSections: [],
    referenceDayStartUnixMs: localDayStartUnixMs(NOW)
  });
  expect(new Set(reconciled.priority.map((member) => member.id)).size).toBe(
    reconciled.priority.length
  );
});

test("activity reconciliation removes a deleted Priority member immediately", () => {
  const initial = createAgentGUIConversationActivityActivation(
    [conversation("deleted", { status: "working", time: NOW })],
    NOW
  );
  const reconciled = reconcileAgentGUIConversationActivityActivation(
    initial,
    [],
    { deleted: true }
  );

  expect(projectAgentGUIConversationActivity(reconciled).priorityIds).toEqual(
    []
  );
});

test("activity reconciliation preserves activation identity when nothing changes", () => {
  const conversations = [conversation("recent", { time: NOW - HOUR_MS })];
  const initial = createAgentGUIConversationActivityActivation(
    conversations,
    NOW
  );
  expect(
    reconcileAgentGUIConversationActivityActivation(initial, conversations)
  ).toBe(initial);
});

test("activity activation preserves source order for equal rank and recency", () => {
  const activation = createAgentGUIConversationActivityActivation(
    [
      conversation("second-by-id", { status: "working", time: NOW }),
      conversation("first-by-id", { status: "working", time: NOW })
    ],
    NOW
  );

  expect(projectAgentGUIConversationActivity(activation).priorityIds).toEqual([
    "second-by-id",
    "first-by-id"
  ]);
});

test("activity activation uses seven local calendar days at the cutoff", () => {
  const openedAt = new Date(2026, 7, 6, 14, 30).getTime();
  const activation = createAgentGUIConversationActivityActivation(
    [
      conversation("cutoff-day", {
        time: new Date(2026, 6, 31, 0, 0).getTime()
      }),
      conversation("before-cutoff", {
        time: new Date(2026, 6, 30, 23, 59).getTime()
      })
    ],
    openedAt
  );

  expect(
    projectAgentGUIConversationActivity(activation).recentSections
  ).toEqual([
    {
      dayStartUnixMs: new Date(2026, 6, 31, 0, 0).getTime(),
      ids: ["cutoff-day"]
    }
  ]);
});

test("activity reconciliation ignores upstream collection reordering", () => {
  const conversations = [
    conversation("newer", { time: NOW - HOUR_MS }),
    conversation("older", { time: NOW - 2 * HOUR_MS })
  ];
  const initial = createAgentGUIConversationActivityActivation(
    conversations,
    NOW
  );

  expect(
    reconcileAgentGUIConversationActivityActivation(
      initial,
      [...conversations].reverse()
    )
  ).toBe(initial);
});

function conversation(
  id: string,
  overrides: {
    hasUnreadCompletion?: boolean;
    needsUserAction?: boolean;
    status?: AgentGUIConversationSummary["status"];
    time: number;
  }
): AgentGUIConversationSummary {
  return {
    cwd: "/workspace",
    hasUnreadCompletion: overrides.hasUnreadCompletion,
    id,
    needsUserAction: overrides.needsUserAction,
    provider: "codex",
    status: overrides.status ?? "ready",
    title: id,
    updatedAtUnixMs: overrides.time
  };
}
