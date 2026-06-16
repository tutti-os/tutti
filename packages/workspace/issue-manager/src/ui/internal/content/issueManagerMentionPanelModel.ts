import {
  DEFAULT_RICH_TEXT_AT_PANEL_PAGE_SIZE,
  activityMentionStatusTone,
  buildMentionPaletteState,
  flattenMentionPaletteEntries,
  issueMentionStatusTone,
  resolveMentionFileVisualKind,
  type MentionFileVisualKind,
  type MentionPaletteState,
  type MentionRowItem,
  type MentionRowStatusTag
} from "@tutti-os/ui-rich-text/at-panel/model";
import type { RichTextAtEditorNavigationEntry } from "@tutti-os/ui-rich-text/editor";
import type { RichTextAtQueryMatch } from "@tutti-os/ui-rich-text/types";
import { resolveWorkspaceFileVisualKind } from "@tutti-os/workspace-file-preview/core";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";
import { resolveIssueManagerStatusLabel } from "../../../services/controllerModel.ts";

export const ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS = {
  apps: "workspace-app",
  files: "file",
  issues: "workspace-issue",
  sessions: "agent-session"
} as const;

export const ISSUE_MANAGER_MENTION_PALETTE_MAX_HEIGHT_PX = 256;

export type IssueManagerMentionPanelConfig = ReturnType<
  typeof buildIssueManagerMentionPanelConfig
>;

export function buildIssueManagerMentionPanelConfig(
  copy: IssueManagerI18nRuntime
) {
  const labels = {
    all: copy.t("richTextAt.all"),
    apps: copy.t("richTextAt.apps"),
    files: copy.t("richTextAt.files"),
    issues: copy.t("richTextAt.issues"),
    sessions: copy.t("richTextAt.sessions")
  };
  return {
    filterTabs: [
      { id: "all", label: labels.all },
      {
        id: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.sessions,
        label: labels.sessions
      },
      {
        id: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.files,
        label: labels.files
      },
      {
        id: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.issues,
        label: labels.issues
      },
      { id: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.apps, label: labels.apps }
    ],
    providerGroups: [
      {
        id: "sessions",
        label: labels.sessions,
        providerIds: [ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.sessions],
        filterId: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.sessions
      },
      {
        id: "files",
        label: labels.files,
        providerIds: [ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.files],
        filterId: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.files
      },
      {
        id: "issues",
        label: labels.issues,
        providerIds: [ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.issues],
        filterId: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.issues
      },
      {
        id: "apps",
        label: labels.apps,
        providerIds: [ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.apps],
        filterId: ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.apps
      }
    ]
  } as const;
}

export function nextIssueManagerMentionFilterId(input: {
  currentFilterId: string;
  delta: 1 | -1;
  filterTabs: readonly { id: string }[];
}): string {
  const ids = input.filterTabs.map((tab) => tab.id);
  if (ids.length === 0) {
    return input.currentFilterId;
  }
  const index = ids.indexOf(input.currentFilterId);
  const base = index >= 0 ? index : input.delta > 0 ? -1 : 0;
  return (
    ids[(base + input.delta + ids.length) % ids.length] ?? input.currentFilterId
  );
}

export function nextIssueManagerMentionExpandedCounts(input: {
  expandedCounts: Record<string, number | undefined>;
  groupId: string;
}): Record<string, number | undefined> {
  return {
    ...input.expandedCounts,
    [input.groupId]:
      (input.expandedCounts[input.groupId] ??
        DEFAULT_RICH_TEXT_AT_PANEL_PAGE_SIZE) +
      DEFAULT_RICH_TEXT_AT_PANEL_PAGE_SIZE
  };
}

export function buildIssueManagerMentionPaletteState(input: {
  activeFilterId: string;
  copy: IssueManagerI18nRuntime;
  expandedCounts: Record<string, number | undefined>;
  filterTabs: IssueManagerMentionPanelConfig["filterTabs"];
  isLoading: boolean;
  matches: readonly RichTextAtQueryMatch[];
  providerGroups: IssueManagerMentionPanelConfig["providerGroups"];
  query: string;
}): MentionPaletteState<RichTextAtQueryMatch> {
  const activeFilterLabel = input.filterTabs.find(
    (tab) => tab.id === input.activeFilterId
  )?.label;
  return buildMentionPaletteState({
    matches: input.matches,
    providerGroups: input.providerGroups,
    filterTabs: input.filterTabs,
    activeFilterId: input.activeFilterId,
    expandedCounts: input.expandedCounts,
    query: input.query,
    isLoading: input.isLoading,
    showMoreLabel: (count) => input.copy.t("richTextAt.showMore", { count }),
    shouldRenderGroupLabel: (groupId, groupCount) => {
      if (input.activeFilterId === "all" || groupCount !== 1) {
        return true;
      }
      const group = input.providerGroups.find((entry) => entry.id === groupId);
      return group?.label !== activeFilterLabel;
    }
  });
}

export function buildIssueManagerMentionNavigationEntries(input: {
  onExpandGroup: (groupId: string) => void;
  state: MentionPaletteState<RichTextAtQueryMatch>;
}): RichTextAtEditorNavigationEntry[] {
  return flattenMentionPaletteEntries(input.state, (item) =>
    issueManagerMentionMatchKey(item)
  ).flatMap((entry): RichTextAtEditorNavigationEntry[] => {
    if (
      entry.type === "item" &&
      entry.groupId !== undefined &&
      entry.itemIndex !== undefined
    ) {
      const item = input.state.groups.find(
        (group) => group.id === entry.groupId
      )?.items[entry.itemIndex];
      return item ? [{ key: entry.key, type: "match", match: item }] : [];
    }
    if (entry.type === "expand" && entry.groupId !== undefined) {
      const groupId = entry.groupId;
      return [
        {
          key: entry.key,
          type: "action",
          onSelect: () => input.onExpandGroup(groupId)
        }
      ];
    }
    return [];
  });
}

export function issueManagerMentionMatchKey(
  match: RichTextAtQueryMatch
): string {
  return `${match.providerId}:${match.key}`;
}

export function issueMatchToRowItem(
  match: RichTextAtQueryMatch,
  copy: IssueManagerI18nRuntime
): MentionRowItem {
  const meta = issueMentionMatchMeta(match);
  const label = nonEmptyText(match.label) ?? match.key;

  if (match.providerId === ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.apps) {
    return {
      kind: "app",
      name: label,
      description:
        nonEmptyText(match.subtitle) ?? nonEmptyText(meta.description),
      iconUrl: nonEmptyText(meta.iconUrl)
    };
  }

  if (match.providerId === ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.issues) {
    return {
      kind: "issue",
      title: label,
      creatorName: nonEmptyText(meta.creatorDisplayName),
      statusTag: issueStatusTagFromMeta(meta.status, copy)
    };
  }

  if (match.providerId === ISSUE_MANAGER_RICH_AT_PROVIDER_GROUP_IDS.sessions) {
    return {
      kind: "session",
      participant: nonEmptyText(meta.participant) ?? label,
      summary: nonEmptyText(meta.title) ?? nonEmptyText(match.subtitle),
      userAvatarUrl: nonEmptyText(meta.userAvatarUrl),
      userAvatarPlaceholderUrl: meta.userAvatarPlaceholderUrl,
      agentIconUrl: meta.agentIconUrl,
      statusTag: sessionStatusTagFromMeta(meta.statusLabel, {
        dataStatus: meta.statusDataStatus,
        pulse: meta.statusPulse
      })
    };
  }

  const filePath = nonEmptyText(match.subtitle) ?? label;
  return {
    kind: "file",
    name: label,
    visualKind: resolveMentionFileVisualKind({
      baseVisualKind: resolveIssueManagerFileBaseVisualKind(filePath)
    }),
    thumbnailUrl: null
  };
}

interface IssueManagerMentionMatchMeta {
  agentIconUrl: string;
  creatorDisplayName: string;
  description: string;
  iconUrl: string;
  participant: string;
  status: string;
  statusDataStatus: string;
  statusLabel: string;
  statusPulse: string;
  title: string;
  userAvatarUrl: string;
  userAvatarPlaceholderUrl: string;
}

function issueMentionMatchMeta(
  match: RichTextAtQueryMatch
): IssueManagerMentionMatchMeta {
  const raw =
    match.insertResult.kind === "mention"
      ? (match.insertResult.mention.meta ?? {})
      : {};
  return {
    agentIconUrl: metaText(raw.agentIconUrl),
    creatorDisplayName: metaText(raw.creatorDisplayName),
    description: metaText(raw.description),
    iconUrl: metaText(raw.iconUrl),
    participant: metaText(raw.participant),
    status: metaText(raw.status),
    statusDataStatus: metaText(raw.statusDataStatus),
    statusLabel: metaText(raw.statusLabel),
    statusPulse: metaText(raw.statusPulse),
    title: metaText(raw.title),
    userAvatarUrl: metaText(raw.userAvatarUrl),
    userAvatarPlaceholderUrl: metaText(raw.userAvatarPlaceholderUrl)
  };
}

function issueStatusTagFromMeta(
  status: string,
  copy: IssueManagerI18nRuntime
): MentionRowStatusTag | null {
  const normalized = status.trim();
  if (!normalized) {
    return null;
  }
  return {
    label: resolveIssueManagerStatusLabel(copy, normalized),
    tone: issueMentionStatusTone(normalized),
    variant: "issue",
    dataStatus: normalized.toLowerCase() || "not_started"
  };
}

function sessionStatusTagFromMeta(
  statusLabel: string,
  options: { dataStatus: string; pulse: string }
): MentionRowStatusTag | null {
  const label = nonEmptyText(statusLabel);
  if (!label) {
    return null;
  }
  const dataStatus = nonEmptyText(options.dataStatus);
  return {
    label,
    tone: activityMentionStatusTone(dataStatus ?? ""),
    pulse: options.pulse === "true",
    variant: "activity",
    dataStatus: dataStatus ?? undefined
  };
}

function resolveIssueManagerFileBaseVisualKind(
  path: string
): MentionFileVisualKind {
  const kind = resolveWorkspaceFileVisualKind({
    kind: "file",
    name: path,
    path
  });
  if (kind === "directory" || kind === "binary") {
    return "document";
  }
  return kind;
}

function metaText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function nonEmptyText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}
