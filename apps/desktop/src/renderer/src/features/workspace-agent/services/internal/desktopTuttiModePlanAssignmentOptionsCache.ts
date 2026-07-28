import type {
  AgentTarget,
  TuttidClient,
  WorkspaceAgent
} from "@tutti-os/client-tuttid-ts";
import type {
  TuttiModePlanAssignmentAgentDetail,
  TuttiModePlanAssignmentAgentOption,
  TuttiModePlanAssignmentOptionsSource
} from "@tutti-os/agent-gui";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import {
  createWorkspaceQueryCache,
  type WorkspaceQueryCache
} from "@tutti-os/agent-gui/workspace-query-cache";

type AssignmentOptionsTuttidClient = Pick<
  TuttidClient,
  | "listAgentTargets"
  | "listWorkspaceAgents"
  | "getAgentProviderComposerOptions"
  | "listModelPlans"
>;

interface AssignmentAgentDirectoryEntry {
  agentTargetId: string;
  label: string;
  provider: string;
}

interface AssignmentOptionsCacheIdentity {
  agentTargetId: string;
  cacheKey: string;
  provider: string;
  workspaceId: string;
}

export interface DesktopTuttiModePlanAssignmentOptionsCache {
  source: TuttiModePlanAssignmentOptionsSource;
  invalidateAgentTargets(
    workspaceId: string,
    agentTargetIds: readonly string[]
  ): readonly string[];
  invalidateProviders(
    workspaceId: string,
    providers: readonly string[]
  ): readonly string[];
}

const ASSIGNMENT_OPTIONS_CACHE_FRESH_MS = 5 * 60_000;
const EMPTY_ASSIGNMENT_AGENT_DETAIL: TuttiModePlanAssignmentAgentDetail = {
  models: [],
  modelPlans: [],
  permissionModes: [],
  reasoningEfforts: []
};
const SUPERSEDED_ASSIGNMENT_OPTIONS_LOAD = Symbol(
  "superseded-assignment-options-load"
);

function workspaceAgentIsSelectable(agent: WorkspaceAgent): boolean {
  return (
    agent.harness.available &&
    agent.harness.enabled !== false &&
    Boolean(agent.harness.provider)
  );
}

function normalizedCachePart(value: string): string {
  return value.trim();
}

function directoryCacheKey(workspaceId: string): string {
  return JSON.stringify([normalizedCachePart(workspaceId)]);
}

function assignmentOptionsCacheKey(input: {
  workspaceId: string;
  agentTargetId: string;
  provider: string;
}): string {
  return JSON.stringify([
    normalizedCachePart(input.workspaceId),
    normalizedCachePart(input.agentTargetId),
    normalizedCachePart(input.provider)
  ]);
}

function cacheEntryIsFresh(
  resolvedAtUnixMs: number,
  stale: boolean,
  now: () => number
): boolean {
  return (
    !stale && now() - resolvedAtUnixMs <= ASSIGNMENT_OPTIONS_CACHE_FRESH_MS
  );
}

async function requestCachedValue<TValue>(input: {
  cache: WorkspaceQueryCache<TValue>;
  cacheKey: string;
  generations: Map<string, number>;
  load: () => Promise<TValue>;
  now: () => number;
}): Promise<TValue> {
  const cached = input.cache.read(input.cacheKey);
  if (
    cached &&
    cacheEntryIsFresh(cached.resolvedAtUnixMs, cached.stale, input.now)
  ) {
    return cached.value;
  }
  const generation = input.generations.get(input.cacheKey) ?? 0;
  try {
    const resolved = await input.cache.request(input.cacheKey, async () => {
      const value = await input.load();
      if ((input.generations.get(input.cacheKey) ?? 0) !== generation) {
        throw SUPERSEDED_ASSIGNMENT_OPTIONS_LOAD;
      }
      return value;
    });
    return resolved.value;
  } catch (error) {
    if (error === SUPERSEDED_ASSIGNMENT_OPTIONS_LOAD) {
      return requestCachedValue(input);
    }
    throw error;
  }
}

function invalidateCachedValue<TValue>(input: {
  cache: WorkspaceQueryCache<TValue>;
  cacheKey: string;
  generations: Map<string, number>;
}): void {
  input.generations.set(
    input.cacheKey,
    (input.generations.get(input.cacheKey) ?? 0) + 1
  );
  input.cache.invalidate(input.cacheKey);
}

export function createDesktopTuttiModePlanAssignmentOptionsCache(
  tuttidClient: AssignmentOptionsTuttidClient,
  now: () => number = Date.now
): DesktopTuttiModePlanAssignmentOptionsCache {
  const directoryCache = createWorkspaceQueryCache<
    readonly AssignmentAgentDirectoryEntry[]
  >({
    maxEntries: 24,
    now
  });
  const detailCache =
    createWorkspaceQueryCache<TuttiModePlanAssignmentAgentDetail>({
      maxEntries: 96,
      now
    });
  const directoryGenerations = new Map<string, number>();
  const detailGenerations = new Map<string, number>();
  const detailIdentityByWorkspaceTarget = new Map<
    string,
    AssignmentOptionsCacheIdentity
  >();

  const loadDirectory = (
    workspaceId: string
  ): Promise<readonly AssignmentAgentDirectoryEntry[]> => {
    const normalizedWorkspaceId = normalizedCachePart(workspaceId);
    const cacheKey = directoryCacheKey(normalizedWorkspaceId);
    return requestCachedValue({
      cache: directoryCache,
      cacheKey,
      generations: directoryGenerations,
      now,
      load: async () => {
        // Built-in Harness targets and workspace Agents coexist in the
        // assignment directory, mirroring the AgentGUI rail: built-ins keep
        // their placement and workspace Agents are appended, deduped by
        // agentTargetId.
        const [targetResponse, workspaceAgentResponse] = await Promise.all([
          tuttidClient.listAgentTargets(),
          tuttidClient.listWorkspaceAgents(normalizedWorkspaceId)
        ]);
        const entries: AssignmentAgentDirectoryEntry[] = [];
        const seen = new Set<string>();
        for (const target of targetResponse.targets) {
          if (!target.enabled || seen.has(target.id)) continue;
          seen.add(target.id);
          entries.push({
            agentTargetId: target.id,
            label: target.name,
            provider: target.provider
          });
        }
        for (const agent of workspaceAgentResponse.agents) {
          if (!workspaceAgentIsSelectable(agent) || seen.has(agent.id)) {
            continue;
          }
          seen.add(agent.id);
          entries.push({
            agentTargetId: agent.id,
            label: agent.name,
            provider: agent.harness.provider ?? ""
          });
        }
        return entries;
      }
    });
  };

  const source: TuttiModePlanAssignmentOptionsSource = {
    readAgents({ workspaceId }) {
      const cached = directoryCache.read(directoryCacheKey(workspaceId));
      return cached
        ? cached.value.map((entry) => ({
            agentTargetId: entry.agentTargetId,
            label: entry.label
          }))
        : null;
    },

    async listAgents({
      workspaceId
    }): Promise<readonly TuttiModePlanAssignmentAgentOption[]> {
      const entries = await loadDirectory(workspaceId);
      return entries.map((entry) => ({
        agentTargetId: entry.agentTargetId,
        label: entry.label
      }));
    },

    readAgentOptions({ workspaceId, agentTargetId }) {
      const identity = detailIdentityByWorkspaceTarget.get(
        JSON.stringify([
          normalizedCachePart(workspaceId),
          normalizedCachePart(agentTargetId)
        ])
      );
      return identity
        ? (detailCache.read(identity.cacheKey)?.value ?? null)
        : null;
    },

    async loadAgentOptions({
      workspaceId,
      agentTargetId
    }): Promise<TuttiModePlanAssignmentAgentDetail> {
      const normalizedWorkspaceId = normalizedCachePart(workspaceId);
      const normalizedAgentTargetId = normalizedCachePart(agentTargetId);
      const entries = await loadDirectory(normalizedWorkspaceId);
      const entry = entries.find(
        (candidate) => candidate.agentTargetId === normalizedAgentTargetId
      );
      if (!entry || !entry.provider) {
        return EMPTY_ASSIGNMENT_AGENT_DETAIL;
      }
      const cacheKey = assignmentOptionsCacheKey({
        workspaceId: normalizedWorkspaceId,
        agentTargetId: normalizedAgentTargetId,
        provider: entry.provider
      });
      detailIdentityByWorkspaceTarget.set(
        JSON.stringify([normalizedWorkspaceId, normalizedAgentTargetId]),
        {
          agentTargetId: normalizedAgentTargetId,
          cacheKey,
          provider: normalizedCachePart(entry.provider),
          workspaceId: normalizedWorkspaceId
        }
      );
      return requestCachedValue({
        cache: detailCache,
        cacheKey,
        generations: detailGenerations,
        now,
        load: async () => {
          const [composerOptions, plans] = await Promise.all([
            tuttidClient.getAgentProviderComposerOptions(
              entry.provider as AgentTarget["provider"],
              { agentTargetId: normalizedAgentTargetId }
            ),
            tuttidClient.listModelPlans(normalizedWorkspaceId).catch(() => null)
          ]);
          const planProtocol =
            resolveAgentGUIProviderCatalogIdentity(entry.provider)
              ?.modelPlanProtocol || null;
          const compatiblePlans = (plans?.plans ?? []).filter(
            (plan) =>
              plan.enabled &&
              plan.status === "ready" &&
              planProtocol !== null &&
              plan.protocol === planProtocol
          );
          return {
            models: composerOptions.modelConfig.options.map(
              (option) => option.value
            ),
            modelPlans: compatiblePlans.map((plan) => ({
              modelPlanId: plan.id,
              label: plan.name,
              models: plan.models.map((model) => model.id)
            })),
            permissionModes: composerOptions.permissionConfig.modes.map(
              (mode) => ({
                id: mode.id,
                label: mode.label
              })
            ),
            reasoningEfforts: composerOptions.reasoningConfig.options.map(
              (option) => option.value
            )
          };
        }
      });
    }
  };

  const invalidateIdentities = (
    predicate: (identity: AssignmentOptionsCacheIdentity) => boolean
  ): readonly string[] => {
    const affectedAgentTargetIds = new Set<string>();
    for (const identity of detailIdentityByWorkspaceTarget.values()) {
      if (!predicate(identity)) continue;
      affectedAgentTargetIds.add(identity.agentTargetId);
      invalidateCachedValue({
        cache: detailCache,
        cacheKey: identity.cacheKey,
        generations: detailGenerations
      });
    }
    return [...affectedAgentTargetIds];
  };

  return {
    source,
    invalidateAgentTargets(workspaceId, agentTargetIds) {
      const normalizedWorkspaceId = normalizedCachePart(workspaceId);
      const normalizedAgentTargetIds = new Set(
        agentTargetIds.map(normalizedCachePart).filter(Boolean)
      );
      return invalidateIdentities(
        (identity) =>
          identity.workspaceId === normalizedWorkspaceId &&
          normalizedAgentTargetIds.has(identity.agentTargetId)
      );
    },
    invalidateProviders(workspaceId, providers) {
      const normalizedWorkspaceId = normalizedCachePart(workspaceId);
      const normalizedProviders = new Set(
        providers.map(normalizedCachePart).filter(Boolean)
      );
      return invalidateIdentities(
        (identity) =>
          identity.workspaceId === normalizedWorkspaceId &&
          normalizedProviders.has(identity.provider)
      );
    }
  };
}
