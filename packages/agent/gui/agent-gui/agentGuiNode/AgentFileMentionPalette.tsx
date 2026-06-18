import {
  normalizeAgentActivityDisplayStatus,
  type AgentActivityDisplayStatus
} from "@tutti-os/agent-activity-core";
import {
  MentionPalette,
  flattenMentionPaletteEntries,
  issueMentionStatusTone,
  renderMentionRow,
  type MentionPaletteEntry,
  type MentionPaletteState,
  type MentionPaletteTheme,
  type MentionRowClassNames,
  type MentionRowItem,
  type MentionRowStatusTag,
  type MentionRowStatusTone
} from "@tutti-os/ui-rich-text/at-panel";
import { Spinner } from "../../app/renderer/components/ui/spinner";
import { userAvatarPlaceholderUrl } from "../../shared/userAvatarPlaceholder";
import { translate } from "../../i18n/index";
import { managedAgentRoundedIconUrl } from "../../shared/managedAgentIcons";
import { workspaceAgentActivityStatusLabel } from "../../shared/workspaceAgentActivityStatusLabel";
import { roomIssueStatusLabel } from "../../shared/roomIssueStatusLabel";
import {
  resolveAgentMentionFileThumbnailUrl,
  resolveAgentMentionFileVisualKind
} from "../shared/mentionFilePresentation";
import {
  agentMentionEmptyGroupLabel,
  agentMentionFilterLabel,
  agentMentionGroupLabel
} from "./AgentMentionLabels";
import {
  AGENT_MENTION_FILTER_TAB_ORDER,
  mentionGroupExpandCount
} from "./agentMentionSearchHelpers";
import {
  type AgentMentionGroup,
  type AgentMentionBrowseCategory,
  type AgentMentionFilterId,
  type AgentMentionGroupId,
  type AgentMentionSearchState
} from "./AgentMentionSearchController";
import { agentGeneratedMentionItemKey } from "./agentMentionAgentGeneratedFilesPresentation";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";

export interface AgentMentionPaletteEntry {
  key: string;
  type: "category" | "item" | "expand";
  categoryId?: AgentMentionBrowseCategory["id"];
  groupId?: AgentMentionGroupId;
  item?: AgentContextMentionItem;
}

export interface AgentFileMentionPaletteProps {
  state: AgentMentionSearchState;
  highlightedKey: string | null;
  label: string;
  loadingLabel: string;
  emptyLabel: string;
  errorLabel: string;
  tabHintLabel: string;
  maxHeightPx: number;
  shouldCenterHighlightedItem?: boolean;
  onHighlightChange: (key: string) => void;
  onSelectItem: (entry: AgentContextMentionItem) => void;
  onSelectCategory: (categoryId: AgentMentionBrowseCategory["id"]) => void;
  onSelectFilter: (filter: AgentMentionFilterId) => void;
  onExpandGroup: (groupId: AgentMentionGroupId) => void;
  onCycleFilter: () => void;
  onMoveSelection: (delta: 1 | -1) => void;
  /**
   * 可选:点击 issue / app 行末尾的「查看产物文件」图标时回调(打开引用 picker 并定位)。
   * 仅 workspace-issue / workspace-app 行渲染该入口。
   */
  onOpenReferences?: (item: AgentContextMentionItem) => void;
}

const AGENT_MENTION_PALETTE_THEME: MentionPaletteTheme = {
  classNames: {
    palette: "agent-gui-node__mention-palette",
    header: "agent-gui-node__mention-palette-header",
    footer: "agent-gui-node__mention-palette-footer",
    tabs: "agent-gui-node__mention-palette-tabs",
    scrollRegion: "agent-gui-node__mention-palette-scroll-region",
    scrollbar:
      "workspace-agents-status-panel__scrollbar agent-gui-node__mention-palette-scrollbar",
    scrollbarThumb: "workspace-agents-status-panel__scrollbar-thumb",
    hint: "agent-gui-node__mention-palette-hint",
    hintItem: "agent-gui-node__mention-palette-hint-item",
    hintButton: "agent-gui-node__mention-palette-hint-button",
    hintSeparator: "agent-gui-node__mention-palette-hint-separator",
    shortcut: "agent-gui-node__mention-palette-shortcut",
    shortcutArrow: "agent-gui-node__mention-palette-shortcut--arrow",
    shortcutButton: "agent-gui-node__mention-palette-shortcut-button",
    shortcutGroup: "agent-gui-node__mention-palette-shortcut-group"
  },
  testIds: {
    emptyState: "agent-gui-mention-palette-empty-state",
    hint: "agent-gui-mention-palette-hint",
    scrollbar: "agent-gui-mention-palette-scrollbar",
    loadingSpinner: "agent-mention-loading-spinner"
  },
  groupDividerAttribute: "data-agent-mention-group-divider"
};

/**
 * The agent composer's existing structural row class names. Passing these to
 * {@link renderMentionRow} keeps the rendered DOM byte-identical to the
 * pre-refactor markup (the agent stylesheet `agentactivity.css` owns these
 * rules and the agent spec greps them), while the shared component defaults to
 * package-owned `rich-text-at-mention-*` names for other surfaces.
 */
const AGENT_MENTION_ROW_CLASS_NAMES: MentionRowClassNames = {
  fileIcon: "agent-gui-node__mention-file-icon",
  fileThumb: "agent-gui-node__mention-file-thumb",
  kindIcon: "tsh-agent-object-token__kind-icon",
  avatarImgUserPlaceholder:
    "workspace-agents-status-panel__avatar-img--user-placeholder"
};

/**
 * Stable per-item key suffix. The shared shell composes the full entry key as
 * `${group.id}:${agentMentionItemKey(item)}`, matching the agent's historical
 * `${group.id}:${item.kind}:${...}` format so highlight keys stay compatible.
 */
function agentMentionItemKey(item: AgentContextMentionItem): string {
  return `${item.kind}:${
    item.kind === "file" ? agentGeneratedMentionItemKey(item) : item.targetId
  }`;
}

export function flattenAgentMentionPaletteEntries(
  state: AgentMentionSearchState
): AgentMentionPaletteEntry[] {
  return flattenMentionPaletteEntries(state, (item) =>
    agentMentionItemKey(item)
  ).map((entry: MentionPaletteEntry): AgentMentionPaletteEntry => {
    if (entry.type === "item") {
      const item =
        entry.groupId !== undefined && entry.itemIndex !== undefined
          ? state.groups.find((group) => group.id === entry.groupId)?.items[
              entry.itemIndex
            ]
          : undefined;
      return {
        key: entry.key,
        type: "item",
        groupId: entry.groupId as AgentMentionGroupId | undefined,
        item
      };
    }
    return {
      key: entry.key,
      type: entry.type,
      categoryId: entry.categoryId as AgentMentionFilterId | undefined,
      groupId: entry.groupId as AgentMentionGroupId | undefined
    };
  });
}

export function groupStartKeys(state: AgentMentionSearchState): string[] {
  if (state.mode === "browse") {
    return state.categories.map((category) => `category:${category.id}`);
  }
  return state.groups
    .map((group) => {
      const firstItem = group.items[0];
      if (firstItem) {
        return `${group.id}:${firstItem.kind}:${firstItem.kind === "file" ? firstItem.path : firstItem.targetId}`;
      }
      if (group.hasMore) {
        return `expand:${group.id}`;
      }
      return null;
    })
    .filter((key): key is string => key !== null);
}

export function AgentFileMentionPalette({
  state,
  highlightedKey,
  label,
  loadingLabel,
  emptyLabel,
  errorLabel,
  tabHintLabel,
  maxHeightPx,
  shouldCenterHighlightedItem = false,
  onHighlightChange,
  onSelectItem,
  onSelectCategory,
  onSelectFilter,
  onExpandGroup,
  onCycleFilter,
  onMoveSelection,
  onOpenReferences
}: AgentFileMentionPaletteProps): React.JSX.Element {
  "use memo";
  const openReferencesLabel = translate(
    "agentHost.agentGui.mentionOpenReferences"
  );
  const filter = state.filter as AgentMentionFilterId;
  const highlightedBrowseCategory = highlightedKey?.startsWith("category:")
    ? highlightedKey.slice("category:".length)
    : null;
  const showBrowseHint = shouldShowBrowseSearchHint({
    browseFilter: filter,
    groups: state.groups,
    highlightedBrowseCategory,
    mode: state.mode
  });

  // Browse mode carries its own category list (with labels); results mode tabs
  // are the fixed agent filter order. The shared shell renders a single tab
  // source, so resolve the right one here.
  const categories =
    state.mode === "browse"
      ? state.categories
      : AGENT_MENTION_FILTER_TAB_ORDER.map((id) => ({
          id,
          label: agentMentionFilterLabel(id)
        }));

  // When the agent wants the single keyboard browse hint we hand the shell an
  // empty group list so it renders its (keyboard-icon) empty state with our
  // computed hint copy. Otherwise we map the real groups, decorating each with
  // the agent-specific label / empty / expand / spacing chrome.
  const shellState: MentionPaletteState<AgentContextMentionItem> =
    showBrowseHint
      ? { ...state, categories, groups: [] }
      : {
          ...state,
          categories,
          groups: state.groups.map((group, index) =>
            decorateMentionGroup(
              group,
              index,
              state.groups,
              filter,
              state.query
            )
          )
        };

  const emptyLabelForShell = showBrowseHint
    ? browseHintForFilter(filter)
    : resolveMentionPaletteEmptyLabel({
        emptyLabel,
        filter,
        mode: state.mode,
        query: state.query
      });

  const showFileSearchMoreHint = shouldShowFileSearchMoreHint({
    filter,
    groups: state.groups,
    mode: state.mode,
    query: state.query
  });

  return (
    <MentionPalette<AgentContextMentionItem>
      state={shellState}
      highlightedKey={highlightedKey}
      getItemKey={agentMentionItemKey}
      renderItem={(item) =>
        renderMentionRow(agentMentionItemToRowItem(item), {
          classNames: AGENT_MENTION_ROW_CLASS_NAMES,
          dataAttributeMode: "agent",
          ...(onOpenReferences && isReferenceableMentionItem(item)
            ? {
                onOpenReferences: () => onOpenReferences(item),
                openReferencesLabel
              }
            : {})
        })
      }
      labels={{
        loading: loadingLabel,
        empty: emptyLabelForShell,
        error: errorLabel,
        tabHint: tabHintLabel,
        listbox: label
      }}
      hintLabels={{
        cycleFilter: translate("agentHost.agentGui.fileMentionSwitchCategory"),
        moveSelection: translate(
          "agentHost.agentGui.fileMentionSwitchSelection"
        )
      }}
      maxHeightPx={maxHeightPx}
      scrollHighlightedIntoViewCentered={shouldCenterHighlightedItem}
      loadingBanner={<MentionPaletteLoadingBanner label={loadingLabel} />}
      theme={AGENT_MENTION_PALETTE_THEME}
      renderListFooter={
        showFileSearchMoreHint ? () => <MentionFileSearchMoreHint /> : undefined
      }
      onHighlightChange={onHighlightChange}
      onSelectItem={(item) => onSelectItem(item)}
      onSelectCategory={(categoryId) =>
        onSelectCategory(categoryId as AgentMentionBrowseCategory["id"])
      }
      onSelectFilter={(nextFilter) =>
        onSelectFilter(nextFilter as AgentMentionFilterId)
      }
      onExpandGroup={(groupId) => onExpandGroup(groupId as AgentMentionGroupId)}
      onCycleFilter={() => onCycleFilter()}
      onMoveSelection={onMoveSelection}
    />
  );
}

export const AgentContextMentionPalette = AgentFileMentionPalette;
export type AgentContextMentionPaletteProps = AgentFileMentionPaletteProps;

/**
 * Map a controller group onto the shared shell group, layering in the
 * agent-specific chrome the generic shell intentionally omits: translated
 * group / empty / expand labels, file-search chrome suppression, and the extra
 * top margin between the "my sessions" and "collab sessions" groups.
 */
function decorateMentionGroup(
  group: AgentMentionGroup,
  index: number,
  groups: ReadonlyArray<AgentMentionGroup>,
  filter: AgentMentionFilterId,
  query: string
): AgentMentionGroup {
  const groupId = group.id as AgentMentionGroupId;
  const suppressChrome = shouldSuppressFileSearchGroupChrome(filter, query);
  const followsMySessions =
    groupId === "collab_sessions" &&
    (groups[index - 1]?.id as AgentMentionGroupId) === "my_sessions";
  const showLabel = shouldRenderMentionGroupLabel({
    filter,
    groupCount: groups.length,
    groupId,
    query
  });
  return {
    ...group,
    label: showLabel ? agentMentionGroupLabel(groupId) : undefined,
    emptyLabel: suppressChrome
      ? undefined
      : agentMentionEmptyGroupLabel(groupId, query),
    expandLabel: group.hasMore
      ? translate("agentHost.agentGui.contextPickerExpandMore", {
          count: mentionGroupExpandCount(group, filter)
        })
      : undefined,
    sectionClassName: followsMySessions ? "mt-2" : undefined,
    hideTopDivider: suppressChrome
  };
}

function MentionPaletteLoadingBanner({
  label
}: {
  label: string;
}): React.JSX.Element {
  "use memo";
  return (
    <div
      className="flex items-center gap-2 border-b border-[var(--line-1)] px-3 py-2 text-[13px] font-medium text-[var(--text-secondary)]"
      data-testid="agent-mention-loading-banner"
    >
      <Spinner
        size={14}
        className="text-[var(--text-secondary)]"
        testId="agent-mention-loading-spinner"
      />
      <span>{label}</span>
    </div>
  );
}

function MentionFileSearchMoreHint(): React.JSX.Element {
  "use memo";
  return (
    <p
      className="px-3 pb-1 pt-2 text-center text-[13px] leading-5 text-[var(--text-tertiary)]"
      data-agent-mention-file-search-hint="true"
    >
      {translate("agentHost.agentGui.mentionFileSearchMoreHint")}
    </p>
  );
}

function shouldSuppressFileSearchGroupChrome(
  filter: AgentMentionFilterId,
  query: string
): boolean {
  return filter === "file" && query.trim().length > 0;
}

function resolveMentionPaletteEmptyLabel(input: {
  emptyLabel: string;
  filter: AgentMentionFilterId;
  mode: AgentMentionSearchState["mode"];
  query: string;
}): string {
  if (
    input.mode === "results" &&
    input.filter === "file" &&
    input.query.trim().length > 0
  ) {
    return translate("agentHost.agentGui.mentionNoMatchingFiles");
  }
  if (input.filter === "session") {
    return agentMentionEmptyGroupLabel("my_sessions", input.query);
  }
  if (input.filter === "app") {
    return agentMentionEmptyGroupLabel("apps", input.query);
  }
  if (input.filter === "issue") {
    return agentMentionEmptyGroupLabel("issues", input.query);
  }
  return input.emptyLabel;
}

function shouldRenderMentionGroupLabel(input: {
  filter: AgentMentionFilterId;
  groupCount: number;
  groupId: AgentMentionGroupId;
  query: string;
}): boolean {
  if (shouldSuppressFileSearchGroupChrome(input.filter, input.query)) {
    return false;
  }
  if (input.filter === "all" || input.groupCount !== 1) {
    return true;
  }
  return (
    agentMentionGroupLabel(input.groupId) !==
    agentMentionFilterLabel(input.filter)
  );
}

/**
 * Resolve an agent mention item into the shared, display-ready
 * {@link MentionRowItem} view-model the generic {@link renderMentionRow}
 * consumes. All agent-specific bits — i18n via {@link translate}, the user
 * avatar placeholder asset, the managed-agent rounded icon, and the activity /
 * issue status labels — are resolved here so the shared renderer stays pure.
 */
function agentMentionItemToRowItem(
  item: AgentContextMentionItem
): MentionRowItem {
  if (item.kind === "file") {
    const visualKind = resolveAgentMentionFileVisualKind({
      entryKind: item.entryKind,
      href: item.href,
      mentionNavigation: item.mentionNavigation,
      name: item.name,
      path: item.path
    });
    const childCountLabel =
      item.mentionNavigation === "agent-generated-folder" &&
      typeof item.childCount === "number" &&
      item.childCount > 0
        ? translate("agentHost.agentGui.mentionAgentGeneratedFolderFileCount", {
            count: item.childCount
          })
        : null;
    return {
      kind: "file",
      name: item.name,
      visualKind,
      thumbnailUrl: resolveAgentMentionFileThumbnailUrl(item) ?? null,
      childCountLabel,
      entryKind: item.entryKind,
      mentionNavigation: item.mentionNavigation
    };
  }

  if (item.kind === "session") {
    return {
      kind: "session",
      participant: `${item.initiatorName} & ${item.agentName}`,
      summary: item.title,
      userAvatarUrl: item.initiatorAvatarUrl ?? null,
      userAvatarPlaceholderUrl,
      agentIconUrl: managedAgentRoundedIconUrl(
        mentionSessionAgentProvider(item) ?? item.agentName
      ),
      statusTag: agentSessionStatusTag(item.status)
    };
  }

  if (item.kind === "workspace-app") {
    return {
      kind: "app",
      name: item.name,
      description: item.description ?? null,
      iconUrl: item.iconUrl ?? null
    };
  }

  if (item.kind === "workspace-app-bundle") {
    return {
      kind: "app",
      name: item.name,
      description: null,
      iconUrl: item.iconUrl ?? null
    };
  }

  if (item.kind === "workspace-app-factory") {
    return {
      kind: "app-factory",
      name: item.name
    };
  }

  return {
    kind: "issue",
    title: item.title,
    creatorName: item.creatorName ?? null,
    statusTag: agentIssueStatusTag(item.status)
  };
}

/**
 * 仅 workspace-issue 行,以及声明了能够提供产物文件(reference)的 workspace-app 行,
 * 才在行末尾展示「查看产物文件」入口。应用是否能提供产物文件由其 manifest 的
 * references 能力决定(`referencesListSupported`),而非硬编码应用名单。
 */
function isReferenceableMentionItem(item: AgentContextMentionItem): boolean {
  if (item.kind === "workspace-issue") {
    return true;
  }
  if (item.kind === "workspace-app") {
    return item.referencesListSupported === true;
  }
  return false;
}

function mentionSessionAgentProvider(
  item: Extract<AgentContextMentionItem, { kind: "session" }>
): string | null {
  const queryStart = item.href.indexOf("?");
  if (queryStart < 0) {
    return null;
  }
  return new URLSearchParams(item.href.slice(queryStart + 1)).get("provider");
}

function agentSessionStatusTag(
  status: string | undefined
): MentionRowStatusTag | null {
  if (!status) {
    return null;
  }
  const activityStatus = normalizeAgentActivityDisplayStatus(status);
  return {
    label: workspaceAgentActivityStatusLabel(activityStatus),
    tone: mentionStatusTone(activityStatus),
    pulse: activityStatus === "working" || activityStatus === "waiting",
    variant: "activity",
    dataStatus: activityStatus
  };
}

function agentIssueStatusTag(
  status: string | undefined
): MentionRowStatusTag | null {
  if (!status) {
    return null;
  }
  return {
    label: roomIssueStatusLabel(status),
    tone: issueMentionStatusTone(status),
    variant: "issue",
    dataStatus: status.trim().toLowerCase() || "not_started"
  };
}

function mentionStatusTone(
  status: AgentActivityDisplayStatus
): MentionRowStatusTone {
  if (status === "working") {
    return "blue";
  }
  if (status === "waiting" || status === "canceled") {
    return "amber";
  }
  if (status === "completed" || status === "idle") {
    return "green";
  }
  if (status === "failed") {
    return "red";
  }
  return "neutral";
}

function browseHintForFilter(filter: AgentMentionFilterId): string {
  if (filter === "all") {
    return translate("agentHost.agentGui.contextPickerBrowseAllHint");
  }
  switch (filter) {
    case "app":
      return translate("agentHost.agentGui.contextPickerBrowseAppHint");
    case "file":
      return translate("agentHost.agentGui.contextPickerBrowseFileHint");
    case "session":
      return translate("agentHost.agentGui.contextPickerBrowseSessionHint");
    case "issue":
      return translate("agentHost.agentGui.contextPickerBrowseIssueHint");
  }
}

function hasInteractiveGroupEntries(
  groups: ReadonlyArray<AgentMentionGroup>
): boolean {
  return groups.some((group) => group.items.length > 0 || group.hasMore);
}

function isFileBrowseGroupsOnlyEmpty(
  groups: ReadonlyArray<AgentMentionGroup>
): boolean {
  const fileGroups = groups.filter(
    (group) =>
      group.id === "opened_files" || group.id === "agent_generated_files"
  );
  if (fileGroups.length === 0) {
    return false;
  }
  return fileGroups.every(
    (group) => group.items.length === 0 && !group.hasMore
  );
}

function hasVisibleFileGroupEntries(
  groups: ReadonlyArray<AgentMentionGroup>
): boolean {
  return groups.some(
    (group) =>
      (group.id === "files" ||
        group.id === "opened_files" ||
        group.id === "agent_generated_files") &&
      (group.items.length > 0 || group.hasMore)
  );
}

function shouldShowFileSearchMoreHint(input: {
  filter: AgentMentionFilterId;
  groups: ReadonlyArray<AgentMentionGroup>;
  mode: AgentMentionSearchState["mode"];
  query: string;
}): boolean {
  if (input.filter !== "file" || input.query.trim()) {
    return false;
  }
  if (input.mode !== "browse" && input.mode !== "results") {
    return false;
  }
  return hasVisibleFileGroupEntries(input.groups);
}

function shouldShowBrowseSearchHint(input: {
  browseFilter: AgentMentionFilterId;
  groups: ReadonlyArray<AgentMentionGroup>;
  highlightedBrowseCategory: string | null;
  mode: AgentMentionSearchState["mode"];
}): boolean {
  if (input.mode !== "browse" || hasInteractiveGroupEntries(input.groups)) {
    return false;
  }
  if (input.groups.length === 0) {
    return true;
  }
  if (
    input.highlightedBrowseCategory !== null &&
    input.highlightedBrowseCategory !== input.browseFilter
  ) {
    return true;
  }
  return (
    input.browseFilter === "file" && isFileBrowseGroupsOnlyEmpty(input.groups)
  );
}
