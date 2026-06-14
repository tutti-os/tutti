import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";

export const workspaceLaunchpadDockActionId = "open-launchpad";
export const workspaceLaunchpadDockEntryId = "workspace-launchpad";

export interface WorkspaceLaunchpadAgentDescriptor {
  comingSoon?: boolean;
  iconUrl: string;
  label: string;
  provider: WorkspaceAgentProvider;
}

export interface WorkspaceLaunchpadNodeDescriptor {
  dockEntryId: string;
  iconUrl: string;
  id: string;
  label: string;
  typeId: string;
}

export interface WorkspaceLaunchpadCopy {
  agentComingSoon: string;
  agentUnavailable: string;
  appUnavailable: string;
}

export type WorkspaceLaunchpadItem =
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
      comingSoon: boolean;
      disabledReason?: string;
      iconUrl: string;
      id: string;
      kind: "agent";
      label: string;
      launchEnabled: boolean;
      provider: WorkspaceAgentProvider;
      status: AgentProviderStatus | null;
    };

export interface WorkspaceLaunchpadGridMetrics {
  columns: number;
  pageSize: number;
  rows: number;
}

export interface WorkspaceLaunchpadPage<TItem> {
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

export function buildWorkspaceLaunchpadItems(input: {
  agentDescriptors: readonly WorkspaceLaunchpadAgentDescriptor[];
  agentStatuses: readonly AgentProviderStatus[];
  apps: readonly WorkspaceAppCenterApp[];
  copy: WorkspaceLaunchpadCopy;
  nodeDescriptors?: readonly WorkspaceLaunchpadNodeDescriptor[];
}): WorkspaceLaunchpadItem[] {
  const statusByProvider = new Map(
    input.agentStatuses.map((status) => [status.provider, status])
  );
  const nodeItems = (input.nodeDescriptors ?? []).map((node) => ({
    dockEntryId: node.dockEntryId,
    iconUrl: node.iconUrl,
    id: `node:${node.id}`,
    kind: "node" as const,
    label: node.label,
    launchEnabled: true,
    typeId: node.typeId
  }));
  const pinnedNodeItems = nodeItems.slice(0, 2);
  const remainingNodeItems = nodeItems.slice(2);
  return [
    ...pinnedNodeItems,
    ...input.apps
      .filter((app) => app.installed)
      .map((app) => {
        const launchEnabled =
          app.runtimeStatus === "running" && Boolean(app.url);
        return {
          appId: app.appId,
          disabledReason: launchEnabled ? undefined : input.copy.appUnavailable,
          iconUrl: app.iconUrl,
          id: `app:${app.appId}`,
          kind: "app" as const,
          label: app.name,
          launchEnabled
        };
      }),
    ...remainingNodeItems,
    ...input.agentDescriptors.map((agent) => {
      const status = statusByProvider.get(agent.provider);
      const comingSoon =
        agent.comingSoon === true ||
        status?.availability.status === "unsupported";
      const launchEnabled =
        !comingSoon && status?.availability.status === "ready";
      return {
        comingSoon,
        disabledReason: launchEnabled
          ? undefined
          : comingSoon
            ? input.copy.agentComingSoon
            : input.copy.agentUnavailable,
        iconUrl: agent.iconUrl,
        id: `agent:${agent.provider}`,
        kind: "agent" as const,
        label: agent.label,
        launchEnabled,
        provider: agent.provider,
        status: status ?? null
      };
    })
  ];
}

export function filterWorkspaceLaunchpadItems<TItem extends { label: string }>(
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

export function paginateWorkspaceLaunchpadItems<TItem>(
  items: readonly TItem[],
  input: {
    page: number;
    pageSize: number;
  }
): WorkspaceLaunchpadPage<TItem> {
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

export function resolveWorkspaceLaunchpadGrid(input: {
  height: number;
  width: number;
}): WorkspaceLaunchpadGridMetrics {
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

export function resolveWorkspaceLaunchpadPreviewIconUrls(input: {
  agentDescriptors?: readonly WorkspaceLaunchpadAgentDescriptor[];
  agentStatuses?: readonly AgentProviderStatus[];
  apps: readonly Pick<
    WorkspaceAppCenterApp,
    "iconUrl" | "installed" | "runtimeStatus" | "url"
  >[];
  excludedAgentProviders?: readonly WorkspaceAgentProvider[];
  fallbackIconUrl: string;
  nodeIconUrls?: readonly string[];
}): string[] {
  const statusByProvider = new Map(
    (input.agentStatuses ?? []).map((status) => [status.provider, status])
  );
  const excludedAgentProviders = new Set(input.excludedAgentProviders ?? []);
  const agentDescriptors = input.agentDescriptors ?? [];
  const notReadyAgentIcons = agentDescriptors
    .filter(
      (agent) =>
        !excludedAgentProviders.has(agent.provider) &&
        statusByProvider.get(agent.provider)?.availability.status !== "ready"
    )
    .map((agent) => agent.iconUrl);
  const visibleAppIcons = input.apps
    .filter((app) => app.installed)
    .map((app) => app.iconUrl?.trim() ?? "");
  const readyAgentIcons = agentDescriptors
    .filter(
      (agent) =>
        !excludedAgentProviders.has(agent.provider) &&
        statusByProvider.get(agent.provider)?.availability.status === "ready"
    )
    .map((agent) => agent.iconUrl);
  const icons = uniqueLaunchpadPreviewIconUrls([
    ...notReadyAgentIcons,
    ...visibleAppIcons,
    ...(input.nodeIconUrls ?? []),
    ...readyAgentIcons
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
