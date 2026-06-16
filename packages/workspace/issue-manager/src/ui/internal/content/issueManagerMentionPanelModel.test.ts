import assert from "node:assert/strict";
import test from "node:test";
import type { RichTextAtQueryMatch } from "@tutti-os/ui-rich-text/types";
import { createIssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";
import {
  ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS,
  buildIssueManagerMentionNavigationEntries,
  buildIssueManagerMentionPaletteState,
  buildIssueManagerMentionPanelConfig,
  issueMatchToRowItem,
  nextIssueManagerMentionExpandedCounts,
  nextIssueManagerMentionFilterId
} from "./issueManagerMentionPanelModel.ts";

const copy = createIssueManagerI18nRuntime(undefined);

test("buildIssueManagerMentionPanelConfig uses canonical filter order", () => {
  const config = buildIssueManagerMentionPanelConfig(copy);

  assert.deepEqual(
    config.filterTabs.map((tab) => tab.id),
    ["all", "agent-session", "file", "workspace-issue", "workspace-app"]
  );
});

test("buildIssueManagerMentionPaletteState suppresses duplicate single group label", () => {
  const config = buildIssueManagerMentionPanelConfig(copy);
  const state = buildIssueManagerMentionPaletteState({
    activeFilterId: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.apps,
    copy,
    expandedCounts: {},
    filterTabs: config.filterTabs,
    isLoading: false,
    matches: [testMatch("workspace-app", "weather")],
    providerGroups: config.providerGroups,
    query: "wea"
  });

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "apps");
  assert.equal(state.groups[0]?.label, undefined);
});

test("buildIssueManagerMentionNavigationEntries includes item and expand entries", () => {
  const config = buildIssueManagerMentionPanelConfig(copy);
  const expanded: string[] = [];
  const state = buildIssueManagerMentionPaletteState({
    activeFilterId: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.apps,
    copy,
    expandedCounts: {},
    filterTabs: config.filterTabs,
    isLoading: false,
    matches: Array.from({ length: 6 }, (_, index) =>
      testMatch("workspace-app", `app-${index}`)
    ),
    providerGroups: config.providerGroups,
    query: ""
  });

  const entries = buildIssueManagerMentionNavigationEntries({
    onExpandGroup: (groupId) => expanded.push(groupId),
    state
  });

  assert.deepEqual(
    entries.map((entry) => `${entry.type}:${entry.key}`),
    [
      "match:apps:workspace-app:app-0",
      "match:apps:workspace-app:app-1",
      "match:apps:workspace-app:app-2",
      "match:apps:workspace-app:app-3",
      "match:apps:workspace-app:app-4",
      "action:expand:apps"
    ]
  );

  const expandEntry = entries.at(-1);
  assert.equal(expandEntry?.type, "action");
  if (expandEntry?.type === "action") {
    expandEntry.onSelect();
  }
  assert.deepEqual(expanded, ["apps"]);
});

test("issueMatchToRowItem maps mention meta into display rows", () => {
  assert.deepEqual(
    issueMatchToRowItem(
      testMatch("workspace-issue", "issue-1", {
        label: "Fix login",
        meta: {
          creatorDisplayName: "Alice",
          status: "running"
        }
      }),
      copy
    ),
    {
      kind: "issue",
      title: "Fix login",
      creatorName: "Alice",
      statusTag: {
        dataStatus: "running",
        label: "Running",
        tone: "neutral",
        variant: "issue"
      }
    }
  );

  assert.deepEqual(
    issueMatchToRowItem(
      testMatch("agent-session", "session-1", {
        label: "Session",
        meta: {
          agentIconUrl: "asset://codex.png",
          participant: "Local & Codex",
          statusDataStatus: "working",
          statusLabel: "Working",
          statusPulse: "true",
          title: "Handle login",
          userAvatarPlaceholderUrl: "asset://user.png"
        }
      }),
      copy
    ),
    {
      kind: "session",
      agentIconUrl: "asset://codex.png",
      participant: "Local & Codex",
      statusTag: {
        dataStatus: "working",
        label: "Working",
        pulse: true,
        tone: "blue",
        variant: "activity"
      },
      summary: "Handle login",
      userAvatarPlaceholderUrl: "asset://user.png",
      userAvatarUrl: null
    }
  );
});

test("issue-manager mention panel helpers cycle filters and expand counts", () => {
  const config = buildIssueManagerMentionPanelConfig(copy);
  assert.equal(
    nextIssueManagerMentionFilterId({
      currentFilterId: "all",
      delta: 1,
      filterTabs: config.filterTabs
    }),
    "agent-session"
  );
  assert.deepEqual(
    nextIssueManagerMentionExpandedCounts({
      expandedCounts: {},
      groupId: "apps"
    }),
    { apps: 10 }
  );
});

function testMatch(
  providerId: string,
  key: string,
  options: {
    label?: string;
    meta?: Readonly<Record<string, string>>;
    subtitle?: string;
  } = {}
): RichTextAtQueryMatch {
  return {
    providerId,
    key,
    label: options.label ?? key,
    subtitle: options.subtitle,
    item: { key },
    insertResult: {
      kind: "mention",
      mention: {
        entityId: key,
        label: options.label ?? key,
        meta: options.meta ?? null
      }
    }
  };
}
