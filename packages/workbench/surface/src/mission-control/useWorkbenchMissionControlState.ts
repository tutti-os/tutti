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
import type {
  WorkbenchMissionControlAdapter,
  WorkbenchMissionControlMode
} from "./types.ts";

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
  mode: WorkbenchMissionControlMode;
  presentation: WorkbenchSurfacePresentation;
  selectedCount: number;
}

export function useWorkbenchMissionControlState<TData>({
  adapter,
  mode,
  nodeIds,
  onRequestClose
}: {
  adapter: WorkbenchMissionControlAdapter<TData> | null;
  mode: WorkbenchMissionControlMode | null;
  nodeIds?: readonly string[];
  onRequestClose: () => void;
}): WorkbenchMissionControlState | null {
  const isActive = mode !== null && adapter !== null;
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
    if (mode === null) {
      return;
    }
    setSelectedNodeIds([]);
  }, [mode]);

  useEffect(() => {
    if (mode !== null && visibleNodes.length === 0) {
      onRequestClose();
    }
  }, [mode, onRequestClose, visibleNodes.length]);

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
      mode === "layout" &&
      orderedSelectedNodeIds.length >= 2 &&
      canUsePreset(nextPreset),
    [canUsePreset, mode, orderedSelectedNodeIds.length]
  );
  const applyActivationAndClose = useCallback(
    (nodeId: string) => {
      const nextAdapter = adapter;
      if (!nextAdapter) {
        return;
      }
      const nextSnapshot = nextAdapter.getSnapshot();
      if (!nextSnapshot.visibleNodes.some((node) => node.id === nodeId)) {
        return;
      }
      onRequestClose();
      window.requestAnimationFrame(() => {
        nextAdapter.focusNode(nodeId);
      });
    },
    [adapter, onRequestClose]
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
  const onPreviewPress = useCallback(
    (nodeId: string) => {
      if (mode === null) {
        return;
      }
      if (mode === "activate") {
        applyActivationAndClose(nodeId);
        return;
      }

      setSelectedNodeIds((current) =>
        current.includes(nodeId)
          ? current.filter((entry) => entry !== nodeId)
          : [...current, nodeId]
      );
    },
    [applyActivationAndClose, mode]
  );
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
      mode === null
        ? null
        : {
            frameByNodeId: new Map(
              previewItems.map((item) => [item.node.id, item.frame])
            ),
            interaction: {
              mode,
              onBackdropPress: onRequestClose,
              onNodePress: onPreviewPress,
              selectedNodeIds: selectedNodeIdSet
            },
            mode: "mission-control",
            visibleNodeIds: new Set(orderedNodes.map((node) => node.id))
          },
    [
      mode,
      onPreviewPress,
      onRequestClose,
      orderedNodes,
      previewItems,
      selectedNodeIdSet
    ]
  );

  useEffect(() => {
    if (mode === null) {
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
  }, [mode, onRequestClose]);

  return useMemo<WorkbenchMissionControlState | null>(
    () =>
      mode === null || presentation === null
        ? null
        : {
            applyPreset,
            canApplyPreset,
            canUsePreset,
            mode,
            presentation,
            selectedCount: orderedSelectedNodeIds.length
          },
    [
      applyPreset,
      canApplyPreset,
      canUsePreset,
      mode,
      orderedSelectedNodeIds.length,
      presentation
    ]
  );
}
