import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  MentionPalette,
  renderMentionRow,
  type MentionPaletteGroup
} from "@tutti-os/ui-rich-text/at-panel";
import type { RichTextAtEditorPanelContext } from "@tutti-os/ui-rich-text/editor";
import type { RichTextAtQueryMatch } from "@tutti-os/ui-rich-text/types";
import type { IssueManagerController } from "../../react/index.ts";
import {
  ISSUE_MANAGER_MENTION_PALETTE_MAX_HEIGHT_PX,
  buildIssueManagerMentionNavigationEntries,
  buildIssueManagerMentionPaletteState,
  buildIssueManagerMentionPanelConfig,
  issueMatchToRowItem,
  nextIssueManagerMentionExpandedCounts,
  nextIssueManagerMentionFilterId
} from "./issueManagerMentionPanelModel.ts";

export function useIssueManagerMentionPanelController(
  controller: IssueManagerController
) {
  const config = useMemo(
    () => buildIssueManagerMentionPanelConfig(controller.copy),
    [controller.copy]
  );
  const [activeFilterId, setActiveFilterId] = useState<string>(
    config.filterTabs[0]?.id ?? "all"
  );
  const [expandedCounts, setExpandedCounts] = useState<
    Record<string, number | undefined>
  >({});

  const expandGroup = useCallback((groupId: string) => {
    setExpandedCounts((current) =>
      nextIssueManagerMentionExpandedCounts({
        expandedCounts: current,
        groupId
      })
    );
  }, []);

  const cycleFilter = useCallback(
    (delta: 1 | -1) => {
      setActiveFilterId((currentFilterId) =>
        nextIssueManagerMentionFilterId({
          currentFilterId,
          delta,
          filterTabs: config.filterTabs
        })
      );
    },
    [config.filterTabs]
  );

  return {
    activeFilterId,
    config,
    cycleFilter,
    expandedCounts,
    expandGroup,
    setActiveFilterId
  };
}

export function IssueManagerMentionPanel({
  activeFilterId,
  context,
  controller,
  expandedCounts,
  onCycleFilter,
  onExpandGroup,
  onSelectFilter,
  panelConfig
}: {
  activeFilterId: string;
  context: RichTextAtEditorPanelContext;
  controller: IssueManagerController;
  expandedCounts: Record<string, number | undefined>;
  onCycleFilter: (delta: 1 | -1) => void;
  onExpandGroup: (groupId: string) => void;
  onSelectFilter: (filterId: string) => void;
  panelConfig: ReturnType<typeof buildIssueManagerMentionPanelConfig>;
}): JSX.Element {
  const copy = controller.copy;
  const state = useMemo(
    () =>
      buildIssueManagerMentionPaletteState({
        activeFilterId,
        copy,
        expandedCounts,
        filterTabs: panelConfig.filterTabs,
        isLoading: context.isLoading,
        matches: context.matches,
        providerGroups: panelConfig.providerGroups,
        query: context.query.keyword
      }),
    [
      activeFilterId,
      context.isLoading,
      context.matches,
      context.query.keyword,
      copy,
      expandedCounts,
      panelConfig.filterTabs,
      panelConfig.providerGroups
    ]
  );

  const navigationEntries = useMemo(
    () =>
      buildIssueManagerMentionNavigationEntries({
        onExpandGroup,
        state
      }),
    [onExpandGroup, state]
  );

  const onNavigationEntriesChange = context.onNavigationEntriesChange;
  useEffect(() => {
    onNavigationEntriesChange(navigationEntries);
  }, [navigationEntries, onNavigationEntriesChange]);
  useEffect(() => {
    return () => {
      onNavigationEntriesChange(null);
    };
  }, [onNavigationEntriesChange]);

  return (
    <MentionPalette<RichTextAtQueryMatch>
      state={state}
      highlightedKey={context.activeEntryKey}
      getItemKey={(item) => `${item.providerId}:${item.key}`}
      renderItem={(item) => renderMentionRow(issueMatchToRowItem(item, copy))}
      labels={{
        loading: copy.t("richTextAt.loading"),
        empty: copy.t("richTextAt.noMatches"),
        error: copy.t("richTextAt.noMatches"),
        tabHint: ""
      }}
      hintLabels={{
        cycleFilter: copy.t("richTextAt.switchCategory"),
        moveSelection: copy.t("richTextAt.switchSelection")
      }}
      maxHeightPx={ISSUE_MANAGER_MENTION_PALETTE_MAX_HEIGHT_PX}
      onHighlightChange={context.onActiveEntryKeyChange}
      onSelectItem={(item) => context.onSelect(item)}
      onSelectCategory={(categoryId) => onSelectFilter(categoryId)}
      onSelectFilter={(filterId) => onSelectFilter(filterId)}
      onExpandGroup={(
        groupId: MentionPaletteGroup<RichTextAtQueryMatch>["id"]
      ) => onExpandGroup(groupId)}
      onCycleFilter={onCycleFilter}
      onMoveSelection={context.onMoveSelection}
    />
  );
}
