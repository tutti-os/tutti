import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from "react";
import {
  Button,
  CheckIcon,
  FolderFilledIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import { AddLinedIcon } from "@tutti-os/ui-system/icons";
import {
  WorkspaceFileEntryIcon,
  useWorkspaceFileEntryIconUrls,
  type WorkspaceFileEntry
} from "@tutti-os/workspace-file-manager";
import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import { nodeRefKey } from "../../../core/index.ts";
import {
  referenceSearchResultNodeAt,
  type ReferenceSearchResultIndex
} from "../../../react/internal/reference/referenceSearchResultIndex.ts";
import { referenceNodeToWorkspaceFileEntry } from "./referenceNodeIconEntry.ts";
import {
  REFERENCE_SEARCH_ROW_HEIGHT_PX,
  referenceSearchEffectiveScrollTopForLogicalPosition,
  referenceSearchVirtualRowTop,
  resolveReferenceSearchVirtualWindow
} from "./referenceSearchVirtualWindow.ts";

export interface ReferenceSearchResultActions {
  isSelectable(node: ReferenceNode): boolean;
  onContextMenu(event: MouseEvent<HTMLElement>, node: ReferenceNode): void;
  onFocus(node: ReferenceNode): void;
  onOpen(node: ReferenceNode): Promise<void>;
  onSingleSelect(node: ReferenceNode): void;
  onToggle(node: ReferenceNode): void;
}

export function ReferenceSearchResultList({
  actionsRef,
  focusedNode,
  hasMore,
  isLoadingMore,
  onEndReached,
  resolveEntryIconUrl,
  resultCount,
  resultIdentity,
  resultIndex,
  scrollElement,
  selection
}: {
  actionsRef: RefObject<ReferenceSearchResultActions | null>;
  focusedNode: ReferenceNode | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  onEndReached(): void;
  resolveEntryIconUrl?: (
    entry: WorkspaceFileEntry
  ) => Promise<string | null | undefined>;
  resultCount: number;
  resultIdentity: number;
  resultIndex: ReferenceSearchResultIndex;
  scrollElement: HTMLDivElement | null;
  selection: readonly ReferenceNode[];
}): JSX.Element {
  const metrics = useReferenceSearchViewportMetrics(
    scrollElement,
    resultIdentity
  );
  const previousVirtualGeometryRef = useRef<{
    logicalScrollTop: number;
    resultCount: number;
    resultIdentity: number;
  } | null>(null);
  const previousVirtualGeometry = previousVirtualGeometryRef.current;
  const appendedScrollTop =
    previousVirtualGeometry &&
    previousVirtualGeometry.resultIdentity === resultIdentity &&
    previousVirtualGeometry.resultCount < resultCount &&
    metrics.viewportHeight > 0
      ? referenceSearchEffectiveScrollTopForLogicalPosition({
          itemCount: resultCount,
          logicalScrollTop: previousVirtualGeometry.logicalScrollTop,
          viewportHeight: metrics.viewportHeight
        })
      : null;
  const virtualWindow = resolveReferenceSearchVirtualWindow({
    itemCount: resultCount,
    scrollTop: appendedScrollTop ?? metrics.scrollTop,
    viewportHeight: metrics.viewportHeight
  });
  useLayoutEffect(() => {
    previousVirtualGeometryRef.current = {
      logicalScrollTop: virtualWindow.logicalScrollTop,
      resultCount,
      resultIdentity
    };
    if (appendedScrollTop !== null) {
      metrics.setScrollTop(appendedScrollTop);
    }
  }, [
    appendedScrollTop,
    metrics.setScrollTop,
    resultCount,
    resultIdentity,
    virtualWindow.logicalScrollTop
  ]);
  const lastEndReachedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !hasMore ||
      isLoadingMore ||
      metrics.viewportHeight <= 0 ||
      virtualWindow.endIndex < resultCount
    ) {
      return;
    }
    const key = `${resultIdentity}:${resultCount}`;
    if (lastEndReachedKeyRef.current === key) {
      return;
    }
    lastEndReachedKeyRef.current = key;
    onEndReached();
  }, [
    hasMore,
    isLoadingMore,
    metrics.viewportHeight,
    onEndReached,
    resultCount,
    resultIdentity,
    virtualWindow.endIndex
  ]);
  const visibleRows = useMemo(() => {
    const rows: Array<{ index: number; node: ReferenceNode }> = [];
    for (
      let index = virtualWindow.startIndex;
      index < virtualWindow.endIndex;
      index += 1
    ) {
      const node = referenceSearchResultNodeAt(resultIndex, index);
      if (node) {
        rows.push({ index, node });
      }
    }
    return rows;
  }, [resultIndex, virtualWindow.endIndex, virtualWindow.startIndex]);
  const visibleEntries = useMemo(
    () =>
      visibleRows.map(({ node }) => referenceNodeToWorkspaceFileEntry(node)),
    [visibleRows]
  );
  const iconUrls = useWorkspaceFileEntryIconUrls({
    entries: visibleEntries,
    includeImageThumbnails: resolveEntryIconUrl !== undefined,
    resolveEntryIconUrl
  });
  const selectedKeys = useMemo(
    () => new Set(selection.map((node) => nodeRefKey(node.ref))),
    [selection]
  );

  return (
    <div
      data-reference-search-virtual-list="true"
      role="list"
      style={{
        height: virtualWindow.spacerHeight,
        minHeight: virtualWindow.spacerHeight,
        position: "relative"
      }}
    >
      {visibleRows.map(({ index, node }) => (
        <div
          data-reference-search-index={index}
          key={nodeRefKey(node.ref)}
          role="listitem"
          style={{
            height: REFERENCE_SEARCH_ROW_HEIGHT_PX,
            left: 0,
            position: "absolute",
            top: referenceSearchVirtualRowTop(virtualWindow, index),
            width: "100%"
          }}
        >
          <ReferenceSearchResultRow
            actionsRef={actionsRef}
            focused={isFocused(focusedNode, node)}
            iconUrls={iconUrls}
            node={node}
            selected={selectedKeys.has(nodeRefKey(node.ref))}
          />
        </div>
      ))}
    </div>
  );
}

function useReferenceSearchViewportMetrics(
  scrollElement: HTMLDivElement | null,
  resultIdentity: number
): {
  scrollTop: number;
  setScrollTop(scrollTop: number): void;
  viewportHeight: number;
} {
  const [metrics, setMetrics] = useState({
    scrollTop: 0,
    viewportHeight: 0
  });
  const setScrollTop = useCallback(
    (scrollTop: number) => {
      if (!scrollElement) {
        return;
      }
      scrollElement.scrollTop = scrollTop;
      const next = {
        scrollTop: scrollElement.scrollTop,
        viewportHeight: scrollElement.clientHeight
      };
      setMetrics((current) =>
        current.scrollTop === next.scrollTop &&
        current.viewportHeight === next.viewportHeight
          ? current
          : next
      );
    },
    [scrollElement]
  );

  useEffect(() => {
    if (!scrollElement) {
      return;
    }
    scrollElement.scrollTop = 0;
    setMetrics({
      scrollTop: 0,
      viewportHeight: scrollElement.clientHeight
    });
  }, [resultIdentity, scrollElement]);

  useEffect(() => {
    if (!scrollElement) {
      return;
    }
    const syncMetrics = () => {
      const next = {
        scrollTop: scrollElement.scrollTop,
        viewportHeight: scrollElement.clientHeight
      };
      setMetrics((current) =>
        current.scrollTop === next.scrollTop &&
        current.viewportHeight === next.viewportHeight
          ? current
          : next
      );
    };
    syncMetrics();
    scrollElement.addEventListener("scroll", syncMetrics, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncMetrics);
    resizeObserver?.observe(scrollElement);
    globalThis.addEventListener?.("resize", syncMetrics);
    return () => {
      scrollElement.removeEventListener("scroll", syncMetrics);
      resizeObserver?.disconnect();
      globalThis.removeEventListener?.("resize", syncMetrics);
    };
  }, [scrollElement]);

  return { ...metrics, setScrollTop };
}

type ReferenceNodeIconUrlState = ReturnType<
  typeof useWorkspaceFileEntryIconUrls
>;

function ReferenceSearchResultRow({
  actionsRef,
  focused,
  iconUrls,
  node,
  selected
}: {
  actionsRef: RefObject<ReferenceSearchResultActions | null>;
  focused: boolean;
  iconUrls: ReferenceNodeIconUrlState;
  node: ReferenceNode;
  selected: boolean;
}): JSX.Element {
  const contextLabel = node.contextLabel?.trim() || null;
  const selectable = actionsRef.current?.isSelectable(node) ?? false;
  const active = selected || (focused && selectable);
  const entry = useMemo(() => referenceNodeToWorkspaceFileEntry(node), [node]);
  return (
    <div
      className={cn(
        "grid h-[56px] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[6px] border py-2.5 pr-1 pl-3 transition-colors",
        active
          ? "border-border bg-transparency-block"
          : "border-transparent bg-transparent hover:border-border/70 hover:bg-transparency-block"
      )}
      onClick={() => {
        actionsRef.current?.onFocus(node);
        actionsRef.current?.onSingleSelect(node);
      }}
      onContextMenu={(event) => actionsRef.current?.onContextMenu(event, node)}
      onDoubleClick={(event) => {
        if (node.kind !== "file") {
          return;
        }
        event.stopPropagation();
        actionsRef.current?.onFocus(node);
        void actionsRef.current?.onOpen(node);
      }}
    >
      <div className="flex min-w-0 items-center gap-3 text-left">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--transparency-block)] text-[var(--text-tertiary)]">
          {node.kind === "folder" ? (
            <span className="grid size-7 flex-none place-items-center text-[var(--rich-text-folder)]">
              <FolderFilledIcon className="size-6" />
            </span>
          ) : (
            <WorkspaceFileEntryIcon
              entry={entry}
              frameClassName="size-7"
              iconClassName="size-6"
              iconUrlByCacheKey={iconUrls.iconUrlByCacheKey}
              onViewportEnter={iconUrls.reportEntryIconViewportEnter}
              onViewportLeave={iconUrls.reportEntryIconViewportLeave}
            />
          )}
        </span>
        <span className="min-w-0">
          <ReferenceSearchTextTooltip content={node.displayName}>
            <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
              {node.displayName}
            </span>
          </ReferenceSearchTextTooltip>
          {contextLabel ? (
            <ReferenceSearchTextTooltip content={contextLabel}>
              <span className="block truncate text-[11px] text-[var(--text-secondary)]">
                {contextLabel}
              </span>
            </ReferenceSearchTextTooltip>
          ) : null}
        </span>
      </div>
      {selectable ? (
        <Button
          aria-label={node.displayName}
          aria-pressed={selected}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            actionsRef.current?.onFocus(node);
            actionsRef.current?.onToggle(node);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {selected ? (
            <CheckIcon size={14} />
          ) : (
            <AddLinedIcon className="text-[var(--text-secondary)]" size={16} />
          )}
        </Button>
      ) : null}
    </div>
  );
}

function ReferenceSearchTextTooltip({
  children,
  content
}: {
  children: ReactNode;
  content: string;
}): JSX.Element {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        className="max-w-[min(520px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]"
        side="top"
        style={{
          maxWidth: "min(520px, calc(100vw - 32px))",
          overflowWrap: "anywhere",
          whiteSpace: "normal",
          backgroundColor: "var(--background-fronted)",
          border: "1px solid var(--border-1)",
          borderRadius: 6,
          boxShadow: "var(--shadow-soft)",
          color: "var(--text-primary)",
          padding: "4px 8px"
        }}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function isFocused(
  focused: ReferenceNode | null,
  node: ReferenceNode
): boolean {
  return focused ? nodeRefKey(focused.ref) === nodeRefKey(node.ref) : false;
}
