import type { AgentActivityAdapter } from "./adapter.ts";
import { createComposerOptionsCacheCoordinator } from "./composerOptionsCache.ts";
import {
  areComposerOptionsEqual,
  cloneAgentActivityComposerOptions
} from "./controllerSnapshot.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivityComposerSettings,
  AgentActivitySnapshot
} from "./types.ts";

export interface AgentActivityLoadComposerOptionsControllerInput {
  /** Opaque directory target identity; activity-core never parses it. */
  targetKey: string;
  provider: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
  signal?: AbortSignal;
  force?: boolean;
}

export interface AgentActivityComposerOptionsController {
  load(
    input: AgentActivityLoadComposerOptionsControllerInput
  ): Promise<AgentActivityComposerOptions>;
  invalidate(input?: { providers?: readonly string[] }): void;
}

export function createAgentActivityComposerOptionsController(input: {
  adapter: AgentActivityAdapter;
  getSnapshot: () => AgentActivitySnapshot;
  updateSnapshot: (
    updater: (current: AgentActivitySnapshot) => AgentActivitySnapshot
  ) => AgentActivitySnapshot;
  workspaceId: string;
}): AgentActivityComposerOptionsController {
  const cache = createComposerOptionsCacheCoordinator();
  const providerByCacheKey = new Map<string, string>();

  async function load(
    request: AgentActivityLoadComposerOptionsControllerInput
  ): Promise<AgentActivityComposerOptions> {
    const provider = request.provider.trim();
    if (!provider) {
      throw new Error("Agent composer options provider is required.");
    }
    const targetKey = request.targetKey.trim();
    if (!targetKey) {
      throw new Error("Agent composer options targetKey is required.");
    }
    const primaryCacheKey = cache.cacheKey(targetKey);
    providerByCacheKey.set(primaryCacheKey, provider);
    const requestSignature = cache.requestSignature(request);
    if (!request.force) {
      const snapshot = input.getSnapshot();
      const cached = snapshot.composerOptionsByTargetKey?.[targetKey];
      if (cached && cache.settledMatches(primaryCacheKey, requestSignature)) {
        return cloneAgentActivityComposerOptions(cached);
      }
    }
    const existingLoad = request.force
      ? null
      : cache.activeLoad(primaryCacheKey, requestSignature);
    if (existingLoad) {
      return existingLoad.then(cloneAgentActivityComposerOptions);
    }
    const loadVersion = cache.nextLoadVersion(primaryCacheKey);
    input.updateSnapshot((current) => {
      if (
        current.composerOptionsLoadStatusByTargetKey?.[targetKey] === "loading"
      ) {
        return current;
      }
      return {
        ...current,
        composerOptionsLoadStatusByTargetKey: {
          ...current.composerOptionsLoadStatusByTargetKey,
          [targetKey]: "loading"
        }
      };
    });
    const pending = Promise.resolve()
      .then(() =>
        input.adapter.loadComposerOptions({
          agentTargetId: targetKey,
          workspaceId: input.workspaceId,
          provider,
          cwd: request.cwd,
          settings: request.settings,
          signal: request.signal
        })
      )
      .then((options) => {
        const normalized = cloneAgentActivityComposerOptions({
          ...options,
          provider,
          loadedAtUnixMs: options.loadedAtUnixMs || Date.now()
        });
        if (!cache.isLatest(primaryCacheKey, loadVersion)) {
          return cloneAgentActivityComposerOptions(normalized);
        }
        cache.markSettled(primaryCacheKey, requestSignature);
        input.updateSnapshot((current) => {
          const currentOptions =
            current.composerOptionsByTargetKey?.[targetKey];
          const optionsUnchanged = Boolean(
            currentOptions &&
            areComposerOptionsEqual(currentOptions, normalized)
          );
          if (
            optionsUnchanged &&
            current.composerOptionsLoadStatusByTargetKey?.[targetKey] ===
              "ready"
          ) {
            return current;
          }
          return {
            ...current,
            composerOptionsByTargetKey: {
              ...current.composerOptionsByTargetKey,
              [targetKey]:
                optionsUnchanged && currentOptions ? currentOptions : normalized
            },
            composerOptionsLoadStatusByTargetKey: {
              ...current.composerOptionsLoadStatusByTargetKey,
              [targetKey]: "ready"
            }
          };
        });
        return cloneAgentActivityComposerOptions(normalized);
      })
      .catch((error: unknown) => {
        if (cache.isLatest(primaryCacheKey, loadVersion)) {
          input.updateSnapshot((current) => ({
            ...current,
            composerOptionsLoadStatusByTargetKey: {
              ...current.composerOptionsLoadStatusByTargetKey,
              [targetKey]: "error"
            }
          }));
        }
        throw error;
      })
      .finally(() => cache.finishActive(primaryCacheKey, pending));
    cache.markActive(primaryCacheKey, requestSignature, pending);
    return pending.then(cloneAgentActivityComposerOptions);
  }

  function invalidate(request?: { providers?: readonly string[] }): void {
    const providers = request?.providers?.length
      ? new Set(request.providers)
      : null;
    const matches = (provider: string | null | undefined): boolean =>
      providers === null || (!!provider && providers.has(provider));
    const staleKeys = new Set<string>();
    const snapshot = input.getSnapshot();
    for (const [targetKey, options] of Object.entries(
      snapshot.composerOptionsByTargetKey ?? {}
    )) {
      if (matches(options?.provider)) {
        staleKeys.add(cache.cacheKey(targetKey));
      }
    }
    for (const cacheKey of cache.settledCacheKeys()) {
      if (matches(providerByCacheKey.get(cacheKey))) {
        staleKeys.add(cacheKey);
      }
    }
    for (const cacheKey of staleKeys) cache.invalidate(cacheKey);
  }

  return { load, invalidate };
}
