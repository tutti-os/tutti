import type { WorkbenchDockContext } from "../react/types.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey
} from "../react/dockPreviewCache.ts";
import {
  canCreateNewWindow,
  canCreateNewWindowInDockPopup,
  resolveWorkbenchDockEntryClick,
  type ResolvedWorkbenchHostDockEntry
} from "./dockEntries.ts";
import { dockActionKey } from "./dockActions.ts";
import { logWorkbenchDockDebug } from "./dockDiagnostics.ts";
import { resolveDockEntryInstanceMode } from "./dockItems.ts";
import { readWorkbenchHostExternalState } from "./externalState.ts";
import {
  resolveWorkbenchMinimizedDockRestoreIntent,
  type WorkbenchMinimizedDockRestoreIntent
} from "./minimizedDockRestoreIntent.ts";
import type {
  WorkbenchMinimizedDockNode,
  WorkbenchMinimizedDockSlot
} from "./minimizedDockSlots.ts";
import {
  readWorkbenchMinimizedDockPreviewImage,
  resolveWorkbenchMinimizedDockPreviewImage,
  resolveWorkbenchMinimizedDockPreviewRevision
} from "./useWorkbenchMinimizedDockPreview.ts";
import {
  WorkbenchHostDockPopup,
  workbenchHostDockPopupPreviewViewport,
  type WorkbenchHostDockPopupAnchorRect,
  type WorkbenchHostDockPopupState
} from "./WorkbenchHostDockPopup.tsx";
import type {
  WorkbenchDockPreviewContent,
  WorkbenchHostExternalStateSource,
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition,
  WorkbenchHostProps
} from "./types.ts";
import type { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

type WorkbenchMinimizedDockStackPopupCardRestoreIntent = Extract<
  WorkbenchMinimizedDockRestoreIntent,
  { kind: "stack-popup-card" }
>;

const dockPopupNewWindowLaunchSource = "dock-popup-new-window";

export function WorkbenchHostDockPopups({
  activeMinimizedStackPopup,
  activePopup,
  captureMinimizedNodePreview,
  captureNodePreviewImage,
  closePopup,
  context,
  debugDiagnostics,
  dockPlacement,
  dockPreviewCache,
  externalStateSource,
  host,
  i18n,
  minimizedDockSlots,
  minimizedNodeIDs,
  nodeDefinitions,
  onDockEntryClick,
  onMissionControlRequestOpen,
  pendingActionKeys,
  provideMinimizedNodePreview,
  resolvedEntries,
  runDockEntryAction,
  runDockMinimizedStackLaunch,
  workspaceId
}: {
  activeMinimizedStackPopup: WorkbenchHostDockPopupAnchorRect | null;
  activePopup: WorkbenchHostDockPopupState | null;
  captureMinimizedNodePreview: (
    node: WorkbenchMinimizedDockNode
  ) => Promise<string | null> | string | null;
  captureNodePreviewImage?: WorkbenchHostProps["captureNodePreviewImage"];
  closePopup: () => void;
  context: WorkbenchDockContext<WorkbenchHostNodeData>;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  dockPlacement: NonNullable<WorkbenchHostProps["dockPlacement"]>;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  externalStateSource?: WorkbenchHostExternalStateSource;
  host: WorkbenchHostHandle;
  i18n: ReturnType<typeof createWorkbenchHostI18nRuntime>;
  minimizedDockSlots: readonly WorkbenchMinimizedDockSlot[];
  minimizedNodeIDs: ReadonlySet<string>;
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>;
  onDockEntryClick?: (input: {
    entryId: string;
    host: WorkbenchHostHandle;
    nodeId?: string;
  }) => Promise<void> | void;
  onMissionControlRequestOpen?: WorkbenchHostProps["onMissionControlRequestOpen"];
  pendingActionKeys: ReadonlySet<string>;
  provideMinimizedNodePreview: (
    node: WorkbenchMinimizedDockNode
  ) => WorkbenchDockPreviewContent | null;
  resolvedEntries: readonly ResolvedWorkbenchHostDockEntry[];
  runDockEntryAction: (entryId: string, actionId: string) => void;
  runDockMinimizedStackLaunch: (
    intent: WorkbenchMinimizedDockStackPopupCardRestoreIntent,
    launch: (intent: WorkbenchMinimizedDockStackPopupCardRestoreIntent) => void
  ) => void;
  workspaceId: string;
}) {
  const popupEntry =
    activePopup === null
      ? null
      : (resolvedEntries.find(
          (entry) => entry.entry.id === activePopup.entryId
        ) ?? null);
  const activeMinimizedStackSlot =
    activeMinimizedStackPopup === null
      ? null
      : (minimizedDockSlots.find(
          (
            slot
          ): slot is Extract<WorkbenchMinimizedDockSlot, { kind: "stack" }> =>
            slot.kind === "stack"
        ) ?? null);
  const openDockContextMenuNodeIds =
    popupEntry?.matchedNodes.map((node) => node.id) ?? [];
  const dockContextMenuInstanceMode =
    popupEntry === null
      ? undefined
      : resolveDockEntryInstanceMode(popupEntry.entry, nodeDefinitions);
  const canShowAllWindowsFromDockContextMenu =
    onMissionControlRequestOpen !== undefined &&
    dockContextMenuInstanceMode === "multi" &&
    openDockContextMenuNodeIds.length > 1;
  const fullscreenNodeFromDockContextMenu =
    popupEntry === null
      ? null
      : resolveDockContextMenuFullscreenNode({
          focusedNodeId: context.focusedNodeId,
          minimizedNodeIDs,
          nodeDefinitions,
          nodes: popupEntry.matchedNodes
        });
  const canOpenFromDockContextMenu =
    popupEntry !== null &&
    popupEntry.matchedNodes.length === 0 &&
    resolveWorkbenchDockEntryClick({
      entry: popupEntry.entry,
      instanceMode: dockContextMenuInstanceMode,
      matchedNodes: popupEntry.matchedNodes
    }).kind === "launch";

  return (
    <>
      {popupEntry && activePopup ? (
        <WorkbenchHostDockPopup
          anchorRect={activePopup.anchorRect}
          placement={dockPlacement}
          canEnterFullscreen={fullscreenNodeFromDockContextMenu !== null}
          canShowAllWindows={canShowAllWindowsFromDockContextMenu}
          debugDiagnostics={debugDiagnostics}
          dockRetention={
            popupEntry.entry.dockRetention
              ? {
                  checked: popupEntry.entry.dockRetention.retained,
                  disabled:
                    popupEntry.entry.dockRetention.disabled === true ||
                    pendingActionKeys.has(
                      dockActionKey(
                        popupEntry.entry.id,
                        popupEntry.entry.dockRetention.actionId
                      )
                    ),
                  label: i18n.t(
                    popupEntry.entry.dockRetention.retained
                      ? "dockContextMenu.removeFromDock"
                      : "dockContextMenu.keepInDock"
                  ),
                  pendingLabel: pendingActionKeys.has(
                    dockActionKey(
                      popupEntry.entry.id,
                      popupEntry.entry.dockRetention.actionId
                    )
                  )
                    ? popupEntry.entry.dockRetention.pendingLabel
                    : undefined
                }
              : null
          }
          capturePreview={
            popupEntry.entry.capturePopupItemPreview || captureNodePreviewImage
              ? async (item) => {
                  const previewImageUrl = await Promise.resolve(
                    popupEntry.entry.capturePopupItemPreview
                      ? popupEntry.entry.capturePopupItemPreview(item)
                      : (captureNodePreviewImage?.(item.node) ?? null)
                  ).catch(() => null);
                  return previewImageUrl
                    ? {
                        kind: "image",
                        revision: item.previewRevision ?? undefined,
                        src: previewImageUrl
                      }
                    : null;
                }
              : undefined
          }
          dockPreviewCache={dockPreviewCache}
          items={popupEntry.matchedNodes
            .map((node) => {
              const externalState = readWorkbenchHostExternalState({
                externalStateSource,
                node,
                workspaceId
              });
              const item = {
                externalNodeState: externalState.externalNodeState,
                externalWorkspaceState: externalState.externalWorkspaceState,
                host,
                isFocused: context.focusedNodeId === node.id,
                isMinimized: minimizedNodeIDs.has(node.id),
                node,
                previewViewport: workbenchHostDockPopupPreviewViewport
              };
              const descriptor =
                popupEntry.entry.resolvePopupItem?.(item) ?? {};
              const descriptorPreview =
                descriptor.preview ??
                popupEntry.entry.providePopupItemPreview?.(item) ??
                null;
              return {
                ...item,
                preview: descriptorPreview,
                previewRevision:
                  previewRevision(descriptorPreview) ??
                  descriptor.revision ??
                  null,
                subtitle:
                  descriptor.subtitle === undefined
                    ? (node.data.instanceKey ?? node.data.instanceId)
                    : descriptor.subtitle,
                title:
                  descriptor.title === undefined
                    ? node.title
                    : descriptor.title?.trim() || null
              };
            })
            .sort((left, right) => {
              if (left.isFocused !== right.isFocused) {
                return left.isFocused ? -1 : 1;
              }
              return left.node.id.localeCompare(right.node.id);
            })}
          label={popupEntry.entry.label}
          labelMode={popupEntry.entry.popupCardLabelMode}
          newWindowLabel={i18n.t("newWindow")}
          closeWindowLabel={(title) => i18n.t("closeWindow", { title })}
          fullscreenLabel={i18n.t("dockContextMenu.fullscreen")}
          hideLabel={i18n.t("dockContextMenu.hide")}
          onClose={() => {
            logWorkbenchDockDebug(
              "dock.popup.close_requested",
              debugDiagnostics,
              {
                entryId: popupEntry.entry.id,
                itemCount: popupEntry.matchedNodes.length,
                workspaceId
              }
            );
            closePopup();
          }}
          onCloseNode={(nodeId) => {
            host.requestNodeClose(nodeId);
            const hasRemainingItems = popupEntry.matchedNodes.some(
              (node) => node.id !== nodeId
            );
            if (!hasRemainingItems) {
              closePopup();
            }
          }}
          onCreateNew={() => {
            closePopup();
            context.genie.launchNodeFromAnchor(
              popupEntry.anchorKey,
              popupEntry.entry.id,
              () =>
                host.launchNode({
                  dockEntryId: popupEntry.entry.id,
                  launchSource: dockPopupNewWindowLaunchSource,
                  payload:
                    popupEntry.entry.newWindowLaunchPayload ??
                    popupEntry.entry.launchPayload,
                  reason: "dock",
                  typeId: popupEntry.entry.typeId
                })
            );
          }}
          onEnterFullscreen={() => {
            if (!fullscreenNodeFromDockContextMenu) {
              return;
            }
            context.controller.commands.enterFullscreen(
              fullscreenNodeFromDockContextMenu.id
            );
            closePopup();
          }}
          onHide={() => {
            for (const node of popupEntry.matchedNodes) {
              if (!minimizedNodeIDs.has(node.id)) {
                host.minimizeNode(node.id);
              }
            }
            closePopup();
          }}
          onRunDockRetentionAction={
            popupEntry.entry.dockRetention
              ? () => {
                  const dockRetention = popupEntry.entry.dockRetention;
                  if (!dockRetention || dockRetention.disabled === true) {
                    return;
                  }
                  runDockEntryAction(
                    popupEntry.entry.id,
                    dockRetention.actionId
                  );
                  closePopup();
                }
              : undefined
          }
          onSelectNode={(nodeId) => {
            closePopup();
            void (async () => {
              try {
                await onDockEntryClick?.({
                  entryId: popupEntry.entry.id,
                  host,
                  nodeId
                });
              } catch {
                // Keep dock click failures contained.
              }
            })();
            context.genie.launchNodeFromAnchor(
              popupEntry.anchorKey,
              nodeId,
              () => {
                host.focusNode(nodeId);
              }
            );
          }}
          onShowAllWindows={() => {
            closePopup();
            for (const node of popupEntry.matchedNodes) {
              if (minimizedNodeIDs.has(node.id)) {
                context.controller.commands.restoreNode(node.id);
              }
            }
            window.requestAnimationFrame(() => {
              onMissionControlRequestOpen?.({
                nodeIds: openDockContextMenuNodeIds,
                trigger: "dock-context-menu"
              });
            });
          }}
          onQuit={() => {
            for (const node of popupEntry.matchedNodes) {
              host.requestNodeClose(node.id);
            }
            closePopup();
          }}
          quitLabel={i18n.t("dockContextMenu.quit")}
          showCreateNew={canCreateNewWindowInDockPopup(
            popupEntry.entry,
            dockContextMenuInstanceMode
          )}
          showCreateNewInContextMenu={canCreateNewWindow(
            popupEntry.entry,
            dockContextMenuInstanceMode
          )}
          showOpen={canOpenFromDockContextMenu}
          showAllWindowsLabel={i18n.t("dockContextMenu.showAllWindows")}
          resolveDockPreviewCacheKey={(node) =>
            resolveDockPreviewCacheKey(workspaceId, node)
          }
          variant={
            activePopup.kind === "context-menu" ? "context-menu" : "default"
          }
        />
      ) : null}
      {activeMinimizedStackSlot && activeMinimizedStackPopup ? (
        <WorkbenchHostDockPopup
          anchorRect={activeMinimizedStackPopup}
          placement={dockPlacement}
          debugDiagnostics={debugDiagnostics}
          capturePreview={async (item) => {
            const src = await resolveWorkbenchMinimizedDockPreviewImage({
              capturePreview: () => captureMinimizedNodePreview(item.node),
              dockPreviewCache,
              node: item.node,
              workspaceId
            });
            return src ? { kind: "image", src } : null;
          }}
          dockPreviewCache={dockPreviewCache}
          items={activeMinimizedStackSlot.nodes.map((node) => {
            const externalState = readWorkbenchHostExternalState({
              externalStateSource,
              node,
              workspaceId
            });
            const minimizedDock = nodeDefinitions.get(node.data.typeId)?.window
              ?.minimizedDock;
            return {
              externalNodeState: externalState.externalNodeState,
              externalWorkspaceState: externalState.externalWorkspaceState,
              host,
              isFocused: context.focusedNodeId === node.id,
              isMinimized: true,
              node,
              preview:
                minimizedDock?.kind === "component"
                  ? (provideMinimizedNodePreview(node) ?? null)
                  : minimizedDock?.kind === "snapshot" &&
                      minimizedDock.capturePreview
                    ? null
                    : (() => {
                        const previewImageUrl =
                          readWorkbenchMinimizedDockPreviewImage(node.id);
                        return previewImageUrl
                          ? ({ kind: "image", src: previewImageUrl } as const)
                          : null;
                      })(),
              previewRevision:
                resolveWorkbenchMinimizedDockPreviewRevision(node),
              subtitle: node.data.instanceKey ?? node.data.instanceId,
              title: node.title
            };
          })}
          label={i18n.t("minimizedWindows")}
          newWindowLabel={i18n.t("newWindow")}
          closeWindowLabel={(title) => i18n.t("closeWindow", { title })}
          onClose={() => {
            logWorkbenchDockDebug(
              "dock.popup.close_requested",
              debugDiagnostics,
              {
                entryId: "minimized-stack",
                itemCount: activeMinimizedStackSlot.nodes.length,
                workspaceId
              }
            );
            closePopup();
          }}
          onCloseNode={(nodeId) => {
            host.requestNodeClose(nodeId);
            const hasRemainingItems = activeMinimizedStackSlot.nodes.some(
              (node) => node.id !== nodeId
            );
            if (!hasRemainingItems) {
              closePopup();
            }
          }}
          onCreateNew={() => undefined}
          onSelectNode={(nodeId) => {
            const restoreIntent = resolveWorkbenchMinimizedDockRestoreIntent({
              nodeId,
              slots: minimizedDockSlots,
              source: {
                kind: "stack-popup-card",
                stackAnchorKey: activeMinimizedStackSlot.anchorKey
              }
            });
            if (restoreIntent?.kind !== "stack-popup-card") {
              return;
            }
            closePopup();
            runDockMinimizedStackLaunch(restoreIntent, (intent) => {
              context.genie.launchNodeFromAnchor(
                intent.anchorKey,
                intent.nodeId,
                () => {
                  host.focusNode(intent.nodeId);
                }
              );
            });
          }}
          showCreateNew={false}
          resolveDockPreviewCacheKey={(node) =>
            resolveDockPreviewCacheKey(workspaceId, node)
          }
          variant="minimized-stack"
        />
      ) : null}
    </>
  );
}

function resolveDockContextMenuFullscreenNode({
  focusedNodeId,
  minimizedNodeIDs,
  nodeDefinitions,
  nodes
}: {
  focusedNodeId: string | null;
  minimizedNodeIDs: ReadonlySet<string>;
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>;
  nodes: readonly WorkbenchMinimizedDockNode[];
}) {
  const candidates = nodes.filter((node) => {
    if (node.displayMode === "fullscreen" || minimizedNodeIDs.has(node.id)) {
      return false;
    }
    return (
      nodeDefinitions.get(node.data.typeId)?.window?.fullscreenable !== false
    );
  });
  return (
    candidates.find((node) => node.id === focusedNodeId) ??
    candidates[0] ??
    null
  );
}

function previewRevision(
  preview: WorkbenchDockPreviewContent | null | undefined
): string | null {
  return preview?.revision ?? null;
}

function resolveDockPreviewCacheKey(
  workspaceId: string,
  node: WorkbenchMinimizedDockNode
): WorkbenchDockPreviewCacheKey {
  return {
    instanceId: node.data.instanceId,
    instanceKey: node.data.instanceKey ?? null,
    nodeId: node.id,
    typeId: node.data.typeId,
    workspaceId
  };
}
