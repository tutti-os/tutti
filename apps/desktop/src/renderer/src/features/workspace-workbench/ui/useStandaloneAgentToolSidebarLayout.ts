import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import {
  clampStandaloneAgentToolPanelWidth,
  resolveStandaloneAgentToolPanelMaxWidth,
  resolveStandaloneAgentToolPanelExpansionReset,
  resolveStandaloneAgentToolPanelExpansionTransfer,
  resolveStandaloneAgentToolPanelPreferredWidth,
  resolveStandaloneAgentToolSidebarLayoutWidth,
  resolveStandaloneAgentToolSidebarWidth,
  shouldResizeStandaloneAgentToolWindow,
  standaloneAgentToolPanelDefaultWidthById,
  standaloneAgentToolPanelMinWidthById,
  type StandaloneAgentToolPanelId
} from "./standaloneAgentToolSidebarModel.ts";

type ToolPanelWidths = Record<StandaloneAgentToolPanelId, number>;

interface ToolPanelResizeState {
  panel: StandaloneAgentToolPanelId;
  pointerId: number;
  startClientX: number;
  startWidth: number;
}

interface UseStandaloneAgentToolSidebarLayoutInput {
  activePanel: StandaloneAgentToolPanelId | null;
  activePanelPreferredWidth?: number;
  mainContentMinWidthPx?: number;
  resizeWindowContentWidth(
    width: number,
    animate?: boolean
  ): Promise<{ width: number }>;
}

interface ResizeForPanelOptions {
  animateWindow?: boolean;
  preserveBaseline?: boolean;
}

export function useStandaloneAgentToolSidebarLayout({
  activePanel,
  activePanelPreferredWidth,
  mainContentMinWidthPx,
  resizeWindowContentWidth
}: UseStandaloneAgentToolSidebarLayoutInput) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [panelWidths, setPanelWidths] = useState<ToolPanelWidths>(() => ({
    ...standaloneAgentToolPanelDefaultWidthById
  }));
  const [manuallyResizedWidth, setManuallyResizedWidth] = useState<
    number | null
  >(null);
  const [expandedPanel, setExpandedPanel] =
    useState<StandaloneAgentToolPanelId | null>(null);
  const expandedPanelRef = useRef<StandaloneAgentToolPanelId | null>(null);
  const baselineViewportWidthRef = useRef<number | null>(null);
  const panelWidthBeforeExpandRef = useRef<Partial<ToolPanelWidths>>({});
  const resizeRequestRef = useRef(0);
  const lastWindowResizeRef = useRef<{
    actualWidth: number;
    requestedWidth: number;
  } | null>(null);
  const resizeStateRef = useRef<ToolPanelResizeState | null>(null);
  const resizeStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const isActivePanelExpanded =
    activePanel !== null && expandedPanel === activePanel;
  const activePanelMaxWidth = activePanel
    ? resolveStandaloneAgentToolPanelMaxWidth(
        activePanel,
        viewportWidth,
        isActivePanelExpanded,
        mainContentMinWidthPx
      )
    : 0;
  const activePanelMinWidth = activePanel
    ? Math.min(
        standaloneAgentToolPanelMinWidthById[activePanel],
        activePanelMaxWidth
      )
    : 0;
  const activePanelWidth = activePanel
    ? resolveActivePanelWidth({
        activePanel,
        activePanelMaxWidth,
        activePanelPreferredWidth,
        baselineViewportWidth:
          baselineViewportWidthRef.current ?? viewportWidth,
        isActivePanelExpanded,
        mainContentMinWidthPx,
        panelWidth: resolveStandaloneAgentToolPanelPreferredWidth({
          isExpanded: isActivePanelExpanded,
          manuallyResizedWidth,
          panelWidth: panelWidths[activePanel]
        }),
        viewportWidth
      })
    : 0;
  const activePanelLayoutWidth = activePanel
    ? resolveStandaloneAgentToolSidebarLayoutWidth({
        baselineViewportWidth:
          baselineViewportWidthRef.current ?? viewportWidth,
        panelWidth: activePanelWidth,
        viewportWidth
      })
    : 0;

  const resetPanelExpansion = useCallback(
    (
      nextPanel: StandaloneAgentToolPanelId | null
    ): "reset" | "transferred" | null => {
      const reset = resolveStandaloneAgentToolPanelExpansionReset({
        expandedPanel: expandedPanelRef.current,
        nextPanel,
        widthBeforeExpansion:
          expandedPanelRef.current === null
            ? undefined
            : panelWidthBeforeExpandRef.current[expandedPanelRef.current]
      });
      if (!reset) {
        return null;
      }

      if (nextPanel !== null) {
        const transfer = resolveStandaloneAgentToolPanelExpansionTransfer({
          expandedPanel: expandedPanelRef.current,
          nextPanel,
          nextPanelWidth: resolveStandaloneAgentToolPanelPreferredWidth({
            isExpanded: false,
            manuallyResizedWidth,
            panelWidth: panelWidths[nextPanel]
          }),
          widthBeforeExpansion:
            panelWidthBeforeExpandRef.current[expandedPanelRef.current!] ??
            manuallyResizedWidth ??
            undefined
        });
        if (!transfer) {
          return null;
        }

        expandedPanelRef.current = transfer.expandedPanel;
        setExpandedPanel(transfer.expandedPanel);
        setPanelWidths((current) => ({
          ...current,
          [transfer.previousPanel]: transfer.previousPanelWidth,
          [transfer.expandedPanel]: Number.MAX_SAFE_INTEGER
        }));
        panelWidthBeforeExpandRef.current[transfer.expandedPanel] =
          transfer.nextPanelWidthBeforeExpansion;
        delete panelWidthBeforeExpandRef.current[transfer.previousPanel];
        return "transferred";
      }

      expandedPanelRef.current = null;
      setExpandedPanel(null);
      setPanelWidths((current) => ({
        ...current,
        [reset.panel]: reset.width
      }));
      delete panelWidthBeforeExpandRef.current[reset.panel];
      return "reset";
    },
    [manuallyResizedWidth, panelWidths]
  );

  const resizeForPanel = useCallback(
    async (
      nextPanel: StandaloneAgentToolPanelId | null,
      preferredWidth?: number,
      options?: ResizeForPanelOptions
    ): Promise<boolean> => {
      const requestId = ++resizeRequestRef.current;
      const expansionTransition = resetPanelExpansion(nextPanel);
      if (
        expansionTransition === "transferred" ||
        (nextPanel !== null && expandedPanelRef.current === nextPanel)
      ) {
        return true;
      }
      if (nextPanel !== null && baselineViewportWidthRef.current === null) {
        baselineViewportWidthRef.current = window.innerWidth;
      }
      const baselineViewportWidth = baselineViewportWidthRef.current;
      const requestedWidth =
        nextPanel === null
          ? baselineViewportWidth
          : (baselineViewportWidth ?? window.innerWidth) +
            resolvePreferredWidth(
              preferredWidth,
              resolveStandaloneAgentToolPanelPreferredWidth({
                isExpanded: expandedPanelRef.current === nextPanel,
                manuallyResizedWidth,
                panelWidth: panelWidths[nextPanel]
              })
            );

      if (requestedWidth !== null) {
        const currentWidth = window.innerWidth;
        const shouldResize = shouldResizeStandaloneAgentToolWindow({
          currentWidth,
          lastResize: lastWindowResizeRef.current,
          requestedWidth
        });
        if (shouldResize) {
          try {
            const result = await resizeWindowContentWidth(
              requestedWidth,
              options?.animateWindow
            );
            if (requestId !== resizeRequestRef.current) {
              return false;
            }
            if (result.width > 0) {
              lastWindowResizeRef.current = {
                actualWidth: result.width,
                requestedWidth
              };
              setViewportWidth(result.width);
            }
          } catch {
            if (requestId !== resizeRequestRef.current) {
              return false;
            }
          }
        }
      }

      if (nextPanel === null && options?.preserveBaseline !== true) {
        baselineViewportWidthRef.current = null;
      }
      return true;
    },
    [
      manuallyResizedWidth,
      panelWidths,
      resetPanelExpansion,
      resizeWindowContentWidth
    ]
  );

  const resetWindowResizeBaseline = useCallback(() => {
    baselineViewportWidthRef.current = null;
  }, []);

  const updatePanelWidth = useCallback(
    (panel: StandaloneAgentToolPanelId, width: number) => {
      const nextWidth = clampStandaloneAgentToolPanelWidth({
        allowFullWidth: expandedPanel === panel,
        mainContentMinWidth: mainContentMinWidthPx,
        panel,
        viewportWidth,
        width
      });
      setManuallyResizedWidth(nextWidth);
      setPanelWidths((current) => ({ ...current, [panel]: nextWidth }));
    },
    [expandedPanel, mainContentMinWidthPx, viewportWidth]
  );

  const togglePanelExpansion = useCallback(
    (panel: StandaloneAgentToolPanelId) => {
      if (expandedPanelRef.current === panel) {
        resetPanelExpansion(null);
        return;
      }

      resetPanelExpansion(panel);
      expandedPanelRef.current = panel;
      setExpandedPanel(panel);
      setPanelWidths((current) => {
        panelWidthBeforeExpandRef.current[panel] =
          resolveStandaloneAgentToolPanelPreferredWidth({
            isExpanded: false,
            manuallyResizedWidth,
            panelWidth: current[panel]
          });
        return { ...current, [panel]: Number.MAX_SAFE_INTEGER };
      });
    },
    [manuallyResizedWidth, resetPanelExpansion]
  );

  const stopResizing = useCallback(() => {
    resizeStateRef.current = null;
    const styles = resizeStyleRef.current;
    if (!styles) {
      return;
    }
    document.body.style.cursor = styles.cursor;
    document.body.style.userSelect = styles.userSelect;
    resizeStyleRef.current = null;
  }, []);
  useEffect(() => stopResizing, [stopResizing]);

  const handleResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || activePanel === null) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStateRef.current = {
        panel: activePanel,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth: activePanelWidth
      };
      resizeStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [activePanel, activePanelWidth]
  );

  const handleResizePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      updatePanelWidth(
        resizeState.panel,
        resizeState.startWidth + resizeState.startClientX - event.clientX
      );
    },
    [updatePanelWidth]
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (activePanel === null) {
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        updatePanelWidth(activePanel, activePanelMinWidth);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        updatePanelWidth(activePanel, Number.MAX_SAFE_INTEGER);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        updatePanelWidth(
          activePanel,
          activePanelWidth + (event.key === "ArrowLeft" ? 24 : -24)
        );
      }
    },
    [activePanel, activePanelMinWidth, activePanelWidth, updatePanelWidth]
  );

  return {
    activePanelLayoutWidth,
    activePanelMaxWidth,
    activePanelMinWidth,
    activePanelWidth,
    handleResizeKeyDown,
    handleResizePointerDown,
    handleResizePointerMove,
    isActivePanelExpanded,
    resizeForPanel,
    resetWindowResizeBaseline,
    stopResizing,
    togglePanelExpansion
  };
}

function resolveActivePanelWidth(input: {
  activePanel: StandaloneAgentToolPanelId;
  activePanelMaxWidth: number;
  activePanelPreferredWidth?: number;
  baselineViewportWidth: number;
  isActivePanelExpanded: boolean;
  mainContentMinWidthPx?: number;
  panelWidth: number;
  viewportWidth: number;
}): number {
  if (
    typeof input.activePanelPreferredWidth === "number" &&
    Number.isFinite(input.activePanelPreferredWidth)
  ) {
    return Math.round(
      Math.max(
        0,
        Math.min(input.activePanelMaxWidth, input.activePanelPreferredWidth)
      )
    );
  }

  return resolveStandaloneAgentToolSidebarWidth({
    allowFullWidth: input.isActivePanelExpanded,
    baselineViewportWidth: input.baselineViewportWidth,
    mainContentMinWidth: input.mainContentMinWidthPx,
    panel: input.activePanel,
    preferredWidth: input.panelWidth,
    viewportWidth: input.viewportWidth
  });
}

function resolvePreferredWidth(
  preferredWidth: number | undefined,
  fallbackWidth: number
): number {
  return typeof preferredWidth === "number" && Number.isFinite(preferredWidth)
    ? Math.max(0, Math.round(preferredWidth))
    : fallbackWidth;
}
