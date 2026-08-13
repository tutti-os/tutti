import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  captureWorkbenchNodePreviewImage,
  readCachedWorkbenchNodePreviewImage,
  writeCachedWorkbenchNodePreviewImage
} from "../react/useWorkbenchGenieAnimation.tsx";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey,
  WorkbenchDockPreviewCacheKeyResolver
} from "../react/dockPreviewCache.ts";
import type {
  WorkbenchDockPreviewContent,
  WorkbenchHostNodeData,
  WorkbenchHostProps
} from "./types.ts";
import type { WorkbenchHostDockPopupItem } from "./WorkbenchHostDockPopup.tsx";

const dockPopupPreviewCacheMaxEntries = 64;
const dockPopupPreviewByMemoryKey = new Map<
  string,
  WorkbenchHostDockPopupCapturedPreview
>();
const pendingDockPopupPreviewCaptureKeys = new Set<string>();

export type WorkbenchHostDockPopupCapturedPreview = {
  preview: WorkbenchDockPreviewContent | null;
  revision: string | null;
};

export type WorkbenchHostDockPopupPreviewState =
  | {
      preview: WorkbenchDockPreviewContent;
      status: "ready";
    }
  | {
      status: "loading";
    }
  | {
      status: "fallback";
    };

export function useWorkbenchHostDockPopupPreviewCapture(input: {
  capturePreview?: (
    item: WorkbenchHostDockPopupItem
  ) =>
    | Promise<WorkbenchDockPreviewContent | string | null>
    | WorkbenchDockPreviewContent
    | string
    | null;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  dockPreviewCache?: WorkbenchDockPreviewCache;
  isContextMenu: boolean;
  items: WorkbenchHostDockPopupItem[];
  resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<WorkbenchHostNodeData>;
}): {
  previewStateFor: (
    item: WorkbenchHostDockPopupItem
  ) => WorkbenchHostDockPopupPreviewState;
} {
  const {
    capturePreview,
    debugDiagnostics,
    dockPreviewCache,
    isContextMenu,
    items,
    resolveDockPreviewCacheKey
  } = input;
  const hasCapturePreview = Boolean(capturePreview);
  const [capturedPreviewByMemoryKey, setCapturedPreviewByMemoryKey] = useState<
    Record<string, WorkbenchHostDockPopupCapturedPreview | undefined>
  >({});
  const capturedPreviewByMemoryKeyRef = useRef(capturedPreviewByMemoryKey);
  const capturePreviewRef = useRef(capturePreview);
  const debugDiagnosticsRef = useRef(debugDiagnostics);
  const dockPreviewCacheRef = useRef(dockPreviewCache);
  const resolveDockPreviewCacheKeyRef = useRef(resolveDockPreviewCacheKey);
  const isMountedRef = useRef(false);
  const isContextMenuRef = useRef(isContextMenu);
  const activePreviewCaptureItemStateKeysRef = useRef<ReadonlySet<string>>(
    new Set()
  );
  capturedPreviewByMemoryKeyRef.current = capturedPreviewByMemoryKey;
  capturePreviewRef.current = capturePreview;
  debugDiagnosticsRef.current = debugDiagnostics;
  dockPreviewCacheRef.current = dockPreviewCache;
  resolveDockPreviewCacheKeyRef.current = resolveDockPreviewCacheKey;

  const previewCaptureItemStateKeys = items.map((item) =>
    resolveDockPopupPreviewItemStateKey(
      item,
      resolveDockPreviewCacheKey?.(item.node) ?? null
    )
  );
  const previewCaptureKey = previewCaptureItemStateKeys.join("|");

  useLayoutEffect(() => {
    isContextMenuRef.current = isContextMenu;
    activePreviewCaptureItemStateKeysRef.current = new Set(
      previewCaptureItemStateKeys
    );
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!capturePreviewRef.current || isContextMenu) {
      return;
    }
    const captureItemStateIsCurrent = (itemStateKey: string): boolean =>
      isMountedRef.current &&
      !isContextMenuRef.current &&
      activePreviewCaptureItemStateKeysRef.current.has(itemStateKey);
    let captureEffectActive = true;
    const ownedCaptureKeys = new Set<string>();
    const startedCaptureKeys = new Set<string>();
    const missingItems = items.filter((item) => {
      const revision = item.previewRevision;
      const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
        item,
        resolveDockPreviewCacheKeyRef.current?.(item.node) ?? null
      );
      const pendingCaptureKey = resolveDockPopupPreviewCaptureKey(
        previewMemoryKey,
        revision
      );
      const capturedPreview =
        capturedPreviewByMemoryKeyRef.current[previewMemoryKey] ??
        readDockPopupPreviewImage(previewMemoryKey);
      const hasCapturedPreview =
        capturedPreview !== undefined && capturedPreview.revision === revision;
      return (
        !item.preview &&
        !hasCapturedPreview &&
        !pendingDockPopupPreviewCaptureKeys.has(pendingCaptureKey)
      );
    });
    if (missingItems.length === 0) {
      logWorkbenchDockPopupDebug(
        "dock.popup.preview_capture.batch",
        debugDiagnosticsRef.current,
        {
          itemCount: items.length,
          missingNodeIds: []
        }
      );
      return;
    }
    logWorkbenchDockPopupDebug(
      "dock.popup.preview_capture.batch",
      debugDiagnosticsRef.current,
      {
        itemCount: items.length,
        missingNodeIds: missingItems.map((item) => item.node.id)
      }
    );

    for (const item of missingItems) {
      const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
        item,
        resolveDockPreviewCacheKeyRef.current?.(item.node) ?? null
      );
      const pendingCaptureKey = resolveDockPopupPreviewCaptureKey(
        previewMemoryKey,
        item.previewRevision
      );
      pendingDockPopupPreviewCaptureKeys.add(pendingCaptureKey);
      ownedCaptureKeys.add(pendingCaptureKey);
    }

    void (async () => {
      for (const item of missingItems) {
        if (!captureEffectActive) {
          break;
        }
        const revision = item.previewRevision;
        const resolvedCacheKey =
          resolveDockPreviewCacheKeyRef.current?.(item.node) ?? null;
        const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
          item,
          resolvedCacheKey
        );
        const pendingCaptureKey = resolveDockPopupPreviewCaptureKey(
          previewMemoryKey,
          revision
        );
        const itemStateKey = resolveDockPopupPreviewItemStateKey(
          item,
          resolvedCacheKey
        );
        if (!captureItemStateIsCurrent(itemStateKey)) {
          pendingDockPopupPreviewCaptureKeys.delete(pendingCaptureKey);
          ownedCaptureKeys.delete(pendingCaptureKey);
          continue;
        }
        startedCaptureKeys.add(pendingCaptureKey);
        try {
          logWorkbenchDockPopupDebug(
            "dock.popup.preview_capture.started",
            debugDiagnosticsRef.current,
            {
              isMinimized: item.isMinimized,
              nodeId: item.node.id,
              revision
            }
          );
          const cacheKey = resolveDockPopupPreviewCacheKey(
            resolvedCacheKey,
            revision
          );
          if (item.isMinimized && cacheKey) {
            const minimizedPersistedPreview = await readPersistedDockPreview(
              dockPreviewCacheRef.current,
              cacheKey
            );
            if (!captureItemStateIsCurrent(itemStateKey)) {
              continue;
            }
            if (minimizedPersistedPreview) {
              const persistedPreview: WorkbenchDockPreviewContent = {
                kind: "image",
                src: minimizedPersistedPreview
              };
              writeCachedWorkbenchNodePreviewImage(
                item.node.id,
                minimizedPersistedPreview
              );
              writeDockPopupPreviewImage(
                previewMemoryKey,
                persistedPreview,
                revision
              );
              setCapturedPreviewByMemoryKey((current) => ({
                ...current,
                [previewMemoryKey]: {
                  preview: persistedPreview,
                  revision
                }
              }));
              continue;
            }
          }

          const providedPreview = await Promise.resolve(
            capturePreviewRef.current?.(item) ?? null
          ).catch(() => null);
          if (!captureItemStateIsCurrent(itemStateKey)) {
            continue;
          }
          const preview = normalizeDockPopupPreviewContentResult(
            providedPreview,
            revision
          );
          if (!captureItemStateIsCurrent(itemStateKey)) {
            continue;
          }
          logWorkbenchDockPopupDebug(
            "dock.popup.preview_capture.resolved",
            debugDiagnosticsRef.current,
            {
              hasPreview: Boolean(preview),
              nodeId: item.node.id,
              providerRevision: preview?.revision ?? null,
              revision
            }
          );
          if (preview) {
            if (preview.kind === "image") {
              writeCachedWorkbenchNodePreviewImage(item.node.id, preview.src);
            }
            writeDockPopupPreviewImage(previewMemoryKey, preview, revision);
            if (cacheKey && preview.kind === "image" && !item.isMinimized) {
              writeLatestPersistedDockPreview(
                dockPreviewCacheRef.current,
                cacheKey,
                preview.src
              );
            }
            setCapturedPreviewByMemoryKey((current) => ({
              ...current,
              [previewMemoryKey]: { preview, revision }
            }));
            continue;
          }

          const fallbackMemoryPreview = !item.isMinimized
            ? readCachedWorkbenchNodePreviewImage(item.node.id)
            : null;
          const [
            fallbackLatestPersistedPreview,
            fallbackExactPersistedPreview
          ] =
            !item.isMinimized && !fallbackMemoryPreview && cacheKey
              ? await Promise.all([
                  readPersistedDockPreview(
                    dockPreviewCacheRef.current,
                    resolveLatestDockPreviewCacheKey(cacheKey)
                  ),
                  readPersistedDockPreview(
                    dockPreviewCacheRef.current,
                    cacheKey
                  )
                ])
              : [null, null];
          if (!captureItemStateIsCurrent(itemStateKey)) {
            continue;
          }
          let fallbackDomPreview: string | null = null;
          if (
            !item.isMinimized &&
            !fallbackMemoryPreview &&
            !fallbackLatestPersistedPreview &&
            !fallbackExactPersistedPreview
          ) {
            await yieldDockPopupPreviewCaptureTask();
            if (!captureItemStateIsCurrent(itemStateKey)) {
              continue;
            }
            fallbackDomPreview = await captureWorkbenchNodePreviewImage(
              item.node.id,
              { bypassCache: true }
            ).catch(() => null);
          }
          if (!captureItemStateIsCurrent(itemStateKey)) {
            continue;
          }
          const fallbackPreviewImageUrl =
            fallbackMemoryPreview ??
            fallbackLatestPersistedPreview ??
            fallbackExactPersistedPreview ??
            fallbackDomPreview;
          if (fallbackPreviewImageUrl) {
            if (
              fallbackMemoryPreview ||
              fallbackLatestPersistedPreview ||
              fallbackExactPersistedPreview
            ) {
              writeCachedWorkbenchNodePreviewImage(
                item.node.id,
                fallbackPreviewImageUrl
              );
            }
            const fallbackPreview: WorkbenchDockPreviewContent = {
              kind: "image",
              src: fallbackPreviewImageUrl
            };
            writeDockPopupPreviewImage(
              previewMemoryKey,
              fallbackPreview,
              revision
            );
            if (cacheKey && !fallbackLatestPersistedPreview) {
              writeLatestPersistedDockPreview(
                dockPreviewCacheRef.current,
                cacheKey,
                fallbackPreviewImageUrl
              );
            }
          }
          const fallbackPreview: WorkbenchDockPreviewContent | null =
            fallbackPreviewImageUrl
              ? { kind: "image", src: fallbackPreviewImageUrl }
              : null;
          setCapturedPreviewByMemoryKey((current) => ({
            ...current,
            [previewMemoryKey]: { preview: fallbackPreview, revision }
          }));
        } finally {
          pendingDockPopupPreviewCaptureKeys.delete(pendingCaptureKey);
          ownedCaptureKeys.delete(pendingCaptureKey);
        }
      }
    })().catch(() => {
      for (const captureKey of ownedCaptureKeys) {
        pendingDockPopupPreviewCaptureKeys.delete(captureKey);
      }
      ownedCaptureKeys.clear();
      const currentItems = missingItems.filter((item) =>
        captureItemStateIsCurrent(
          resolveDockPopupPreviewItemStateKey(
            item,
            resolveDockPreviewCacheKeyRef.current?.(item.node) ?? null
          )
        )
      );
      for (const item of currentItems) {
        const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
          item,
          resolveDockPreviewCacheKey?.(item.node) ?? null
        );
        pendingDockPopupPreviewCaptureKeys.delete(
          resolveDockPopupPreviewCaptureKey(
            previewMemoryKey,
            item.previewRevision
          )
        );
      }
      if (currentItems.length > 0) {
        setCapturedPreviewByMemoryKey((current) => ({
          ...current,
          ...Object.fromEntries(
            currentItems.map((item) => {
              const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
                item,
                resolveDockPreviewCacheKey?.(item.node) ?? null
              );
              return [
                previewMemoryKey,
                { preview: null, revision: item.previewRevision }
              ];
            })
          )
        }));
      }
    });

    return () => {
      captureEffectActive = false;
      for (const captureKey of ownedCaptureKeys) {
        if (!startedCaptureKeys.has(captureKey)) {
          pendingDockPopupPreviewCaptureKeys.delete(captureKey);
          ownedCaptureKeys.delete(captureKey);
        }
      }
    };
  }, [hasCapturePreview, isContextMenu, previewCaptureKey]);

  return {
    previewStateFor(item) {
      const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
        item,
        resolveDockPreviewCacheKey?.(item.node) ?? null
      );
      const capturedPreview =
        capturedPreviewByMemoryKey[previewMemoryKey] ??
        readDockPopupPreviewImage(previewMemoryKey);
      return resolveDockPopupItemPreviewState(
        item,
        capturedPreview,
        hasCapturePreview
      );
    }
  };
}

export function logWorkbenchDockPopupDebug(
  event: string,
  debugDiagnostics: WorkbenchHostProps["debugDiagnostics"],
  details: Record<string, unknown>
): void {
  if (!debugDiagnostics?.log) {
    return;
  }
  void Promise.resolve(
    debugDiagnostics.log({
      details,
      event,
      level: "info",
      source: "workbench-dock"
    })
  ).catch(() => undefined);
}

function readDockPopupPreviewImage(
  memoryKey: string
): WorkbenchHostDockPopupCapturedPreview | undefined {
  return dockPopupPreviewByMemoryKey.get(memoryKey);
}

function writeDockPopupPreviewImage(
  memoryKey: string,
  preview: WorkbenchDockPreviewContent,
  revision: string | null
): void {
  dockPopupPreviewByMemoryKey.delete(memoryKey);
  dockPopupPreviewByMemoryKey.set(memoryKey, { preview, revision });
  while (dockPopupPreviewByMemoryKey.size > dockPopupPreviewCacheMaxEntries) {
    const oldestMemoryKey = dockPopupPreviewByMemoryKey.keys().next().value;
    if (typeof oldestMemoryKey !== "string") {
      break;
    }
    dockPopupPreviewByMemoryKey.delete(oldestMemoryKey);
  }
}

function readPersistedDockPreview(
  dockPreviewCache: WorkbenchDockPreviewCache | undefined,
  cacheKey: WorkbenchDockPreviewCacheKey | null
): Promise<string | null> {
  if (!cacheKey) {
    return Promise.resolve(null);
  }
  return (
    dockPreviewCache?.read(cacheKey).catch(() => null) ?? Promise.resolve(null)
  );
}

function writeLatestPersistedDockPreview(
  dockPreviewCache: WorkbenchDockPreviewCache | undefined,
  cacheKey: WorkbenchDockPreviewCacheKey,
  previewImageUrl: string
): void {
  dockPreviewCache?.write({
    key: resolveLatestDockPreviewCacheKey(cacheKey),
    previewImageUrl
  });
}

function resolveLatestDockPreviewCacheKey(
  cacheKey: WorkbenchDockPreviewCacheKey
): WorkbenchDockPreviewCacheKey {
  return { ...cacheKey, revision: undefined };
}

function yieldDockPopupPreviewCaptureTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function resolveDockPopupPreviewCacheKey(
  cacheKey: WorkbenchDockPreviewCacheKey | null,
  revision: string | null
): WorkbenchDockPreviewCacheKey | null {
  return cacheKey ? { ...cacheKey, revision } : null;
}

function resolveDockPopupPreviewMemoryKey(
  item: WorkbenchHostDockPopupItem,
  cacheKey: WorkbenchDockPreviewCacheKey | null
): string {
  if (!cacheKey) {
    return `node:${item.node.id}`;
  }
  return `cache:${JSON.stringify({
    instanceId: cacheKey.instanceId,
    instanceKey: cacheKey.instanceKey ?? null,
    nodeId: cacheKey.nodeId,
    typeId: cacheKey.typeId,
    workspaceId: cacheKey.workspaceId
  })}`;
}

function resolveDockPopupPreviewCaptureKey(
  memoryKey: string,
  revision: string | null
): string {
  return `${memoryKey}\u0000${revision ?? ""}`;
}

function resolveDockPopupPreviewItemStateKey(
  item: WorkbenchHostDockPopupItem,
  cacheKey: WorkbenchDockPreviewCacheKey | null
): string {
  return [
    resolveDockPopupPreviewMemoryKey(item, cacheKey),
    item.isMinimized ? "minimized" : "visible",
    previewCacheToken(item.preview),
    item.previewRevision ?? ""
  ].join(":");
}

function normalizeDockPopupPreviewContentResult(
  preview: WorkbenchDockPreviewContent | string | null | undefined,
  revision: string | null
): WorkbenchDockPreviewContent | null {
  if (!preview) {
    return null;
  }
  if (typeof preview === "string") {
    return { kind: "image", revision: revision ?? undefined, src: preview };
  }
  return {
    ...preview,
    revision: preview.revision ?? revision ?? undefined
  };
}

function resolveDockPopupItemPreviewState(
  item: WorkbenchHostDockPopupItem,
  capturedPreview: WorkbenchHostDockPopupCapturedPreview | undefined,
  hasPreviewProvider: boolean
): WorkbenchHostDockPopupPreviewState {
  const revision = item.previewRevision;
  if (item.preview) {
    return { preview: item.preview, status: "ready" };
  }
  if (
    capturedPreview &&
    capturedPreview.revision === revision &&
    capturedPreview.preview
  ) {
    return { preview: capturedPreview.preview, status: "ready" };
  }
  if (
    (capturedPreview !== undefined && capturedPreview.revision === revision) ||
    !hasPreviewProvider
  ) {
    return { status: "fallback" };
  }
  return { status: "loading" };
}

function previewCacheToken(
  preview: WorkbenchDockPreviewContent | null | undefined
): string {
  if (!preview) {
    return "";
  }
  switch (preview.kind) {
    case "component":
      return `component:${preview.revision ?? ""}`;
    case "image":
      return `image:${preview.revision ?? ""}:${preview.src}`;
  }
}
