import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useExternalStoreSnapshot,
  type ExternalStoreSnapshotSource
} from "@tutti-os/ui-react-hooks";
import {
  defaultWorkbenchLayoutConstraints,
  defaultWorkbenchSurfaceSize,
  type WorkbenchLayoutConstraints,
  type WorkbenchFrame,
  type WorkbenchLayoutPreset,
  type WorkbenchSize
} from "../core/types.ts";
import { getWorkbenchLayoutPresetFrames } from "../core/geometry.ts";
import type { WorkbenchSurfacePresentation } from "../react/types.ts";
import {
  orderWorkbenchNodesForMissionControl,
  resolveWorkbenchMissionControlPreviewLayout
} from "./layout.ts";
import type { WorkbenchMissionControlAdapter } from "./types.ts";

const missionControlStagePaddingX = 24;
const missionControlStageTop = 64;
const missionControlStageBottom = 104;
const inactiveMissionControlSnapshotSource: ExternalStoreSnapshotSource<null> =
  {
    getSnapshot() {
      return null;
    },
    subscribe() {
      return () => {};
    }
  };

export interface WorkbenchMissionControlState {
  applyPreset(
    preset: WorkbenchLayoutPreset,
    options?: { lock?: boolean }
  ): void;
  canApplyPreset(preset: WorkbenchLayoutPreset): boolean;
  canUsePreset(preset: WorkbenchLayoutPreset): boolean;
  presentation: WorkbenchSurfacePresentation;
  selectedCount: number;
}

export function useWorkbenchMissionControlState<TData>({
  active,
  adapter,
  nodeIds,
  onRequestClose
}: {
  active: boolean;
  adapter: WorkbenchMissionControlAdapter<TData> | null;
  nodeIds?: readonly string[];
  onRequestClose: () => void;
}): WorkbenchMissionControlState | null {
  const isActive = active && adapter !== null;
  const snapshot = useExternalStoreSnapshot(
    isActive
      ? {
          getSnapshot() {
            return adapter.getSnapshot();
          },
          subscribe(listener) {
            return adapter.subscribe(listener);
          }
        }
      : inactiveMissionControlSnapshotSource
  );
  const layoutConstraints: WorkbenchLayoutConstraints =
    snapshot?.layoutConstraints ?? defaultWorkbenchLayoutConstraints;
  const surfaceSize: WorkbenchSize =
    snapshot?.surfaceSize ?? defaultWorkbenchSurfaceSize;
  const scopedNodeIdSet = useMemo(
    () => (nodeIds === undefined ? null : new Set(nodeIds)),
    [nodeIds]
  );
  const visibleNodes = useMemo(() => {
    const nextVisibleNodes = snapshot?.visibleNodes ?? [];
    if (scopedNodeIdSet === null) {
      return nextVisibleNodes;
    }
    return nextVisibleNodes.filter((node) => scopedNodeIdSet.has(node.id));
  }, [scopedNodeIdSet, snapshot?.visibleNodes]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);

  useEffect(() => {
    if (!active) {
      return;
    }
    setSelectedNodeIds([]);
  }, [active]);

  useEffect(() => {
    if (active && visibleNodes.length === 0) {
      onRequestClose();
    }
  }, [active, onRequestClose, visibleNodes.length]);

  const orderedNodes = useMemo(
    () => (isActive ? orderWorkbenchNodesForMissionControl(visibleNodes) : []),
    [isActive, visibleNodes]
  );
  const orderedSelectedNodeIds = useMemo(
    () =>
      orderedNodes
        .map((node) => node.id)
        .filter((nodeId) => selectedNodeIds.includes(nodeId)),
    [orderedNodes, selectedNodeIds]
  );

  const previewFrame = useMemo<WorkbenchFrame>(
    () =>
      isActive
        ? {
            x: missionControlStagePaddingX,
            y: missionControlStageTop,
            width: Math.max(
              240,
              surfaceSize.width - missionControlStagePaddingX * 2
            ),
            height: Math.max(
              180,
              surfaceSize.height -
                missionControlStageTop -
                missionControlStageBottom
            )
          }
        : {
            x: 0,
            y: 0,
            width: 0,
            height: 0
          },
    [isActive, surfaceSize]
  );
  const previewItems = useMemo(
    () =>
      isActive
        ? resolveWorkbenchMissionControlPreviewLayout({
            container: previewFrame,
            nodes: orderedNodes
          })
        : [],
    [isActive, orderedNodes, previewFrame]
  );
  const canUsePreset = useCallback(
    (nextPreset: WorkbenchLayoutPreset) =>
      orderedSelectedNodeIds.length < 2
        ? true
        : getWorkbenchLayoutPresetFrames(
            orderedSelectedNodeIds.length,
            nextPreset,
            surfaceSize,
            layoutConstraints
          ) !== null,
    [layoutConstraints, orderedSelectedNodeIds.length, surfaceSize]
  );
  const canApplyPreset = useCallback(
    (nextPreset: WorkbenchLayoutPreset) =>
      orderedSelectedNodeIds.length >= 2 && canUsePreset(nextPreset),
    [canUsePreset, orderedSelectedNodeIds.length]
  );
  const applyLayoutAndClose = useCallback(
    (nodeIds: string[], nextPreset: WorkbenchLayoutPreset, lock: boolean) => {
      if (!adapter || nodeIds.length < 2) {
        return;
      }
      onRequestClose();
      window.requestAnimationFrame(() => {
        adapter.applyLayoutPreset(nodeIds, nextPreset, lock);
      });
    },
    [adapter, onRequestClose]
  );
  const onPreviewPress = useCallback((nodeId: string) => {
    setSelectedNodeIds((current) =>
      current.includes(nodeId)
        ? current.filter((entry) => entry !== nodeId)
        : [...current, nodeId]
    );
  }, []);
  const selectedNodeIdSet = useMemo(
    () => new Set(selectedNodeIds),
    [selectedNodeIds]
  );
  const applyPreset = useCallback(
    (nextPreset: WorkbenchLayoutPreset, options?: { lock?: boolean }) => {
      if (!canApplyPreset(nextPreset)) {
        return;
      }
      applyLayoutAndClose(
        orderedSelectedNodeIds,
        nextPreset,
        options?.lock ?? false
      );
    },
    [applyLayoutAndClose, canApplyPreset, orderedSelectedNodeIds]
  );

  const presentation = useMemo<WorkbenchSurfacePresentation | null>(
    () =>
      !active
        ? null
        : {
            frameByNodeId: new Map(
              previewItems.map((item) => [item.node.id, item.frame])
            ),
            interaction: {
              onBackdropPress: onRequestClose,
              onNodePress: onPreviewPress,
              selectedNodeIds: selectedNodeIdSet
            },
            mode: "mission-control",
            visibleNodeIds: new Set(orderedNodes.map((node) => node.id))
          },
    [
      active,
      onPreviewPress,
      onRequestClose,
      orderedNodes,
      previewItems,
      selectedNodeIdSet
    ]
  );

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onRequestClose();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active, onRequestClose]);

  return useMemo<WorkbenchMissionControlState | null>(
    () =>
      !active || presentation === null
        ? null
        : {
            applyPreset,
            canApplyPreset,
            canUsePreset,
            presentation,
            selectedCount: orderedSelectedNodeIds.length
          },
    [
      active,
      applyPreset,
      canApplyPreset,
      canUsePreset,
      orderedSelectedNodeIds.length,
      presentation
    ]
  );
}
