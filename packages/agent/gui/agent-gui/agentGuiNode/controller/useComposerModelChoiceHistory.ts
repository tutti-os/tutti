import { useCallback, useMemo, useReducer } from "react";
import type { AgentGUIComposerModelChoiceHistoryVM } from "../model/agentGuiNodeTypes";
import {
  MAX_RECENT_COMPOSER_MODELS,
  composerModelFavoritesStorageKey,
  composerModelRecentsStorageKey,
  normalizeComposerModelHistoryTargetId,
  parseComposerModelIdList,
  reconcileRecentComposerModels,
  recordRecentComposerModel,
  sanitizeComposerModelIdList,
  serializeComposerModelIdList,
  toggleFavoriteComposerModel,
  type ComposerModelHistoryVerdict
} from "../model/composerModelChoiceHistory";
import { verifyComposerModelAgainstNativeOptions } from "./agentGuiController.composerPresentation";

const EMPTY_MODEL_IDS: readonly string[] = [];
const LEGACY_MODEL_HISTORY_TARGET_ID = "default";

export interface ComposerModelChoiceHistoryController {
  enabled: boolean;
  favoriteModelIds: readonly string[];
  recentModelIds: readonly string[];
  recordRecentModel: (modelId: string) => void;
  refreshFromStorage: () => void;
  toggleFavoriteModel: (modelId: string) => void;
}

/**
 * Owns browser-local model menu history. The exact Agent Target scopes all
 * reads and writes; unresolved identity disables history rather than falling
 * back to the legacy shared bucket.
 */
export function useComposerModelChoiceHistory(
  input: AgentGUIComposerModelChoiceHistoryVM | null | undefined
): ComposerModelChoiceHistoryController {
  const targetId = normalizeComposerModelHistoryTargetId(input?.targetId);
  const catalog = input?.catalog ?? null;
  const [revision, bumpRevision] = useReducer((value: number) => value + 1, 0);
  const favoriteModelIds = useMemo(
    () =>
      targetId
        ? readModelIds(composerModelFavoritesStorageKey(targetId))
        : EMPTY_MODEL_IDS,
    [revision, targetId]
  );
  const storedRecentModelIds = useMemo(
    () =>
      targetId
        ? readModelIds(composerModelRecentsStorageKey(targetId))
        : EMPTY_MODEL_IDS,
    [revision, targetId]
  );
  const recentModelIds = useMemo(
    () => reconcileForCatalog(storedRecentModelIds, catalog),
    [catalog, storedRecentModelIds]
  );

  const refreshFromStorage = useCallback((): void => {
    if (targetId) {
      const storage = browserLocalStorage();
      if (storage) {
        migrateLegacyFavorites(storage, targetId);
        migrateLegacyRecents(storage, targetId, catalog);
        reconcileStoredRecents(storage, targetId, catalog);
      }
    }
    bumpRevision();
  }, [catalog, targetId]);

  const recordRecentModel = useCallback(
    (modelId: string): void => {
      if (!targetId) {
        return;
      }
      const current = reconcileForCatalog(
        readModelIds(composerModelRecentsStorageKey(targetId)),
        catalog
      );
      writeModelIds(
        composerModelRecentsStorageKey(targetId),
        recordRecentComposerModel(current, modelId)
      );
      refreshFromStorage();
    },
    [catalog, refreshFromStorage, targetId]
  );
  const toggleFavoriteModel = useCallback(
    (modelId: string): void => {
      if (!targetId) {
        return;
      }
      const key = composerModelFavoritesStorageKey(targetId);
      writeModelIds(
        key,
        toggleFavoriteComposerModel(readModelIds(key), modelId)
      );
      refreshFromStorage();
    },
    [refreshFromStorage, targetId]
  );

  return {
    enabled: targetId !== null,
    favoriteModelIds,
    recentModelIds,
    recordRecentModel,
    refreshFromStorage,
    toggleFavoriteModel
  };
}

function verdictForCatalog(
  catalog: AgentGUIComposerModelChoiceHistoryVM["catalog"],
  modelId: string
): ComposerModelHistoryVerdict {
  if (!catalog?.authoritative) {
    return "unverifiable";
  }
  return verifyComposerModelAgainstNativeOptions(modelId, {
    models: catalog.models,
    modelOptionsLoading: catalog.loading,
    effectiveSettings: { model: catalog.effectiveModel }
  });
}

function reconcileForCatalog(
  recentModelIds: readonly string[],
  catalog: AgentGUIComposerModelChoiceHistoryVM["catalog"]
): readonly string[] {
  return reconcileRecentComposerModels(recentModelIds, (modelId) =>
    verdictForCatalog(catalog, modelId)
  );
}

function migrateLegacyFavorites(storage: Storage, targetId: string): boolean {
  if (targetId === LEGACY_MODEL_HISTORY_TARGET_ID) {
    return false;
  }
  const legacyKey = composerModelFavoritesStorageKey(
    LEGACY_MODEL_HISTORY_TARGET_ID
  );
  const legacyRaw = safeStorageRead(storage, legacyKey);
  if (legacyRaw === null) {
    return false;
  }
  const targetKey = composerModelFavoritesStorageKey(targetId);
  writeModelIdsToStorage(
    storage,
    targetKey,
    mergeModelIds(
      readModelIdsFromStorage(storage, targetKey),
      parseComposerModelIdList(legacyRaw)
    )
  );
  safeStorageRemove(storage, legacyKey);
  return true;
}

function migrateLegacyRecents(
  storage: Storage,
  targetId: string,
  catalog: AgentGUIComposerModelChoiceHistoryVM["catalog"]
): boolean {
  if (targetId === LEGACY_MODEL_HISTORY_TARGET_ID) {
    return false;
  }
  const legacyKey = composerModelRecentsStorageKey(
    LEGACY_MODEL_HISTORY_TARGET_ID
  );
  const legacyRaw = safeStorageRead(storage, legacyKey);
  if (legacyRaw === null) {
    return false;
  }
  const legacyIds = parseComposerModelIdList(legacyRaw);
  if (!catalog?.authoritative) {
    return false;
  }
  const verdicts = legacyIds.map((modelId) =>
    verdictForCatalog(catalog, modelId)
  );
  if (verdicts.some((verdict) => verdict === "unverifiable")) {
    return false;
  }
  const targetKey = composerModelRecentsStorageKey(targetId);
  const migratedIds = legacyIds.filter(
    (_modelId, index) => verdicts[index] !== "rejected"
  );
  writeModelIdsToStorage(
    storage,
    targetKey,
    mergeModelIds(
      readModelIdsFromStorage(storage, targetKey),
      migratedIds
    ).slice(0, MAX_RECENT_COMPOSER_MODELS)
  );
  safeStorageRemove(storage, legacyKey);
  return true;
}

function reconcileStoredRecents(
  storage: Storage,
  targetId: string,
  catalog: AgentGUIComposerModelChoiceHistoryVM["catalog"]
): boolean {
  if (!catalog?.authoritative) {
    return false;
  }
  const key = composerModelRecentsStorageKey(targetId);
  const raw = safeStorageRead(storage, key);
  if (raw === null) {
    return false;
  }
  const current = parseComposerModelIdList(raw);
  const next = reconcileForCatalog(current, catalog);
  if (sameModelIds(current, next) && next.length > 0) {
    return false;
  }
  writeModelIdsToStorage(storage, key, next);
  return true;
}

function mergeModelIds(
  primary: readonly string[],
  secondary: readonly string[]
): readonly string[] {
  return sanitizeComposerModelIdList([...primary, ...secondary]);
}

function sameModelIds(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((modelId, index) => modelId === right[index])
  );
}

function browserLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readModelIds(key: string): readonly string[] {
  const storage = browserLocalStorage();
  return storage ? readModelIdsFromStorage(storage, key) : EMPTY_MODEL_IDS;
}

function readModelIdsFromStorage(
  storage: Storage,
  key: string
): readonly string[] {
  return parseComposerModelIdList(safeStorageRead(storage, key));
}

function writeModelIds(key: string, modelIds: readonly string[]): void {
  const storage = browserLocalStorage();
  if (storage) {
    writeModelIdsToStorage(storage, key, modelIds);
  }
}

function writeModelIdsToStorage(
  storage: Storage,
  key: string,
  modelIds: readonly string[]
): void {
  const sanitized = sanitizeComposerModelIdList(modelIds);
  if (sanitized.length === 0) {
    safeStorageRemove(storage, key);
    return;
  }
  try {
    storage.setItem(key, serializeComposerModelIdList(sanitized));
  } catch {
    // Browser-local chrome persistence is best-effort.
    return;
  }
}

function safeStorageRead(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Browser-local chrome persistence is best-effort.
    return;
  }
}
