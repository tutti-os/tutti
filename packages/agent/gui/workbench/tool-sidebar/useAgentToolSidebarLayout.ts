import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import {
  agentToolPanelDefaultWidthById,
  agentToolPanelMinWidthById,
  clampAgentToolPanelWidth,
  resolveAgentToolPanelExpansionReset,
  resolveAgentToolPanelExpansionTransfer,
  resolveAgentToolPanelMaxWidth,
  resolveAgentToolPanelPreferredWidth,
  resolveAgentToolSidebarLayoutWidth,
  resolveAgentToolSidebarWidth,
  shouldResizeAgentToolContainer,
  type AgentToolPanelId
} from "./model.ts";

type ToolPanelWidths = Record<AgentToolPanelId, number>;

interface ToolPanelResizeState {
  panel: AgentToolPanelId;
  pointerId: number;
  startClientX: number;
  startWidth: number;
}

export interface ResizeForPanelOptions {
  animateContainer?: boolean;
  preserveBaseline?: boolean;
}

export function useAgentToolSidebarLayout({
  activePanel,
  activePanelPreferredWidth,
  containerWidth,
  mainContentMinWidthPx,
  resizeContainerContentWidth
}: {
  activePanel: AgentToolPanelId | null;
  activePanelPreferredWidth?: number;
  containerWidth: number;
  mainContentMinWidthPx?: number;
  resizeContainerContentWidth(
    width: number,
    animate?: boolean
  ): Promise<{ width: number }>;
}) {
  const [containerResolution, setContainerResolution] = useState(() => ({
    resolved: containerWidth,
    source: containerWidth
  }));
  if (containerResolution.source !== containerWidth) {
    setContainerResolution({
      resolved: containerWidth,
      source: containerWidth
    });
  }
  const resolvedContainerWidth = containerResolution.resolved;
  const [panelWidths, setPanelWidths] = useState<ToolPanelWidths>(() => ({
    ...agentToolPanelDefaultWidthById
  }));
  const [manuallyResizedWidth, setManuallyResizedWidth] = useState<
    number | null
  >(null);
  const [expandedPanel, setExpandedPanel] = useState<AgentToolPanelId | null>(
    null
  );
  const expandedPanelRef = useRef<AgentToolPanelId | null>(null);
  const baselineContainerWidthRef = useRef<number | null>(null);
  const panelWidthBeforeExpandRef = useRef<Partial<ToolPanelWidths>>({});
  const resizeRequestRef = useRef(0);
  const lastContainerResizeRef = useRef<{
    actualWidth: number;
    requestedWidth: number;
  } | null>(null);
  const dragRef = useRef<ToolPanelResizeState | null>(null);
  const resizeStyleRef = useRef<{ cursor: string; userSelect: string } | null>(
    null
  );

  const isActivePanelExpanded =
    activePanel !== null && expandedPanel === activePanel;
  const activePanelMaxWidth = activePanel
    ? resolveAgentToolPanelMaxWidth(
        activePanel,
        resolvedContainerWidth,
        isActivePanelExpanded,
        mainContentMinWidthPx
      )
    : 0;
  const activePanelMinWidth = activePanel
    ? Math.min(agentToolPanelMinWidthById[activePanel], activePanelMaxWidth)
    : 0;
  const activePanelWidth = activePanel
    ? resolveActivePanelWidth({
        activePanel,
        activePanelMaxWidth,
        activePanelPreferredWidth,
        baselineContainerWidth:
          baselineContainerWidthRef.current ?? resolvedContainerWidth,
        containerWidth: resolvedContainerWidth,
        isActivePanelExpanded,
        mainContentMinWidthPx,
        panelWidth: resolveAgentToolPanelPreferredWidth({
          isExpanded: isActivePanelExpanded,
          manuallyResizedWidth,
          panelWidth: panelWidths[activePanel]
        })
      })
    : 0;
  const activePanelLayoutWidth = activePanel
    ? resolveAgentToolSidebarLayoutWidth({
        baselineContainerWidth:
          baselineContainerWidthRef.current ?? resolvedContainerWidth,
        containerWidth: resolvedContainerWidth,
        panelWidth: activePanelWidth
      })
    : 0;

  const resetPanelExpansion = useCallback(
    (nextPanel: AgentToolPanelId | null): "reset" | "transferred" | null => {
      const reset = resolveAgentToolPanelExpansionReset({
        expandedPanel: expandedPanelRef.current,
        nextPanel,
        widthBeforeExpansion:
          expandedPanelRef.current === null
            ? undefined
            : panelWidthBeforeExpandRef.current[expandedPanelRef.current]
      });
      if (!reset) return null;

      if (nextPanel !== null) {
        const transfer = resolveAgentToolPanelExpansionTransfer({
          expandedPanel: expandedPanelRef.current,
          nextPanel,
          nextPanelWidth: resolveAgentToolPanelPreferredWidth({
            isExpanded: false,
            manuallyResizedWidth,
            panelWidth: panelWidths[nextPanel]
          }),
          widthBeforeExpansion:
            panelWidthBeforeExpandRef.current[expandedPanelRef.current!] ??
            manuallyResizedWidth ??
            undefined
        });
        if (!transfer) return null;
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
      setPanelWidths((current) => ({ ...current, [reset.panel]: reset.width }));
      delete panelWidthBeforeExpandRef.current[reset.panel];
      return "reset";
    },
    [manuallyResizedWidth, panelWidths]
  );

  const resizeForPanel = useCallback(
    async (
      nextPanel: AgentToolPanelId | null,
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
      if (nextPanel !== null && baselineContainerWidthRef.current === null) {
        baselineContainerWidthRef.current = resolvedContainerWidth;
      }
      const baseline = baselineContainerWidthRef.current;
      const requestedWidth =
        nextPanel === null
          ? baseline
          : (baseline ?? resolvedContainerWidth) +
            resolvePreferredWidth(
              preferredWidth,
              resolveAgentToolPanelPreferredWidth({
                isExpanded: expandedPanelRef.current === nextPanel,
                manuallyResizedWidth,
                panelWidth: panelWidths[nextPanel]
              })
            );

      if (
        requestedWidth !== null &&
        shouldResizeAgentToolContainer({
          currentWidth: resolvedContainerWidth,
          lastResize: lastContainerResizeRef.current,
          requestedWidth
        })
      ) {
        try {
          const result = await resizeContainerContentWidth(
            requestedWidth,
            options?.animateContainer
          );
          if (requestId !== resizeRequestRef.current) return false;
          if (result.width > 0) {
            lastContainerResizeRef.current = {
              actualWidth: result.width,
              requestedWidth
            };
            setContainerResolution((current) => ({
              ...current,
              resolved: result.width
            }));
          }
        } catch {
          if (requestId !== resizeRequestRef.current) return false;
        }
      }

      if (nextPanel === null && options?.preserveBaseline !== true) {
        baselineContainerWidthRef.current = null;
      }
      return true;
    },
    [
      manuallyResizedWidth,
      panelWidths,
      resetPanelExpansion,
      resizeContainerContentWidth,
      resolvedContainerWidth
    ]
  );

  const resetContainerResizeBaseline = useCallback(() => {
    baselineContainerWidthRef.current = null;
  }, []);

  const updatePanelWidth = useCallback(
    (panel: AgentToolPanelId, width: number) => {
      const nextWidth = clampAgentToolPanelWidth({
        allowFullWidth: expandedPanel === panel,
        mainContentMinWidth: mainContentMinWidthPx,
        panel,
        viewportWidth: resolvedContainerWidth,
        width
      });
      setManuallyResizedWidth(nextWidth);
      setPanelWidths((current) => ({ ...current, [panel]: nextWidth }));
    },
    [expandedPanel, mainContentMinWidthPx, resolvedContainerWidth]
  );

  const togglePanelExpansion = useCallback(
    (panel: AgentToolPanelId) => {
      if (expandedPanelRef.current === panel) {
        resetPanelExpansion(null);
        return;
      }
      resetPanelExpansion(panel);
      expandedPanelRef.current = panel;
      setExpandedPanel(panel);
      setPanelWidths((current) => {
        panelWidthBeforeExpandRef.current[panel] =
          resolveAgentToolPanelPreferredWidth({
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
    dragRef.current = null;
    const styles = resizeStyleRef.current;
    if (!styles) return;
    document.body.style.cursor = styles.cursor;
    document.body.style.userSelect = styles.userSelect;
    resizeStyleRef.current = null;
  }, []);
  const bindLayoutRoot = useCallback(
    (node: HTMLElement | null) => {
      if (!node) stopResizing();
    },
    [stopResizing]
  );

  const handleResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || activePanel === null) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
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
      const resizeState = dragRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      updatePanelWidth(
        resizeState.panel,
        resizeState.startWidth + resizeState.startClientX - event.clientX
      );
    },
    [updatePanelWidth]
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (activePanel === null) return;
      if (event.key === "Home") {
        event.preventDefault();
        updatePanelWidth(activePanel, activePanelMinWidth);
      } else if (event.key === "End") {
        event.preventDefault();
        updatePanelWidth(activePanel, Number.MAX_SAFE_INTEGER);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
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
    bindLayoutRoot,
    handleResizeKeyDown,
    handleResizePointerDown,
    handleResizePointerMove,
    isActivePanelExpanded,
    resetContainerResizeBaseline,
    resetPanelExpansion,
    resizeForPanel,
    stopResizing,
    togglePanelExpansion
  };
}

function resolveActivePanelWidth(input: {
  activePanel: AgentToolPanelId;
  activePanelMaxWidth: number;
  activePanelPreferredWidth?: number;
  baselineContainerWidth: number;
  containerWidth: number;
  isActivePanelExpanded: boolean;
  mainContentMinWidthPx?: number;
  panelWidth: number;
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
  return resolveAgentToolSidebarWidth({
    allowFullWidth: input.isActivePanelExpanded,
    baselineViewportWidth: input.baselineContainerWidth,
    mainContentMinWidth: input.mainContentMinWidthPx,
    panel: input.activePanel,
    preferredWidth: input.panelWidth,
    viewportWidth: input.containerWidth
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
