import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type FocusEvent,
  type JSX,
  type WheelEvent
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import { AgentTranscriptItemView } from "./AgentTranscriptItemView";
import { assessAgentTranscriptComplexity } from "./agentTranscriptComplexity";

const AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN = 6;
const AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX = 280;
const AGENT_TRANSCRIPT_TURN_GAP_PX = 12;
const AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT = 3;
const AGENT_MESSAGE_LOCATOR_PANEL_FADE_MS = 160;
const AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX = 30;
const AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX = 36;
const AGENT_MESSAGE_LOCATOR_BOTTOM_SAFE_INSET_MAX_PX = 48;
const AGENT_MESSAGE_LOCATOR_NATIVE_SMOOTH_MAX_DISTANCE_PX = 720;
const AGENT_MESSAGE_LOCATOR_FAST_SCROLL_SPEED_PX_PER_MS = 8;
const AGENT_MESSAGE_LOCATOR_FAST_SCROLL_MIN_DURATION_MS = 120;
const agentMessageLocatorScrollAnimations = new WeakMap<HTMLElement, number>();

interface AgentTranscriptTurnGroup {
  key: string;
  turnId: string | null;
  rows: Array<{
    row: AgentConversationVM["rows"][number];
    rowIndex: number;
  }>;
}

interface AgentTranscriptViewProps {
  conversation: AgentConversationVM;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
  showRawTimelineJson?: boolean;
  labels: {
    toolCallsLabel: (count: number) => string;
    thinkingLabel: string;
    processing: string;
    turnSummary: string;
    rawTimelineJson?: string;
    userMessageLocator?: string;
  };
}

interface AgentMessageLocatorItem {
  hasAgentResponse: boolean;
  key: string;
  rowKey: string;
  turnGroupIndex: number;
  rowIndex: number;
  summary: string;
}

interface AgentMessageLocatorVisibleFrame {
  heightPx: number;
  topOffsetPx: number;
}

function transcriptLabelsEqual(
  previous: AgentTranscriptViewProps["labels"],
  next: AgentTranscriptViewProps["labels"]
): boolean {
  return (
    previous === next ||
    (previous.thinkingLabel === next.thinkingLabel &&
      previous.processing === next.processing &&
      previous.turnSummary === next.turnSummary &&
      previous.rawTimelineJson === next.rawTimelineJson &&
      previous.userMessageLocator === next.userMessageLocator &&
      previous.toolCallsLabel === next.toolCallsLabel)
  );
}

function transcriptTurnIdentityEquals(
  previous: AgentConversationVM["sourceDetail"]["turns"],
  next: AgentConversationVM["sourceDetail"]["turns"]
): boolean {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((turn, index) => turn.id === next[index]?.id))
  );
}

function transcriptConversationRenderInputEquals(
  previous: AgentConversationVM,
  next: AgentConversationVM
): boolean {
  return (
    previous === next ||
    (previous.rows === next.rows &&
      previous.workspaceRoot === next.workspaceRoot &&
      previous.sourceDetail.cwd === next.sourceDetail.cwd &&
      transcriptTurnIdentityEquals(
        previous.sourceDetail.turns,
        next.sourceDetail.turns
      ))
  );
}

export function areAgentTranscriptViewPropsEqual(
  previous: AgentTranscriptViewProps,
  next: AgentTranscriptViewProps
): boolean {
  return (
    transcriptConversationRenderInputEquals(
      previous.conversation,
      next.conversation
    ) &&
    previous.onLinkAction === next.onLinkAction &&
    previous.onAuthLogin === next.onAuthLogin &&
    previous.availableSkills === next.availableSkills &&
    previous.workspaceAppIcons === next.workspaceAppIcons &&
    previous.previewMode === next.previewMode &&
    previous.showRawTimelineJson === next.showRawTimelineJson &&
    transcriptLabelsEqual(previous.labels, next.labels)
  );
}

export const AgentTranscriptView = memo(function AgentTranscriptView({
  conversation,
  onLinkAction,
  onAuthLogin,
  availableSkills,
  workspaceAppIcons,
  previewMode = false,
  showRawTimelineJson = false,
  labels
}: AgentTranscriptViewProps): JSX.Element {
  "use memo";
  const [expandedToolRows, setExpandedToolRows] = useState<
    Record<string, boolean>
  >({});
  const virtualizerHostRef = useRef<HTMLDivElement | null>(null);
  const [virtualScrollElement, setVirtualScrollElement] =
    useState<HTMLElement | null>(null);
  const rowKeys = useMemo(
    () => conversation.rows.map(transcriptRowKey),
    [conversation.rows]
  );
  const turnGroups = useMemo(
    () => buildAgentTranscriptTurnGroups(conversation.rows, rowKeys),
    [conversation.rows, rowKeys]
  );
  const turnGroupIndexByRowIndex = useMemo(
    () => buildTurnGroupIndexByRowIndex(turnGroups),
    [turnGroups]
  );
  const userMessageLocatorItems = useMemo(
    () =>
      buildUserMessageLocatorItems(
        conversation.rows,
        rowKeys,
        turnGroupIndexByRowIndex
      ),
    [conversation.rows, rowKeys, turnGroupIndexByRowIndex]
  );
  const enteringRowKeys = useEnteringTranscriptRows(rowKeys);
  const handleToolGroupExpandedChange = useCallback(
    (key: string, expanded: boolean) => {
      setExpandedToolRows((previous) => {
        if (previous[key] === expanded) {
          return previous;
        }
        return {
          ...previous,
          [key]: expanded
        };
      });
    },
    []
  );
  const turnIndexById = useMemo(
    () =>
      new Map(
        conversation.sourceDetail.turns.map((turn, index) => [turn.id, index])
      ),
    [conversation.sourceDetail.turns]
  );
  const dividerRowIndexes = useMemo(
    () => findTurnDividerRowIndexes(turnIndexById, conversation.rows),
    [conversation.rows, turnIndexById]
  );
  const basePath = conversation.sourceDetail.cwd;
  const workspaceRoot = conversation.workspaceRoot;
  const provider = conversation.activity.agentProvider;
  const shouldVirtualize = useMemo(
    () => assessAgentTranscriptComplexity(turnGroups).shouldVirtualize,
    [turnGroups]
  );
  const rowVirtualizer = useVirtualizer({
    count: turnGroups.length,
    estimateSize: () => AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX,
    getItemKey: (index) => turnGroups[index]?.key ?? index,
    getScrollElement: () => virtualScrollElement,
    overscan: AGENT_TRANSCRIPT_VIRTUALIZATION_OVERSCAN
  });
  const handleLocateUserMessage = useCallback(
    (item: AgentMessageLocatorItem) => {
      const scrollParent = virtualizerHostRef.current?.parentElement ?? null;
      const scrollToRenderedRow = (): boolean => {
        const renderedRow = (
          scrollParent ?? document
        ).querySelector<HTMLElement>(
          `[data-agent-transcript-row="${escapeCssString(item.rowKey)}"]`
        );
        if (!renderedRow) {
          return false;
        }
        scrollTranscriptRowIntoView(
          renderedRow,
          scrollParent ?? findMessageLocatorScrollParent(renderedRow)
        );
        return true;
      };

      if (scrollToRenderedRow()) {
        return;
      }
      if (shouldVirtualize) {
        rowVirtualizer.scrollToIndex(item.turnGroupIndex, {
          align: "center"
        });
        window.setTimeout(scrollToRenderedRow, 0);
      }
    },
    [rowVirtualizer, shouldVirtualize]
  );

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setVirtualScrollElement(null);
      return;
    }
    setVirtualScrollElement(virtualizerHostRef.current?.parentElement ?? null);
  }, [shouldVirtualize]);

  const renderRow = (
    row: AgentConversationVM["rows"][number],
    rowIndex: number
  ): JSX.Element => {
    const rowKey = rowKeys[rowIndex] ?? transcriptRowKey(row);
    const showTurnDivider = dividerRowIndexes.has(rowIndex);
    const shouldAnimateEnter =
      row.kind !== "processing" && enteringRowKeys.has(rowKey);

    return (
      <Fragment key={rowKey}>
        {showTurnDivider ? (
          <div
            className="h-px w-full flex-none bg-[var(--line-2,var(--tutti-line-2))]"
            data-testid="agent-transcript-turn-divider"
            aria-hidden="true"
          />
        ) : null}
        <div
          className="agent-gui-transcript-row"
          data-agent-transcript-row={rowKey}
          data-agent-transcript-row-kind={row.kind}
          data-agent-transcript-row-index={rowIndex}
          data-agent-transcript-row-enter={
            shouldAnimateEnter ? "true" : undefined
          }
        >
          <AgentTranscriptItemView
            workspaceRoot={workspaceRoot}
            basePath={basePath}
            row={row}
            labels={labels}
            onLinkAction={onLinkAction}
            onAuthLogin={onAuthLogin}
            provider={provider}
            availableSkills={availableSkills}
            workspaceAppIcons={workspaceAppIcons}
            previewMode={previewMode}
            showRawTimelineJson={showRawTimelineJson}
            toolGroupExpanded={
              row.kind === "tool-group"
                ? expandedToolRows[rowKey] === true
                : undefined
            }
            toolGroupExpansionKey={
              row.kind === "tool-group" ? rowKey : undefined
            }
            onToolGroupExpandedChange={handleToolGroupExpandedChange}
          />
        </div>
      </Fragment>
    );
  };

  if (shouldVirtualize) {
    const virtualItems =
      virtualScrollElement === null
        ? turnGroups
            .slice(-AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT)
            .map((group, fallbackIndex) => ({
              index:
                turnGroups.length -
                Math.min(
                  turnGroups.length,
                  AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT
                ) +
                fallbackIndex,
              key: group.key,
              start:
                (turnGroups.length -
                  Math.min(
                    turnGroups.length,
                    AGENT_TRANSCRIPT_FALLBACK_TURN_COUNT
                  ) +
                  fallbackIndex) *
                AGENT_TRANSCRIPT_ESTIMATED_TURN_HEIGHT_PX
            }))
        : rowVirtualizer.getVirtualItems();
    return (
      <>
        <AgentMessageLocatorRail
          items={userMessageLocatorItems}
          label={labels.userMessageLocator}
          onLocate={handleLocateUserMessage}
        />
        <div
          ref={virtualizerHostRef}
          className="agent-gui-transcript-virtual"
          data-agent-transcript-virtualized="true"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {virtualItems.map((virtualTurn) => {
            const group = turnGroups[virtualTurn.index];
            if (!group) {
              return null;
            }
            return (
              <div
                key={virtualTurn.key}
                ref={rowVirtualizer.measureElement}
                className="agent-gui-transcript-virtual-item"
                data-index={virtualTurn.index}
                data-agent-transcript-virtual-turn={group.key}
                style={{
                  paddingBottom: `${AGENT_TRANSCRIPT_TURN_GAP_PX}px`,
                  transform: `translateY(${virtualTurn.start}px)`
                }}
              >
                {group.rows.map(({ row, rowIndex }) =>
                  renderRow(row, rowIndex)
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <>
      <AgentMessageLocatorRail
        items={userMessageLocatorItems}
        label={labels.userMessageLocator}
        onLocate={handleLocateUserMessage}
      />
      {conversation.rows.map(renderRow)}
    </>
  );
}, areAgentTranscriptViewPropsEqual);

function AgentMessageLocatorRail({
  items,
  label,
  onLocate
}: {
  items: readonly AgentMessageLocatorItem[];
  label?: string;
  onLocate: (item: AgentMessageLocatorItem) => void;
}): JSX.Element | null {
  const locatorRef = useRef<HTMLElement | null>(null);
  const locatorViewportRef = useRef<HTMLDivElement | null>(null);
  const closePanelTimeoutRef = useRef<number | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [shouldRenderPanel, setShouldRenderPanel] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const previousAgentResponseByKeyRef = useRef<ReadonlyMap<
    string,
    boolean
  > | null>(null);
  const [unreadAgentResponseKeys, setUnreadAgentResponseKeys] = useState<
    ReadonlySet<string>
  >(new Set());
  const [visibleFrame, setVisibleFrame] =
    useState<AgentMessageLocatorVisibleFrame | null>(null);
  useEffect(() => {
    if (isPanelOpen) {
      setShouldRenderPanel(true);
      return;
    }
    const timeout = window.setTimeout(
      () => setShouldRenderPanel(false),
      AGENT_MESSAGE_LOCATOR_PANEL_FADE_MS
    );
    return () => window.clearTimeout(timeout);
  }, [isPanelOpen]);
  useEffect(
    () => () => {
      if (closePanelTimeoutRef.current !== null) {
        window.clearTimeout(closePanelTimeoutRef.current);
      }
    },
    []
  );
  useEffect(() => {
    if (selectedKey && !items.some((item) => item.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [items, selectedKey]);
  useEffect(() => {
    const previousAgentResponseByKey = previousAgentResponseByKeyRef.current;
    const currentKeys = new Set(items.map((item) => item.key));

    setUnreadAgentResponseKeys((currentUnreadKeys) => {
      let nextUnreadKeys: Set<string> | null = null;
      const ensureNextUnreadKeys = (): Set<string> => {
        if (!nextUnreadKeys) {
          nextUnreadKeys = new Set(currentUnreadKeys);
        }
        return nextUnreadKeys;
      };

      for (const key of currentUnreadKeys) {
        if (!currentKeys.has(key)) {
          ensureNextUnreadKeys().delete(key);
        }
      }

      if (previousAgentResponseByKey) {
        for (const item of items) {
          const hadAgentResponse =
            previousAgentResponseByKey.get(item.key) ?? false;
          if (
            previousAgentResponseByKey.has(item.key) &&
            item.hasAgentResponse &&
            !hadAgentResponse &&
            item.key !== selectedKey
          ) {
            ensureNextUnreadKeys().add(item.key);
          }
        }
      }

      return nextUnreadKeys ?? currentUnreadKeys;
    });

    previousAgentResponseByKeyRef.current = new Map(
      items.map((item) => [item.key, item.hasAgentResponse])
    );
  }, [items, selectedKey]);
  useEffect(() => {
    if (!selectedKey) {
      return;
    }
    setUnreadAgentResponseKeys((currentUnreadKeys) => {
      if (!currentUnreadKeys.has(selectedKey)) {
        return currentUnreadKeys;
      }
      const nextUnreadKeys = new Set(currentUnreadKeys);
      nextUnreadKeys.delete(selectedKey);
      return nextUnreadKeys;
    });
  }, [selectedKey]);
  useLayoutEffect(() => {
    const locator = locatorRef.current;
    const scrollParent = locator
      ? findMessageLocatorScrollParent(locator)
      : null;
    if (!scrollParent) {
      return;
    }

    let animationFrame: number | null = null;
    const updateVisibleFrame = (): void => {
      animationFrame = null;
      const nextFrame = readMessageLocatorVisibleFrame(scrollParent);
      setVisibleFrame((current) =>
        current?.heightPx === nextFrame.heightPx &&
        current.topOffsetPx === nextFrame.topOffsetPx
          ? current
          : nextFrame
      );
    };
    const scheduleUpdate = (): void => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateVisibleFrame);
    };

    scheduleUpdate();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(scrollParent);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [items.length]);
  useEffect(() => {
    const locator = locatorRef.current;
    const scrollParent = locator
      ? findMessageLocatorScrollParent(locator)
      : null;
    if (!scrollParent) {
      return;
    }

    let animationFrame: number | null = null;
    const updateSelectedFromScroll = (): void => {
      animationFrame = null;
      const nextSelectedKey = selectMessageLocatorItemAtViewportCenter(
        scrollParent,
        items
      );
      if (nextSelectedKey) {
        setSelectedKey(nextSelectedKey);
      }
    };
    const scheduleUpdate = (): void => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateSelectedFromScroll);
    };

    scheduleUpdate();
    scrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
    return () => {
      scrollParent.removeEventListener("scroll", scheduleUpdate);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [items]);
  useLayoutEffect(() => {
    const selectedIndex = selectedKey
      ? items.findIndex((item) => item.key === selectedKey)
      : -1;
    const viewport = locatorViewportRef.current;
    if (selectedIndex < 0 || !viewport) {
      return;
    }

    const railHeight =
      (items.length - 1) * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
      AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
    const viewportHeight =
      viewport.clientHeight ||
      Math.min(railHeight, visibleFrame?.heightPx ?? railHeight);
    scrollMessageLocatorViewportToIndex(
      viewport,
      selectedIndex,
      viewportHeight
    );
  }, [items, selectedKey, visibleFrame]);

  if (items.length < 2) {
    return null;
  }

  const railHeight =
    (items.length - 1) * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
  const viewportHeight =
    visibleFrame === null
      ? railHeight
      : Math.min(railHeight, visibleFrame.heightPx);
  const activeOrSelectedKey = activeKey ?? selectedKey;
  const markItemRead = (itemKey: string): void => {
    setUnreadAgentResponseKeys((currentUnreadKeys) => {
      if (!currentUnreadKeys.has(itemKey)) {
        return currentUnreadKeys;
      }
      const nextUnreadKeys = new Set(currentUnreadKeys);
      nextUnreadKeys.delete(itemKey);
      return nextUnreadKeys;
    });
  };
  const handleLocateItem = (item: AgentMessageLocatorItem): void => {
    setSelectedKey(item.key);
    setActiveKey(item.key);
    markItemRead(item.key);
    onLocate(item);
  };
  const itemFromPointerEvent = (
    event: MouseEvent<HTMLElement>
  ): AgentMessageLocatorItem | null => {
    const viewport = locatorViewportRef.current;
    if (!viewport) {
      return null;
    }
    const rect = viewport.getBoundingClientRect();
    const pointerY = event.clientY - rect.top + viewport.scrollTop;
    const index = Math.round(
      (pointerY - AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX / 2) /
        AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX
    );
    return items[Math.max(0, Math.min(items.length - 1, index))] ?? null;
  };
  const handleViewportClick = (event: MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement | null)?.closest("button")) {
      return;
    }
    const item = itemFromPointerEvent(event);
    if (item) {
      handleLocateItem(item);
    }
  };
  const handleViewportMouseMove = (event: MouseEvent<HTMLDivElement>): void => {
    const item = itemFromPointerEvent(event);
    if (item) {
      setActiveKey(item.key);
    }
  };
  const openPanel = (): void => {
    if (closePanelTimeoutRef.current !== null) {
      window.clearTimeout(closePanelTimeoutRef.current);
      closePanelTimeoutRef.current = null;
    }
    setIsPanelOpen(true);
  };
  const closePanelSoon = (): void => {
    if (closePanelTimeoutRef.current !== null) {
      window.clearTimeout(closePanelTimeoutRef.current);
    }
    closePanelTimeoutRef.current = window.setTimeout(() => {
      closePanelTimeoutRef.current = null;
      setIsPanelOpen(false);
      setActiveKey(null);
    }, 120);
  };
  const closePanelNow = (): void => {
    if (closePanelTimeoutRef.current !== null) {
      window.clearTimeout(closePanelTimeoutRef.current);
      closePanelTimeoutRef.current = null;
    }
    setIsPanelOpen(false);
    setActiveKey(null);
  };
  const handleBlurCapture = (event: FocusEvent<HTMLElement>): void => {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    closePanelNow();
  };

  return (
    <nav
      ref={locatorRef}
      className="agent-gui-message-locator"
      aria-label={label ?? items[0]?.summary}
      data-testid="agent-message-locator"
      onBlurCapture={handleBlurCapture}
      onFocusCapture={openPanel}
      onMouseEnter={openPanel}
      onMouseLeave={closePanelSoon}
      style={
        {
          "--agent-message-locator-height": `${railHeight}px`,
          "--agent-message-locator-viewport-height": `${viewportHeight}px`,
          ...(visibleFrame !== null
            ? {
                "--agent-message-locator-visible-height": `${visibleFrame.heightPx}px`,
                "--agent-message-locator-visible-top-offset": `${visibleFrame.topOffsetPx}px`
              }
            : {})
        } as CSSProperties
      }
    >
      <div
        ref={locatorViewportRef}
        className="agent-gui-message-locator__viewport"
        data-testid="agent-message-locator-viewport"
        onClick={handleViewportClick}
        onMouseMove={handleViewportMouseMove}
      >
        <div
          className="agent-gui-message-locator__content"
          style={
            {
              "--agent-message-locator-height": `${railHeight}px`
            } as CSSProperties
          }
        >
          {items.slice(0, -1).map((item, index) => (
            <div
              key={`segment:${item.key}`}
              className="agent-gui-message-locator__track-segment"
              style={
                {
                  "--agent-message-locator-segment-position": `${
                    index * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
                    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX
                  }px`
                } as CSSProperties
              }
              aria-hidden="true"
            />
          ))}
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              className="agent-gui-message-locator__tick nodrag tsh-desktop-no-drag"
              style={
                {
                  "--agent-message-locator-position": `${
                    index * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
                    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX / 2
                  }px`
                } as CSSProperties
              }
              aria-label={item.summary}
              title={item.summary}
              data-selected={item.key === selectedKey ? "true" : undefined}
              data-unread-agent-response={
                unreadAgentResponseKeys.has(item.key) ? "true" : undefined
              }
              onClick={() => handleLocateItem(item)}
              onFocus={() => setActiveKey(item.key)}
              onMouseEnter={() => setActiveKey(item.key)}
            >
              <span
                className="agent-gui-message-locator__dot"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </div>
      {shouldRenderPanel ? (
        <div
          className="agent-gui-message-locator__panel"
          role="tooltip"
          data-open={isPanelOpen ? "true" : undefined}
          data-testid="agent-message-locator-panel"
          onMouseEnter={openPanel}
          onMouseLeave={closePanelSoon}
          onWheel={containMessageLocatorPanelWheel}
        >
          {items.map((item) => (
            <button
              key={`panel:${item.key}`}
              type="button"
              className="agent-gui-message-locator__panel-item nodrag tsh-desktop-no-drag"
              data-active={
                item.key === activeOrSelectedKey ? "true" : undefined
              }
              onClick={() => handleLocateItem(item)}
              onFocus={() => setActiveKey(item.key)}
              onMouseEnter={() => setActiveKey(item.key)}
            >
              <span className="agent-gui-message-locator__panel-item-text">
                {item.summary}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}

function scrollMessageLocatorViewportToIndex(
  viewport: HTMLElement,
  selectedIndex: number,
  viewportHeight: number
): void {
  const selectedTop =
    selectedIndex * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX -
    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX / 2;
  const selectedBottom = selectedTop + AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
  const padding = AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
  const currentTop = viewport.scrollTop;
  const currentBottom = currentTop + viewportHeight;

  if (selectedTop < currentTop + padding) {
    viewport.scrollTop = Math.max(0, selectedTop - padding);
    return;
  }

  if (selectedBottom > currentBottom - padding) {
    viewport.scrollTop = Math.max(0, selectedBottom - viewportHeight + padding);
  }
}

function scrollTranscriptRowIntoView(
  row: HTMLElement,
  scrollParent: HTMLElement | null
): void {
  if (!scrollParent) {
    row.scrollIntoView({
      block: "center",
      behavior: "smooth"
    });
    return;
  }

  const targetScrollTop = targetScrollTopForTranscriptRow(row, scrollParent);
  const distance = Math.abs(targetScrollTop - scrollParent.scrollTop);
  if (distance <= AGENT_MESSAGE_LOCATOR_NATIVE_SMOOTH_MAX_DISTANCE_PX) {
    row.scrollIntoView({
      block: "center",
      behavior: "smooth"
    });
    return;
  }

  animateMessageLocatorScroll(scrollParent, targetScrollTop, distance);
}

function targetScrollTopForTranscriptRow(
  row: HTMLElement,
  scrollParent: HTMLElement
): number {
  const rowRect = row.getBoundingClientRect();
  const scrollParentRect = scrollParent.getBoundingClientRect();
  const visibleFrame = readMessageLocatorVisibleFrame(scrollParent);
  const rowCenter =
    rowRect.top -
    scrollParentRect.top +
    scrollParent.scrollTop +
    rowRect.height / 2;
  const maxScrollTop = Math.max(
    0,
    scrollParent.scrollHeight - scrollParent.clientHeight
  );
  const targetScrollTop =
    rowCenter - visibleFrame.topOffsetPx - visibleFrame.heightPx / 2;
  return Math.min(maxScrollTop, Math.max(0, targetScrollTop));
}

function animateMessageLocatorScroll(
  scrollParent: HTMLElement,
  targetScrollTop: number,
  distance: number
): void {
  const previousAnimation =
    agentMessageLocatorScrollAnimations.get(scrollParent);
  if (previousAnimation !== undefined) {
    window.cancelAnimationFrame(previousAnimation);
  }

  const startScrollTop = scrollParent.scrollTop;
  const delta = targetScrollTop - startScrollTop;
  const durationMs = Math.max(
    AGENT_MESSAGE_LOCATOR_FAST_SCROLL_MIN_DURATION_MS,
    distance / AGENT_MESSAGE_LOCATOR_FAST_SCROLL_SPEED_PX_PER_MS
  );
  const startedAt = performance.now();

  const step = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    scrollParent.scrollTop = startScrollTop + delta * progress;
    if (progress >= 1) {
      scrollParent.scrollTop = targetScrollTop;
      agentMessageLocatorScrollAnimations.delete(scrollParent);
      return;
    }
    agentMessageLocatorScrollAnimations.set(
      scrollParent,
      window.requestAnimationFrame(step)
    );
  };

  agentMessageLocatorScrollAnimations.set(
    scrollParent,
    window.requestAnimationFrame(step)
  );
}

function readMessageLocatorVisibleFrame(
  scrollParent: HTMLElement
): AgentMessageLocatorVisibleFrame {
  const style = window.getComputedStyle(scrollParent);
  const topOffsetPx = parseCssPx(style.scrollPaddingTop);
  const bottomOffsetPx = Math.min(
    parseCssPx(style.scrollPaddingBottom),
    AGENT_MESSAGE_LOCATOR_BOTTOM_SAFE_INSET_MAX_PX
  );
  return {
    heightPx: Math.max(
      0,
      scrollParent.clientHeight - topOffsetPx - bottomOffsetPx
    ),
    topOffsetPx
  };
}

function parseCssPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function containMessageLocatorPanelWheel(
  event: WheelEvent<HTMLDivElement>
): void {
  event.stopPropagation();
  if (event.deltaY === 0) {
    return;
  }
  event.preventDefault();
  event.currentTarget.scrollTop += event.deltaY;
}

function findMessageLocatorScrollParent(
  locator: HTMLElement
): HTMLElement | null {
  const timeline = locator.closest<HTMLElement>(
    '[data-testid="agent-gui-timeline"]'
  );
  if (timeline) {
    return timeline;
  }

  let current = locator.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function selectMessageLocatorItemAtViewportCenter(
  scrollParent: HTMLElement,
  items: readonly AgentMessageLocatorItem[]
): string | null {
  const viewportRect = scrollParent.getBoundingClientRect();
  const viewportCenterY = viewportRect.top + viewportRect.height / 2;
  let nearest: { key: string; distance: number } | null = null;

  for (const item of items) {
    const row = scrollParent.querySelector<HTMLElement>(
      `[data-agent-transcript-row="${escapeCssString(item.rowKey)}"]`
    );
    if (!row) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    const rowCenterY = rowRect.top + rowRect.height / 2;
    const distance = Math.abs(rowCenterY - viewportCenterY);
    if (!nearest || distance < nearest.distance) {
      nearest = { key: item.key, distance };
    }
  }

  return nearest?.key ?? null;
}

function useEnteringTranscriptRows(rowKeys: string[]): ReadonlySet<string> {
  const previousKeysRef = useRef<Set<string> | null>(null);
  const previousKeys = previousKeysRef.current;
  const enteringRowKeys = new Set<string>();

  if (previousKeys) {
    for (const key of rowKeys) {
      if (!previousKeys.has(key)) {
        enteringRowKeys.add(key);
      }
    }
  }

  useLayoutEffect(() => {
    previousKeysRef.current = new Set(rowKeys);
  }, [rowKeys]);

  return enteringRowKeys;
}

function transcriptRowKey(row: AgentConversationVM["rows"][number]): string {
  if (row.kind === "tool-group") {
    return row.expansionKey ?? row.id;
  }
  return row.id;
}

function buildAgentTranscriptTurnGroups(
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>,
  rowKeys: ReadonlyArray<string>
): AgentTranscriptTurnGroup[] {
  const groups: AgentTranscriptTurnGroup[] = [];
  let currentGroup: AgentTranscriptTurnGroup | null = null;

  rows.forEach((row, rowIndex) => {
    const turnId = row.turnId ?? null;
    if (!currentGroup || currentGroup.turnId !== turnId) {
      currentGroup = {
        key: turnId ?? `orphan:${rowKeys[rowIndex] ?? transcriptRowKey(row)}`,
        turnId,
        rows: []
      };
      groups.push(currentGroup);
    }

    currentGroup.rows.push({ row, rowIndex });
  });

  return groups;
}

function buildTurnGroupIndexByRowIndex(
  turnGroups: readonly AgentTranscriptTurnGroup[]
): ReadonlyMap<number, number> {
  const rowIndexToTurnGroupIndex = new Map<number, number>();
  turnGroups.forEach((group, groupIndex) => {
    group.rows.forEach(({ rowIndex }) => {
      rowIndexToTurnGroupIndex.set(rowIndex, groupIndex);
    });
  });
  return rowIndexToTurnGroupIndex;
}

function buildUserMessageLocatorItems(
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>,
  rowKeys: ReadonlyArray<string>,
  turnGroupIndexByRowIndex: ReadonlyMap<number, number>
): AgentMessageLocatorItem[] {
  const items: AgentMessageLocatorItem[] = [];
  rows.forEach((row, rowIndex) => {
    if (row.kind !== "message" || row.speaker !== "user") {
      return;
    }
    const summary = summarizeUserMessageRow(row);
    if (!summary) {
      return;
    }
    const rowKey = rowKeys[rowIndex] ?? transcriptRowKey(row);
    items.push({
      hasAgentResponse: hasAgentResponseForTurn(rows, row, rowIndex),
      key: `user-message:${rowKey}`,
      rowKey,
      turnGroupIndex: turnGroupIndexByRowIndex.get(rowIndex) ?? rowIndex,
      rowIndex,
      summary
    });
  });
  return items;
}

function hasAgentResponseForTurn(
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>,
  userRow: AgentConversationVM["rows"][number],
  userRowIndex: number
): boolean {
  const turnId = userRow.turnId ?? null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.kind !== "message") {
      continue;
    }
    if (row.speaker === "user") {
      return false;
    }
    if (turnId && row.turnId !== turnId) {
      return false;
    }
    if (row.speaker === "assistant") {
      return true;
    }
  }
  return false;
}

function summarizeUserMessageRow(
  row: Extract<AgentConversationVM["rows"][number], { kind: "message" }>
): string {
  return normalizeLocatorSummary(
    row.messages.map((message) => message.copyText ?? message.body).join(" ")
  );
}

function normalizeLocatorSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeCssString(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function findTurnDividerRowIndexes(
  turnIndexById: ReadonlyMap<string, number>,
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>
): ReadonlySet<number> {
  const dividerRowIndexes = new Set<number>();
  const previousTurnIds = new Set<string>();

  rows.forEach((row, rowIndex) => {
    const currentTurnId = row.turnId ?? null;
    if (!currentTurnId) {
      return;
    }

    const turnIndex = turnIndexById.get(currentTurnId) ?? -1;
    const previousTurnId = rows[rowIndex - 1]?.turnId ?? null;
    if (
      rowIndex > 0 &&
      turnIndex > 0 &&
      previousTurnId &&
      previousTurnId !== currentTurnId &&
      !previousTurnIds.has(currentTurnId)
    ) {
      dividerRowIndexes.add(rowIndex);
    }

    previousTurnIds.add(currentTurnId);
  });

  return dividerRowIndexes;
}
