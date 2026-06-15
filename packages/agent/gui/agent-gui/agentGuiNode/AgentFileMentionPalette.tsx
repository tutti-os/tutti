import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
  type MutableRefObject,
  type RefObject
} from "react";
import {
  normalizeAgentActivityDisplayStatus,
  type AgentActivityDisplayStatus
} from "@tutti-os/agent-activity-core";
import { FolderFailedFilledIcon } from "../../app/renderer/components/icons/FolderFailedFilledIcon";
import { KeyboardFilledIcon } from "../../app/renderer/components/icons/KeyboardFilledIcon";
import { Spinner } from "../../app/renderer/components/ui/spinner";
import { UnderlineTabs } from "../../app/renderer/components/ui/underline-tabs";
import userAvatarPlaceholderUrl from "../../app/renderer/assets/icons/user-avatar-placeholder.png";
import { translate } from "../../i18n/index";
import { cn } from "../../app/renderer/lib/utils";
import { managedAgentRoundedIconUrl } from "../../shared/managedAgentIcons";
import { workspaceAgentActivityStatusLabel } from "../../shared/workspaceAgentActivityStatusLabel";
import { roomIssueStatusLabel } from "../../shared/roomIssueStatusLabel";
import {
  resolveAgentMentionFileThumbnailUrl,
  resolveAgentMentionFileVisualKind
} from "../shared/mentionFilePresentation";
import { Badge, StatusDot, menuItemClassName } from "@tutti-os/ui-system";
import {
  agentMentionEmptyGroupLabel,
  agentMentionFilterLabel,
  agentMentionGroupLabel
} from "./AgentMentionLabels";
import {
  AGENT_MENTION_FILTER_TAB_ORDER,
  mentionGroupExpandCount
} from "./agentMentionSearchHelpers";
import {
  type AgentMentionGroup,
  type AgentMentionBrowseCategory,
  type AgentMentionFilterId,
  type AgentMentionGroupId,
  type AgentMentionSearchState
} from "./AgentMentionSearchController";
import { agentGeneratedMentionItemKey } from "./agentMentionAgentGeneratedFilesPresentation";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";

export interface AgentMentionPaletteEntry {
  key: string;
  type: "category" | "item" | "expand";
  categoryId?: AgentMentionBrowseCategory["id"];
  groupId?: AgentMentionGroupId;
  item?: AgentContextMentionItem;
}

interface AgentFileMentionPaletteProps {
  state: AgentMentionSearchState;
  highlightedKey: string | null;
  label: string;
  loadingLabel: string;
  emptyLabel: string;
  errorLabel: string;
  tabHintLabel: string;
  maxHeightPx: number;
  shouldCenterHighlightedItem?: boolean;
  onHighlightChange: (key: string) => void;
  onSelectItem: (entry: AgentContextMentionItem) => void;
  onSelectCategory: (categoryId: AgentMentionBrowseCategory["id"]) => void;
  onSelectFilter: (filter: AgentMentionFilterId) => void;
  onExpandGroup: (groupId: AgentMentionGroupId) => void;
  onCycleFilter: () => void;
  onMoveSelection: (delta: 1 | -1) => void;
}

const paletteStyles = {
  palette:
    "agent-gui-node__mention-palette nodrag grid h-full max-h-[320px] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden text-[13px] [-webkit-app-region:no-drag]",
  header: "agent-gui-node__mention-palette-header relative z-10 shrink-0",
  footer: "agent-gui-node__mention-palette-footer shrink-0",
  scrollShell: "relative min-h-0 overflow-hidden",
  scrollBody:
    "agent-gui-node__mention-palette-scroll-region h-full min-h-0 overflow-y-auto overscroll-contain px-1 pb-1 pt-2",
  categoryButton:
    "nodrag flex min-h-[72px] w-full items-center gap-3.5 rounded-[6px] border-0 bg-transparent px-2.5 py-2.5 text-left text-[var(--text-primary)] transition-[background-color,color] hover:bg-[var(--transparency-block)] focus-visible:bg-[var(--transparency-block)] focus-visible:outline-none active:bg-[var(--transparency-active)]",
  rowButton: cn(
    menuItemClassName,
    "nodrag min-h-9 w-full min-w-0 justify-start overflow-hidden rounded-[6px] border-0 bg-transparent px-2.5 py-2 text-left hover:bg-[var(--transparency-block)] focus:bg-[var(--transparency-block)] data-[highlighted]:bg-[var(--transparency-block)] active:bg-[var(--transparency-active)]"
  ),
  expandButton:
    "nodrag flex w-full items-center justify-center rounded-[6px] px-3 py-2 text-[13px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--transparency-block)] focus-visible:bg-[var(--transparency-block)] focus-visible:outline-none active:bg-[var(--transparency-active)]"
};
const MENTION_PALETTE_LOADING_MIN_VISIBLE_MS = 320;

export function flattenAgentMentionPaletteEntries(
  state: AgentMentionSearchState
): AgentMentionPaletteEntry[] {
  if (state.mode === "browse" && !hasInteractiveGroupEntries(state.groups)) {
    return state.categories.map((category) => ({
      key: `category:${category.id}`,
      type: "category",
      categoryId: category.id
    }));
  }
  const entries: AgentMentionPaletteEntry[] = [];
  for (const group of state.groups) {
    for (const item of group.items) {
      entries.push({
        key: `${group.id}:${item.kind}:${
          item.kind === "file"
            ? agentGeneratedMentionItemKey(item)
            : item.targetId
        }`,
        type: "item",
        groupId: group.id,
        item
      });
    }
    if (group.hasMore) {
      entries.push({
        key: `expand:${group.id}`,
        type: "expand",
        groupId: group.id
      });
    }
  }
  return entries;
}

export function groupStartKeys(state: AgentMentionSearchState): string[] {
  if (state.mode === "browse") {
    return state.categories.map((category) => `category:${category.id}`);
  }
  return state.groups
    .map((group) => {
      const firstItem = group.items[0];
      if (firstItem) {
        return `${group.id}:${firstItem.kind}:${firstItem.kind === "file" ? firstItem.path : firstItem.targetId}`;
      }
      if (group.hasMore) {
        return `expand:${group.id}`;
      }
      return null;
    })
    .filter((key): key is string => key !== null);
}

export function AgentFileMentionPalette({
  state,
  highlightedKey,
  label,
  loadingLabel,
  emptyLabel,
  errorLabel,
  tabHintLabel,
  maxHeightPx,
  shouldCenterHighlightedItem = false,
  onHighlightChange,
  onSelectItem,
  onSelectCategory,
  onSelectFilter,
  onExpandGroup,
  onCycleFilter,
  onMoveSelection
}: AgentFileMentionPaletteProps): React.JSX.Element {
  "use memo";
  const highlightedOptionRef = useRef<HTMLButtonElement | null>(null);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const loadingVisibleUntilRef = useRef(0);
  const loadingHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [loadingIndicatorVisible, setLoadingIndicatorVisible] = useState(
    state.status === "loading"
  );
  const browseFilter = state.filter;
  const highlightedBrowseCategory = highlightedKey?.startsWith("category:")
    ? highlightedKey.slice("category:".length)
    : null;
  const browseDisplayFilter = isBrowseCategoryId(highlightedBrowseCategory)
    ? highlightedBrowseCategory
    : browseFilter;
  const hasInteractiveEntries = hasInteractiveGroupEntries(state.groups);
  const showBrowseHint = shouldShowBrowseSearchHint({
    browseFilter,
    groups: state.groups,
    highlightedBrowseCategory,
    mode: state.mode
  });
  const showLoadingState =
    loadingIndicatorVisible &&
    (!hasInteractiveEntries || state.mode === "browse");
  const showLoadingBanner =
    loadingIndicatorVisible &&
    hasInteractiveEntries &&
    state.mode === "results";

  useEffect(() => {
    const highlightedElement = highlightedOptionRef.current;
    if (!highlightedElement) {
      return;
    }

    const scrollContainer = scrollBodyRef.current;
    if (!scrollContainer || !scrollContainer.contains(highlightedElement)) {
      highlightedElement.scrollIntoView({ block: "nearest" });
      return;
    }

    if (!shouldCenterHighlightedItem) {
      return;
    }

    centerElementInScrollContainer(scrollContainer, highlightedElement);
  }, [highlightedKey, shouldCenterHighlightedItem]);

  useEffect(() => {
    if (loadingHideTimerRef.current !== null) {
      clearTimeout(loadingHideTimerRef.current);
      loadingHideTimerRef.current = null;
    }

    if (state.status === "loading") {
      loadingVisibleUntilRef.current =
        Date.now() + MENTION_PALETTE_LOADING_MIN_VISIBLE_MS;
      setLoadingIndicatorVisible(true);
      return;
    }

    const remainingMs = loadingVisibleUntilRef.current - Date.now();
    if (remainingMs <= 0) {
      setLoadingIndicatorVisible(false);
      return;
    }

    loadingHideTimerRef.current = setTimeout(() => {
      loadingHideTimerRef.current = null;
      setLoadingIndicatorVisible(false);
    }, remainingMs);

    return () => {
      if (loadingHideTimerRef.current !== null) {
        clearTimeout(loadingHideTimerRef.current);
        loadingHideTimerRef.current = null;
      }
    };
  }, [state.status]);

  const paletteMaxHeightStyle: CSSProperties | undefined =
    maxHeightPx > 0 ? { maxHeight: `${maxHeightPx}px` } : undefined;

  if (state.status === "error") {
    return (
      <div
        className={paletteStyles.palette}
        style={paletteMaxHeightStyle}
        role="listbox"
        aria-label={label}
      >
        <MentionPaletteEmptyState label={errorLabel} />
      </div>
    );
  }

  if (state.mode === "browse") {
    return (
      <div
        className={paletteStyles.palette}
        style={paletteMaxHeightStyle}
        role="listbox"
        aria-label={label}
      >
        <div className={paletteStyles.header}>
          <UnderlineTabs
            tabs={state.categories.map((category) => ({
              value: category.id,
              label: agentMentionFilterLabel(category.id)
            }))}
            value={browseFilter}
            onValueChange={onSelectCategory}
            className="agent-gui-node__mention-palette-tabs"
            preventMouseDownDefault
          />
          {showLoadingBanner ? (
            <MentionPaletteLoadingBanner label={loadingLabel} />
          ) : null}
        </div>
        <div className={paletteStyles.scrollShell}>
          <div ref={scrollBodyRef} className={paletteStyles.scrollBody}>
            {showLoadingState ? (
              <MentionPaletteLoading label={loadingLabel} />
            ) : showBrowseHint ? (
              <MentionPaletteEmptyState
                icon="keyboard"
                label={browseHintForFilter(browseDisplayFilter)}
              />
            ) : (
              renderMentionPaletteGroups({
                filter: state.filter,
                groups: state.groups,
                highlightedKey,
                highlightedOptionRef,
                mode: state.mode,
                onExpandGroup,
                onHighlightChange,
                onSelectItem,
                query: state.query
              })
            )}
          </div>
          <MentionPaletteScrollbar scrollBodyRef={scrollBodyRef} />
        </div>
        <div className={paletteStyles.footer}>
          <MentionPaletteHint
            ariaLabel={tabHintLabel}
            onCycleFilter={onCycleFilter}
            onMoveSelection={onMoveSelection}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={paletteStyles.palette}
      style={paletteMaxHeightStyle}
      role="listbox"
      aria-label={label}
    >
      <div className={paletteStyles.header}>
        <UnderlineTabs
          tabs={AGENT_MENTION_FILTER_TAB_ORDER.map((filter) => ({
            value: filter,
            label: agentMentionFilterLabel(filter)
          }))}
          value={state.filter}
          onValueChange={onSelectFilter}
          className="agent-gui-node__mention-palette-tabs"
          preventMouseDownDefault
        />
        {showLoadingBanner ? (
          <MentionPaletteLoadingBanner label={loadingLabel} />
        ) : null}
      </div>
      <div className={paletteStyles.scrollShell}>
        <div ref={scrollBodyRef} className={paletteStyles.scrollBody}>
          {showLoadingState ? (
            <MentionPaletteLoading label={loadingLabel} />
          ) : state.groups.length === 0 ? (
            <MentionPaletteEmptyState
              label={resolveMentionPaletteEmptyLabel({
                emptyLabel,
                filter: state.filter,
                mode: state.mode,
                query: state.query
              })}
            />
          ) : (
            renderMentionPaletteGroups({
              filter: state.filter,
              groups: state.groups,
              highlightedKey,
              highlightedOptionRef,
              mode: state.mode,
              onExpandGroup,
              onHighlightChange,
              onSelectItem,
              query: state.query
            })
          )}
        </div>
        <MentionPaletteScrollbar scrollBodyRef={scrollBodyRef} />
      </div>
      <div className={paletteStyles.footer}>
        <MentionPaletteHint
          ariaLabel={tabHintLabel}
          onCycleFilter={onCycleFilter}
          onMoveSelection={onMoveSelection}
        />
      </div>
    </div>
  );
}

function MentionPaletteEmptyState({
  icon = "folder-failed",
  label
}: {
  icon?: "folder-failed" | "keyboard";
  label: string;
}): React.JSX.Element {
  "use memo";
  const EmptyStateIcon =
    icon === "keyboard" ? KeyboardFilledIcon : FolderFailedFilledIcon;

  return (
    <div
      className="flex h-full min-h-0 flex-1 items-center justify-center px-4 py-6 text-center text-[13px] text-[var(--text-tertiary)]"
      data-empty-state-icon={icon}
      data-testid="agent-gui-mention-palette-empty-state"
    >
      <div className="flex max-w-[28ch] flex-col items-center justify-center gap-3">
        <EmptyStateIcon
          className="h-6 w-6 text-[var(--text-tertiary)]"
          aria-hidden="true"
        />
        <span className="leading-5 text-[var(--text-tertiary)]">{label}</span>
      </div>
    </div>
  );
}

function MentionPaletteLoading({
  label
}: {
  label: string;
}): React.JSX.Element {
  "use memo";
  return (
    <div className="flex min-h-[52px] items-center gap-2 rounded-xl px-3 text-[13px] text-[var(--text-secondary)]">
      <Spinner
        size={16}
        className="text-[var(--text-secondary)]"
        testId="agent-mention-loading-spinner"
      />
      <span>{label}</span>
    </div>
  );
}

function MentionPaletteLoadingBanner({
  label
}: {
  label: string;
}): React.JSX.Element {
  "use memo";
  return (
    <div
      className="flex items-center gap-2 border-b border-[var(--line-1)] px-3 py-2 text-[13px] font-medium text-[var(--text-secondary)]"
      data-testid="agent-mention-loading-banner"
    >
      <Spinner
        size={14}
        className="text-[var(--text-secondary)]"
        testId="agent-mention-loading-spinner"
      />
      <span>{label}</span>
    </div>
  );
}

function MentionPaletteHint({
  ariaLabel,
  onCycleFilter,
  onMoveSelection
}: {
  ariaLabel: string;
  onCycleFilter: () => void;
  onMoveSelection: (delta: 1 | -1) => void;
}): React.JSX.Element {
  "use memo";
  const switchCategoryLabel = translate(
    "agentHost.agentGui.fileMentionSwitchCategory"
  );
  const switchSelectionLabel = translate(
    "agentHost.agentGui.fileMentionSwitchSelection"
  );
  return (
    <div
      className="agent-gui-node__mention-palette-hint"
      aria-label={ariaLabel}
      data-testid="agent-gui-mention-palette-hint"
    >
      <button
        className="agent-gui-node__mention-palette-hint-item agent-gui-node__mention-palette-hint-button"
        type="button"
        aria-label={switchCategoryLabel}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onCycleFilter}
      >
        {/* i18n-check-ignore: Keyboard key label. */}
        <kbd className="agent-gui-node__mention-palette-shortcut">Tab</kbd>
        <span>{switchCategoryLabel}</span>
      </button>
      <span
        className="agent-gui-node__mention-palette-hint-separator"
        aria-hidden="true"
      >
        ｜
      </span>
      <span className="agent-gui-node__mention-palette-hint-item">
        <span className="agent-gui-node__mention-palette-shortcut-group">
          <button
            className="agent-gui-node__mention-palette-shortcut agent-gui-node__mention-palette-shortcut--arrow agent-gui-node__mention-palette-shortcut-button"
            type="button"
            aria-label={`↑ ${switchSelectionLabel}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onMoveSelection(-1)}
          >
            ↑
          </button>
          <button
            className="agent-gui-node__mention-palette-shortcut agent-gui-node__mention-palette-shortcut--arrow agent-gui-node__mention-palette-shortcut-button"
            type="button"
            aria-label={`↓ ${switchSelectionLabel}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onMoveSelection(1)}
          >
            ↓
          </button>
        </span>
        <span>{switchSelectionLabel}</span>
      </span>
    </div>
  );
}

interface MentionPaletteScrollbarState {
  scrollable: boolean;
  thumbHeight: number;
  thumbTop: number;
}

interface MentionPaletteScrollbarDragState {
  maxScrollTop: number;
  maxThumbTop: number;
  startClientY: number;
  startScrollTop: number;
}

const MENTION_PALETTE_SCROLLBAR_MIN_THUMB_HEIGHT = 24;
const MENTION_PALETTE_SCROLLBAR_HIDDEN_STATE: MentionPaletteScrollbarState = {
  scrollable: false,
  thumbHeight: 0,
  thumbTop: 0
};

function MentionPaletteScrollbar({
  scrollBodyRef
}: {
  scrollBodyRef: RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  "use memo";
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<MentionPaletteScrollbarDragState | null>(null);
  const [scrollbarState, setScrollbarState] =
    useState<MentionPaletteScrollbarState>({
      scrollable: false,
      thumbHeight: 0,
      thumbTop: 0
    });
  const [dragging, setDragging] = useState(false);

  const hideScrollbar = useCallback((): void => {
    setScrollbarState((previous) =>
      previous.scrollable ||
      previous.thumbHeight !== 0 ||
      previous.thumbTop !== 0
        ? MENTION_PALETTE_SCROLLBAR_HIDDEN_STATE
        : previous
    );
  }, []);

  const syncScrollbarState = useCallback((): void => {
    const contentElement = scrollBodyRef.current;
    if (!contentElement) {
      hideScrollbar();
      return;
    }

    const { scrollHeight, scrollTop, clientHeight } = contentElement;
    const measuredTrackHeight = trackRef.current?.clientHeight ?? 0;
    const trackHeight =
      measuredTrackHeight > 0 ? measuredTrackHeight : clientHeight;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);

    if (clientHeight <= 0 || trackHeight <= 0 || maxScrollTop <= 0) {
      hideScrollbar();
      return;
    }

    const thumbHeight = Math.max(
      MENTION_PALETTE_SCROLLBAR_MIN_THUMB_HEIGHT,
      Math.round((clientHeight / scrollHeight) * trackHeight)
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = Math.round((scrollTop / maxScrollTop) * maxThumbTop);
    setScrollbarState((previous) =>
      previous.scrollable &&
      previous.thumbHeight === thumbHeight &&
      previous.thumbTop === thumbTop
        ? previous
        : { scrollable: true, thumbHeight, thumbTop }
    );
  }, [hideScrollbar, scrollBodyRef]);

  useEffect(() => {
    const contentElement = scrollBodyRef.current;
    if (!contentElement) {
      hideScrollbar();
      return;
    }

    syncScrollbarState();
    contentElement.addEventListener("scroll", syncScrollbarState, {
      passive: true
    });
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncScrollbarState)
        : null;
    resizeObserver?.observe(contentElement);
    if (trackRef.current) {
      resizeObserver?.observe(trackRef.current);
    }
    const animationFrameId = window.requestAnimationFrame(syncScrollbarState);
    return () => {
      contentElement.removeEventListener("scroll", syncScrollbarState);
      resizeObserver?.disconnect();
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [hideScrollbar, scrollBodyRef, syncScrollbarState]);

  useEffect(() => {
    if (!dragging) {
      return;
    }

    const handleMouseMove = (event: MouseEvent): void => {
      const contentElement = scrollBodyRef.current;
      const dragState = dragStateRef.current;
      if (!contentElement || !dragState || dragState.maxThumbTop <= 0) {
        return;
      }
      const delta = event.clientY - dragState.startClientY;
      const nextThumbTop =
        (dragState.startScrollTop / dragState.maxScrollTop) *
          dragState.maxThumbTop +
        delta;
      contentElement.scrollTop =
        (Math.min(Math.max(0, nextThumbTop), dragState.maxThumbTop) /
          dragState.maxThumbTop) *
        dragState.maxScrollTop;
      syncScrollbarState();
    };

    const handleMouseUp = (): void => {
      dragStateRef.current = null;
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, scrollBodyRef, syncScrollbarState]);

  const scrollContentToThumbTop = (thumbTop: number): void => {
    const contentElement = scrollBodyRef.current;
    const trackElement = trackRef.current;
    if (!contentElement || !trackElement) {
      return;
    }
    const maxScrollTop = Math.max(
      0,
      contentElement.scrollHeight - contentElement.clientHeight
    );
    const maxThumbTop = Math.max(
      0,
      trackElement.clientHeight - scrollbarState.thumbHeight
    );
    if (maxScrollTop <= 0 || maxThumbTop <= 0) {
      return;
    }
    contentElement.scrollTop =
      (Math.min(Math.max(0, thumbTop), maxThumbTop) / maxThumbTop) *
      maxScrollTop;
    syncScrollbarState();
  };

  const handleTrackMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>
  ): void => {
    if (
      event.button !== 0 ||
      !scrollbarState.scrollable ||
      event.target !== event.currentTarget
    ) {
      return;
    }
    event.preventDefault();
    const trackRect = event.currentTarget.getBoundingClientRect();
    scrollContentToThumbTop(
      event.clientY - trackRect.top - scrollbarState.thumbHeight / 2
    );
  };

  const handleThumbMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>
  ): void => {
    if (event.button !== 0 || !scrollbarState.scrollable) {
      return;
    }
    const contentElement = scrollBodyRef.current;
    const trackElement = trackRef.current;
    if (!contentElement || !trackElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      maxScrollTop: Math.max(
        0,
        contentElement.scrollHeight - contentElement.clientHeight
      ),
      maxThumbTop: Math.max(
        0,
        trackElement.clientHeight - scrollbarState.thumbHeight
      ),
      startClientY: event.clientY,
      startScrollTop: contentElement.scrollTop
    };
    setDragging(true);
  };

  if (!scrollbarState.scrollable && !dragging) {
    return <div ref={trackRef} className="hidden" aria-hidden="true" />;
  }

  return (
    <div
      ref={trackRef}
      className="workspace-agents-status-panel__scrollbar agent-gui-node__mention-palette-scrollbar group/status-scrollbar"
      data-scrollable={scrollbarState.scrollable ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-testid="agent-gui-mention-palette-scrollbar"
      aria-hidden="true"
      onMouseDown={handleTrackMouseDown}
    >
      <div
        className="workspace-agents-status-panel__scrollbar-thumb"
        onMouseDown={handleThumbMouseDown}
        style={{
          height: `${scrollbarState.thumbHeight}px`,
          transform: `translateY(${scrollbarState.thumbTop}px)`
        }}
      />
    </div>
  );
}

function centerElementInScrollContainer(
  container: HTMLElement,
  element: HTMLElement
): void {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const currentScrollTop = container.scrollTop;
  const elementTop = elementRect.top - containerRect.top + currentScrollTop;
  const centeredScrollTop =
    elementTop - (container.clientHeight - elementRect.height) / 2;
  const maxScrollTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight
  );
  const nextScrollTop = Math.min(Math.max(0, centeredScrollTop), maxScrollTop);
  container.scrollTo({ top: nextScrollTop, behavior: "auto" });
}

function renderMentionPaletteGroups(input: {
  filter: AgentMentionFilterId;
  groups: ReadonlyArray<AgentMentionGroup>;
  highlightedKey: string | null;
  highlightedOptionRef: MutableRefObject<HTMLButtonElement | null>;
  mode: AgentMentionSearchState["mode"];
  onExpandGroup: (groupId: AgentMentionGroupId) => void;
  onHighlightChange: (key: string) => void;
  onSelectItem: (entry: AgentContextMentionItem) => void;
  query: string;
}): React.JSX.Element {
  return (
    <div className="grid gap-3">
      {renderMentionGroups(
        input.groups,
        input.query,
        input.filter,
        input.highlightedKey,
        input.highlightedOptionRef,
        input.onHighlightChange,
        input.onSelectItem,
        input.onExpandGroup
      )}
      {shouldShowFileSearchMoreHint(input) ? (
        <MentionFileSearchMoreHint />
      ) : null}
    </div>
  );
}

function MentionFileSearchMoreHint(): React.JSX.Element {
  "use memo";
  return (
    <p
      className="px-3 pb-1 pt-2 text-center text-[13px] leading-5 text-[var(--text-tertiary)]"
      data-agent-mention-file-search-hint="true"
    >
      {translate("agentHost.agentGui.mentionFileSearchMoreHint")}
    </p>
  );
}

function renderMentionGroups(
  groups: ReadonlyArray<AgentMentionGroup>,
  query: string,
  filter: AgentMentionFilterId,
  highlightedKey: string | null,
  highlightedOptionRef: MutableRefObject<HTMLButtonElement | null>,
  onHighlightChange: (key: string) => void,
  onSelectItem: (entry: AgentContextMentionItem) => void,
  onExpandGroup: (groupId: AgentMentionGroupId) => void
): React.JSX.Element[] {
  return groups.map((group, index) => {
    const followsMySessions =
      group.id === "collab_sessions" && groups[index - 1]?.id === "my_sessions";
    const showGroupLabel = shouldRenderMentionGroupLabel({
      filter,
      groupCount: groups.length,
      groupId: group.id,
      query
    });
    const showGroupDivider =
      index > 0 && !shouldSuppressFileSearchGroupChrome(filter, query);
    return (
      <section
        key={group.id}
        className={cn("grid gap-1", followsMySessions && "mt-2")}
      >
        {showGroupDivider ? (
          <div
            className="mx-3 mb-2 border-t border-[var(--line-1)]"
            data-agent-mention-group-divider="true"
            aria-hidden="true"
          />
        ) : null}
        {showGroupLabel ? (
          <div className="px-3 text-[13px] font-normal text-[var(--text-secondary)]">
            {agentMentionGroupLabel(group.id)}
          </div>
        ) : null}
        <div className="grid gap-1">
          {group.items.length === 0 &&
          !shouldSuppressFileSearchGroupChrome(filter, query) ? (
            <div className="px-3 py-1 text-[13px] font-normal text-[var(--text-tertiary)]">
              {agentMentionEmptyGroupLabel(group.id, query)}
            </div>
          ) : null}
          {group.items.map((item) => {
            const itemKey = `${group.id}:${item.kind}:${
              item.kind === "file"
                ? agentGeneratedMentionItemKey(item)
                : item.targetId
            }`;
            const isHighlighted = itemKey === highlightedKey;
            return (
              <button
                key={itemKey}
                ref={isHighlighted ? highlightedOptionRef : null}
                type="button"
                className={cn(
                  paletteStyles.rowButton,
                  isHighlighted && "bg-[var(--transparency-block)]"
                )}
                role="option"
                aria-selected={isHighlighted}
                onMouseEnter={() => onHighlightChange(itemKey)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelectItem(item)}
              >
                {renderMentionRow(item)}
              </button>
            );
          })}
          {group.hasMore ? (
            <button
              key={`expand:${group.id}`}
              ref={
                `expand:${group.id}` === highlightedKey
                  ? highlightedOptionRef
                  : null
              }
              type="button"
              className={cn(
                paletteStyles.expandButton,
                `expand:${group.id}` === highlightedKey &&
                  "bg-[var(--transparency-block)] text-[var(--text-primary)]"
              )}
              onMouseEnter={() => onHighlightChange(`expand:${group.id}`)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onExpandGroup(group.id)}
            >
              {translate("agentHost.agentGui.contextPickerExpandMore", {
                count: mentionGroupExpandCount(group, filter)
              })}
            </button>
          ) : null}
        </div>
      </section>
    );
  });
}

function shouldSuppressFileSearchGroupChrome(
  filter: AgentMentionFilterId,
  query: string
): boolean {
  return filter === "file" && query.trim().length > 0;
}

function resolveMentionPaletteEmptyLabel(input: {
  emptyLabel: string;
  filter: AgentMentionFilterId;
  mode: AgentMentionSearchState["mode"];
  query: string;
}): string {
  if (
    input.mode === "results" &&
    input.filter === "file" &&
    input.query.trim().length > 0
  ) {
    return translate("agentHost.agentGui.mentionNoMatchingFiles");
  }
  return input.emptyLabel;
}

function shouldRenderMentionGroupLabel(input: {
  filter: AgentMentionFilterId;
  groupCount: number;
  groupId: AgentMentionGroupId;
  query: string;
}): boolean {
  if (shouldSuppressFileSearchGroupChrome(input.filter, input.query)) {
    return false;
  }
  if (input.filter === "all" || input.groupCount !== 1) {
    return true;
  }
  return (
    agentMentionGroupLabel(input.groupId) !==
    agentMentionFilterLabel(input.filter)
  );
}

function renderMentionRow(item: AgentContextMentionItem): React.JSX.Element {
  if (item.kind === "file") {
    const visualKind = resolveAgentMentionFileVisualKind({
      entryKind: item.entryKind,
      href: item.href,
      mentionNavigation: item.mentionNavigation,
      name: item.name,
      path: item.path
    });
    const childCountLabel =
      item.mentionNavigation === "agent-generated-folder" &&
      typeof item.childCount === "number" &&
      item.childCount > 0
        ? translate("agentHost.agentGui.mentionAgentGeneratedFolderFileCount", {
            count: item.childCount
          })
        : null;
    return (
      <span
        className="flex min-w-0 items-center gap-2"
        data-agent-file-mention="true"
        data-agent-mention-kind="file"
        data-agent-file-entry-kind={item.entryKind}
        data-agent-file-visual-kind={visualKind}
        {...(item.mentionNavigation
          ? { "data-agent-mention-navigation": item.mentionNavigation }
          : {})}
      >
        <MentionFileIcon item={item} visualKind={visualKind} />
        <span className="flex min-w-0 items-baseline gap-1 overflow-hidden">
          <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {item.name}
          </span>
          {childCountLabel ? (
            <span className="shrink-0 text-[13px] font-normal text-[var(--text-secondary)]">
              {childCountLabel}
            </span>
          ) : null}
        </span>
      </span>
    );
  }

  if (item.kind === "session") {
    const statusTag = renderSessionMentionStatusTag(item.status);
    return (
      <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <span className="flex min-w-0 items-center gap-2 overflow-hidden">
          <MentionSessionAvatarStack item={item} />
          <span className="min-w-0 truncate text-[13px] font-semibold leading-[16px] text-[var(--text-primary)]">
            <MentionSessionTitle item={item} />
          </span>
        </span>
        {statusTag}
      </span>
    );
  }

  if (item.kind === "workspace-app") {
    return (
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        <MentionWorkspaceAppIcon iconUrl={item.iconUrl} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden">
          <span className="min-w-0 max-w-[40%] shrink-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {item.name}
          </span>
          {item.description ? (
            <span className="min-w-0 flex-1 truncate text-[13px] font-normal text-[var(--text-secondary)]">
              {item.description}
            </span>
          ) : null}
        </span>
      </span>
    );
  }

  if (item.kind === "workspace-app-factory") {
    return (
      <span className="grid min-w-0 overflow-hidden gap-1">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {item.name}
        </span>
      </span>
    );
  }

  return (
    <span className="grid min-w-0 overflow-hidden gap-1">
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {item.title}
        </span>
        {item.status ? <IssueMentionStatusTag status={item.status} /> : null}
      </span>
      {item.creatorName ? (
        <span className="truncate text-[13px] font-normal text-[var(--text-secondary)]">
          {item.creatorName}
        </span>
      ) : null}
    </span>
  );
}

function MentionFileIcon({
  item,
  visualKind
}: {
  item: Extract<AgentContextMentionItem, { kind: "file" }>;
  visualKind: ReturnType<typeof resolveAgentMentionFileVisualKind>;
}): React.JSX.Element {
  "use memo";
  const thumbnailUrl = resolveAgentMentionFileThumbnailUrl(item);
  if (thumbnailUrl) {
    return (
      <span
        className="agent-gui-node__mention-file-thumb"
        data-agent-mention-file-thumb="true"
        aria-hidden="true"
      >
        <img
          src={thumbnailUrl}
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }

  return (
    <span
      className="agent-gui-node__mention-file-icon"
      data-agent-file-visual-kind={visualKind}
      aria-hidden="true"
    />
  );
}

function MentionWorkspaceAppIcon({
  iconUrl
}: {
  iconUrl?: string | null;
}): React.JSX.Element {
  "use memo";
  const normalizedIconUrl = iconUrl?.trim() ?? "";
  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-[5px] bg-block text-[var(--text-secondary)]"
      data-agent-mention-app-icon="true"
      data-workspace-app-icon="true"
      aria-hidden="true"
    >
      {normalizedIconUrl ? (
        <img
          src={normalizedIconUrl}
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className="tsh-agent-object-token__kind-icon h-4 w-4" />
      )}
    </span>
  );
}

function MentionSessionAvatarStack({
  item
}: {
  item: Extract<AgentContextMentionItem, { kind: "session" }>;
}): React.JSX.Element {
  "use memo";
  const userAvatarUrl = item.initiatorAvatarUrl?.trim() ?? "";
  const userImageUrl = userAvatarUrl || userAvatarPlaceholderUrl;
  return (
    <span
      className="relative isolate block h-5 w-9 shrink-0"
      aria-hidden="true"
    >
      <span
        className="absolute left-0 top-0 z-0 grid h-5 w-5 overflow-hidden rounded-full bg-block"
        data-agent-mention-user-avatar="true"
      >
        <img
          src={userImageUrl}
          alt=""
          className={cn(
            "h-full w-full object-cover",
            !userAvatarUrl &&
              "workspace-agents-status-panel__avatar-img--user-placeholder"
          )}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={(event) => {
            if (event.currentTarget.dataset.fallbackAvatarApplied === "true") {
              return;
            }
            event.currentTarget.dataset.fallbackAvatarApplied = "true";
            event.currentTarget.src = userAvatarPlaceholderUrl;
            event.currentTarget.classList.add(
              "workspace-agents-status-panel__avatar-img--user-placeholder"
            );
          }}
        />
      </span>
      <span
        className="absolute left-4 top-0 z-10 grid h-5 w-5 overflow-hidden rounded-full bg-block"
        data-agent-mention-agent-avatar="true"
      >
        <img
          src={managedAgentRoundedIconUrl(
            mentionSessionAgentProvider(item) ?? item.agentName
          )}
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    </span>
  );
}

function mentionSessionAgentProvider(
  item: Extract<AgentContextMentionItem, { kind: "session" }>
): string | null {
  const queryStart = item.href.indexOf("?");
  if (queryStart < 0) {
    return null;
  }
  return new URLSearchParams(item.href.slice(queryStart + 1)).get("provider");
}

function MentionSessionTitle({
  item
}: {
  item: Extract<AgentContextMentionItem, { kind: "session" }>;
}): React.JSX.Element {
  "use memo";
  return (
    <>
      <span className="text-[13px] leading-[16px]">
        {item.initiatorName} & {item.agentName}
      </span>
      <span className="text-[13px] font-normal leading-[16px] text-[var(--text-secondary)]">
        {" "}
        {item.title}
      </span>
    </>
  );
}

function MentionStatusTag({ status }: { status: string }): React.JSX.Element {
  "use memo";
  const activityStatus = normalizeAgentActivityDisplayStatus(status);
  const statusTone = mentionStatusTone(activityStatus);
  const statusLabel = workspaceAgentActivityStatusLabel(activityStatus);
  return (
    <Badge
      variant="secondary"
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-[11px] font-semibold leading-none",
        mentionStatusBadgeClassName(activityStatus)
      )}
      data-agent-mention-status-tag="true"
      data-status={activityStatus}
      data-tone={statusTone}
      title={statusLabel}
    >
      <StatusDot
        tone={statusTone}
        pulse={activityStatus === "working" || activityStatus === "waiting"}
        size="xs"
        title={statusLabel}
      />
      <span>{statusLabel}</span>
    </Badge>
  );
}

function renderSessionMentionStatusTag(
  status: string | undefined
): React.JSX.Element | null {
  if (!status) {
    return null;
  }
  const activityStatus = normalizeAgentActivityDisplayStatus(status);
  return <MentionStatusTag status={activityStatus} />;
}

function IssueMentionStatusTag({
  status
}: {
  status: string;
}): React.JSX.Element {
  "use memo";
  const normalizedStatus = status.trim().toLowerCase() || "not_started";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "shrink-0 text-[13px]",
        issueMentionStatusBadgeClassName(status)
      )}
      data-agent-mention-status-tag="true"
      data-status={normalizedStatus}
    >
      {roomIssueStatusLabel(status)}
    </Badge>
  );
}

function mentionStatusTone(
  status: AgentActivityDisplayStatus
): "amber" | "blue" | "green" | "neutral" | "red" {
  if (status === "working") {
    return "blue";
  }
  if (status === "waiting" || status === "canceled") {
    return "amber";
  }
  if (status === "completed" || status === "idle") {
    return "green";
  }
  if (status === "failed") {
    return "red";
  }
  return "neutral";
}

function mentionStatusBadgeClassName(
  status: AgentActivityDisplayStatus
): string {
  if (status === "working") {
    return "bg-sky-500/10 text-sky-700";
  }
  if (status === "waiting" || status === "canceled") {
    return "bg-[color:color-mix(in_srgb,var(--color-amber-500)_12%,transparent)] text-[var(--color-amber-500)]";
  }
  if (status === "completed" || status === "idle") {
    return "bg-[var(--tsh-ui-pill-success-bg)] text-[var(--tsh-ui-pill-success-fg)]";
  }
  if (status === "failed") {
    return "bg-[var(--on-danger)] text-[var(--state-danger)]";
  }
  return "bg-[var(--transparency-block)] text-[var(--text-secondary)]";
}

function issueMentionStatusBadgeClassName(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "bg-[color:color-mix(in_srgb,var(--state-success)_12%,transparent)] text-[var(--state-success)]";
    case "running":
    case "pending_acceptance":
      return "bg-[var(--transparency-block)] text-[var(--text-secondary)]";
    case "failed":
    case "canceled":
      return "bg-[var(--on-danger)] text-[var(--state-danger)]";
    default:
      return "bg-[var(--transparency-block)] text-[var(--text-secondary)]";
  }
}

function browseHintForFilter(filter: AgentMentionFilterId): string {
  if (filter === "all") {
    return translate("agentHost.agentGui.contextPickerBrowseAllHint");
  }
  switch (filter) {
    case "app":
      return translate("agentHost.agentGui.contextPickerBrowseAppHint");
    case "file":
      return translate("agentHost.agentGui.contextPickerBrowseFileHint");
    case "session":
      return translate("agentHost.agentGui.contextPickerBrowseSessionHint");
    case "issue":
      return translate("agentHost.agentGui.contextPickerBrowseIssueHint");
  }
}

function isBrowseCategoryId(
  value: string | null
): value is AgentMentionFilterId {
  return (
    value === "all" ||
    value === "app" ||
    value === "file" ||
    value === "session" ||
    value === "issue"
  );
}

function hasInteractiveGroupEntries(
  groups: ReadonlyArray<AgentMentionGroup>
): boolean {
  return groups.some((group) => group.items.length > 0 || group.hasMore);
}

function isFileBrowseGroupsOnlyEmpty(
  groups: ReadonlyArray<AgentMentionGroup>
): boolean {
  const fileGroups = groups.filter(
    (group) =>
      group.id === "opened_files" || group.id === "agent_generated_files"
  );
  if (fileGroups.length === 0) {
    return false;
  }
  return fileGroups.every(
    (group) => group.items.length === 0 && !group.hasMore
  );
}

function hasVisibleFileGroupEntries(
  groups: ReadonlyArray<AgentMentionGroup>
): boolean {
  return groups.some(
    (group) =>
      (group.id === "files" ||
        group.id === "opened_files" ||
        group.id === "agent_generated_files") &&
      (group.items.length > 0 || group.hasMore)
  );
}

function shouldShowFileSearchMoreHint(input: {
  filter: AgentMentionFilterId;
  groups: ReadonlyArray<AgentMentionGroup>;
  mode: AgentMentionSearchState["mode"];
  query: string;
}): boolean {
  if (input.filter !== "file" || input.query.trim()) {
    return false;
  }
  if (input.mode !== "browse" && input.mode !== "results") {
    return false;
  }
  return hasVisibleFileGroupEntries(input.groups);
}

function shouldShowBrowseSearchHint(input: {
  browseFilter: AgentMentionFilterId;
  groups: ReadonlyArray<AgentMentionGroup>;
  highlightedBrowseCategory: string | null;
  mode: AgentMentionSearchState["mode"];
}): boolean {
  if (input.mode !== "browse" || hasInteractiveGroupEntries(input.groups)) {
    return false;
  }
  if (input.groups.length === 0) {
    return true;
  }
  if (
    input.highlightedBrowseCategory !== null &&
    input.highlightedBrowseCategory !== input.browseFilter
  ) {
    return true;
  }
  return (
    input.browseFilter === "file" && isFileBrowseGroupsOnlyEmpty(input.groups)
  );
}
