import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import {
  Button,
  CheckIcon,
  CloseIcon,
  FileCreateIcon,
  MaximizeIcon,
  MinimizeIcon,
  OverviewLayoutIcon,
  PinFilledIcon,
  PinIcon,
  cn
} from "@tutti-os/ui-system";
import type { WorkbenchDockPlacement } from "../react/types.ts";
import type {
  WorkbenchHostDockPopupItem,
  WorkbenchHostDockPopupRetentionAction,
  WorkbenchHostDockPopupVariant
} from "./WorkbenchHostDockPopup.tsx";
import type { WorkbenchHostDockPopupCardLabelMode } from "./types.ts";
import type { WorkbenchHostDockPopupPreviewState } from "./useWorkbenchHostDockPopupPreviewCapture.ts";

const dockPopupMinimizedStackLaunchDisappearMs = 0;
const popupCardMagnificationRange = 160;
const popupCardMaxScale = 1.16;
const popupCardMaxLiftPx = 10;

interface WorkbenchHostDockPopupCardStyle extends CSSProperties {
  "--desktop-dock-popup-card-lift"?: string;
  "--desktop-dock-popup-card-scale"?: string;
  "--desktop-dock-popup-card-z-index"?: string;
  "--desktop-dock-popup-fan-delay"?: string;
  "--desktop-dock-popup-fan-rotate"?: string;
  "--desktop-dock-popup-fan-x"?: string;
  "--desktop-dock-popup-fan-y"?: string;
}

export function resolvePopupCardMagnificationStyle(
  pointer: { x: number; y: number } | null,
  element: HTMLElement | null
): WorkbenchHostDockPopupCardStyle | undefined {
  if (!pointer || !element) {
    return undefined;
  }

  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const distance = Math.hypot(pointer.x - centerX, pointer.y - centerY);
  const influence = Math.max(0, 1 - distance / popupCardMagnificationRange);
  if (influence <= 0) {
    return undefined;
  }

  const eased = influence * influence * (3 - 2 * influence);
  const scale = 1 + (popupCardMaxScale - 1) * eased;
  const lift = -popupCardMaxLiftPx * eased;
  return {
    "--desktop-dock-popup-card-lift": `${Math.round(lift * 10) / 10}px`,
    "--desktop-dock-popup-card-scale": `${Math.round(scale * 1000) / 1000}`,
    "--desktop-dock-popup-card-z-index": `${Math.round(1 + influence * 20)}`
  };
}

export function resolvePopupFanCardStyle(
  index: number,
  count: number,
  placement: WorkbenchDockPlacement
): WorkbenchHostDockPopupCardStyle {
  const safeCount = Math.max(1, count);
  const cappedIndex = Math.min(index, safeCount - 1);
  const arcDirection = placement === "left" ? -1 : 1;
  const arcX = cappedIndex * 6 * arcDirection;
  const arcY = -18 - cappedIndex * 78;
  const rotateDeg = (-2 + cappedIndex * 0.8) * arcDirection;

  return {
    "--desktop-dock-popup-fan-delay": `${index * 22}ms`,
    "--desktop-dock-popup-fan-rotate": `${Math.round(rotateDeg * 10) / 10}deg`,
    "--desktop-dock-popup-fan-x": `${Math.round(arcX)}px`,
    "--desktop-dock-popup-fan-y": `${Math.round(arcY)}px`
  };
}

export function WorkbenchHostDockContextMenu({
  canCreateNew,
  canEnterFullscreen,
  canShowAllWindows,
  dockRetention,
  fullscreenLabel,
  hideLabel,
  items,
  newWindowLabel,
  onCreateNew,
  onEnterFullscreen,
  onHide,
  onQuit,
  onRunDockRetentionAction,
  onSelectNode,
  onShowAllWindows,
  quitLabel,
  showAllWindowsLabel,
  showOpen
}: {
  canCreateNew: boolean;
  canEnterFullscreen: boolean;
  canShowAllWindows: boolean;
  dockRetention?: WorkbenchHostDockPopupRetentionAction | null;
  fullscreenLabel?: string;
  hideLabel?: string;
  items: WorkbenchHostDockPopupItem[];
  newWindowLabel: string;
  onCreateNew: () => void;
  onEnterFullscreen?: () => void;
  onHide?: () => void;
  onQuit?: () => void;
  onRunDockRetentionAction?: () => void;
  onSelectNode: (nodeId: string) => void;
  onShowAllWindows?: () => void;
  quitLabel?: string;
  showAllWindowsLabel?: string;
  showOpen: boolean;
}) {
  const hasOpenWindows = items.length > 0;
  const hasNewWindowCommand = hasOpenWindows && canCreateNew;
  const hasOpenCommand = !hasOpenWindows;
  const hasDockActionGroup =
    Boolean(dockRetention) || hasNewWindowCommand || hasOpenCommand;
  const hasWindowActionGroup = hasOpenWindows;

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-desktop-dock-context-menu="true"
      role="menu"
    >
      {hasOpenWindows ? (
        <div className="max-h-48 min-w-0 overflow-auto overscroll-contain">
          {items.map((item) => (
            <WorkbenchHostDockContextMenuItem
              key={item.node.id}
              checked={!item.isMinimized}
              label={item.title?.trim() || item.node.title}
              onSelect={() => onSelectNode(item.node.id)}
            />
          ))}
        </div>
      ) : null}
      {hasOpenWindows && (hasDockActionGroup || hasWindowActionGroup) ? (
        <WorkbenchHostDockContextMenuSeparator />
      ) : null}
      {dockRetention ? (
        <WorkbenchHostDockContextMenuItem
          checked={dockRetention.checked}
          checkedIcon={
            <PinFilledIcon
              aria-hidden="true"
              className="size-4 text-[var(--tutti-purple)]"
            />
          }
          disabled={dockRetention.disabled}
          icon={<PinIcon aria-hidden="true" className="size-4" />}
          label={dockRetention.pendingLabel ?? dockRetention.label}
          onSelect={onRunDockRetentionAction}
        />
      ) : null}
      {hasNewWindowCommand ? (
        <WorkbenchHostDockContextMenuItem
          icon={<FileCreateIcon aria-hidden="true" className="size-4" />}
          label={newWindowLabel}
          onSelect={onCreateNew}
        />
      ) : null}
      {hasOpenCommand ? (
        <WorkbenchHostDockContextMenuItem
          disabled={!showOpen}
          icon={<FileCreateIcon aria-hidden="true" className="size-4" />}
          label={newWindowLabel}
          onSelect={onCreateNew}
        />
      ) : null}
      {hasOpenWindows ? (
        <>
          {hasDockActionGroup ? (
            <WorkbenchHostDockContextMenuSeparator />
          ) : null}
          {canShowAllWindows && onShowAllWindows ? (
            <WorkbenchHostDockContextMenuItem
              icon={
                <OverviewLayoutIcon aria-hidden="true" className="size-4" />
              }
              label={showAllWindowsLabel}
              onSelect={onShowAllWindows}
            />
          ) : null}
          <WorkbenchHostDockContextMenuItem
            disabled={!canEnterFullscreen || !onEnterFullscreen}
            icon={<MaximizeIcon aria-hidden="true" className="size-4" />}
            label={fullscreenLabel}
            onSelect={onEnterFullscreen}
          />
          <WorkbenchHostDockContextMenuItem
            disabled={!onHide}
            icon={<MinimizeIcon aria-hidden="true" className="size-4" />}
            label={hideLabel}
            onSelect={onHide}
          />
          <WorkbenchHostDockContextMenuItem
            disabled={!onQuit}
            icon={<CloseIcon aria-hidden="true" className="size-4" />}
            label={quitLabel}
            onSelect={onQuit}
          />
        </>
      ) : null}
    </div>
  );
}

function WorkbenchHostDockContextMenuItem({
  checked,
  checkedIcon,
  disabled,
  icon,
  label,
  onSelect
}: {
  checked?: boolean;
  checkedIcon?: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  label?: string;
  onSelect?: () => void;
}) {
  return (
    <button
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--text-primary)] transition-colors",
        disabled
          ? "cursor-default opacity-45"
          : "hover:bg-transparency-hover focus-visible:bg-transparency-hover focus-visible:outline-none"
      )}
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => {
        if (disabled || !onSelect) {
          return;
        }
        onSelect();
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-[var(--text-secondary)]">
        {checked && checkedIcon ? (
          checkedIcon
        ) : checked ? (
          <CheckIcon
            aria-hidden="true"
            className="size-4 text-[var(--tutti-purple)]"
          />
        ) : (
          (icon ?? null)
        )}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function WorkbenchHostDockContextMenuSeparator() {
  return (
    <div
      aria-hidden="true"
      className="mx-2 my-1 h-px bg-[var(--border-1)]"
      role="separator"
    />
  );
}

interface WorkbenchHostDockPopupCardProps {
  closeWindowLabel: (title: string) => string;
  item: WorkbenchHostDockPopupItem;
  labelMode?: WorkbenchHostDockPopupCardLabelMode;
  onCloseNode: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  previewState: WorkbenchHostDockPopupPreviewState;
  style?: CSSProperties;
  variant?: WorkbenchHostDockPopupVariant;
}

export const WorkbenchHostDockPopupCard = forwardRef<
  HTMLDivElement,
  WorkbenchHostDockPopupCardProps
>(function WorkbenchHostDockPopupCard(
  {
    closeWindowLabel,
    item,
    labelMode,
    onCloseNode,
    onSelectNode,
    previewState,
    style,
    variant
  },
  ref
) {
  const title = item.title?.trim() || item.node.title;
  const isMinimizedStack = variant === "minimized-stack";
  const [isLaunching, setIsLaunching] = useState(false);
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (launchTimerRef.current !== null) {
        clearTimeout(launchTimerRef.current);
      }
    },
    []
  );

  const handleSelect = useCallback(() => {
    if (!isMinimizedStack) {
      onSelectNode(item.node.id);
      return;
    }
    if (launchTimerRef.current !== null) {
      return;
    }
    setIsLaunching(true);
    launchTimerRef.current = setTimeout(() => {
      launchTimerRef.current = null;
      onSelectNode(item.node.id);
    }, dockPopupMinimizedStackLaunchDisappearMs);
  }, [isMinimizedStack, item.node.id, onSelectNode]);
  const handleSelectKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      handleSelect();
    },
    [handleSelect]
  );
  const hasReadyPreview = previewState.status === "ready";

  return (
    <div
      ref={ref}
      className={cn(
        "group/dock-popup-card relative flex h-[103px] w-[165px] min-w-0 flex-col overflow-hidden rounded-[8px] border border-[var(--border-1)] bg-background-fronted text-left text-[var(--text-primary)] transition-[border-color,color] duration-150",
        item.isMinimized && "text-[var(--text-secondary)]"
      )}
      data-active={item.isFocused ? "true" : undefined}
      data-desktop-dock-popup-card="true"
      data-fan-card={isMinimizedStack ? "true" : undefined}
      data-launching={isLaunching ? "true" : undefined}
      data-minimized={item.isMinimized ? "true" : undefined}
      style={style}
    >
      <div
        aria-label={title}
        data-active={item.isFocused ? "true" : undefined}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 cursor-pointer flex-col overflow-hidden rounded-md bg-transparent text-inherit",
          hasReadyPreview ? "p-0" : "p-1"
        )}
        role="button"
        tabIndex={0}
        onClick={handleSelect}
        onKeyDown={handleSelectKeyDown}
      >
        <WorkbenchHostDockPopupCardPreview previewState={previewState} />
        {labelMode === "hover-overlay" && title.trim() ? (
          <WorkbenchHostDockPopupCardLabel title={title} />
        ) : null}
      </div>
      <Button
        aria-label={closeWindowLabel(title)}
        className="absolute top-1.5 right-1.5 z-[2] rounded-full bg-[var(--background-fronted)] opacity-0 transition-[background-color,opacity] duration-150 hover:bg-[var(--background-fronted)] focus-visible:bg-[var(--background-fronted)] group-hover/dock-popup-card:opacity-100 group-focus-within/dock-popup-card:opacity-100 focus-visible:opacity-100"
        size="icon-sm"
        title={closeWindowLabel(title)}
        type="button"
        variant="ghost"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseNode(item.node.id);
        }}
      >
        <CloseIcon className="size-3.5" />
      </Button>
      {item.isFocused ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[3] rounded-md shadow-[inset_0_0_0_2px_var(--border-focus)]"
          data-desktop-dock-popup-card-active-overlay="true"
        />
      ) : null}
      {isMinimizedStack ? (
        <span className="desktop-dock-popup__fan-title-tip" title={title}>
          {title}
        </span>
      ) : null}
    </div>
  );
});

function WorkbenchHostDockPopupCardPreview({
  previewState
}: {
  previewState: WorkbenchHostDockPopupPreviewState;
}) {
  if (previewState.status === "loading") {
    return (
      <span
        className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-[7px] rounded-md border border-[var(--border-1)] bg-transparency-block px-3 py-[11px]"
        aria-hidden="true"
        data-preview-state={previewState.status}
      >
        <span className="block h-[7px] w-[72%] rounded-full bg-transparency-hover" />
        <span className="block h-[7px] w-[58%] rounded-full bg-transparency-hover" />
        <span className="block h-[7px] w-[34%] rounded-full bg-transparency-hover" />
      </span>
    );
  }
  if (previewState.status === "fallback") {
    return (
      <span
        className="flex min-h-0 min-w-0 flex-1 rounded-md border border-[var(--border-1)] bg-transparency-block"
        aria-hidden="true"
        data-preview-state={previewState.status}
      />
    );
  }

  const preview = previewState.preview;
  if (preview.kind === "component") {
    return (
      <span
        className="block min-h-0 min-w-0 flex-1 overflow-hidden rounded-md"
        aria-hidden="true"
        data-preview-kind={preview.kind}
        data-preview-state={previewState.status}
      >
        {preview.element}
      </span>
    );
  }

  return (
    <span
      className="block min-h-0 min-w-0 flex-1 overflow-hidden rounded-md"
      aria-hidden="true"
      data-preview-kind={preview.kind}
      data-preview-state={previewState.status}
    >
      <img
        alt=""
        className="block h-full max-h-full w-full max-w-full object-contain object-center"
        draggable={false}
        src={preview.src}
      />
    </span>
  );
}

function WorkbenchHostDockPopupCardLabel({ title }: { title: string }) {
  return (
    <span
      className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] flex h-[30px] items-end px-[10px] pb-0.5 text-[var(--white-stationary)] opacity-0 transition-opacity duration-150 [text-shadow:0_1px_2px_rgb(0_0_0_/_20%)] group-hover/dock-popup-card:opacity-100 group-focus-within/dock-popup-card:opacity-100"
      style={{
        background:
          "linear-gradient(180deg, transparent 0%, color-mix(in srgb, hsl(var(--card)) 28%, transparent) 18%, color-mix(in srgb, hsl(var(--card)) 82%, transparent) 56%, color-mix(in srgb, hsl(var(--card)) 98%, transparent) 100%)"
      }}
      title={title}
    >
      <span className="desktop-dock-popup__title-viewport block min-w-0 flex-1 overflow-hidden whitespace-nowrap">
        <span className="desktop-dock-popup__title-marquee inline-block max-w-full overflow-hidden text-[12px] font-semibold leading-5 text-ellipsis whitespace-nowrap">
          {title}
        </span>
      </span>
    </span>
  );
}
