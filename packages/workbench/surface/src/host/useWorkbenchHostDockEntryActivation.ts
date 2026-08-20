import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { WorkbenchDockContext } from "../react/types.ts";
import type {
  ResolvedWorkbenchHostDockEntry,
  WorkbenchHostDockClickResolution
} from "./dockEntries.ts";
import { logWorkbenchDockDebug } from "./dockDiagnostics.ts";
import type { WorkbenchHostDockPopupState } from "./WorkbenchHostDockPopup.tsx";
import type {
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostNodeInstanceStrategy,
  WorkbenchHostProps
} from "./types.ts";

export interface WorkbenchHostDockEntryActivationInput {
  anchorKey: string;
  clickResolution: WorkbenchHostDockClickResolution;
  currentPopup: WorkbenchHostDockPopupState | null;
  instanceMode?: WorkbenchHostNodeInstanceStrategy["mode"];
  resolvedEntry: ResolvedWorkbenchHostDockEntry;
  triggerRect: DOMRect | null;
}

export interface WorkbenchHostDockEntryContextMenuInput {
  anchorKey: string;
  resolvedEntry: ResolvedWorkbenchHostDockEntry;
  triggerRect: DOMRect;
}

export function useWorkbenchHostDockEntryActivation({
  closePopup,
  context,
  debugDiagnostics,
  host,
  onDockEntryAction,
  onDockEntryClick,
  setActivePopup,
  workspaceId
}: {
  closePopup: () => void;
  context: WorkbenchDockContext<WorkbenchHostNodeData>;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  host: WorkbenchHostHandle;
  onDockEntryAction?: (input: {
    actionId: string;
    entryId: string;
    host: WorkbenchHostHandle;
  }) => Promise<void> | void;
  onDockEntryClick?: (input: {
    entryId: string;
    host: WorkbenchHostHandle;
    nodeId?: string;
  }) => Promise<void> | void;
  setActivePopup: Dispatch<SetStateAction<WorkbenchHostDockPopupState | null>>;
  workspaceId: string;
}) {
  const activateDockEntry = useCallback(
    ({
      anchorKey,
      clickResolution,
      currentPopup,
      instanceMode,
      resolvedEntry,
      triggerRect
    }: WorkbenchHostDockEntryActivationInput) => {
      const { entry } = resolvedEntry;
      logWorkbenchDockDebug("dock.click", debugDiagnostics, {
        anchorKey,
        clickResolution,
        dockDiagnostics: entry.diagnostics ?? null,
        dockNodeState: resolvedEntry.dockNodeState,
        entryId: entry.id,
        entryLaunchBehavior: entry.launchBehavior ?? "enabled",
        entryOrder: entry.order ?? null,
        entryState: entry.state ?? { kind: "enabled" },
        entryVisibility: entry.visibility ?? "always",
        hoverActions:
          entry.hoverActions?.map((action) => ({
            disabled: action.disabled === true,
            id: action.id,
            pending: Boolean(action.pendingLabel)
          })) ?? [],
        instanceMode: instanceMode ?? null,
        matchedNodeCount: resolvedEntry.matchedNodes.length,
        matchedNodeIds: resolvedEntry.matchedNodes.map((node) => node.id),
        typeId: entry.typeId,
        workspaceId
      });

      switch (clickResolution.kind) {
        case "blocked":
          return;
        case "focus-node":
          closePopup();
          void (async () => {
            try {
              await onDockEntryClick?.({
                entryId: entry.id,
                host,
                nodeId: clickResolution.nodeId
              });
            } catch {
              // Keep dock click failures contained.
            }
          })();
          context.genie.launchNodeFromAnchor(
            anchorKey,
            clickResolution.nodeId,
            () => {
              host.focusNode(clickResolution.nodeId);
            }
          );
          return;
        case "open-popup":
          if (!triggerRect) {
            return;
          }
          logWorkbenchDockDebug("dock.popup.toggle", debugDiagnostics, {
            anchorKey,
            entryId: entry.id,
            matchedNodeCount: resolvedEntry.matchedNodes.length,
            nextOpen: currentPopup === null,
            typeId: entry.typeId,
            workspaceId
          });
          setActivePopup((current) =>
            current?.entryId === entry.id
              ? null
              : {
                  anchorRect: {
                    height: triggerRect.height,
                    left: triggerRect.left,
                    top: triggerRect.top,
                    width: triggerRect.width
                  },
                  kind: "preview",
                  entryId: entry.id
                }
          );
          return;
        case "action":
          closePopup();
          void (async () => {
            try {
              await onDockEntryAction?.({
                actionId: clickResolution.actionId,
                entryId: entry.id,
                host
              });
            } catch {
              // Keep dock action failures contained.
            }
          })();
          return;
        case "launch":
          closePopup();
          context.genie.launchNodeFromAnchor(anchorKey, entry.id, () =>
            host.launchNode({
              dockEntryId: entry.id,
              payload: entry.launchPayload,
              reason: "dock",
              typeId: entry.typeId
            })
          );
      }
    },
    [
      closePopup,
      context.genie,
      debugDiagnostics,
      host,
      onDockEntryAction,
      onDockEntryClick,
      setActivePopup,
      workspaceId
    ]
  );

  const openDockEntryContextMenu = useCallback(
    ({
      anchorKey,
      resolvedEntry,
      triggerRect
    }: WorkbenchHostDockEntryContextMenuInput) => {
      const { entry } = resolvedEntry;
      logWorkbenchDockDebug("dock.popup.context_menu", debugDiagnostics, {
        anchorKey,
        entryId: entry.id,
        matchedNodeCount: resolvedEntry.matchedNodes.length,
        typeId: entry.typeId,
        workspaceId
      });
      setActivePopup({
        anchorRect: {
          height: triggerRect.height,
          left: triggerRect.left,
          top: triggerRect.top,
          width: triggerRect.width
        },
        kind: "context-menu",
        entryId: entry.id
      });
    },
    [debugDiagnostics, setActivePopup, workspaceId]
  );

  return { activateDockEntry, openDockEntryContextMenu };
}
