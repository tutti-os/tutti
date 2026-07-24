import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Button,
  ChevronDownIcon,
  ChevronUpIcon
} from "@tutti-os/ui-system";
import type { WorkbenchDockContext } from "../react/types.ts";
import {
  captureWorkbenchNodePreviewImage,
  readCachedWorkbenchNodePreviewImage,
  writeCachedWorkbenchNodePreviewImage
} from "../react/useWorkbenchGenieAnimation.tsx";
import {
  canCreateNewWindow,
  canCreateNewWindowInDockPopup,
  resolveWorkbenchDockEntries,
  resolveWorkbenchDockEntryClick,
  type ResolvedWorkbenchHostDockEntry
} from "./dockEntries.ts";
import {
  DOCK_ICON_PEAK_SIZE,
  useDockMagnification
} from "./dockMagnification.ts";
import { resolveDockLabelTooltipAnchorRect } from "./dockLabelTooltipAnchor.ts";
import {
  getDockWallpaperImageSample,
  sampleDockWallpaperLuminanceAtElement
} from "./dockWallpaperSampling.ts";
import {
  resolveWorkbenchHostDockScrollState,
  type WorkbenchHostDockScrollState
} from "./dockScrollState.ts";
import {
  createWorkbenchHostExternalStateLookupInput,
  readWorkbenchHostExternalState
} from "./externalState.ts";
import {
  resolveWorkbenchMinimizedDockSlots,
  type WorkbenchMinimizedDockNode,
  type WorkbenchMinimizedDockSlot
} from "./minimizedDockSlots.ts";
import { useMinimizedDockStackPromotion } from "./minimizedDockStackPromotion.ts";
import {
  resolveWorkbenchMinimizedDockRestoreIntent,
  type WorkbenchMinimizedDockRestoreIntent
} from "./minimizedDockRestoreIntent.ts";
import {
  WorkbenchHostDockPopup,
  workbenchHostDockPopupPreviewViewport,
  type WorkbenchHostDockPopupAnchorRect,
  type WorkbenchHostDockPopupState
} from "./WorkbenchHostDockPopup.tsx";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey
} from "../react/dockPreviewCache.ts";
import type {
  WorkbenchDockPreviewContent,
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryStateSource,
  WorkbenchHostExternalStateSource,
  WorkbenchHostHandle,
  WorkbenchHostNodeDefinition,
  WorkbenchHostNodeData,
  WorkbenchHostNodeInstanceStrategy,
  WorkbenchHostProps
} from "./types.ts";
import type { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

type WorkbenchMinimizedDockNodeSlotRestoreIntent = Extract<
  WorkbenchMinimizedDockRestoreIntent,
  { kind: "node-slot" }
>;

type WorkbenchMinimizedDockStackPopupCardRestoreIntent = Extract<
  WorkbenchMinimizedDockRestoreIntent,
  { kind: "stack-popup-card" }
>;

type WorkbenchDockWallpaperTone = "dark" | "light";

const minimizedDockPreviewViewport = {
  height: 34.2,
  width: 46.8
};
const dockPopupNewWindowLaunchSource = "dock-popup-new-window";

function stripDockDescriptionTerminalPunctuation(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith("...") || trimmed.endsWith("…")) {
    return trimmed;
  }
  return trimmed.replace(/[。．.]+$/u, "");
}

function activateDockButtonFromKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  disabled = false
) {
  if (disabled || (event.key !== "Enter" && event.key !== " ")) {
    return;
  }

  event.preventDefault();
  event.currentTarget.click();
}

function isDockVisualMutationActive(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }

  return (
    element.hasAttribute("data-dock-pointer-active") ||
    element.hasAttribute("data-dock-hover-panel-open") ||
    element.querySelector(
      '[data-collapsing="true"], [data-presence="entering"], [data-presence="exiting"], [data-stack-dispatching="true"], [data-promoted-from-stack="true"]'
    ) !== null
  );
}

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
  const dockPlateRef = useRef<HTMLDivElement | null>(null);
  const dockMeasureRef = useRef<HTMLDivElement | null>(null);
  const dockItemsRef = useRef<HTMLDivElement | null>(null);
  const hoverPanelRef = useRef<HTMLDivElement | null>(null);
  const hoverPanelCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const hoverPanelOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const labelTooltipOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const hoverPanelScheduledPointRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const labelTooltipScheduledPointRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const hoverPanelRestTargetRef = useRef<{
    anchorKey: string;
    entryId: string;
  } | null>(null);
  const activeHoverPanelRef = useRef<WorkbenchHostDockHoverPanelState | null>(
    null
  );
  const activeLabelTooltipRef =
    useRef<WorkbenchHostDockLabelTooltipState | null>(null);
  const pendingDockStateRefreshRef = useRef(false);
  const slotRefs = useRef(new Map<string, HTMLElement>());
  const wallpaperToneElementRefs = useRef(new Map<string, HTMLElement>());
  const dockSlotRefCallbacksRef = useRef(
    new Map<string, (element: HTMLElement | null) => void>()
  );
  const previousAttentionTokenByEntryId = useRef(new Map<string, unknown>());
  const dockEntryClickThrottleUntilRef = useRef(new Map<string, number>());
  const attentionTimeouts = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const [activeAttentionEntryIds, setActiveAttentionEntryIds] = useState<
    Set<string>
  >(new Set());
  const [activePopup, setActivePopup] =
    useState<WorkbenchHostDockPopupState | null>(null);
  const [activeHoverPanel, setActiveHoverPanel] =
    useState<WorkbenchHostDockHoverPanelState | null>(null);
  const [activeLabelTooltip, setActiveLabelTooltip] =
    useState<WorkbenchHostDockLabelTooltipState | null>(null);
  const [activeMinimizedStackPopup, setActiveMinimizedStackPopup] =
    useState<WorkbenchHostDockPopupAnchorRect | null>(null);
  const [pendingActionKeys, setPendingActionKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [dockFrameSize, setDockFrameSize] = useState<number | null>(null);
  const { triggerDockBounce } = useDockBounce(slotRefs);
  const [dockScrollState, setDockScrollState] =
    useState<WorkbenchHostDockScrollState>(() => ({
      canScrollBackward: false,
      canScrollForward: false,
      hasOverflow: false
    }));
  const [dockStateRevision, setDockStateRevision] = useState(0);
  const [externalStateRevision, setExternalStateRevision] = useState(0);
  const [
    collapsingMinimizedLaunchAnchorKeys,
    setCollapsingMinimizedLaunchAnchorKeys
  ] = useState<Set<string>>(() => new Set());
  const collapsingMinimizedLaunchTimerRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );

  const clearHoverPanelCloseTimer = useCallback(() => {
    if (hoverPanelCloseTimerRef.current === null) {
      return;
    }
    clearTimeout(hoverPanelCloseTimerRef.current);
    hoverPanelCloseTimerRef.current = null;
  }, []);

  const clearHoverPanelOpenTimer = useCallback(() => {
    if (hoverPanelOpenTimerRef.current === null) {
      return;
    }
    clearTimeout(hoverPanelOpenTimerRef.current);
    hoverPanelOpenTimerRef.current = null;
    hoverPanelScheduledPointRef.current = null;
  }, []);

  const clearLabelTooltipOpenTimer = useCallback(() => {
    if (labelTooltipOpenTimerRef.current === null) {
      return;
    }
    clearTimeout(labelTooltipOpenTimerRef.current);
    labelTooltipOpenTimerRef.current = null;
    labelTooltipScheduledPointRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearHoverPanelCloseTimer();
      clearHoverPanelOpenTimer();
      clearLabelTooltipOpenTimer();
      for (const timer of collapsingMinimizedLaunchTimerRef.current.values()) {
        clearTimeout(timer);
      }
      collapsingMinimizedLaunchTimerRef.current.clear();
    },
    [
      clearHoverPanelCloseTimer,
      clearHoverPanelOpenTimer,
      clearLabelTooltipOpenTimer
    ]
  );

  const clearCollapsingMinimizedLaunch = useCallback((anchorKey: string) => {
    const timer = collapsingMinimizedLaunchTimerRef.current.get(anchorKey);
    if (timer) {
      clearTimeout(timer);
      collapsingMinimizedLaunchTimerRef.current.delete(anchorKey);
    }
    const slotElement = slotRefs.current.get(anchorKey);
    slotElement?.removeAttribute("data-collapsing");
    slotElement?.style.removeProperty("--desktop-dock-collapse-inline-size");
    slotElement?.style.removeProperty("--desktop-dock-collapse-block-size");
    setCollapsingMinimizedLaunchAnchorKeys((current) => {
      if (!current.has(anchorKey)) {
        return current;
      }
      const next = new Set(current);
      next.delete(anchorKey);
      return next;
    });
  }, []);

  const scheduleCollapsingMinimizedLaunchClear = useCallback(
    (anchorKey: string) => {
      const existing = collapsingMinimizedLaunchTimerRef.current.get(anchorKey);
      if (existing) {
        clearTimeout(existing);
      }
      collapsingMinimizedLaunchTimerRef.current.set(
        anchorKey,
        setTimeout(() => {
          clearCollapsingMinimizedLaunch(anchorKey);
        }, minimizedDockSlotLayoutAnimationMs)
      );
    },
    [clearCollapsingMinimizedLaunch]
  );

  useLayoutEffect(() => {
    const element = dockMeasureRef.current;
    if (!element || typeof window === "undefined") {
      return undefined;
    }

    let frameId: number | null = null;
    const updateDockFrameSize = () => {
      frameId = null;
      if (isDockVisualMutationActive(dockMeasureRef.current)) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const nextSize = Math.ceil(
        (dockPlacement === "left" ? rect.height : rect.width) +
          desktopDockPlateChromeWidth
      );
      setDockFrameSize((current) =>
        current === nextSize ? current : nextSize
      );
    };
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(updateDockFrameSize);
    };

    updateDockFrameSize();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [dockPlacement]);

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
      createWorkbenchHostDockItems({
        minimizedDockSlots,
        resolvedEntries
      }),
    [minimizedDockSlots, resolvedEntries]
  );
  const presentDockItems = useDockPresenceItems(dockItems, (nodeId) =>
    context.genie.shouldAnimateMinimizedDockEnter(nodeId)
  );
  const presentDockItemKeys = useMemo(
    () => presentDockItems.map((item) => item.key).join("\n"),
    [presentDockItems]
  );
  const wallpaperTones = useDockWallpaperTones({
    dockItemsRef,
    elementRefs: wallpaperToneElementRefs,
    itemKeys: presentDockItemKeys
  });
  const dockWidth = useMemo(
    () => resolveWorkbenchHostDockItemsWidth(dockItems),
    [dockItems]
  );
  const {
    clearSlotMagnification,
    handlePointerLeave: handleDockPointerLeave,
    handlePointerMove: handleDockPointerMove,
    pauseMagnification: pauseDockMagnification,
    resetMagnification: resetDockMagnification
  } = useDockMagnification({
    dockPlateRef,
    dockPlacement,
    dockRootRef: dockMeasureRef,
    dockViewportRef: dockItemsRef,
    slotRefs
  });
  const clearSlotMagnificationRef = useRef<(anchorKey: string) => void>(() => {
    return;
  });
  const registerDockAnchorRef = useRef(
    (anchorKey: string, element: HTMLElement | null) => {
      context.genie.registerDockAnchor(anchorKey, element);
    }
  );
  clearSlotMagnificationRef.current = (anchorKey) => {
    clearSlotMagnification(anchorKey);
  };
  registerDockAnchorRef.current = (anchorKey, element) => {
    context.genie.registerDockAnchor(anchorKey, element);
  };
  const registerWallpaperToneElement = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) {
        wallpaperToneElementRefs.current.set(key, element);
        return;
      }
      wallpaperToneElementRefs.current.delete(key);
    },
    []
  );

  const setDockHoverPanelOpen = useCallback((open: boolean) => {
    if (open) {
      dockMeasureRef.current?.setAttribute(
        "data-dock-hover-panel-open",
        "true"
      );
      return;
    }
    dockMeasureRef.current?.removeAttribute("data-dock-hover-panel-open");
  }, []);

  useEffect(() => {
    activeHoverPanelRef.current = activeHoverPanel;
  }, [activeHoverPanel]);

  useEffect(() => {
    activeLabelTooltipRef.current = activeLabelTooltip;
  }, [activeLabelTooltip]);

  const closeLabelTooltipImmediate = useCallback(
    (targetKey?: string) => {
      clearLabelTooltipOpenTimer();
      if (
        targetKey !== undefined &&
        activeLabelTooltipRef.current?.key !== targetKey
      ) {
        return;
      }
      if (activeLabelTooltipRef.current === null) {
        return;
      }
      activeLabelTooltipRef.current = null;
      setActiveLabelTooltip(null);
    },
    [clearLabelTooltipOpenTimer]
  );

  const closeHoverPanelImmediate = useCallback(
    (entryId?: string) => {
      clearHoverPanelOpenTimer();
      clearHoverPanelCloseTimer();
      if (
        entryId !== undefined &&
        activeHoverPanelRef.current?.entryId !== entryId
      ) {
        return;
      }
      if (activeHoverPanelRef.current === null) {
        return;
      }
      hoverPanelRestTargetRef.current = null;
      setDockHoverPanelOpen(false);
      activeHoverPanelRef.current = null;
      setActiveHoverPanel(null);
      flushPendingDockStateRefresh();
    },
    [
      clearHoverPanelCloseTimer,
      clearHoverPanelOpenTimer,
      flushPendingDockStateRefresh,
      setDockHoverPanelOpen
    ]
  );

  const scheduleHoverPanelClose = useCallback(
    (entryId?: string) => {
      clearHoverPanelOpenTimer();
      clearHoverPanelCloseTimer();
      hoverPanelCloseTimerRef.current = setTimeout(() => {
        hoverPanelCloseTimerRef.current = null;
        closeHoverPanelImmediate(entryId);
        handleDockPointerLeave();
      }, dockHoverPanelCloseDelayMs);
    },
    [
      clearHoverPanelCloseTimer,
      clearHoverPanelOpenTimer,
      closeHoverPanelImmediate,
      handleDockPointerLeave
    ]
  );

  const showHoverPanel = useCallback(
    (entryId: string, anchorKey: string, anchorElement: HTMLElement): void => {
      const dockElement = dockMeasureRef.current;
      if (!dockElement) {
        return;
      }

      pauseDockMagnification();
      const dockRect = dockElement.getBoundingClientRect();
      const anchorRect = anchorElement.getBoundingClientRect();
      clearHoverPanelCloseTimer();
      const nextHoverPanel = {
        anchorKey,
        anchorRect: {
          height: anchorRect.height,
          left: anchorRect.left - dockRect.left,
          top: anchorRect.top - dockRect.top,
          width: anchorRect.width
        },
        entryId
      };
      setDockHoverPanelOpen(true);
      activeHoverPanelRef.current = nextHoverPanel;
      setActiveHoverPanel(nextHoverPanel);
    },
    [clearHoverPanelCloseTimer, pauseDockMagnification, setDockHoverPanelOpen]
  );

  const scheduleHoverPanelAfterRest = useCallback(
    (entryId: string, anchorKey: string) => {
      hoverPanelRestTargetRef.current = { anchorKey, entryId };
      clearHoverPanelOpenTimer();
      hoverPanelScheduledPointRef.current = null;
      hoverPanelOpenTimerRef.current = setTimeout(() => {
        hoverPanelOpenTimerRef.current = null;
        hoverPanelScheduledPointRef.current = null;
        const pending = hoverPanelRestTargetRef.current;
        if (!pending || pending.entryId !== entryId) {
          return;
        }
        const slotElement = slotRefs.current.get(anchorKey);
        if (!slotElement) {
          return;
        }
        showHoverPanel(entryId, anchorKey, slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [clearHoverPanelOpenTimer, showHoverPanel]
  );

  const showLabelTooltip = useCallback(
    (
      target: WorkbenchHostDockLabelTooltipTarget,
      anchorKey: string,
      anchorElement: HTMLElement
    ): void => {
      const dockElement = dockMeasureRef.current;
      if (!dockElement) {
        return;
      }

      const dockRect = dockElement.getBoundingClientRect();
      const anchorRect = resolveDockLabelTooltipAnchorRect(anchorElement);
      clearLabelTooltipOpenTimer();
      const nextTooltip = {
        anchorKey,
        anchorRect: {
          height: anchorRect.height,
          left: anchorRect.left - dockRect.left,
          top: anchorRect.top - dockRect.top,
          width: anchorRect.width
        },
        key: target.key,
        label: target.label
      };
      activeLabelTooltipRef.current = nextTooltip;
      setActiveLabelTooltip(nextTooltip);
    },
    [clearLabelTooltipOpenTimer]
  );

  const scheduleLabelTooltipAfterRest = useCallback(
    (target: WorkbenchHostDockLabelTooltipTarget, anchorKey: string) => {
      clearLabelTooltipOpenTimer();
      labelTooltipScheduledPointRef.current = null;
      labelTooltipOpenTimerRef.current = setTimeout(() => {
        labelTooltipOpenTimerRef.current = null;
        labelTooltipScheduledPointRef.current = null;
        const slotElement = slotRefs.current.get(anchorKey);
        if (!slotElement) {
          return;
        }
        showLabelTooltip(target, anchorKey, slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [clearLabelTooltipOpenTimer, showLabelTooltip]
  );

  const resolveHoverPanelTargetAtPoint = useCallback(
    (
      clientX: number,
      clientY: number
    ): {
      anchorKey: string;
      entryId: string;
      slotElement: HTMLElement;
    } | null => {
      for (const [anchorKey, slotElement] of slotRefs.current) {
        const entryId = slotElement.dataset.dockHoverPanelEntryId;
        if (!entryId) {
          continue;
        }

        const rect = slotElement.getBoundingClientRect();
        if (
          clientX >= rect.left - dockHoverPanelHitSlopPx &&
          clientX <= rect.right + dockHoverPanelHitSlopPx &&
          clientY >= rect.top - dockHoverPanelHitSlopPx &&
          clientY <= rect.bottom + dockHoverPanelHitSlopPx
        ) {
          return { anchorKey, entryId, slotElement };
        }
      }
      return null;
    },
    []
  );

  const resolveLabelTooltipTargetAtPoint = useCallback(
    (
      clientX: number,
      clientY: number
    ): {
      anchorKey: string;
      slotElement: HTMLElement;
      target: WorkbenchHostDockLabelTooltipTarget;
    } | null => {
      for (const [anchorKey, slotElement] of slotRefs.current) {
        if (slotElement.dataset.dockHoverPanelEntryId) {
          continue;
        }
        const key = slotElement.dataset.dockLabelTooltipKey;
        const label = slotElement.dataset.dockLabelTooltipLabel?.trim() ?? "";
        if (!key || !label) {
          continue;
        }

        const rect = slotElement.getBoundingClientRect();
        if (
          clientX >= rect.left - dockHoverPanelHitSlopPx &&
          clientX <= rect.right + dockHoverPanelHitSlopPx &&
          clientY >= rect.top - dockHoverPanelHitSlopPx &&
          clientY <= rect.bottom + dockHoverPanelHitSlopPx
        ) {
          return {
            anchorKey,
            slotElement,
            target: {
              key,
              label
            }
          };
        }
      }
      return null;
    },
    []
  );

  const isPointerInsideActiveHoverPanelRegion = useCallback(
    (clientX: number, clientY: number): boolean => {
      const activeHoverPanel = activeHoverPanelRef.current;
      if (!activeHoverPanel) {
        return false;
      }

      const anchorSlot = slotRefs.current.get(activeHoverPanel.anchorKey);
      const panel = hoverPanelRef.current;
      if (
        !anchorSlot ||
        !panel ||
        !anchorSlot.isConnected ||
        !panel.isConnected
      ) {
        return false;
      }

      const anchorRect = anchorSlot.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return (
        rectContainsPoint(
          anchorRect,
          clientX,
          clientY,
          dockHoverPanelHitSlopPx
        ) ||
        rectContainsPoint(
          panelRect,
          clientX,
          clientY,
          dockHoverPanelHitSlopPx
        ) ||
        rectContainsPoint(
          createHoverPanelBridgeRect(anchorRect, panelRect),
          clientX,
          clientY,
          dockHoverPanelBridgeSlopPx
        )
      );
    },
    []
  );

  const scheduleHoverPanelAtPointAfterRest = useCallback(
    (clientX: number, clientY: number) => {
      const scheduledPoint = hoverPanelScheduledPointRef.current;
      if (
        hoverPanelOpenTimerRef.current !== null &&
        scheduledPoint &&
        Math.abs(clientX - scheduledPoint.clientX) <=
          dockHoverPanelPointerRestTolerancePx &&
        Math.abs(clientY - scheduledPoint.clientY) <=
          dockHoverPanelPointerRestTolerancePx
      ) {
        return;
      }

      clearHoverPanelOpenTimer();
      hoverPanelScheduledPointRef.current = { clientX, clientY };
      hoverPanelOpenTimerRef.current = setTimeout(() => {
        hoverPanelOpenTimerRef.current = null;
        hoverPanelScheduledPointRef.current = null;
        if (activeHoverPanelRef.current !== null) {
          return;
        }
        const target = resolveHoverPanelTargetAtPoint(clientX, clientY);
        if (!target) {
          hoverPanelRestTargetRef.current = null;
          return;
        }
        hoverPanelRestTargetRef.current = {
          anchorKey: target.anchorKey,
          entryId: target.entryId
        };
        showHoverPanel(target.entryId, target.anchorKey, target.slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [clearHoverPanelOpenTimer, resolveHoverPanelTargetAtPoint, showHoverPanel]
  );

  const scheduleLabelTooltipAtPointAfterRest = useCallback(
    (clientX: number, clientY: number) => {
      if (activeLabelTooltipRef.current !== null) {
        return;
      }

      const scheduledPoint = labelTooltipScheduledPointRef.current;
      if (
        labelTooltipOpenTimerRef.current !== null &&
        scheduledPoint &&
        Math.abs(clientX - scheduledPoint.clientX) <=
          dockHoverPanelPointerRestTolerancePx &&
        Math.abs(clientY - scheduledPoint.clientY) <=
          dockHoverPanelPointerRestTolerancePx
      ) {
        return;
      }

      clearLabelTooltipOpenTimer();
      labelTooltipScheduledPointRef.current = { clientX, clientY };
      labelTooltipOpenTimerRef.current = setTimeout(() => {
        labelTooltipOpenTimerRef.current = null;
        labelTooltipScheduledPointRef.current = null;
        if (activeHoverPanelRef.current !== null) {
          return;
        }
        const target = resolveLabelTooltipTargetAtPoint(clientX, clientY);
        if (!target) {
          return;
        }
        showLabelTooltip(target.target, target.anchorKey, target.slotElement);
      }, dockHoverPanelOpenDelayMs);
    },
    [
      clearLabelTooltipOpenTimer,
      resolveLabelTooltipTargetAtPoint,
      showLabelTooltip
    ]
  );

  const beginDockIconInteraction = useCallback(
    (anchorKey: string) => {
      hoverPanelRestTargetRef.current = null;
      clearHoverPanelOpenTimer();
      closeLabelTooltipImmediate();
      closeHoverPanelImmediate();
      triggerDockBounce(anchorKey);
    },
    [
      clearHoverPanelOpenTimer,
      closeHoverPanelImmediate,
      closeLabelTooltipImmediate,
      triggerDockBounce
    ]
  );

  const isDockEntryClickThrottled = useCallback(
    (anchorKey: string): boolean => {
      const throttledUntil =
        dockEntryClickThrottleUntilRef.current.get(anchorKey);
      return throttledUntil !== undefined && Date.now() < throttledUntil;
    },
    []
  );

  const claimDockEntryClick = useCallback((anchorKey: string): void => {
    dockEntryClickThrottleUntilRef.current.set(
      anchorKey,
      Date.now() + DOCK_ENTRY_CLICK_THROTTLE_MS
    );
  }, []);

  const beginDockMinimizedInteraction = useCallback(
    (anchorKey?: string): boolean => {
      hoverPanelRestTargetRef.current = null;
      clearHoverPanelOpenTimer();
      clearLabelTooltipOpenTimer();
      closeLabelTooltipImmediate();
      closeHoverPanelImmediate();
      pauseDockMagnification();

      if (!anchorKey) {
        return false;
      }
      const slotElement = slotRefs.current.get(anchorKey);
      if (!slotElement) {
        return false;
      }
      clearSlotMagnification(anchorKey);
      if (slotElement.dataset.collapsing === "true") {
        return true;
      }
      const rect = slotElement.getBoundingClientRect();
      slotElement.style.setProperty(
        "--desktop-dock-collapse-inline-size",
        `${rect.width}px`
      );
      slotElement.style.setProperty(
        "--desktop-dock-collapse-block-size",
        `${rect.height}px`
      );
      slotElement.dataset.collapsing = "true";
      return true;
    },
    [
      clearHoverPanelOpenTimer,
      clearLabelTooltipOpenTimer,
      clearSlotMagnification,
      closeHoverPanelImmediate,
      closeLabelTooltipImmediate,
      pauseDockMagnification
    ]
  );

  const runDockMinimizedLaunchAfterCollapse = useCallback(
    (
      intent: WorkbenchMinimizedDockNodeSlotRestoreIntent,
      launch: (intent: WorkbenchMinimizedDockNodeSlotRestoreIntent) => void
    ) => {
      const { anchorKey } = intent;
      beginDockMinimizedInteraction(anchorKey);
      setCollapsingMinimizedLaunchAnchorKeys((current) => {
        const next = new Set(current);
        next.add(anchorKey);
        return next;
      });
      scheduleCollapsingMinimizedLaunchClear(anchorKey);
      launch(intent);
    },
    [beginDockMinimizedInteraction, scheduleCollapsingMinimizedLaunchClear]
  );

  const runDockMinimizedStackLaunch = useCallback(
    (
      intent: WorkbenchMinimizedDockStackPopupCardRestoreIntent,
      launch: (
        intent: WorkbenchMinimizedDockStackPopupCardRestoreIntent
      ) => void
    ) => {
      beginDockMinimizedInteraction();
      launch(intent);
    },
    [beginDockMinimizedInteraction]
  );

  const handleDockPointerTravel = useCallback(
    (clientX: number, clientY: number) => {
      if (activeHoverPanelRef.current !== null) {
        closeLabelTooltipImmediate();
        if (isPointerInsideActiveHoverPanelRegion(clientX, clientY)) {
          clearHoverPanelCloseTimer();
          return;
        }
        scheduleHoverPanelClose(activeHoverPanelRef.current.entryId);
        handleDockPointerLeave();
        return;
      }

      const activeLabelTooltip = activeLabelTooltipRef.current;
      if (activeLabelTooltip) {
        const target = resolveLabelTooltipTargetAtPoint(clientX, clientY);
        if (target?.target.key !== activeLabelTooltip.key) {
          closeLabelTooltipImmediate(activeLabelTooltip.key);
        }
      }

      handleDockPointerMove(clientX, clientY);
      scheduleHoverPanelAtPointAfterRest(clientX, clientY);
      scheduleLabelTooltipAtPointAfterRest(clientX, clientY);
    },
    [
      clearHoverPanelCloseTimer,
      closeLabelTooltipImmediate,
      handleDockPointerMove,
      handleDockPointerLeave,
      isPointerInsideActiveHoverPanelRegion,
      resolveLabelTooltipTargetAtPoint,
      scheduleHoverPanelClose,
      scheduleHoverPanelAtPointAfterRest,
      scheduleLabelTooltipAtPointAfterRest
    ]
  );

  const updateDockScrollState = useCallback(() => {
    const scrollElement = dockItemsRef.current;
    const viewportElement = dockMeasureRef.current;
    if (!scrollElement || !viewportElement) {
      setDockScrollState((current) =>
        current.hasOverflow ||
        current.canScrollBackward ||
        current.canScrollForward
          ? {
              canScrollBackward: false,
              canScrollForward: false,
              hasOverflow: false
            }
          : current
      );
      return;
    }

    const isVertical = dockPlacement === "left";
    const viewportSize = isVertical
      ? viewportElement.clientHeight
      : viewportElement.clientWidth;
    const scrollSize = isVertical
      ? scrollElement.scrollHeight
      : scrollElement.scrollWidth;
    const scrollOffset = isVertical
      ? scrollElement.scrollTop
      : scrollElement.scrollLeft;
    const nextState = resolveWorkbenchHostDockScrollState({
      contentSize: dockWidth,
      scrollOffset,
      scrollSize,
      viewportSize
    });

    setDockScrollState((current) =>
      current.canScrollBackward === nextState.canScrollBackward &&
      current.canScrollForward === nextState.canScrollForward &&
      current.hasOverflow === nextState.hasOverflow
        ? current
        : nextState
    );
  }, [dockPlacement, dockWidth]);

  useLayoutEffect(() => {
    const element = dockItemsRef.current;
    if (!element || typeof window === "undefined") {
      return undefined;
    }

    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (isDockVisualMutationActive(dockMeasureRef.current)) {
        return;
      }
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateDockScrollState();
      });
    };

    updateDockScrollState();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);
    element.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      element.removeEventListener("scroll", scheduleUpdate);
    };
  }, [dockPlacement, presentDockItems.length, updateDockScrollState]);

  const hasMinimizedPreviewCapture = minimizedDockSlots.some((slot) =>
    minimizedDockSlotNodes(slot).some((node) =>
      (() => {
        if (context.genie.isPendingMinimizedDockNode(node.id)) {
          return false;
        }
        const minimizedDock = nodeDefinitions.get(node.data.typeId)?.window
          ?.minimizedDock;
        return (
          minimizedDock?.kind === "snapshot" &&
          Boolean(minimizedDock.capturePreview)
        );
      })()
    )
  );

  useEffect(() => {
    const shouldSubscribe = activePopup !== null || hasMinimizedPreviewCapture;
    if (!shouldSubscribe || !externalStateSource?.subscribeNodeState) {
      return undefined;
    }
    const nodes = activePopup ? context.nodes : context.minimizedNodes;
    const disposers = nodes.map((node) =>
      externalStateSource.subscribeNodeState?.(
        createWorkbenchHostExternalStateLookupInput({ node, workspaceId }),
        () => setExternalStateRevision((revision) => revision + 1)
      )
    );
    return () => {
      for (const dispose of disposers) {
        dispose?.();
      }
    };
  }, [
    activePopup,
    context.minimizedNodes,
    context.nodes,
    externalStateSource,
    hasMinimizedPreviewCapture,
    workspaceId
  ]);

  useEffect(() => {
    const nextAttentionIds = new Set<string>();

    for (const entry of renderedDockEntries) {
      const nextToken = entry.attentionToken ?? null;
      const previousToken =
        previousAttentionTokenByEntryId.current.get(entry.id) ?? null;
      if (nextToken !== null && nextToken !== previousToken) {
        nextAttentionIds.add(entry.id);
      }
      previousAttentionTokenByEntryId.current.set(entry.id, nextToken);
    }

    if (nextAttentionIds.size === 0) {
      return;
    }

    setActiveAttentionEntryIds((current) => {
      const next = new Set(current);
      for (const entryId of nextAttentionIds) {
        next.add(entryId);
      }
      return next;
    });

    for (const entryId of nextAttentionIds) {
      const existingTimeout = attentionTimeouts.current.get(entryId);
      if (existingTimeout) {
        globalThis.clearTimeout(existingTimeout);
      }
      attentionTimeouts.current.set(
        entryId,
        globalThis.setTimeout(() => {
          attentionTimeouts.current.delete(entryId);
          setActiveAttentionEntryIds((current) => {
            if (!current.has(entryId)) {
              return current;
            }
            const next = new Set(current);
            next.delete(entryId);
            return next;
          });
        }, 900)
      );
    }
  }, [renderedDockEntries]);

  useEffect(
    () => () => {
      for (const timeout of attentionTimeouts.current.values()) {
        globalThis.clearTimeout(timeout);
      }
      attentionTimeouts.current.clear();
    },
    []
  );

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
    hoverPanelRestTargetRef.current = null;
    setDockHoverPanelOpen(false);
    setActivePopup(null);
    setActiveHoverPanel(null);
    closeLabelTooltipImmediate();
    setActiveMinimizedStackPopup(null);
  };

  const scrollDockItems = (direction: WorkbenchHostDockScrollDirection) => {
    const element = dockItemsRef.current;
    if (!element) {
      return;
    }

    resetDockMagnification();
    closeHoverPanelImmediate();
    closeLabelTooltipImmediate();
    hoverPanelRestTargetRef.current = null;

    const isVertical = dockPlacement === "left";
    const viewportSize = isVertical
      ? element.clientHeight
      : element.clientWidth;
    const delta =
      Math.max(DOCK_ICON_PEAK_SIZE * 2, viewportSize * 0.72) *
      (direction === "forward" ? 1 : -1);

    element.scrollBy({
      behavior: "smooth",
      left: isVertical ? 0 : delta,
      top: isVertical ? delta : 0
    });
  };

  const registerDockSlot = useCallback((anchorKey: string) => {
    const existing = dockSlotRefCallbacksRef.current.get(anchorKey);
    if (existing) {
      return existing;
    }

    const callback = (element: HTMLElement | null) => {
      if (element) {
        slotRefs.current.set(anchorKey, element);
        wallpaperToneElementRefs.current.set(anchorKey, element);
      } else {
        slotRefs.current.delete(anchorKey);
        wallpaperToneElementRefs.current.delete(anchorKey);
        if (!dockMeasureRef.current?.hasAttribute("data-dock-pointer-active")) {
          clearSlotMagnificationRef.current(anchorKey);
        }
      }
      registerDockAnchorRef.current(anchorKey, element);
    };
    dockSlotRefCallbacksRef.current.set(anchorKey, callback);
    return callback;
  }, []);

  const runDockEntryAction = useCallback(
    (entryId: string, actionId: string) => {
      const actionKey = dockActionKey(entryId, actionId);
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

  if (dockItems.length === 0 && presentDockItems.length === 0) {
    return null;
  }

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
          onPointerLeave={() => {
            hoverPanelRestTargetRef.current = null;
            clearHoverPanelOpenTimer();
            clearLabelTooltipOpenTimer();
            closeLabelTooltipImmediate();
            closeHoverPanelImmediate();
            handleDockPointerLeave();
            flushPendingDockStateRefresh();
          }}
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
                const { anchorKey, entry } = resolvedEntry;
                const currentPopup =
                  activePopup?.entryId === entry.id ? activePopup : null;
                const instanceMode = resolveDockEntryInstanceMode(
                  entry,
                  nodeDefinitions
                );
                const clickResolution = resolveWorkbenchDockEntryClick({
                  entry,
                  instanceMode,
                  matchedNodes: resolvedEntry.matchedNodes
                });
                const hasHoverPanel = dockEntryHasHoverPanel(entry);
                const labelTooltipTarget = hasHoverPanel
                  ? null
                  : dockLabelTooltipTarget(`entry:${entry.id}`, entry.label);
                const dockButton = (
                  <button
                    aria-expanded={currentPopup ? true : undefined}
                    aria-haspopup={
                      clickResolution.kind === "open-popup"
                        ? "dialog"
                        : undefined
                    }
                    aria-label={i18n.t("launch", { title: entry.label })}
                    aria-disabled={
                      clickResolution.kind === "blocked" ? true : undefined
                    }
                    className="desktop-dock__btn"
                    data-interactive={
                      clickResolution.kind === "blocked" ? "false" : "true"
                    }
                    data-dock-hover-panel-trigger={
                      hasHoverPanel ? "true" : undefined
                    }
                    type="button"
                    onPointerDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }
                      if (clickResolution.kind === "blocked") {
                        return;
                      }
                      if (isDockEntryClickThrottled(anchorKey)) {
                        return;
                      }
                      beginDockIconInteraction(anchorKey);
                    }}
                    onClick={(event) => {
                      if (clickResolution.kind === "blocked") {
                        return;
                      }
                      if (isDockEntryClickThrottled(anchorKey)) {
                        return;
                      }
                      claimDockEntryClick(anchorKey);
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
                        matchedNodeIds: resolvedEntry.matchedNodes.map(
                          (node) => node.id
                        ),
                        typeId: entry.typeId,
                        workspaceId
                      });
                      switch (clickResolution.kind) {
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
                        case "open-popup": {
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          logWorkbenchDockDebug(
                            "dock.popup.toggle",
                            debugDiagnostics,
                            {
                              anchorKey,
                              entryId: entry.id,
                              matchedNodeCount:
                                resolvedEntry.matchedNodes.length,
                              nextOpen: currentPopup === null,
                              typeId: entry.typeId,
                              workspaceId
                            }
                          );
                          setActivePopup((current) =>
                            current?.entryId === entry.id
                              ? null
                              : {
                                  anchorRect: {
                                    height: rect.height,
                                    left: rect.left,
                                    top: rect.top,
                                    width: rect.width
                                  },
                                  kind: "preview",
                                  entryId: entry.id
                                }
                          );
                          return;
                        }
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
                          context.genie.launchNodeFromAnchor(
                            anchorKey,
                            entry.id,
                            () =>
                              host.launchNode({
                                dockEntryId: entry.id,
                                payload: entry.launchPayload,
                                reason: "dock",
                                typeId: entry.typeId
                              })
                          );
                          return;
                      }
                    }}
                    onContextMenu={(event) => {
                      if (
                        clickResolution.kind === "blocked" ||
                        !dockEntryHasContextMenu(entry, resolvedEntry)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      logWorkbenchDockDebug(
                        "dock.popup.context_menu",
                        debugDiagnostics,
                        {
                          anchorKey,
                          entryId: entry.id,
                          matchedNodeCount: resolvedEntry.matchedNodes.length,
                          typeId: entry.typeId,
                          workspaceId
                        }
                      );
                      setActivePopup({
                        anchorRect: {
                          height: rect.height,
                          left: rect.left,
                          top: rect.top,
                          width: rect.width
                        },
                        kind: "context-menu",
                        entryId: entry.id
                      });
                    }}
                  >
                    <span
                      className="desktop-dock__icon-shell"
                      data-desktop-dock-icon-shell="true"
                      data-entry-state={entry.state?.kind ?? "enabled"}
                      aria-hidden
                    >
                      <span className="desktop-dock__icon-content">
                        {entry.icon}
                      </span>
                      {renderDockBadge(
                        entry,
                        resolvedEntry.matchedNodes.length
                      )}
                    </span>
                  </button>
                );

                return (
                  <span
                    key={dockItem.key}
                    ref={registerDockSlot(anchorKey)}
                    className="desktop-dock__slot"
                    data-attention-active={
                      activeAttentionEntryIds.has(entry.id) ? "true" : undefined
                    }
                    data-desktop-dock-anchor-key={anchorKey}
                    data-desktop-dock-slot="true"
                    data-entry-state={entry.state?.kind ?? "enabled"}
                    data-dock-hover-panel-entry-id={
                      hasHoverPanel ? entry.id : undefined
                    }
                    data-dock-label-tooltip-key={labelTooltipTarget?.key}
                    data-dock-label-tooltip-label={labelTooltipTarget?.label}
                    data-icon-size={entry.iconSize ?? "default"}
                    data-node-state={resolvedEntry.dockNodeState}
                    data-popup-active={currentPopup ? "true" : undefined}
                    data-presence={dockItem.presence}
                    data-section-id={entry.sectionId}
                    data-wallpaper-tone={wallpaperTones.get(anchorKey)}
                    onBlur={(event) => {
                      if (
                        hasHoverPanel &&
                        !event.currentTarget.contains(event.relatedTarget)
                      ) {
                        closeHoverPanelImmediate(entry.id);
                      }
                      if (
                        labelTooltipTarget &&
                        !event.currentTarget.contains(event.relatedTarget)
                      ) {
                        closeLabelTooltipImmediate(labelTooltipTarget.key);
                      }
                    }}
                    onFocus={(event) => {
                      if (hasHoverPanel) {
                        showHoverPanel(
                          entry.id,
                          anchorKey,
                          event.currentTarget
                        );
                        return;
                      }
                      if (labelTooltipTarget) {
                        showLabelTooltip(
                          labelTooltipTarget,
                          anchorKey,
                          event.currentTarget
                        );
                      }
                    }}
                    onPointerEnter={() => {
                      if (hasHoverPanel) {
                        scheduleHoverPanelAfterRest(entry.id, anchorKey);
                        return;
                      }
                      if (labelTooltipTarget) {
                        scheduleLabelTooltipAfterRest(
                          labelTooltipTarget,
                          anchorKey
                        );
                      }
                    }}
                    onPointerLeave={(event) => {
                      if (!hasHoverPanel) {
                        if (labelTooltipTarget) {
                          clearLabelTooltipOpenTimer();
                          closeLabelTooltipImmediate(labelTooltipTarget.key);
                          const relatedTarget = event.relatedTarget;
                          if (
                            relatedTarget instanceof Node &&
                            dockMeasureRef.current?.contains(relatedTarget)
                          ) {
                            scheduleLabelTooltipAtPointAfterRest(
                              event.clientX,
                              event.clientY
                            );
                          }
                        }
                        return;
                      }
                      const relatedTarget = event.relatedTarget;
                      if (
                        relatedTarget instanceof Node &&
                        hoverPanelRef.current?.contains(relatedTarget)
                      ) {
                        return;
                      }
                      if (
                        relatedTarget instanceof Node &&
                        dockMeasureRef.current?.contains(relatedTarget)
                      ) {
                        scheduleHoverPanelAtPointAfterRest(
                          event.clientX,
                          event.clientY
                        );
                        return;
                      }
                      if (
                        hoverPanelRestTargetRef.current?.anchorKey === anchorKey
                      ) {
                        hoverPanelRestTargetRef.current = null;
                      }
                      clearHoverPanelOpenTimer();
                      closeHoverPanelImmediate(entry.id);
                      handleDockPointerLeave();
                    }}
                  >
                    {dockButton}
                  </span>
                );
              }

              const slot = dockItem.item.slot;
              if (slot.kind === "stack") {
                const stackPopupActive =
                  activeMinimizedStackPopup !== null ? true : undefined;
                const stackLabel = i18n.t("minimizedWindows");
                const labelTooltipTarget = dockLabelTooltipTarget(
                  `minimized-stack:${slot.anchorKey}`,
                  stackLabel
                );
                const stackButton = (
                  <span
                    aria-expanded={stackPopupActive}
                    aria-haspopup="dialog"
                    aria-label={stackLabel}
                    className="desktop-dock__btn desktop-dock__minimized-btn"
                    data-interactive="true"
                    role="button"
                    tabIndex={0}
                    onKeyDown={activateDockButtonFromKeyboard}
                    onPointerDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }
                      beginDockMinimizedInteraction();
                    }}
                    onClick={(event) => {
                      setActivePopup(null);
                      const rect = event.currentTarget.getBoundingClientRect();
                      const dockRect =
                        dockMeasureRef.current?.getBoundingClientRect();
                      setActiveMinimizedStackPopup((current) =>
                        current
                          ? null
                          : {
                              dockRight: Math.max(
                                rect.right,
                                dockRect?.right ?? rect.right
                              ),
                              height: rect.height,
                              left: rect.left,
                              top: rect.top,
                              width: rect.width
                            }
                      );
                    }}
                  >
                    <span
                      className="desktop-dock__minimized-stack-icon"
                      data-desktop-dock-icon-shell="true"
                      data-stack-folded={
                        slot.nodes.length > 1 ? "true" : undefined
                      }
                      aria-hidden
                    >
                      {Array.from(
                        {
                          length:
                            slot.nodes.length > 1
                              ? 3
                              : Math.min(slot.nodes.length, 1)
                        },
                        (_, index) => {
                          const node = slot.nodes[index];
                          if (index === 0 && node) {
                            return (
                              <WorkbenchHostDockMinimizedNodePreview
                                key={minimizedDockPreviewFreezeKey(node)}
                                capturePreview={captureMinimizedNodePreview}
                                className={`desktop-dock__minimized-stack-layer desktop-dock__minimized-stack-layer--${index}`}
                                dockPreviewCache={dockPreviewCache}
                                node={node}
                                providePreview={provideMinimizedNodePreviewForNode(
                                  node
                                )}
                                workspaceId={workspaceId}
                              />
                            );
                          }
                          return (
                            <span
                              key={`${slot.anchorKey}-stack-back-${index}`}
                              aria-hidden="true"
                              className={`desktop-dock__minimized-preview desktop-dock__minimized-stack-layer desktop-dock__minimized-stack-layer--${index} desktop-dock__minimized-stack-layer-back`}
                            />
                          );
                        }
                      )}
                      <span className="desktop-dock__count-badge">
                        {slot.nodes.length}
                      </span>
                    </span>
                  </span>
                );

                return (
                  <span
                    key={dockItem.key}
                    ref={registerDockSlot(slot.anchorKey)}
                    className="desktop-dock__slot desktop-dock__slot--minimized"
                    data-desktop-dock-anchor-key={slot.anchorKey}
                    data-desktop-dock-slot="true"
                    data-dock-label-tooltip-key={labelTooltipTarget.key}
                    data-dock-label-tooltip-label={labelTooltipTarget.label}
                    data-node-state="minimized"
                    data-popup-active={stackPopupActive}
                    data-presence={dockItem.presence}
                    data-section-id="minimized"
                    data-stack-dispatching={
                      stackDispatching ? "true" : undefined
                    }
                    data-wallpaper-tone={wallpaperTones.get(slot.anchorKey)}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) {
                        closeLabelTooltipImmediate(labelTooltipTarget.key);
                      }
                    }}
                    onFocus={(event) => {
                      showLabelTooltip(
                        labelTooltipTarget,
                        slot.anchorKey,
                        event.currentTarget
                      );
                    }}
                    onPointerEnter={() => {
                      scheduleLabelTooltipAfterRest(
                        labelTooltipTarget,
                        slot.anchorKey
                      );
                    }}
                    onPointerLeave={(event) => {
                      clearLabelTooltipOpenTimer();
                      closeLabelTooltipImmediate(labelTooltipTarget.key);
                      const relatedTarget = event.relatedTarget;
                      if (
                        relatedTarget instanceof Node &&
                        dockMeasureRef.current?.contains(relatedTarget)
                      ) {
                        scheduleLabelTooltipAtPointAfterRest(
                          event.clientX,
                          event.clientY
                        );
                      }
                    }}
                  >
                    {stackButton}
                  </span>
                );
              }

              const node = slot.node;
              const isPendingMinimizedNode =
                context.genie.isPendingMinimizedDockNode(node.id);
              const labelTooltipTarget = dockLabelTooltipTarget(
                `minimized-node:${node.id}`,
                node.title
              );
              const dockButton = (
                <span
                  aria-label={i18n.t("launch", { title: node.title })}
                  aria-disabled={isPendingMinimizedNode ? true : undefined}
                  className="desktop-dock__btn desktop-dock__minimized-btn"
                  data-interactive={isPendingMinimizedNode ? "false" : "true"}
                  role="button"
                  tabIndex={isPendingMinimizedNode ? -1 : 0}
                  onKeyDown={(event) =>
                    activateDockButtonFromKeyboard(
                      event,
                      isPendingMinimizedNode
                    )
                  }
                  onPointerDown={(event) => {
                    if (event.button !== 0 || isPendingMinimizedNode) {
                      return;
                    }
                    const restoreIntent =
                      resolveWorkbenchMinimizedDockRestoreIntent({
                        nodeId: node.id,
                        slots: minimizedDockSlots,
                        source: {
                          anchorKey: slot.anchorKey,
                          kind: "node-slot"
                        }
                      });
                    if (restoreIntent?.kind !== "node-slot") {
                      clearCollapsingMinimizedLaunch(slot.anchorKey);
                      return;
                    }
                    beginDockMinimizedInteraction();
                  }}
                  onClick={() => {
                    if (isPendingMinimizedNode) {
                      return;
                    }
                    const restoreIntent =
                      resolveWorkbenchMinimizedDockRestoreIntent({
                        nodeId: node.id,
                        slots: minimizedDockSlots,
                        source: {
                          anchorKey: slot.anchorKey,
                          kind: "node-slot"
                        }
                      });
                    if (restoreIntent?.kind !== "node-slot") {
                      clearCollapsingMinimizedLaunch(slot.anchorKey);
                      return;
                    }
                    closePopup();
                    runDockMinimizedLaunchAfterCollapse(
                      restoreIntent,
                      (intent) => {
                        context.genie.launchNodeFromAnchor(
                          intent.anchorKey,
                          intent.nodeId,
                          () => {
                            host.focusNode(intent.nodeId);
                          }
                        );
                      }
                    );
                  }}
                >
                  <WorkbenchHostDockMinimizedNodePreview
                    key={minimizedDockPreviewFreezeKey(node)}
                    capturePreview={
                      isPendingMinimizedNode
                        ? undefined
                        : captureMinimizedNodePreview
                    }
                    deferPreview={isPendingMinimizedNode}
                    dockPreviewCache={
                      isPendingMinimizedNode ? undefined : dockPreviewCache
                    }
                    node={node}
                    providePreview={
                      isPendingMinimizedNode
                        ? undefined
                        : provideMinimizedNodePreviewForNode(node)
                    }
                    workspaceId={workspaceId}
                  />
                </span>
              );

              return (
                <span
                  key={dockItem.key}
                  ref={registerDockSlot(slot.anchorKey)}
                  className="desktop-dock__slot desktop-dock__slot--minimized"
                  data-collapsing={
                    collapsingMinimizedLaunchAnchorKeys.has(slot.anchorKey)
                      ? "true"
                      : undefined
                  }
                  data-desktop-dock-anchor-key={slot.anchorKey}
                  data-desktop-dock-slot="true"
                  data-dock-label-tooltip-key={labelTooltipTarget.key}
                  data-dock-label-tooltip-label={labelTooltipTarget.label}
                  data-node-state="minimized"
                  data-pending-minimize={
                    isPendingMinimizedNode ? "true" : undefined
                  }
                  data-presence={dockItem.presence}
                  data-promoted-from-stack={
                    promotedNodeId === node.id ? "true" : undefined
                  }
                  data-section-id="minimized"
                  data-wallpaper-tone={wallpaperTones.get(slot.anchorKey)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      closeLabelTooltipImmediate(labelTooltipTarget.key);
                    }
                  }}
                  onFocus={(event) => {
                    showLabelTooltip(
                      labelTooltipTarget,
                      slot.anchorKey,
                      event.currentTarget
                    );
                  }}
                  onPointerEnter={() => {
                    scheduleLabelTooltipAfterRest(
                      labelTooltipTarget,
                      slot.anchorKey
                    );
                  }}
                  onPointerLeave={(event) => {
                    clearLabelTooltipOpenTimer();
                    closeLabelTooltipImmediate(labelTooltipTarget.key);
                    const relatedTarget = event.relatedTarget;
                    if (
                      relatedTarget instanceof Node &&
                      dockMeasureRef.current?.contains(relatedTarget)
                    ) {
                      scheduleLabelTooltipAtPointAfterRest(
                        event.clientX,
                        event.clientY
                      );
                    }
                  }}
                >
                  {dockButton}
                </span>
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
            <WorkbenchHostDockHoverPanel
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
            <WorkbenchHostDockLabelTooltip
              placement={dockPlacement}
              state={activeLabelTooltip}
            />
          ) : null}
        </div>
      </div>
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
            popupEntry.entry.capturePopupItemPreview
              ? async (item) => {
                  const previewImageUrl = await Promise.resolve(
                    popupEntry.entry.capturePopupItemPreview?.(item) ?? null
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
              anchorKeyFromPopupEntry(popupEntry),
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
              anchorKeyFromPopupEntry(popupEntry),
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
              onMissionControlRequestOpen?.("activate", {
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
            const src = await captureMinimizedNodePreview(item.node);
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
                          readCachedWorkbenchNodePreviewImage(node.id);
                        return previewImageUrl
                          ? ({ kind: "image", src: previewImageUrl } as const)
                          : null;
                      })(),
              previewRevision: null,
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
    </div>
  );
}

function WorkbenchHostDockMinimizedNodePreview({
  capturePreview,
  className,
  deferPreview = false,
  dockPreviewCache,
  node,
  providePreview,
  workspaceId
}: {
  capturePreview?: (
    node: WorkbenchMinimizedDockNode
  ) => Promise<string | null> | string | null;
  className?: string;
  deferPreview?: boolean;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  node: WorkbenchMinimizedDockNode;
  providePreview?: (
    node: WorkbenchMinimizedDockNode
  ) => WorkbenchDockPreviewContent | null;
  workspaceId: string;
}) {
  const [componentPreview, setComponentPreview] = useState<
    WorkbenchDockPreviewContent | null | undefined
  >(undefined);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(() =>
    deferPreview ? null : readCachedWorkbenchNodePreviewImage(node.id)
  );

  useEffect(() => {
    if (
      deferPreview ||
      !providePreview ||
      componentPreview !== undefined ||
      previewImageUrl
    ) {
      return undefined;
    }

    let cancelled = false;
    let frameId: number | null = null;
    let idleId: number | null = null;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const setDeferredComponentPreview = () => {
      if (cancelled) {
        return;
      }
      setComponentPreview(providePreview(node) ?? null);
    };
    const scheduler = globalThis as typeof globalThis & {
      cancelIdleCallback?: (id: number) => void;
      cancelAnimationFrame?: (id: number) => void;
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout?: number }
      ) => number;
      requestAnimationFrame?: (callback: () => void) => number;
    };

    if (typeof scheduler.requestIdleCallback === "function") {
      idleId = scheduler.requestIdleCallback(setDeferredComponentPreview, {
        timeout: 250
      });
    } else if (typeof scheduler.requestAnimationFrame === "function") {
      frameId = scheduler.requestAnimationFrame(() => {
        frameId = null;
        timeoutId = globalThis.setTimeout(setDeferredComponentPreview, 0);
      });
    } else {
      timeoutId = globalThis.setTimeout(setDeferredComponentPreview, 0);
    }

    return () => {
      cancelled = true;
      if (
        idleId !== null &&
        typeof scheduler.cancelIdleCallback === "function"
      ) {
        scheduler.cancelIdleCallback(idleId);
      }
      if (
        frameId !== null &&
        typeof scheduler.cancelAnimationFrame === "function"
      ) {
        scheduler.cancelAnimationFrame(frameId);
      }
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
    };
  }, [
    componentPreview,
    deferPreview,
    node.data.instanceId,
    node.data.instanceKey,
    node.data.typeId,
    node.id,
    node.minimizedAtUnixMs,
    previewImageUrl,
    providePreview
  ]);

  useEffect(() => {
    if (deferPreview) {
      return undefined;
    }

    let cancelled = false;
    const cachedPreviewImageUrl = readCachedWorkbenchNodePreviewImage(node.id);
    setPreviewImageUrl(cachedPreviewImageUrl);
    const cacheKey = resolveDockPreviewCacheKey(workspaceId, node);
    if (!cachedPreviewImageUrl && dockPreviewCache) {
      void dockPreviewCache
        .read(cacheKey)
        .catch(() => null)
        .then((persistedPreview) => {
          if (cancelled || !persistedPreview) {
            return;
          }
          writeCachedWorkbenchNodePreviewImage(node.id, persistedPreview);
          setPreviewImageUrl(persistedPreview);
        });
    }
    if (capturePreview) {
      void Promise.resolve(capturePreview(node))
        .catch(() => null)
        .then((nextPreview) => {
          if (cancelled || !nextPreview) {
            return;
          }
          writeCachedWorkbenchNodePreviewImage(node.id, nextPreview);
          dockPreviewCache?.write({
            key: cacheKey,
            previewImageUrl: nextPreview
          });
          setPreviewImageUrl(nextPreview);
        });
    }
    if (cachedPreviewImageUrl || node.isMinimized || capturePreview) {
      return () => {
        cancelled = true;
      };
    }
    void captureWorkbenchNodePreviewImage(node.id).then((nextPreview) => {
      if (!cancelled) {
        setPreviewImageUrl(nextPreview);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    capturePreview,
    deferPreview,
    dockPreviewCache,
    node.data.instanceId,
    node.data.instanceKey,
    node.data.typeId,
    node.id,
    node.minimizedAtUnixMs,
    providePreview,
    workspaceId
  ]);

  if (deferPreview) {
    return renderMinimizedDockPreviewPlaceholder(className);
  }

  if (previewImageUrl) {
    return (
      <span
        className={[
          "desktop-dock__minimized-preview",
          "desktop-dock__minimized-preview--snapshot",
          className
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      >
        <img
          alt=""
          className="desktop-dock__minimized-preview-image"
          draggable={false}
          src={previewImageUrl}
        />
      </span>
    );
  }

  if (componentPreview) {
    return renderMinimizedDockPreviewContent(componentPreview, className);
  }

  return renderMinimizedDockPreviewPlaceholder(className);
}

function renderMinimizedDockPreviewPlaceholder(className?: string) {
  return (
    <span
      className={["desktop-dock__minimized-preview", className]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      <span className="desktop-dock__minimized-preview-line" />
      <span className="desktop-dock__minimized-preview-line desktop-dock__minimized-preview-line--short" />
      <span className="desktop-dock__minimized-preview-line desktop-dock__minimized-preview-line--accent" />
    </span>
  );
}

export function renderMinimizedDockPreviewContent(
  preview: WorkbenchDockPreviewContent,
  className?: string
) {
  if (preview.kind === "image") {
    return (
      <span
        className={[
          "desktop-dock__minimized-preview",
          "desktop-dock__minimized-preview--snapshot",
          className
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      >
        <img
          alt=""
          className="desktop-dock__minimized-preview-image"
          draggable={false}
          src={preview.src}
        />
      </span>
    );
  }

  return (
    <WorkbenchHostDockFrozenComponentPreview
      className={className}
      preview={preview}
    />
  );
}

function WorkbenchHostDockFrozenComponentPreview({
  className,
  preview
}: {
  className?: string;
  preview: Extract<WorkbenchDockPreviewContent, { kind: "component" }>;
}) {
  const sourceRef = useRef<HTMLSpanElement | null>(null);
  const [frozenMarkup, setFrozenMarkup] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (frozenMarkup !== null) {
      return;
    }
    setFrozenMarkup(sourceRef.current?.innerHTML ?? "");
  }, [frozenMarkup]);

  return (
    <span
      className={[
        "desktop-dock__minimized-preview",
        "desktop-dock__minimized-preview--component",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {frozenMarkup === null ? (
        <span
          ref={sourceRef}
          className="desktop-dock__minimized-preview-freeze-source"
        >
          {preview.element}
        </span>
      ) : (
        <span
          className="desktop-dock__minimized-preview-frozen-content"
          dangerouslySetInnerHTML={{ __html: frozenMarkup }}
        />
      )}
    </span>
  );
}

function minimizedDockPreviewFreezeKey(
  node: WorkbenchMinimizedDockNode
): string {
  return `${node.id}:${node.minimizedAtUnixMs ?? "pending"}`;
}

function dockEntryHasHoverPanel(entry: WorkbenchHostDockEntry): boolean {
  return (
    Boolean(entry.state?.reason?.trim()) ||
    (entry.hoverActions?.length ?? 0) > 0
  );
}

function dockEntryHasContextMenu(
  entry: WorkbenchHostDockEntry,
  resolvedEntry: ResolvedWorkbenchHostDockEntry
): boolean {
  if (resolvedEntry.matchedNodes.length > 0 || entry.dockRetention) {
    return true;
  }
  return entry.clickActionId === undefined;
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

function dockLabelTooltipTarget(
  key: string,
  label: string
): WorkbenchHostDockLabelTooltipTarget {
  return { key, label: label.trim() };
}

function renderDockBadge(
  entry: WorkbenchHostDockEntry,
  matchedNodeCount: number
) {
  const badge =
    entry.badge ??
    (matchedNodeCount > 1
      ? ({
          kind: "count",
          value: matchedNodeCount
        } as const)
      : null);
  if (!badge) {
    return null;
  }
  if (badge.kind === "count") {
    return <span className="desktop-dock__count-badge">{badge.value}</span>;
  }
  if (badge.kind === "custom") {
    return <span className="desktop-dock__custom-badge">{badge.content}</span>;
  }
  return (
    <span className="desktop-dock__status-badge" data-status={badge.status} />
  );
}

function WorkbenchHostDockLabelTooltip({
  placement,
  state
}: {
  placement: WorkbenchHostProps["dockPlacement"];
  state: WorkbenchHostDockLabelTooltipState;
}) {
  return (
    <div
      className="desktop-dock__label-tooltip"
      data-dock-placement={placement}
      role="tooltip"
      style={
        {
          "--desktop-dock-label-tooltip-anchor-height": `${state.anchorRect.height}px`,
          "--desktop-dock-label-tooltip-anchor-left": `${state.anchorRect.left}px`,
          "--desktop-dock-label-tooltip-anchor-top": `${state.anchorRect.top}px`,
          "--desktop-dock-label-tooltip-anchor-width": `${state.anchorRect.width}px`
        } as WorkbenchHostDockLabelTooltipStyle
      }
    >
      {state.label}
    </div>
  );
}

function WorkbenchHostDockHoverPanel({
  entry,
  host,
  hoverPanelRef,
  onBlur,
  onDockEntryAction,
  onFocus,
  onPointerEnter,
  onPointerLeave,
  pendingActionKeys,
  placement,
  setPendingActionKeys,
  state
}: {
  entry: WorkbenchHostDockEntry | null;
  host: WorkbenchHostHandle;
  hoverPanelRef: RefObject<HTMLDivElement | null>;
  onDockEntryAction?: (input: {
    actionId: string;
    entryId: string;
    host: WorkbenchHostHandle;
  }) => Promise<void> | void;
  onBlur?: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  pendingActionKeys: Set<string>;
  placement: WorkbenchHostProps["dockPlacement"];
  setPendingActionKeys: Dispatch<SetStateAction<Set<string>>>;
  state: WorkbenchHostDockHoverPanelState;
}) {
  const lastPointerActionAtRef = useRef<Map<string, number>>(new Map());
  if (!entry) {
    return null;
  }
  const hoverPanelEntry = entry;

  const runHoverAction = (
    actionKey: string,
    actionId: string,
    disabled: boolean
  ): void => {
    if (disabled || pendingActionKeys.has(actionKey)) {
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
          entryId: hoverPanelEntry.id,
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
  };

  return (
    <div
      ref={hoverPanelRef}
      className="desktop-dock__hover-panel"
      data-dock-placement={placement}
      role="group"
      aria-label={entry.label}
      onBlur={onBlur}
      onFocus={onFocus}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={
        {
          "--desktop-dock-hover-panel-anchor-height": `${state.anchorRect.height}px`,
          "--desktop-dock-hover-panel-anchor-left": `${state.anchorRect.left}px`,
          "--desktop-dock-hover-panel-anchor-top": `${state.anchorRect.top}px`,
          "--desktop-dock-hover-panel-anchor-width": `${state.anchorRect.width}px`
        } as WorkbenchHostDockHoverPanelStyle
      }
    >
      <div className="desktop-dock__hover-panel-title">{entry.label}</div>
      {entry.state?.reason ? (
        <div className="desktop-dock__hover-panel-description">
          {stripDockDescriptionTerminalPunctuation(entry.state.reason)}
        </div>
      ) : null}
      {entry.hoverActions?.length ? (
        <div className="desktop-dock__hover-actions">
          {entry.hoverActions.map((action) => {
            const actionKey = dockActionKey(entry.id, action.id);
            const isLocallyPending = pendingActionKeys.has(actionKey);
            const isPending =
              isLocallyPending ||
              (action.disabled === true && action.pendingLabel !== undefined);
            return (
              <Button
                key={action.id}
                aria-busy={isPending ? true : undefined}
                className="desktop-dock__hover-action"
                disabled={action.disabled || isLocallyPending}
                type="button"
                onPointerDown={(event) => {
                  // The dock hover panel can be torn down between pointerdown
                  // and the synthetic click — a re-render race, or the
                  // overlapping workspace-app webview swallowing the pointerup —
                  // which silently drops the click and makes the button look
                  // dead. Act on pointerdown (primary button), the event proven
                  // to reliably reach this button; keyboard activation still
                  // flows through onClick below.
                  if (event.button !== 0) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  lastPointerActionAtRef.current.set(
                    actionKey,
                    performance.now()
                  );
                  runHoverAction(
                    actionKey,
                    action.id,
                    action.disabled === true
                  );
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // A mouse activation already ran on pointerdown; skip its
                  // trailing click. Only the keyboard path (Enter/Space, with no
                  // preceding pointerdown) should trigger the action here.
                  const lastPointerAt =
                    lastPointerActionAtRef.current.get(actionKey);
                  if (
                    lastPointerAt !== undefined &&
                    performance.now() - lastPointerAt < 700
                  ) {
                    return;
                  }
                  runHoverAction(
                    actionKey,
                    action.id,
                    action.disabled === true
                  );
                }}
              >
                {isPending
                  ? (action.pendingLabel ?? action.label)
                  : action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function resolveDockEntryInstanceMode(
  entry: WorkbenchHostDockEntry,
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>
): WorkbenchHostNodeInstanceStrategy["mode"] | undefined {
  return (
    entry.instanceMode ?? nodeDefinitions.get(entry.typeId)?.instance?.mode
  );
}

function anchorKeyFromPopupEntry(
  entry: ResolvedWorkbenchHostDockEntry
): string {
  return entry.anchorKey;
}

function previewRevision(
  preview: WorkbenchDockPreviewContent | null | undefined
): string | null {
  return preview?.revision ?? null;
}

function logWorkbenchDockDebug(
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
      source: "workbench-dock",
      workspaceId:
        typeof details.workspaceId === "string" ? details.workspaceId : null
    })
  ).catch(() => undefined);
}

function minimizedDockSlotNodes(
  slot: WorkbenchMinimizedDockSlot
): readonly WorkbenchMinimizedDockNode[] {
  return slot.kind === "stack" ? slot.nodes : [slot.node];
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

function dockActionKey(entryId: string, actionId: string): string {
  return `${entryId}:${actionId}`;
}

function createWorkbenchHostDockItems({
  minimizedDockSlots,
  resolvedEntries
}: {
  minimizedDockSlots: readonly WorkbenchMinimizedDockSlot[];
  resolvedEntries: readonly ResolvedWorkbenchHostDockEntry[];
}): WorkbenchHostDockItem[] {
  const items: WorkbenchHostDockItem[] = [];

  for (const resolvedEntry of resolvedEntries) {
    if (resolvedEntry.sectionBreakBefore) {
      items.push({
        key: `separator:before:${resolvedEntry.entry.id}`,
        kind: "separator"
      });
    }
    items.push({
      key: `entry:${resolvedEntry.entry.id}`,
      kind: "entry",
      resolvedEntry
    });
    if (resolvedEntry.entry.separatorAfter) {
      items.push({
        key: `separator:after:${resolvedEntry.entry.id}`,
        kind: "separator"
      });
    }
  }

  if (minimizedDockSlots.length > 0 && resolvedEntries.length > 0) {
    items.push({
      key: "separator:minimized",
      kind: "separator"
    });
  }

  for (const slot of minimizedDockSlots) {
    items.push({
      key: `minimized:${slot.anchorKey}`,
      kind: "minimized",
      slot
    });
  }

  return items;
}

function resolveMinimizedDockItemNodeId(
  item: WorkbenchHostDockItem
): string | null {
  if (item.kind !== "minimized" || item.slot.kind !== "node") {
    return null;
  }
  return item.slot.node.id;
}

function resolveNextDockItemPresence(
  item: WorkbenchHostDockItem,
  initialized: boolean,
  previousPresence: WorkbenchHostDockPresence | undefined,
  shouldAnimateMinimizedDockEnter: (nodeId: string) => boolean
): WorkbenchHostDockPresence {
  if (!initialized) {
    return "present";
  }

  if (item.key === "separator:minimized") {
    return "present";
  }

  if (item.kind === "minimized") {
    const nodeId = resolveMinimizedDockItemNodeId(item);
    if (nodeId && shouldAnimateMinimizedDockEnter(nodeId)) {
      if (previousPresence === "exiting") {
        return "entering";
      }
      return previousPresence ?? "entering";
    }
    return "present";
  }

  if (previousPresence === "exiting") {
    return "entering";
  }

  return previousPresence ?? "entering";
}

function resolveDockPresenceItems(input: {
  current: readonly WorkbenchHostPresentDockItem[];
  initialized: boolean;
  nextSourceItems: readonly WorkbenchHostDockItem[];
  shouldAnimateMinimizedDockEnter: (nodeId: string) => boolean;
}): WorkbenchHostPresentDockItem[] {
  const currentByKey = new Map(input.current.map((item) => [item.key, item]));
  const currentIndexByKey = new Map(
    input.current.map((item, index) => [item.key, index])
  );
  const nextByKey = new Map(
    input.nextSourceItems.map((item) => [item.key, item])
  );
  const nextKeys = new Set(input.nextSourceItems.map((item) => item.key));
  const currentVisibleItemCount = input.current.filter(
    (item) => item.presence !== "exiting"
  ).length;
  const shouldRetainExitingItems =
    input.nextSourceItems.length < currentVisibleItemCount;
  const emittedKeys = new Set<string>();
  const nextItems: WorkbenchHostPresentDockItem[] = [];
  let currentIndex = 0;

  const emitExitingUntil = (nextCurrentIndex: number) => {
    while (currentIndex < nextCurrentIndex) {
      const currentItem = input.current[currentIndex];
      currentIndex += 1;
      if (
        shouldRetainExitingItems &&
        currentItem &&
        !nextKeys.has(currentItem.key) &&
        !emittedKeys.has(currentItem.key)
      ) {
        emittedKeys.add(currentItem.key);
        nextItems.push({
          ...currentItem,
          presence: "exiting"
        });
      }
    }
  };

  for (const item of input.nextSourceItems) {
    const previousIndex = currentIndexByKey.get(item.key);
    if (previousIndex !== undefined) {
      emitExitingUntil(previousIndex);
      currentIndex = Math.max(currentIndex, previousIndex + 1);
    }
    emittedKeys.add(item.key);
    nextItems.push({
      item,
      key: item.key,
      presence: resolveNextDockItemPresence(
        item,
        input.initialized,
        currentByKey.get(item.key)?.presence,
        input.shouldAnimateMinimizedDockEnter
      )
    });
  }

  for (const currentItem of input.current) {
    if (shouldRetainExitingItems && !nextKeys.has(currentItem.key)) {
      if (emittedKeys.has(currentItem.key)) {
        continue;
      }
      emittedKeys.add(currentItem.key);
      nextItems.push({
        ...currentItem,
        presence: "exiting"
      });
    }
  }

  return nextItems.filter(
    (item) => nextByKey.has(item.key) || item.presence === "exiting"
  );
}

function resolveDockPresenceSettleMs(
  items: readonly WorkbenchHostPresentDockItem[]
): number {
  if (
    items.some(
      (item) =>
        item.item.kind === "minimized" &&
        (item.presence === "entering" || item.presence === "exiting")
    )
  ) {
    return minimizedDockSlotLayoutAnimationMs;
  }
  return dockPresenceAnimationMs;
}

function useDockPresenceItems(
  items: readonly WorkbenchHostDockItem[],
  shouldAnimateMinimizedDockEnter: (nodeId: string) => boolean
): WorkbenchHostPresentDockItem[] {
  const latestItemsByKey = useRef(new Map<string, WorkbenchHostDockItem>());
  const shouldAnimateMinimizedDockEnterRef = useRef(
    shouldAnimateMinimizedDockEnter
  );
  latestItemsByKey.current = new Map(items.map((item) => [item.key, item]));
  shouldAnimateMinimizedDockEnterRef.current = shouldAnimateMinimizedDockEnter;
  const itemKeys = items.map((item) => item.key).join("\u0000");
  const [presentItems, setPresentItems] = useState<
    WorkbenchHostPresentDockItem[]
  >(() =>
    items.map((item) => ({
      item,
      key: item.key,
      presence: "present" as const
    }))
  );
  const initialized = useRef(false);

  useEffect(() => {
    let nextSettleMs = dockPresenceAnimationMs;

    setPresentItems((current) => {
      const filteredItems = resolveDockPresenceItems({
        current,
        initialized: initialized.current,
        nextSourceItems: [...latestItemsByKey.current.values()],
        shouldAnimateMinimizedDockEnter:
          shouldAnimateMinimizedDockEnterRef.current
      });
      nextSettleMs = resolveDockPresenceSettleMs(filteredItems);
      return filteredItems;
    });
    initialized.current = true;

    const timeout = globalThis.setTimeout(() => {
      setPresentItems((current) =>
        current
          .filter((item) => item.presence !== "exiting")
          .map((item) =>
            item.presence === "entering"
              ? { ...item, presence: "present" as const }
              : item
          )
      );
    }, nextSettleMs);

    return () => globalThis.clearTimeout(timeout);
  }, [itemKeys]);

  const renderedPresentItems = resolveDockPresenceItems({
    current: presentItems,
    initialized: initialized.current,
    nextSourceItems: [...latestItemsByKey.current.values()],
    shouldAnimateMinimizedDockEnter
  });

  return renderedPresentItems.map((presentItem) => {
    const latestItem = latestItemsByKey.current.get(presentItem.key);
    return latestItem ? { ...presentItem, item: latestItem } : presentItem;
  });
}

function useDockWallpaperTones({
  dockItemsRef,
  elementRefs,
  itemKeys
}: {
  dockItemsRef: RefObject<HTMLElement | null>;
  elementRefs: RefObject<Map<string, HTMLElement>>;
  itemKeys: string;
}): ReadonlyMap<string, WorkbenchDockWallpaperTone> {
  const [tones, setTones] = useState<Map<string, WorkbenchDockWallpaperTone>>(
    () => new Map()
  );

  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let canceled = false;
    let frameId: number | null = null;

    const updateTones = () => {
      frameId = null;
      void resolveDockWallpaperTones({
        dockItemsElement: dockItemsRef.current,
        elements: elementRefs.current
      }).then((nextTones) => {
        if (canceled) {
          return;
        }
        setTones((current) =>
          dockWallpaperToneMapsEqual(current, nextTones) ? current : nextTones
        );
      });
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(updateTones);
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    if (dockItemsRef.current) {
      resizeObserver?.observe(dockItemsRef.current);
    }
    const wallpaperElement = dockItemsRef.current
      ?.closest(".workbench-surface")
      ?.querySelector(".workbench-surface__wallpaper");
    if (wallpaperElement instanceof HTMLElement) {
      resizeObserver?.observe(wallpaperElement);
    }

    return () => {
      canceled = true;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [dockItemsRef, elementRefs, itemKeys]);

  return tones;
}

async function resolveDockWallpaperTones({
  dockItemsElement,
  elements
}: {
  dockItemsElement: HTMLElement | null;
  elements: ReadonlyMap<string, HTMLElement>;
}): Promise<Map<string, WorkbenchDockWallpaperTone>> {
  const wallpaperElement = dockItemsElement
    ?.closest(".workbench-surface")
    ?.querySelector(".workbench-surface__wallpaper");
  if (!(wallpaperElement instanceof HTMLElement)) {
    return new Map();
  }

  const wallpaperStyle = window.getComputedStyle(wallpaperElement);
  const wallpaperUrl = parseDockWallpaperCssUrl(wallpaperStyle.backgroundImage);
  if (!wallpaperUrl) {
    return new Map();
  }

  const wallpaperImage = await loadDockWallpaperImage(wallpaperUrl);
  if (!wallpaperImage) {
    return new Map();
  }

  const wallpaperSample = getDockWallpaperImageSample(wallpaperImage);
  if (!wallpaperSample) {
    return new Map();
  }

  const wallpaperRect = wallpaperElement.getBoundingClientRect();
  const renderedImageRect = resolveDockWallpaperRenderedImageRect({
    containerHeight: wallpaperRect.height,
    containerWidth: wallpaperRect.width,
    imageHeight: wallpaperImage.naturalHeight,
    imageWidth: wallpaperImage.naturalWidth,
    positionX: wallpaperStyle.backgroundPositionX,
    positionY: wallpaperStyle.backgroundPositionY,
    size: wallpaperStyle.backgroundSize
  });
  const nextTones = new Map<string, WorkbenchDockWallpaperTone>();

  for (const [key, element] of elements) {
    const luminance = sampleDockWallpaperLuminanceAtElement({
      elementRect: element.getBoundingClientRect(),
      renderedImageRect,
      sample: wallpaperSample,
      wallpaperRect
    });
    if (luminance === null) {
      continue;
    }
    nextTones.set(
      key,
      luminance < dockWallpaperDarkLuminanceThreshold ? "dark" : "light"
    );
  }

  return nextTones;
}

function parseDockWallpaperCssUrl(backgroundImage: string): string | null {
  const match = /^url\((['"]?)(.*)\1\)$/u.exec(backgroundImage.trim());
  return match?.[2] ? match[2] : null;
}

const dockWallpaperImageCache = new Map<
  string,
  Promise<HTMLImageElement | null>
>();

function loadDockWallpaperImage(url: string): Promise<HTMLImageElement | null> {
  const cached = dockWallpaperImageCache.get(url);
  if (cached) {
    return cached;
  }
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
  dockWallpaperImageCache.set(url, promise);
  return promise;
}

function resolveDockWallpaperRenderedImageRect({
  containerHeight,
  containerWidth,
  imageHeight,
  imageWidth,
  positionX,
  positionY,
  size
}: {
  containerHeight: number;
  containerWidth: number;
  imageHeight: number;
  imageWidth: number;
  positionX: string;
  positionY: string;
  size: string;
}): { height: number; left: number; top: number; width: number } {
  const imageAspect = imageWidth / imageHeight;
  const containerAspect = containerWidth / containerHeight;
  let width = containerWidth;
  let height = containerHeight;

  if (size === "cover") {
    if (containerAspect > imageAspect) {
      height = containerWidth / imageAspect;
    } else {
      width = containerHeight * imageAspect;
    }
  } else if (size === "contain") {
    if (containerAspect > imageAspect) {
      width = containerHeight * imageAspect;
    } else {
      height = containerWidth / imageAspect;
    }
  } else if (size !== "100% 100%") {
    width = imageWidth;
    height = imageHeight;
  }

  return {
    height,
    left: resolveDockWallpaperPositionOffset(positionX, containerWidth - width),
    top: resolveDockWallpaperPositionOffset(
      positionY,
      containerHeight - height
    ),
    width
  };
}

function resolveDockWallpaperPositionOffset(
  value: string,
  availableSpace: number
): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const percentage = Number.parseFloat(trimmed);
    return Number.isFinite(percentage)
      ? (availableSpace * percentage) / 100
      : availableSpace / 2;
  }
  if (trimmed.endsWith("px")) {
    const px = Number.parseFloat(trimmed);
    return Number.isFinite(px) ? px : availableSpace / 2;
  }
  if (trimmed === "left" || trimmed === "top") {
    return 0;
  }
  if (trimmed === "right" || trimmed === "bottom") {
    return availableSpace;
  }
  return availableSpace / 2;
}

function dockWallpaperToneMapsEqual(
  left: ReadonlyMap<string, WorkbenchDockWallpaperTone>,
  right: ReadonlyMap<string, WorkbenchDockWallpaperTone>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

const DOCK_BOUNCE_MS = 600;
const DOCK_ENTRY_CLICK_THROTTLE_MS = DOCK_BOUNCE_MS;

function useDockBounce(slotRefs: RefObject<Map<string, HTMLElement>>) {
  const timeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearDockBounce = useCallback(
    (anchorKey: string): boolean => {
      const timeout = timeoutsRef.current.get(anchorKey);
      const slotElement = slotRefs.current.get(anchorKey);
      const wasBouncing = slotElement?.hasAttribute("data-bouncing") === true;
      if (timeout) {
        clearTimeout(timeout);
        timeoutsRef.current.delete(anchorKey);
      }
      slotElement?.removeAttribute("data-bouncing");
      return wasBouncing;
    },
    [slotRefs]
  );

  useEffect(
    () => () => {
      for (const anchorKey of timeoutsRef.current.keys()) {
        clearDockBounce(anchorKey);
      }
      timeoutsRef.current.clear();
    },
    [clearDockBounce]
  );

  const triggerDockBounce = useCallback(
    (anchorKey: string) => {
      const shouldRestartAnimation = clearDockBounce(anchorKey);

      const slotElement = slotRefs.current.get(anchorKey);
      if (!slotElement) {
        return;
      }

      if (shouldRestartAnimation) {
        // Restart the CSS keyframes without scheduling a React render.
        void slotElement.offsetWidth;
      }
      slotElement.setAttribute("data-bouncing", "true");
      timeoutsRef.current.set(
        anchorKey,
        setTimeout(() => {
          clearDockBounce(anchorKey);
        }, DOCK_BOUNCE_MS)
      );
    },
    [clearDockBounce, slotRefs]
  );

  return { triggerDockBounce };
}

function resolveWorkbenchHostDockItemsWidth(
  items: readonly WorkbenchHostDockItem[]
): number {
  if (items.length === 0) {
    return dockItemsHorizontalPaddingPx;
  }

  const itemWidth = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === "separator" ? dockSeparatorOuterWidthPx : dockSlotWidthPx),
    0
  );
  const gapWidth = Math.max(0, items.length - 1) * dockItemsGapPx;
  return itemWidth + gapWidth + dockItemsHorizontalPaddingPx;
}

const dockHoverPanelOpenDelayMs = 120;
const dockHoverPanelCloseDelayMs = 160;
const dockHoverPanelHitSlopPx = 12;
const dockHoverPanelBridgeSlopPx = 6;
const dockHoverPanelPointerRestTolerancePx = 4;
const dockWallpaperDarkLuminanceThreshold = 132;

function rectContainsPoint(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  slopPx = 0
): boolean {
  return (
    clientX >= rect.left - slopPx &&
    clientX <= rect.right + slopPx &&
    clientY >= rect.top - slopPx &&
    clientY <= rect.bottom + slopPx
  );
}

function createHoverPanelBridgeRect(anchor: DOMRect, panel: DOMRect): DOMRect {
  if (anchor.right <= panel.left || panel.right <= anchor.left) {
    const left = Math.min(anchor.right, panel.right);
    const right = Math.max(anchor.left, panel.left);
    const top = Math.max(anchor.top, panel.top);
    const bottom = Math.min(anchor.bottom, panel.bottom);
    return new DOMRect(left, top, right - left, Math.max(0, bottom - top));
  }

  const left = Math.max(anchor.left, panel.left);
  const right = Math.min(anchor.right, panel.right);
  const top = Math.min(anchor.bottom, panel.bottom);
  const bottom = Math.max(anchor.top, panel.top);
  return new DOMRect(left, top, Math.max(0, right - left), bottom - top);
}
const dockPresenceAnimationMs = 300;
const minimizedDockSlotLayoutAnimationMs = 720;
const dockItemsGapPx = 10.8;
const dockItemsHorizontalPaddingPx = 12.6;
const dockSeparatorOuterWidthPx = 8.1;
const dockSlotWidthPx = 43.2;
const desktopDockPlateChromeWidth = 15.3;

interface WorkbenchHostDockPlateStyle extends CSSProperties {
  "--desktop-dock-frame-size"?: string;
}

interface WorkbenchHostDockHoverPanelStyle extends CSSProperties {
  "--desktop-dock-hover-panel-anchor-height"?: string;
  "--desktop-dock-hover-panel-anchor-left"?: string;
  "--desktop-dock-hover-panel-anchor-top"?: string;
  "--desktop-dock-hover-panel-anchor-width"?: string;
}

interface WorkbenchHostDockLabelTooltipStyle extends CSSProperties {
  "--desktop-dock-label-tooltip-anchor-height"?: string;
  "--desktop-dock-label-tooltip-anchor-left"?: string;
  "--desktop-dock-label-tooltip-anchor-top"?: string;
  "--desktop-dock-label-tooltip-anchor-width"?: string;
}

type WorkbenchHostDockPresence = "entering" | "exiting" | "present";
type WorkbenchHostDockScrollDirection = "backward" | "forward";

interface WorkbenchHostDockLabelTooltipTarget {
  key: string;
  label: string;
}

interface WorkbenchHostDockLabelTooltipState extends WorkbenchHostDockLabelTooltipTarget {
  anchorKey: string;
  anchorRect: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
}

interface WorkbenchHostDockHoverPanelState {
  anchorKey: string;
  anchorRect: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
  entryId: string;
}

type WorkbenchHostDockItem =
  | {
      key: string;
      kind: "entry";
      resolvedEntry: ResolvedWorkbenchHostDockEntry;
    }
  | {
      key: string;
      kind: "minimized";
      slot: WorkbenchMinimizedDockSlot;
    }
  | {
      key: string;
      kind: "separator";
    };

interface WorkbenchHostPresentDockItem {
  item: WorkbenchHostDockItem;
  key: string;
  presence: WorkbenchHostDockPresence;
}
