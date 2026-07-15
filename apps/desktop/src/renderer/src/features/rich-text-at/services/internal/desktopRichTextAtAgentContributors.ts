import type {
  AgentProviderStatus,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { workspaceAgentSessionStatus } from "@tutti-os/agent-activity-core";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/context-mention-provider";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import { resolveAgentGUIProviderIdentity } from "@tutti-os/agent-gui/provider-identity";
import type { ReferenceProvenanceFilter } from "@tutti-os/workspace-file-reference/contracts";
import type {
  AgentTargetPresentation,
  IAgentsService
} from "../../../workspace-agent/services/agentsService.interface";
import {
  compactMentionPresentation,
  compactStringRecord,
  createDesktopRichTextMentionInsertResult,
  createRichTextTriggerProvider,
  resolveMentionSafely,
  scopeString,
  type DesktopRichTextAtContributor
} from "./desktopRichTextAtMentionSupport.ts";

interface AgentSessionAtItem {
  agentIconUrl?: string | null;
  agentName?: string | null;
  agentTargetId?: string | null;
  createdAtUnixMs?: number | null;
  id: string;
  initiatorName?: string | null;
  provider?: string | null;
  scope?: "my_sessions" | "collab_sessions";
  sessionOrigin?: string | null;
  status?: string | null;
  title?: string | null;
  updatedAtUnixMs?: number | null;
  userId?: string | null;
  workspaceId: string;
}

interface AgentTargetAtItem {
  description: string;
  displayName: string;
  iconUrl: string;
  provider: WorkspaceAgentProvider;
  sortOrder: number;
  targetId: string;
  workspaceId: string;
}

export function createAgentTargetAtContributor(contributorInput: {
  agentsService?: Pick<IAgentsService, "load">;
  agentProviderStatuses?: () => readonly AgentProviderStatus[] | undefined;
  isTuttiAgentSwitchEnabled?: () => boolean;
}): DesktopRichTextAtContributor {
  return {
    capability: "agent-target",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<AgentTargetAtItem>({
          id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.agentTarget,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) return [];
            const response = await contributorInput.agentsService?.load(
              searchInput.abortSignal
            );
            if (searchInput.abortSignal?.aborted || !response) return [];
            return agentTargetAtItemsFromTargets({
              agentProviderStatuses: contributorInput.agentProviderStatuses?.(),
              isTuttiAgentSwitchEnabled:
                contributorInput.isTuttiAgentSwitchEnabled,
              keyword: searchInput.keyword,
              maxResults: searchInput.maxResults,
              targets: response.agentTargets,
              workspaceId: input.workspaceId
            });
          },
          getItemKey: (item) => item.targetId,
          getItemLabel: (item) => item.displayName,
          getItemSubtitle: (item) => item.description,
          getItemIconUrl: (item) => item.iconUrl,
          toInsertResult(item) {
            const description =
              item.description === item.displayName ? "" : item.description;
            return createDesktopRichTextMentionInsertResult({
              entityId: item.targetId,
              label: item.displayName,
              scope: compactStringRecord({ workspaceId: item.workspaceId }),
              presentation: compactMentionPresentation({
                agentProviderId: item.provider,
                description,
                iconUrl: item.iconUrl,
                subtitle: description
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            if (!workspaceId) return null;
            return resolveMentionSafely(async () => {
              const response = await contributorInput.agentsService?.load();
              if (!response) return null;
              const item = agentTargetAtItemsFromTargets({
                agentProviderStatuses:
                  contributorInput.agentProviderStatuses?.(),
                isTuttiAgentSwitchEnabled:
                  contributorInput.isTuttiAgentSwitchEnabled,
                keyword: "",
                targets: response.agentTargets,
                workspaceId
              }).find((target) => target.targetId === identity.entityId);
              if (!item) return null;
              const description =
                item.description === item.displayName ? "" : item.description;
              return {
                label: item.displayName,
                presentation: compactMentionPresentation({
                  agentProviderId: item.provider,
                  description,
                  iconUrl: item.iconUrl,
                  subtitle: description
                })
              };
            });
          }
        })
      ];
    }
  };
}

export function createAgentSessionAtContributor(contributorInput: {
  agentsService?: Pick<IAgentsService, "load">;
  tuttidClient: TuttidClient;
}): DesktopRichTextAtContributor {
  return {
    capability: "agent-session",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<AgentSessionAtItem>({
          id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.agentSession,
          trigger: "@",
          async query(searchInput) {
            if (searchInput.abortSignal?.aborted) return [];
            const currentUserId = metadataString(
              searchInput.context.metadata,
              "currentUserId"
            );
            const provenanceFilter = metadataReferenceProvenanceFilter(
              searchInput.context.metadata
            );
            const agentTargetIds = provenanceFilter?.agentTargetIds ?? null;
            if (agentTargetIds?.length === 0) return [];
            const [response, agentDirectory] = await Promise.all([
              listAgentSessionsByProvenance({
                agentTargetIds,
                client: contributorInput.tuttidClient,
                limit: searchInput.maxResults,
                searchQuery: searchInput.keyword.trim(),
                workspaceId: input.workspaceId
              }),
              contributorInput.agentsService?.load(searchInput.abortSignal) ??
                null
            ]);
            if (searchInput.abortSignal?.aborted) return [];
            return response.sessions.map((session) => {
              const agentTarget = resolveSessionAgentTarget(
                session.agentTargetId,
                agentDirectory?.agentTargets
              );
              return {
                ...(agentTarget?.iconUrl
                  ? { agentIconUrl: agentTarget.iconUrl }
                  : {}),
                agentName:
                  agentTarget?.name ??
                  resolveAgentSessionProviderLabel(session.provider),
                ...(session.agentTargetId?.trim()
                  ? { agentTargetId: session.agentTargetId.trim() }
                  : {}),
                createdAtUnixMs: session.createdAtUnixMs,
                id: session.id,
                initiatorName: "local",
                provider: session.provider,
                scope: resolveAgentSessionScope(currentUserId, "local"),
                sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
                status: workspaceAgentSessionStatus(session),
                title: session.title,
                updatedAtUnixMs: session.updatedAtUnixMs,
                userId: "local",
                workspaceId: response.workspaceId || input.workspaceId
              };
            });
          },
          getItemKey: (item) => item.id,
          getItemLabel: resolveAgentSessionLabel,
          getItemSubtitle: (item) =>
            [item.provider, item.status]
              .map((value) => value?.trim() ?? "")
              .filter(Boolean)
              .join(" · "),
          toInsertResult(item) {
            return createDesktopRichTextMentionInsertResult({
              entityId: item.id,
              label: resolveAgentSessionLabel(item),
              scope: compactStringRecord({
                scope: item.scope,
                userId: item.userId,
                workspaceId: item.workspaceId
              }),
              presentation: compactMentionPresentation({
                agentProviderId: item.provider?.trim() ?? "",
                iconUrl: item.agentIconUrl?.trim() ?? "",
                participant: [item.initiatorName, item.agentName]
                  .map((value) => value?.trim() ?? "")
                  .filter(Boolean)
                  .join(" & "),
                status: item.status?.trim() ?? "",
                subtitle: item.agentName?.trim() ?? ""
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            if (!workspaceId) return null;
            return resolveMentionSafely(async () => {
              const [session, agentDirectory] = await Promise.all([
                contributorInput.tuttidClient.getWorkspaceAgentSession(
                  workspaceId,
                  identity.entityId
                ),
                contributorInput.agentsService?.load() ?? null
              ]);
              const agentTarget = resolveSessionAgentTarget(
                session.agentTargetId,
                agentDirectory?.agentTargets
              );
              return {
                label: resolveAgentSessionLabel({
                  id: session.id,
                  provider: session.provider,
                  title: session.title,
                  workspaceId
                }),
                presentation: compactMentionPresentation({
                  agentProviderId: session.provider,
                  iconUrl: agentTarget?.iconUrl ?? "",
                  status: workspaceAgentSessionStatus(session),
                  subtitle:
                    agentTarget?.name ??
                    resolveAgentSessionProviderLabel(session.provider)
                })
              };
            });
          }
        })
      ];
    }
  };
}

function resolveSessionAgentTarget(
  agentTargetId: string | null | undefined,
  targets: readonly AgentTargetPresentation[] | undefined
): Pick<AgentTargetPresentation, "iconUrl" | "name"> | null {
  const targetId = agentTargetId?.trim() ?? "";
  if (!targetId) {
    return null;
  }
  return (
    targets?.find((target) => target.agentTargetId.trim() === targetId) ?? null
  );
}

function agentTargetAtItemsFromTargets(input: {
  agentProviderStatuses?: readonly AgentProviderStatus[];
  isTuttiAgentSwitchEnabled?: () => boolean;
  keyword: string;
  maxResults?: number;
  targets: readonly AgentTargetPresentation[];
  workspaceId: string;
}): AgentTargetAtItem[] {
  const keyword = input.keyword.trim().toLowerCase();
  const items = input.targets
    .filter((target) => target.enabled)
    .map((target): AgentTargetAtItem | null => {
      const identity = resolveAgentGUIProviderCatalogIdentity(target.provider);
      const provider = target.provider.trim() as WorkspaceAgentProvider;
      if (!provider) return null;
      if (
        identity?.desktop.visibilityGate === "tutti_agent" &&
        input.isTuttiAgentSwitchEnabled?.() !== true
      ) {
        return null;
      }
      if (target.availability.status !== "ready") {
        return null;
      }
      if (
        identity &&
        input.agentProviderStatuses !== undefined &&
        !input.agentProviderStatuses.some(
          (status) =>
            status.provider === provider &&
            status.availability.status === "ready"
        )
      ) {
        return null;
      }
      const targetId = target.agentTargetId.trim();
      if (!targetId) return null;
      const label =
        normalizeText(target.name) ??
        resolveAgentSessionProviderLabel(provider);
      return {
        description: normalizeText(target.name) ?? label,
        displayName: label,
        iconUrl: target.iconUrl,
        provider,
        sortOrder: target.sortOrder,
        targetId,
        workspaceId: input.workspaceId
      };
    })
    .filter((item): item is AgentTargetAtItem => item !== null)
    .filter((item) =>
      !keyword
        ? true
        : [item.targetId, item.provider, item.displayName, item.description]
            .join("\n")
            .toLowerCase()
            .includes(keyword)
    )
    .sort((left, right) => {
      return (
        left.sortOrder - right.sortOrder ||
        left.displayName.localeCompare(right.displayName, undefined, {
          sensitivity: "base"
        }) ||
        left.targetId.localeCompare(right.targetId)
      );
    });
  return input.maxResults === undefined
    ? items
    : items.slice(0, Math.max(0, input.maxResults));
}

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function metadataReferenceProvenanceFilter(
  metadata: Readonly<Record<string, unknown>> | undefined
): ReferenceProvenanceFilter | null {
  const value = metadata?.referenceProvenanceFilter;
  if (!value || typeof value !== "object") return null;
  const filter = value as Partial<ReferenceProvenanceFilter>;
  return {
    agentTargetIds: stringArrayOrNull(filter.agentTargetIds),
    memberIds: stringArrayOrNull(filter.memberIds)
  };
}

function stringArrayOrNull(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

async function listAgentSessionsByProvenance(input: {
  agentTargetIds: readonly string[] | null;
  client: TuttidClient;
  limit?: number;
  searchQuery: string;
  workspaceId: string;
}): Promise<Awaited<ReturnType<TuttidClient["listWorkspaceAgentSessions"]>>> {
  if (input.agentTargetIds === null) {
    return input.client.listWorkspaceAgentSessions(input.workspaceId, {
      limit: input.limit,
      searchQuery: input.searchQuery
    });
  }
  const responses = await Promise.all(
    input.agentTargetIds.map((agentTargetId) =>
      input.client.listWorkspaceAgentSessions(input.workspaceId, {
        agentTargetId,
        limit: input.limit,
        searchQuery: input.searchQuery
      })
    )
  );
  const sessionsById = new Map(
    responses
      .flatMap((response) => response.sessions)
      .map((session) => [session.id, session] as const)
  );
  const sessions = [...sessionsById.values()]
    .sort(
      (left, right) =>
        (right.updatedAtUnixMs ?? right.createdAtUnixMs ?? 0) -
        (left.updatedAtUnixMs ?? left.createdAtUnixMs ?? 0)
    )
    .slice(0, input.limit && input.limit > 0 ? input.limit : undefined);
  return {
    ...responses[0],
    hasMore: responses.some((response) => response.hasMore),
    workspaceId: responses[0]?.workspaceId || input.workspaceId,
    sessions
  };
}

function resolveAgentSessionScope(
  currentUserId: string,
  userId: string
): NonNullable<AgentSessionAtItem["scope"]> {
  const current = currentUserId.trim();
  const user = userId.trim();
  if (!current || !user || current === "local" || user === "local") {
    return "my_sessions";
  }
  return current === user ? "my_sessions" : "collab_sessions";
}

function resolveAgentSessionLabel(item: AgentSessionAtItem): string {
  const title = item.title?.trim() ?? "";
  if (title) return title;
  const provider = item.provider?.trim();
  return provider ? `${provider} session` : item.id;
}

function resolveAgentSessionProviderLabel(provider?: string | null): string {
  const normalized = provider?.trim() ?? "";
  return resolveAgentGUIProviderIdentity(normalized)?.displayName ?? normalized;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
