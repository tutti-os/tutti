import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon
} from "@tutti-os/ui-system";
import type { WorkbenchDockContext } from "../react/types.ts";
export { renderMinimizedDockPreviewContent } from "./WorkbenchHostDockMinimizedPreview.tsx";
import { resolveWorkbenchDockEntries } from "./dockEntries.ts";
import { readWorkbenchHostExternalState } from "./externalState.ts";
import {
  resolveWorkbenchMinimizedDockSlots,
  type WorkbenchMinimizedDockNode
} from "./minimizedDockSlots.ts";
import { useMinimizedDockStackPromotion } from "./minimizedDockStackPromotion.ts";
import { resolveWorkbenchMinimizedDockRestoreIntent } from "./minimizedDockRestoreIntent.ts";
import {
  createWorkbenchHostDockItems as createDockItems,
  resolveWorkbenchHostDockItemsWidth as getDockItemsWidth
} from "./dockItems.ts";
import { useWorkbenchHostDockPresence as useDockPresence } from "./useWorkbenchHostDockPresence.ts";
import { useWorkbenchHostDockInteractions } from "./useWorkbenchHostDockInteractions.ts";
import {
  isDockVisualMutationActive,
  useWorkbenchHostDockViewport,
  type WorkbenchHostDockScrollDirection
} from "./useWorkbenchHostDockViewport.ts";
import { useWorkbenchHostDockOverlays } from "./useWorkbenchHostDockOverlays.ts";
import {
  WorkbenchHostDockHoverPanel as DockHoverPanel,
  WorkbenchHostDockLabelTooltip as DockLabelTooltip
} from "./WorkbenchHostDockOverlayPresentation.tsx";
import { dockActionKey as createDockActionKey } from "./dockActions.ts";
import { WorkbenchHostDockEntrySlot } from "./WorkbenchHostDockEntrySlot.tsx";
import { WorkbenchHostDockMinimizedSlot } from "./WorkbenchHostDockMinimizedSlot.tsx";
import { WorkbenchHostDockPopups } from "./WorkbenchHostDockPopups.tsx";
import { useWorkbenchHostDockEntryActivation } from "./useWorkbenchHostDockEntryActivation.ts";
import { useWorkbenchHostDockActivity } from "./useWorkbenchHostDockActivity.ts";
import {
  type WorkbenchHostDockPopupAnchorRect,
  type WorkbenchHostDockPopupState
} from "./WorkbenchHostDockPopup.tsx";
import type { WorkbenchDockPreviewCache } from "../react/dockPreviewCache.ts";
import type {
  WorkbenchDockPreviewContent,
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryStateSource,
  WorkbenchHostExternalStateSource,
  WorkbenchHostHandle,
  WorkbenchHostNodeDefinition,
  WorkbenchHostNodeData,
  WorkbenchHostProps
} from "./types.ts";
import type { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

const minimizedDockPreviewViewport = {
  height: 34.2,
  width: 46.8
};

export function WorkbenchHostDock({
  captureNodePreviewImage,
  context,
  debugDiagnostics,
  dockEntries,
  dockPlacement = "bottom",
  dockPreviewCache,
  dockStateSource,
  externalStateSource,
  host,
  i18n,
  nodeDefinitions,
  onDockEntryAction,
  onDockEntryClick,
  onMissionControlRequestOpen,
  workspaceId
}: {
  captureNodePreviewImage?: WorkbenchHostProps["captureNodePreviewImage"];
  context: WorkbenchDockContext<WorkbenchHostNodeData>;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  dockEntries: readonly WorkbenchHostDockEntry[];
  dockPlacement?: WorkbenchHostProps["dockPlacement"];
  dockPreviewCache?: WorkbenchDockPreviewCache;
  dockStateSource?: WorkbenchHostDockEntryStateSource;
  externalStateSource?: WorkbenchHostExternalStateSource;
  host: WorkbenchHostHandle;
  i18n: ReturnType<typeof createWorkbenchHostI18nRuntime>;
  nodeDefinitions: Map<string, WorkbenchHostNodeDefinition>;
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
  onMissionControlRequestOpen?: WorkbenchHostProps["onMissionControlRequestOpen"];
  workspaceId: string;
}) {
  const minimizedNodeIDs = useMemo(
    () => new Set(context.minimizedNodes.map((node) => node.id)),
    [context.minimizedNodes]
  );
  const pendingDockStateRefreshRef = useRef(false);
  const [activePopup, setActivePopup] =
    useState<WorkbenchHostDockPopupState | null>(null);
  const [activeMinimizedStackPopup, setActiveMinimizedStackPopup] =
    useState<WorkbenchHostDockPopupAnchorRect | null>(null);
  const [pendingActionKeys, setPendingActionKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [dockStateRevision, setDockStateRevision] = useState(0);

  const flushPendingDockStateRefresh = useCallback(() => {
    if (!pendingDockStateRefreshRef.current) {
      return;
    }
    pendingDockStateRefreshRef.current = false;
    setDockStateRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    if (!dockStateSource) {
      return undefined;
    }
    return dockStateSource.subscribe(() => {
      if (isDockVisualMutationActive(dockMeasureRef.current)) {
        pendingDockStateRefreshRef.current = true;
        return;
      }
      setDockStateRevision((revision) => revision + 1);
    });
  }, [dockStateSource]);

  const renderedDockEntries = useMemo(
    () =>
      dockEntries.map((entry) => {
        const dynamicState = dockStateSource?.getEntryState(entry.id);
        return dynamicState ? { ...entry, ...dynamicState } : entry;
      }),
    [dockEntries, dockStateRevision, dockStateSource]
  );
  const resolvedEntries = useMemo(
    () =>
      resolveWorkbenchDockEntries({
        dockEntries: renderedDockEntries,
        minimizedNodeIds: minimizedNodeIDs,
        nodes: context.nodes
      }),
    [context.nodes, minimizedNodeIDs, renderedDockEntries]
  );
  const minimizedDockSlots = useMemo(
    () =>
      resolveWorkbenchMinimizedDockSlots({
        nodeDefinitions,
        nodes: context.minimizedNodes
      }),
    [context.minimizedNodes, nodeDefinitions]
  );
  const { promotedNodeId, stackDispatching } =
    useMinimizedDockStackPromotion(minimizedDockSlots);
  const dockItems = useMemo(
    () =>
      createDockItems({
        minimizedDockSlots,
        resolvedEntries
      }),
    [minimizedDockSlots, resolvedEntries]
  );
  const presentDockItems = useDockPresence(dockItems, (nodeId) =>
    context.genie.shouldAnimateMinimizedDockEnter(nodeId)
  );
  const presentDockItemKeys = useMemo(
    () => presentDockItems.map((item) => item.key).join("\n"),
    [presentDockItems]
  );
  const dockWidth = useMemo(() => getDockItemsWidth(dockItems), [dockItems]);
  const {
    clearSlotMagnification,
    dockFrameSize,
    dockItemsRef,
    dockMeasureRef,
    dockPlateRef,
    dockScrollState,
    handlePointerLeave: handleDockPointerLeave,
    handlePointerMove: handleDockPointerMove,
    pauseMagnification: pauseDockMagnification,
    registerDockSlot,
    registerWallpaperToneElement,
    resetMagnification: resetDockMagnification,
    scrollDockItems: scrollDockViewport,
    slotRefs,
    triggerDockBounce,
    wallpaperTones
  } = useWorkbenchHostDockViewport({
    dockItemsCount: presentDockItems.length,
    dockItemsKey: presentDockItemKeys,
    dockPlacement,
    dockWidth,
    registerDockAnchor: (anchorKey, element) => {
      context.genie.registerDockAnchor(anchorKey, element);
    }
  });

  const {
    activeHoverPanel,
    activeLabelTooltip,
    beginDockIconInteraction,
    clearHoverPanelCloseTimer,
    clearHoverPanelOpenTimer,
    clearHoverPanelRestTarget,
    clearHoverPanelRestTargetForAnchor,
    clearLabelTooltipOpenTimer,
    closeHoverPanelImmediate,
    closeLabelTooltipImmediate,
    dismissHoverPanelForPopup,
    handleDockPointerTravel,
    handleDockRootPointerLeave,
    hoverPanelRef,
    scheduleHoverPanelAfterRest,
    scheduleHoverPanelAtPointAfterRest,
    scheduleHoverPanelClose,
    scheduleLabelTooltipAfterRest,
    scheduleLabelTooltipAtPointAfterRest,
    showHoverPanel,
    showLabelTooltip
  } = useWorkbenchHostDockOverlays({
    dockMeasureRef,
    flushPendingDockStateRefresh,
    handleDockPointerLeave,
    handleDockPointerMove,
    pauseDockMagnification,
    slotRefs,
    triggerDockBounce
  });
  const {
    beginDockMinimizedInteraction,
    claimDockEntryClick,
    clearCollapsingMinimizedLaunch,
    collapsingMinimizedLaunchAnchorKeys,
    isDockEntryClickThrottled,
    runDockMinimizedLaunchAfterCollapse,
    runDockMinimizedStackLaunch
  } = useWorkbenchHostDockInteractions({
    clearHoverPanelOpenTimer,
    clearHoverPanelRestTarget,
    clearLabelTooltipOpenTimer,
    clearSlotMagnification,
    closeHoverPanelImmediate,
    closeLabelTooltipImmediate,
    pauseDockMagnification,
    slotRefs
  });

  const { activeAttentionEntryIds, externalStateRevision } =
    useWorkbenchHostDockActivity({
      activePopup: activePopup !== null,
      context,
      externalStateSource,
      minimizedDockSlots,
      nodeDefinitions,
      renderedDockEntries,
      workspaceId
    });

  const captureMinimizedNodePreview = useCallback(
    async (node: WorkbenchMinimizedDockNode) => {
      const minimizedDock = nodeDefinitions.get(node.data.typeId)?.window
        ?.minimizedDock;
      const capturePreview =
        minimizedDock?.kind === "snapshot"
          ? minimizedDock.capturePreview
          : undefined;
      const externalState = readWorkbenchHostExternalState({
        externalStateSource,
        node,
        workspaceId
      });
      return (
        (await Promise.resolve(
          capturePreview?.({
            externalNodeState: externalState.externalNodeState,
            externalWorkspaceState: externalState.externalWorkspaceState,
            host,
            isFocused: context.focusedNodeId === node.id,
            isMinimized: node.isMinimized,
            node
          }) ?? null
        ).catch(() => null)) ??
        (await Promise.resolve(captureNodePreviewImage?.(node) ?? null).catch(
          () => null
        ))
      );
    },
    [
      captureNodePreviewImage,
      context.focusedNodeId,
      externalStateRevision,
      externalStateSource,
      nodeDefinitions,
      workspaceId
    ]
  );

  const provideMinimizedNodePreview = useCallback(
    (node: WorkbenchMinimizedDockNode): WorkbenchDockPreviewContent | null => {
      const minimizedDock = nodeDefinitions.get(node.data.typeId)?.window
        ?.minimizedDock;
      if (minimizedDock?.kind !== "component") {
        return null;
      }

      const externalState = readWorkbenchHostExternalState({
        externalStateSource,
        node,
        workspaceId
      });
      return minimizedDock.providePreview({
        externalNodeState: externalState.externalNodeState,
        externalWorkspaceState: externalState.externalWorkspaceState,
        host,
        isFocused: context.focusedNodeId === node.id,
        isMinimized: node.isMinimized,
        node,
        previewViewport: minimizedDockPreviewViewport
      });
    },
    [
      context.focusedNodeId,
      externalStateSource,
      host,
      nodeDefinitions,
      workspaceId
    ]
  );

  const provideMinimizedNodePreviewForNode = useCallback(
    (node: WorkbenchMinimizedDockNode) => {
      const minimizedDock = nodeDefinitions.get(node.data.typeId)?.window
        ?.minimizedDock;
      return minimizedDock?.kind === "component"
        ? provideMinimizedNodePreview
        : undefined;
    },
    [nodeDefinitions, provideMinimizedNodePreview]
  );

  const closePopup = () => {
    clearHoverPanelCloseTimer();
    clearHoverPanelOpenTimer();
    clearLabelTooltipOpenTimer();
    clearHoverPanelRestTarget();
    dismissHoverPanelForPopup();
    setActivePopup(null);
    closeLabelTooltipImmediate();
    setActiveMinimizedStackPopup(null);
  };
  const { activateDockEntry, openDockEntryContextMenu } =
    useWorkbenchHostDockEntryActivation({
      closePopup,
      context,
      debugDiagnostics,
      host,
      onDockEntryAction,
      onDockEntryClick,
      setActivePopup,
      workspaceId
    });

  const scrollDockItems = (direction: WorkbenchHostDockScrollDirection) => {
    resetDockMagnification();
    closeHoverPanelImmediate();
    closeLabelTooltipImmediate();
    clearHoverPanelRestTarget();
    scrollDockViewport(direction);
  };

  const runDockEntryAction = useCallback(
    (entryId: string, actionId: string) => {
      const actionKey = createDockActionKey(entryId, actionId);
      if (pendingActionKeys.has(actionKey)) {
        return;
      }
      setPendingActionKeys((current) => {
        const next = new Set(current);
        next.add(actionKey);
        return next;
      });
      void (async () => {
        try {
          await onDockEntryAction?.({
            actionId,
            entryId,
            host
          });
        } catch {
          // Keep dock action failures contained.
        } finally {
          setPendingActionKeys((current) => {
            if (!current.has(actionKey)) {
              return current;
            }
            const next = new Set(current);
            next.delete(actionKey);
            return next;
          });
        }
      })();
    },
    [host, onDockEntryAction, pendingActionKeys]
  );

  const handleMinimizedNodePointerDown = (
    nodeId: string,
    anchorKey: string
  ) => {
    const restoreIntent = resolveWorkbenchMinimizedDockRestoreIntent({
      nodeId,
      slots: minimizedDockSlots,
      source: { anchorKey, kind: "node-slot" }
    });
    if (restoreIntent?.kind !== "node-slot") {
      clearCollapsingMinimizedLaunch(anchorKey);
      return;
    }
    beginDockMinimizedInteraction();
  };

  const handleMinimizedNodeActivate = (nodeId: string, anchorKey: string) => {
    const restoreIntent = resolveWorkbenchMinimizedDockRestoreIntent({
      nodeId,
      slots: minimizedDockSlots,
      source: { anchorKey, kind: "node-slot" }
    });
    if (restoreIntent?.kind !== "node-slot") {
      clearCollapsingMinimizedLaunch(anchorKey);
      return;
    }
    closePopup();
    runDockMinimizedLaunchAfterCollapse(restoreIntent, (intent) => {
      context.genie.launchNodeFromAnchor(
        intent.anchorKey,
        intent.nodeId,
        () => {
          host.focusNode(intent.nodeId);
        }
      );
    });
  };

  const toggleMinimizedStackPopup = (
    anchorRect: WorkbenchHostDockPopupAnchorRect
  ) => {
    setActivePopup(null);
    setActiveMinimizedStackPopup((current) => (current ? null : anchorRect));
  };

  if (dockItems.length === 0 && presentDockItems.length === 0) {
    return null;
  }

  return (
    <div
      className="flex justify-center pointer-events-none"
      data-dock-placement={dockPlacement}
    >
      <div
        ref={dockPlateRef}
        className="desktop-dock-plate"
        data-dock-placement={dockPlacement}
        style={
          dockFrameSize === null
            ? undefined
            : ({
                "--desktop-dock-frame-size": `${dockFrameSize}px`
              } as WorkbenchHostDockPlateStyle)
        }
      >
        <div
          ref={dockMeasureRef}
          aria-label={i18n.t("dockLabel")}
          className="desktop-dock"
          data-dock-placement={dockPlacement}
          data-desktop-dock-root="true"
          data-scroll-overflow={
            dockScrollState.hasOverflow ? "true" : undefined
          }
          data-scroll-backward={
            dockScrollState.canScrollBackward ? "true" : undefined
          }
          data-scroll-forward={
            dockScrollState.canScrollForward ? "true" : undefined
          }
          onPointerLeave={handleDockRootPointerLeave}
          onPointerMoveCapture={(event) => {
            handleDockPointerTravel(event.clientX, event.clientY);
          }}
          role="toolbar"
          style={
            dockPlacement === "left"
              ? { height: dockWidth }
              : { width: dockWidth }
          }
        >
          <span
            className="desktop-dock__pointer-rail"
            data-desktop-dock-pointer-rail="true"
            aria-hidden
          />
          <button
            aria-label={i18n.t(
              dockPlacement === "left" ? "scrollDockUp" : "scrollDockLeft"
            )}
            className="desktop-dock__scroll-button desktop-dock__scroll-button--backward"
            data-scroll-button="backward"
            disabled={!dockScrollState.canScrollBackward}
            onClick={() => scrollDockItems("backward")}
            type="button"
          >
            {dockPlacement === "left" ? (
              <ChevronUpIcon size={16} />
            ) : (
              <ArrowLeftIcon size={16} />
            )}
          </button>
          <div ref={dockItemsRef} className="desktop-dock__items">
            {presentDockItems.map((dockItem) => {
              if (dockItem.item.kind === "separator") {
                return (
                  <span
                    ref={registerWallpaperToneElement(dockItem.key)}
                    className="desktop-dock__separator"
                    aria-hidden="true"
                    data-presence={dockItem.presence}
                    data-wallpaper-tone={wallpaperTones.get(dockItem.key)}
                    key={dockItem.key}
                  />
                );
              }

              if (dockItem.item.kind === "entry") {
                const resolvedEntry = dockItem.item.resolvedEntry;
                const currentPopup =
                  activePopup?.entryId === resolvedEntry.entry.id
                    ? activePopup
                    : null;
                return (
                  <WorkbenchHostDockEntrySlot
                    key={dockItem.key}
                    activeAttention={activeAttentionEntryIds.has(
                      resolvedEntry.entry.id
                    )}
                    beginDockIconInteraction={beginDockIconInteraction}
                    claimDockEntryClick={claimDockEntryClick}
                    currentPopup={currentPopup}
                    isDockEntryClickThrottled={isDockEntryClickThrottled}
                    launchLabel={i18n.t("launch", {
                      title: resolvedEntry.entry.label
                    })}
                    nodeDefinitions={nodeDefinitions}
                    onActivate={activateDockEntry}
                    onOpenContextMenu={openDockEntryContextMenu}
                    overlay={{
                      clearHoverPanelOpenTimer,
                      clearHoverPanelRestTargetForAnchor,
                      clearLabelTooltipOpenTimer,
                      closeHoverPanelImmediate,
                      closeLabelTooltipImmediate,
                      dockMeasureRef,
                      handleDockPointerLeave,
                      hoverPanelRef,
                      scheduleHoverPanelAfterRest,
                      scheduleHoverPanelAtPointAfterRest,
                      scheduleLabelTooltipAfterRest,
                      scheduleLabelTooltipAtPointAfterRest,
                      showHoverPanel,
                      showLabelTooltip
                    }}
                    presence={dockItem.presence}
                    registerDockSlot={registerDockSlot}
                    resolvedEntry={resolvedEntry}
                    wallpaperTone={wallpaperTones.get(resolvedEntry.anchorKey)}
                  />
                );
              }

              const slot = dockItem.item.slot;
              return (
                <WorkbenchHostDockMinimizedSlot
                  key={dockItem.key}
                  activeStackPopup={activeMinimizedStackPopup !== null}
                  capturePreview={captureMinimizedNodePreview}
                  collapsing={collapsingMinimizedLaunchAnchorKeys.has(
                    slot.anchorKey
                  )}
                  dockPreviewCache={dockPreviewCache}
                  isPendingNode={context.genie.isPendingMinimizedDockNode}
                  minimizedWindowsLabel={i18n.t("minimizedWindows")}
                  nodeLaunchLabel={(title) => i18n.t("launch", { title })}
                  onBeginStackInteraction={() =>
                    beginDockMinimizedInteraction()
                  }
                  onNodeActivate={handleMinimizedNodeActivate}
                  onNodePointerDown={handleMinimizedNodePointerDown}
                  onToggleStackPopup={toggleMinimizedStackPopup}
                  overlay={{
                    clearLabelTooltipOpenTimer,
                    closeLabelTooltipImmediate,
                    dockMeasureRef,
                    scheduleLabelTooltipAfterRest,
                    scheduleLabelTooltipAtPointAfterRest,
                    showLabelTooltip
                  }}
                  presence={dockItem.presence}
                  promotedNodeId={promotedNodeId}
                  providePreviewForNode={provideMinimizedNodePreviewForNode}
                  registerDockSlot={registerDockSlot}
                  slot={slot}
                  stackDispatching={stackDispatching}
                  wallpaperTone={wallpaperTones.get(slot.anchorKey)}
                  workspaceId={workspaceId}
                />
              );
            })}
          </div>
          <button
            aria-label={i18n.t(
              dockPlacement === "left" ? "scrollDockDown" : "scrollDockRight"
            )}
            className="desktop-dock__scroll-button desktop-dock__scroll-button--forward"
            data-scroll-button="forward"
            disabled={!dockScrollState.canScrollForward}
            onClick={() => scrollDockItems("forward")}
            type="button"
          >
            {dockPlacement === "left" ? (
              <ChevronDownIcon size={16} />
            ) : (
              <ArrowRightIcon size={16} />
            )}
          </button>
          {activeHoverPanel ? (
            <DockHoverPanel
              entry={
                resolvedEntries.find(
                  (entry) => entry.entry.id === activeHoverPanel.entryId
                )?.entry ?? null
              }
              host={host}
              onDockEntryAction={onDockEntryAction}
              pendingActionKeys={pendingActionKeys}
              placement={dockPlacement}
              hoverPanelRef={hoverPanelRef}
              setPendingActionKeys={setPendingActionKeys}
              state={activeHoverPanel}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  closeHoverPanelImmediate(activeHoverPanel.entryId);
                }
              }}
              onFocus={clearHoverPanelCloseTimer}
              onPointerEnter={clearHoverPanelCloseTimer}
              onPointerLeave={(event) => {
                const relatedTarget = event.relatedTarget;
                const anchorSlot = slotRefs.current.get(
                  activeHoverPanel.anchorKey
                );
                if (
                  relatedTarget instanceof Node &&
                  anchorSlot?.contains(relatedTarget)
                ) {
                  return;
                }
                scheduleHoverPanelClose(activeHoverPanel.entryId);
                handleDockPointerLeave();
              }}
            />
          ) : null}
          {activeLabelTooltip ? (
            <DockLabelTooltip
              placement={dockPlacement}
              state={activeLabelTooltip}
            />
          ) : null}
        </div>
      </div>
      <WorkbenchHostDockPopups
        activeMinimizedStackPopup={activeMinimizedStackPopup}
        activePopup={activePopup}
        captureMinimizedNodePreview={captureMinimizedNodePreview}
        captureNodePreviewImage={captureNodePreviewImage}
        closePopup={closePopup}
        context={context}
        debugDiagnostics={debugDiagnostics}
        dockPlacement={dockPlacement}
        dockPreviewCache={dockPreviewCache}
        externalStateSource={externalStateSource}
        host={host}
        i18n={i18n}
        minimizedDockSlots={minimizedDockSlots}
        minimizedNodeIDs={minimizedNodeIDs}
        nodeDefinitions={nodeDefinitions}
        onDockEntryClick={onDockEntryClick}
        onMissionControlRequestOpen={onMissionControlRequestOpen}
        pendingActionKeys={pendingActionKeys}
        provideMinimizedNodePreview={provideMinimizedNodePreview}
        resolvedEntries={resolvedEntries}
        runDockEntryAction={runDockEntryAction}
        runDockMinimizedStackLaunch={runDockMinimizedStackLaunch}
        workspaceId={workspaceId}
      />
    </div>
  );
}

interface WorkbenchHostDockPlateStyle extends CSSProperties {
  "--desktop-dock-frame-size"?: string;
}
