import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type TransitionEvent
} from "react";
import {
  AppWindowIcon,
  Button,
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
      className="workbench-mission-control pointer-events-none absolute inset-0 z-[1100] overflow-hidden"
      data-phase={phase}
    >
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
                  {layoutPresets.map((option) => {
                    const canApply = state.canApplyPreset(option.preset);
                    const LayoutIcon = option.icon;

                    return (
                      <Button
                        key={option.key}
                        aria-label={option.label}
                        className="workbench-mission-control__layout-dock-button"
                        data-layout-key={option.key}
                        disabled={!canApply}
                        size="icon"
                        title={option.label}
                        type="button"
                        variant="ghost"
                        onClick={() => state.applyPreset(option.preset)}
                      >
                        <LayoutIcon
                          aria-hidden
                          className="workbench-mission-control__layout-glyph"
                        />
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
