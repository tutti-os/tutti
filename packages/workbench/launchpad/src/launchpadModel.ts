export const workbenchLaunchpadDockActionId = "open-launchpad";
export const workbenchLaunchpadDockEntryId = "workspace-launchpad";

export interface WorkbenchLaunchpadAppDescriptor {
  appId: string;
  disabledReason?: string;
  iconUrl?: string | null;
  id?: string;
  label: string;
  launchEnabled: boolean;
}

export interface WorkbenchLaunchpadNodeDescriptor {
  dockEntryId: string;
  disabledReason?: string;
  iconUrl: string;
  id: string;
  label: string;
  launchEnabled?: boolean;
  typeId: string;
}

export interface WorkbenchLaunchpadAgentDescriptor<
  TProvider extends string = string
> {
  action?: string | null;
  actions?: readonly WorkbenchLaunchpadAgentAction[];
  comingSoon?: boolean;
  disabledReason?: string;
  iconUrl: string;
  id?: string;
  label: string;
  launchEnabled: boolean;
  provider: TProvider;
  reason?: string | null;
}

export interface WorkbenchLaunchpadAgentAction {
  id: string;
}

export type WorkbenchLaunchpadItem<TProvider extends string = string> =
  | {
      appId: string;
      disabledReason?: string;
      iconUrl?: string | null;
      id: string;
      kind: "app";
      label: string;
      launchEnabled: boolean;
    }
  | {
      dockEntryId: string;
      disabledReason?: string;
      iconUrl: string;
      id: string;
      kind: "node";
      label: string;
      launchEnabled: boolean;
      typeId: string;
    }
  | {
      action?: string | null;
      actions?: readonly WorkbenchLaunchpadAgentAction[];
      comingSoon?: boolean;
      disabledReason?: string;
      iconUrl: string;
      id: string;
      kind: "agent";
      label: string;
      launchEnabled: boolean;
      provider: TProvider;
      reason?: string | null;
    };

export interface WorkbenchLaunchpadGridMetrics {
  columns: number;
  pageSize: number;
  rows: number;
}

export interface WorkbenchLaunchpadPage<TItem> {
  currentPage: number;
  pageCount: number;
  pageItems: readonly TItem[];
}

const launchpadPreviewIconCount = 4;
const launchpadMinColumns = 2;
const launchpadMaxColumns = 7;
const launchpadMinRows = 1;
const launchpadMaxRows = 5;
const launchpadTileWidth = 136;
const launchpadTileHeight = 138;

export function buildWorkbenchLaunchpadItems<
  TProvider extends string = string
>(input: {
  agentDescriptors?: readonly WorkbenchLaunchpadAgentDescriptor<TProvider>[];
  apps?: readonly WorkbenchLaunchpadAppDescriptor[];
  nodeDescriptors?: readonly WorkbenchLaunchpadNodeDescriptor[];
}): WorkbenchLaunchpadItem<TProvider>[] {
  const nodeItems = (input.nodeDescriptors ?? []).map((node) => ({
    disabledReason: node.disabledReason,
    dockEntryId: node.dockEntryId,
    iconUrl: node.iconUrl,
    id: `node:${node.id}`,
    kind: "node" as const,
    label: node.label,
    launchEnabled: node.launchEnabled ?? true,
    typeId: node.typeId
  }));
  const pinnedNodeItems = nodeItems.slice(0, 2);
  const remainingNodeItems = nodeItems.slice(2);
  return [
    ...pinnedNodeItems,
    ...(input.apps ?? []).map((app) => ({
      appId: app.appId,
      disabledReason: app.disabledReason,
      iconUrl: app.iconUrl,
      id: app.id ?? `app:${app.appId}`,
      kind: "app" as const,
      label: app.label,
      launchEnabled: app.launchEnabled
    })),
    ...remainingNodeItems,
    ...(input.agentDescriptors ?? []).map((agent) => ({
      action: agent.action,
      actions: agent.actions,
      comingSoon: agent.comingSoon,
      disabledReason: agent.disabledReason,
      iconUrl: agent.iconUrl,
      id: agent.id ?? `agent:${agent.provider}`,
      kind: "agent" as const,
      label: agent.label,
      launchEnabled: agent.launchEnabled,
      provider: agent.provider,
      reason: agent.reason
    }))
  ];
}

export function filterWorkbenchLaunchpadItems<TItem extends { label: string }>(
  items: readonly TItem[],
  query: string
): TItem[] {
  const normalizedQuery = normalizeLaunchpadSearchText(query);
  if (!normalizedQuery) {
    return [...items];
  }
  return items.filter((item) =>
    normalizeLaunchpadSearchText(item.label).includes(normalizedQuery)
  );
}

export function paginateWorkbenchLaunchpadItems<TItem>(
  items: readonly TItem[],
  input: {
    page: number;
    pageSize: number;
  }
): WorkbenchLaunchpadPage<TItem> {
  const pageSize = Math.max(1, Math.floor(input.pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = clampInteger(input.page, 0, pageCount - 1);
  const pageStart = currentPage * pageSize;
  return {
    currentPage,
    pageCount,
    pageItems: items.slice(pageStart, pageStart + pageSize)
  };
}

export function resolveWorkbenchLaunchpadGrid(input: {
  height: number;
  width: number;
}): WorkbenchLaunchpadGridMetrics {
  const columns = clampInteger(
    Math.floor(input.width / launchpadTileWidth),
    launchpadMinColumns,
    launchpadMaxColumns
  );
  const rows = clampInteger(
    Math.floor(input.height / launchpadTileHeight),
    launchpadMinRows,
    launchpadMaxRows
  );
  return {
    columns,
    pageSize: Math.max(1, columns * rows),
    rows
  };
}

export function resolveWorkbenchLaunchpadPreviewIconUrls(input: {
  agentIcons?: readonly string[];
  appIcons?: readonly (string | null | undefined)[];
  fallbackIconUrl: string;
  nodeIconUrls?: readonly string[];
}): string[] {
  const icons = uniqueLaunchpadPreviewIconUrls([
    ...(input.appIcons ?? []),
    ...(input.nodeIconUrls ?? []),
    ...(input.agentIcons ?? [])
  ]).slice(0, launchpadPreviewIconCount);
  while (icons.length < launchpadPreviewIconCount) {
    icons.push(input.fallbackIconUrl);
  }
  return icons;
}

function uniqueLaunchpadPreviewIconUrls(
  iconUrls: readonly (string | null | undefined)[]
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const iconUrl of iconUrls) {
    const normalizedIconUrl = iconUrl?.trim();
    if (!normalizedIconUrl || seen.has(normalizedIconUrl)) {
      continue;
    }
    seen.add(normalizedIconUrl);
    result.push(normalizedIconUrl);
  }
  return result;
}

function normalizeLaunchpadSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}
