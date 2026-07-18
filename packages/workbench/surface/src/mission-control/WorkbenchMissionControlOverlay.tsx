import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type TransitionEvent
} from "react";
import {
  AppWindowIcon,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GridHorizontalLinedIcon,
  GridVerticalLinedIcon,
  type IconProps
} from "@tutti-os/ui-system";
import {
  shouldShowWorkbenchMissionControlLayoutHint,
  shouldShowWorkbenchMissionControlLayoutPreset,
  shouldShowWorkbenchMissionControlNoAvailableLayoutMessage
} from "./layoutDock.ts";
import type { WorkbenchMissionControlState } from "./useWorkbenchMissionControlState.ts";
import type { WorkbenchMissionControlPhase } from "./useWorkbenchMissionControlPresence.ts";
import type { WorkbenchMissionControlI18nRuntime } from "./workbenchMissionControlI18n.ts";

export interface WorkbenchMissionControlBackdropProps {
  className?: string;
  onExitTransitionComplete?: () => void;
  phase: WorkbenchMissionControlPhase;
}

export function WorkbenchMissionControlBackdrop({
  className,
  onExitTransitionComplete,
  phase
}: WorkbenchMissionControlBackdropProps) {
  return (
    <div
      aria-hidden
      className={["workbench-mission-control-backdrop", className]
        .filter(Boolean)
        .join(" ")}
      data-phase={phase}
      onTransitionEnd={(event: TransitionEvent<HTMLDivElement>) => {
        if (
          phase !== "closing" ||
          event.target !== event.currentTarget ||
          event.propertyName !== "opacity"
        ) {
          return;
        }
        onExitTransitionComplete?.();
      }}
    />
  );
}

export interface WorkbenchMissionControlOverlayProps {
  i18n: WorkbenchMissionControlI18nRuntime;
  phase: WorkbenchMissionControlPhase;
  state: WorkbenchMissionControlState;
}

export function WorkbenchMissionControlOverlay({
  i18n,
  phase,
  state
}: WorkbenchMissionControlOverlayProps) {
  const layoutDockContentRef = useRef<HTMLDivElement | null>(null);
  const [layoutDockWidth, setLayoutDockWidth] = useState<number | null>(null);
  // Only one preset menu may be open at a time; hovering another button
  // replaces the previous one instead of stacking popovers.
  const [openLayoutKey, setOpenLayoutKey] = useState<
    "balanced" | "row" | "column" | null
  >(null);
  const hoverOpenTimeoutRef = useRef<number | null>(null);

  const clearHoverOpenTimeout = () => {
    if (hoverOpenTimeoutRef.current !== null) {
      window.clearTimeout(hoverOpenTimeoutRef.current);
      hoverOpenTimeoutRef.current = null;
    }
  };

  const requestHoverOpen = (key: "balanced" | "row" | "column") => {
    clearHoverOpenTimeout();
    // A menu is already open: switch to the hovered button immediately.
    if (openLayoutKey !== null) {
      setOpenLayoutKey(key);
      return;
    }
    hoverOpenTimeoutRef.current = window.setTimeout(() => {
      hoverOpenTimeoutRef.current = null;
      setOpenLayoutKey(key);
    }, layoutPresetMenuHoverOpenDelayMs);
  };

  const closeLayoutMenu = (key: "balanced" | "row" | "column") => {
    clearHoverOpenTimeout();
    setOpenLayoutKey((current) => (current === key ? null : current));
  };

  useEffect(() => clearHoverOpenTimeout, []);

  const layoutPresets: Array<{
    icon: ComponentType<IconProps>;
    key: "balanced" | "row" | "column";
    label: string;
    preset: { kind: "balanced" } | { kind: "row" } | { kind: "column" };
  }> = [
    {
      icon: AppWindowIcon,
      key: "balanced" as const,
      label: i18n.t("presets.balanced"),
      preset: { kind: "balanced" } as const
    },
    {
      icon: GridHorizontalLinedIcon,
      key: "row" as const,
      label: i18n.t("presets.row"),
      preset: { kind: "row" } as const
    },
    {
      icon: GridVerticalLinedIcon,
      key: "column" as const,
      label: i18n.t("presets.column"),
      preset: { kind: "column" } as const
    }
  ].filter((option) =>
    shouldShowWorkbenchMissionControlLayoutPreset(
      state.selectedCount,
      option.preset
    )
  );
  const showLayoutSelectionHint = shouldShowWorkbenchMissionControlLayoutHint(
    state.selectedCount
  );
  const hasUsableLayoutPreset = layoutPresets.some((option) =>
    state.canUsePreset(option.preset)
  );
  const showNoAvailableLayoutMessage =
    shouldShowWorkbenchMissionControlNoAvailableLayoutMessage(
      state.selectedCount,
      hasUsableLayoutPreset
    );

  useLayoutEffect(() => {
    const element = layoutDockContentRef.current;
    if (!element) {
      return;
    }
    const computedStyle = window.getComputedStyle(element.parentElement!);
    const horizontalChrome =
      Number.parseFloat(computedStyle.paddingLeft) +
      Number.parseFloat(computedStyle.paddingRight) +
      Number.parseFloat(computedStyle.borderLeftWidth) +
      Number.parseFloat(computedStyle.borderRightWidth);
    setLayoutDockWidth(element.scrollWidth + horizontalChrome);
  }, [
    i18n,
    layoutPresets.length,
    showLayoutSelectionHint,
    showNoAvailableLayoutMessage,
    state.selectedCount
  ]);

  return (
    <div
      className="workbench-mission-control pointer-events-none absolute inset-0 overflow-hidden"
      data-phase={phase}
    >
      {state.mode === "activate" ? (
        <div className="workbench-mission-control__footer-shell pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-6">
          <div
            className="workbench-mission-control__layout-dock desktop-dock-plate pointer-events-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workbench-mission-control__layout-dock-content">
              <Button
                className="workbench-mission-control__layout-mode-button"
                type="button"
                variant="ghost"
                onClick={() => state.requestMode("layout")}
              >
                <AppWindowIcon
                  aria-hidden
                  className="workbench-mission-control__layout-glyph"
                />
                {i18n.t("layoutModeTrigger")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {state.mode === "layout" ? (
        <div className="workbench-mission-control__footer-shell pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-6">
          <div
            className="workbench-mission-control__layout-dock desktop-dock-plate pointer-events-auto"
            style={
              layoutDockWidth === null ? undefined : { width: layoutDockWidth }
            }
            onClick={(event) => event.stopPropagation()}
          >
            <div
              ref={layoutDockContentRef}
              className="workbench-mission-control__layout-dock-content"
            >
              {showLayoutSelectionHint ? (
                <span className="workbench-mission-control__layout-hint">
                  {i18n.t("layoutSelectionHint")}
                </span>
              ) : showNoAvailableLayoutMessage ? (
                <span className="workbench-mission-control__layout-hint">
                  {i18n.t("noAvailableLayout")}
                </span>
              ) : (
                <div className="flex items-end gap-2">
                  {layoutPresets.map((option) => (
                    <WorkbenchMissionControlLayoutPresetButton
                      key={option.key}
                      arrangeOnceLabel={i18n.t("presetActions.arrangeOnce")}
                      canApply={state.canApplyPreset(option.preset)}
                      icon={option.icon}
                      layoutKey={option.key}
                      lockLayoutLabel={i18n.t("presetActions.lockLayout")}
                      open={openLayoutKey === option.key}
                      onApply={(lock) => {
                        closeLayoutMenu(option.key);
                        state.applyPreset(option.preset, { lock });
                      }}
                      onHoverOpen={() => requestHoverOpen(option.key)}
                      onHoverCancel={clearHoverOpenTimeout}
                      onRequestClose={() => closeLayoutMenu(option.key)}
                      presetLabel={option.label}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const layoutPresetMenuHoverOpenDelayMs = 200;

interface WorkbenchMissionControlLayoutPresetButtonProps {
  arrangeOnceLabel: string;
  canApply: boolean;
  icon: ComponentType<IconProps>;
  layoutKey: "balanced" | "row" | "column";
  lockLayoutLabel: string;
  onApply: (lock: boolean) => void;
  onHoverCancel: () => void;
  onHoverOpen: () => void;
  onRequestClose: () => void;
  open: boolean;
  presetLabel: string;
}

function WorkbenchMissionControlLayoutPresetButton({
  arrangeOnceLabel,
  canApply,
  icon: LayoutIcon,
  layoutKey,
  lockLayoutLabel,
  onApply,
  onHoverCancel,
  onHoverOpen,
  onRequestClose,
  open,
  presetLabel
}: WorkbenchMissionControlLayoutPresetButtonProps) {
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onRequestClose();
          return;
        }
        if (canApply) {
          onHoverOpen();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={presetLabel}
          className="workbench-mission-control__layout-dock-button"
          data-layout-key={layoutKey}
          data-menu-open={open ? "true" : undefined}
          disabled={!canApply}
          size="icon"
          title={presetLabel}
          type="button"
          variant="ghost"
          onClick={() => {
            // Clicking the icon directly applies the locked layout; the
            // dropdown stays a hover affordance for choosing "arrange once".
            if (canApply) {
              onApply(true);
            }
          }}
          onPointerDown={(event) => {
            // Keep Radix from toggling the menu on pointer down so the click
            // applies the layout instead.
            event.preventDefault();
          }}
          onPointerEnter={() => {
            if (canApply) {
              onHoverOpen();
            }
          }}
          onPointerLeave={onHoverCancel}
        >
          <LayoutIcon
            aria-hidden
            className="workbench-mission-control__layout-glyph"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="w-auto min-w-40"
        sideOffset={10}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuItem onSelect={() => onApply(false)}>
          {arrangeOnceLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onApply(true)}>
          {lockLayoutLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
