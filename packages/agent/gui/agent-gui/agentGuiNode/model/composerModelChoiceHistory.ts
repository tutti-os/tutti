/**
 * UI-local chrome state for the composer model menu: per-agent-target recent
 * model picks and favorite toggles, persisted in browser localStorage (same
 * pattern as agent rail ordering). This never enters controller state, session
 * state, or durable AgentGUI node data.
 */

const COMPOSER_MODEL_RECENTS_STORAGE_PREFIX =
  "agent-gui:composer-model-recents:";
const COMPOSER_MODEL_FAVORITES_STORAGE_PREFIX =
  "agent-gui:composer-model-favorites:";

export const MAX_RECENT_COMPOSER_MODELS = 5;

export function composerModelRecentsStorageKey(
  agentTargetId: string | null | undefined
): string {
  return `${COMPOSER_MODEL_RECENTS_STORAGE_PREFIX}${normalizeTargetId(agentTargetId)}`;
}

export function composerModelFavoritesStorageKey(
  agentTargetId: string | null | undefined
): string {
  return `${COMPOSER_MODEL_FAVORITES_STORAGE_PREFIX}${normalizeTargetId(agentTargetId)}`;
}

export function parseComposerModelIdList(
  rawValue: string | null | undefined
): readonly string[] {
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return sanitizeComposerModelIdList(parsed);
  } catch {
    return [];
  }
}

export function serializeComposerModelIdList(
  modelIds: readonly string[]
): string {
  return JSON.stringify(sanitizeComposerModelIdList(modelIds));
}

export function sanitizeComposerModelIdList(
  modelIds: readonly unknown[]
): readonly string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const value of modelIds) {
    if (typeof value !== "string") {
      continue;
    }
    const modelId = value.trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    sanitized.push(modelId);
  }
  return sanitized;
}

/** Most-recent-first, deduplicated, capped at MAX_RECENT_COMPOSER_MODELS. */
export function recordRecentComposerModel(
  currentRecentIds: readonly string[],
  modelId: string
): readonly string[] {
  const normalized = modelId.trim();
  if (!normalized) {
    return sanitizeComposerModelIdList(currentRecentIds);
  }
  return sanitizeComposerModelIdList([normalized, ...currentRecentIds]).slice(
    0,
    MAX_RECENT_COMPOSER_MODELS
  );
}

export function toggleFavoriteComposerModel(
  currentFavoriteIds: readonly string[],
  modelId: string
): readonly string[] {
  const normalized = modelId.trim();
  const sanitized = sanitizeComposerModelIdList(currentFavoriteIds);
  if (!normalized) {
    return sanitized;
  }
  if (sanitized.includes(normalized)) {
    return sanitized.filter((value) => value !== normalized);
  }
  return [...sanitized, normalized];
}

function normalizeTargetId(agentTargetId: string | null | undefined): string {
  return agentTargetId?.trim() || "default";
}
