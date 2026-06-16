import type { RichTextAtQueryMatch } from "../types/at.ts";
import type {
  RichTextAtFilterId,
  RichTextAtFilterTab,
  RichTextAtGroupId,
  RichTextAtProviderGroup,
  RichTextAtSearchGroup
} from "./types.ts";

export const RICH_TEXT_AT_ALL_FILTER_ID = "all";
export const DEFAULT_RICH_TEXT_AT_PANEL_PAGE_SIZE = 5;

export function normalizeAtPanelQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildDefaultRichTextAtProviderGroups(input: {
  providers: readonly { id: string }[];
  labels?: Readonly<Record<string, string>>;
}): RichTextAtProviderGroup[] {
  return input.providers.map((provider) => ({
    id: provider.id,
    label: input.labels?.[provider.id] ?? provider.id,
    providerIds: [provider.id],
    filterId: provider.id
  }));
}

export function buildRichTextAtFilterTabs(input: {
  allLabel: string;
  groups: readonly RichTextAtProviderGroup[];
  labels?: Readonly<Record<string, string>>;
}): RichTextAtFilterTab[] {
  const seen = new Set<string>([RICH_TEXT_AT_ALL_FILTER_ID]);
  const tabs: RichTextAtFilterTab[] = [
    {
      id: RICH_TEXT_AT_ALL_FILTER_ID,
      label: input.allLabel
    }
  ];
  for (const group of input.groups) {
    const filterId = group.filterId ?? group.id;
    if (seen.has(filterId)) {
      continue;
    }
    seen.add(filterId);
    tabs.push({
      id: filterId,
      label: input.labels?.[filterId] ?? group.label
    });
  }
  return tabs;
}

export function filterGroupsForRichTextAtPanel(input: {
  filterId: RichTextAtFilterId;
  groups: readonly RichTextAtProviderGroup[];
}): readonly RichTextAtProviderGroup[] {
  if (input.filterId === RICH_TEXT_AT_ALL_FILTER_ID) {
    return input.groups;
  }
  return input.groups.filter(
    (group) => (group.filterId ?? group.id) === input.filterId
  );
}

export function groupRichTextAtMatches(input: {
  expandedCounts?: Readonly<Record<string, number | undefined>>;
  filterId: RichTextAtFilterId;
  groups: readonly RichTextAtProviderGroup[];
  matches: readonly RichTextAtQueryMatch[];
  pageSize?: number;
}): RichTextAtSearchGroup[] {
  const visibleGroups = filterGroupsForRichTextAtPanel({
    filterId: input.filterId,
    groups: input.groups
  });
  const pageSize = input.pageSize ?? DEFAULT_RICH_TEXT_AT_PANEL_PAGE_SIZE;
  return visibleGroups
    .map<RichTextAtSearchGroup | null>((group) => {
      const providerIds = new Set(group.providerIds);
      const items = input.matches.filter((match) =>
        providerIds.has(match.providerId)
      );
      const groupPageSize = group.pageSize ?? pageSize;
      const visibleCount = Math.min(
        items.length,
        input.expandedCounts?.[group.id] ?? groupPageSize
      );
      if (items.length === 0 && !group.emptyLabel) {
        return null;
      }
      return {
        id: group.id,
        label: group.label,
        items: items.slice(0, visibleCount),
        totalCount: items.length,
        visibleCount,
        hasMore: items.length > visibleCount,
        emptyLabel: group.emptyLabel
      } satisfies RichTextAtSearchGroup;
    })
    .filter((group): group is RichTextAtSearchGroup => group !== null);
}

export function richTextAtGroupExpandCount(
  group: RichTextAtSearchGroup,
  pageSize = DEFAULT_RICH_TEXT_AT_PANEL_PAGE_SIZE
): number {
  const remaining = Math.max(0, group.totalCount - group.visibleCount);
  return Math.min(pageSize, remaining);
}

export function findRichTextAtProviderGroup(
  groups: readonly RichTextAtProviderGroup[],
  groupId: RichTextAtGroupId
): RichTextAtProviderGroup | undefined {
  return groups.find((group) => group.id === groupId);
}
