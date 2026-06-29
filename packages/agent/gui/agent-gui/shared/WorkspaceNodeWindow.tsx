import {
  useMemo,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";
import { useTranslation } from "../../i18n/index";
import { cn } from "../../app/renderer/lib/utils";
import { CanvasNodeMinimizeButton } from "./CanvasNodeMinimizeButton";
import { CanvasNodeGhostIconButton } from "./CanvasNodeGhostIconButton";
import {
  CanvasNodeCloseIcon,
  CanvasNodeMaximizeLinedIcon,
  CanvasNodeMinimizeLinedIcon
} from "./canvasNodeChromeIcons";
import { NodeResizeHandles } from "./NodeResizeHandles";
import { WindowLayoutMenuButton } from "../workspaceDesktop/view/WindowLayoutMenuButton";
import {
  useNodeFrameResize,
  type ResizeEdges
} from "../../utils/nodeFrameResize";
import type { NodeFrame, Point, WorkspaceNodeKind } from "../../types";
import type { DesktopSize } from "../workspaceDesktop/types";

interface WorkspaceNodeWindowInteractionOptions {
  normalizeViewport?: boolean;
  selectNode?: boolean;
  shiftKey?: boolean;
}

interface WorkspaceNodeWindowRenderFrame {
  position: Point;
  size: {
    width: number;
    height: number;
  };
}

type WorkspaceNodeWindowStyle = CSSProperties & {
  "--node-header-padding-x"?: string;
};

export interface WorkspaceNodeWindowProps {
  nodeId: string;
  kind: WorkspaceNodeKind;
  title: string;
  position: Point;
  width: number;
  height: number;
  desktopSize: DesktopSize;
  minSize: { width: number; height: number };
  className?: string;
  bodyClassName?: string;
  rootProps?: Omit<
    HTMLAttributes<HTMLDivElement>,
    "className" | "children" | "style"
  > &
    Record<`data-${string}`, string | number | boolean | undefined>;
  sizeStyle?: CSSProperties;
  appearance?: "window" | "embedded";
  children: ReactNode | ((frame: WorkspaceNodeWindowRenderFrame) => ReactNode);
  customHeader?: ReactNode;
  titleIcon?: ReactNode;
  titleAccessory?: ReactNode;
  headerAccessory?: ReactNode;
  controlStartAccessory?: ReactNode;
  hideHeader?: boolean;
  onClose: () => void;
  onResize: (frame: NodeFrame) => void;
  onInteractionStart?: (
    options?: WorkspaceNodeWindowInteractionOptions
  ) => void;
  isMaximized?: boolean;
  isMuted?: boolean;
  hideMaximizeButton?: boolean;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  resizeTestIdPrefix?: string;
  resizeHandlePointerDown?: (
    edges: ResizeEdges
  ) => (event: React.PointerEvent<HTMLElement>) => void;
}

export function WorkspaceNodeWindow({
  nodeId,
  kind,
  title,
  position,
  width,
  height,
  desktopSize,
  minSize,
  className,
  bodyClassName,
  rootProps,
  sizeStyle,
  appearance = "window",
  children,
  customHeader,
  titleIcon,
  titleAccessory,
  headerAccessory,
  controlStartAccessory,
  hideHeader = false,
  onClose,
  onResize,
  onInteractionStart,
  isMaximized = false,
  isMuted = false,
  hideMaximizeButton = false,
  onMinimize,
  onToggleMaximize,
  resizeTestIdPrefix = `${kind}-node-resizer`,
  resizeHandlePointerDown
}: WorkspaceNodeWindowProps): React.JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const { onClickCapture, ...restRootProps } = rootProps ?? {};
  const { draftFrame, handleResizePointerDown } = useNodeFrameResize({
    position,
    width,
    height,
    minSize,
    onResize
  });

  const renderedFrame = draftFrame ?? {
    position,
    size: { width, height }
  };

  const style = useMemo(
    () => ({
      width: renderedFrame.size.width,
      height: renderedFrame.size.height,
      transform:
        renderedFrame.position.x !== position.x ||
        renderedFrame.position.y !== position.y
          ? `translate(${renderedFrame.position.x - position.x}px, ${renderedFrame.position.y - position.y}px)`
          : undefined
    }),
    [
      position.x,
      position.y,
      renderedFrame.position.x,
      renderedFrame.position.y,
      renderedFrame.size.height,
      renderedFrame.size.width
    ]
  );
  const resolvedStyle = sizeStyle ?? style;
  const renderedChildren =
    typeof children === "function" ? children(renderedFrame) : children;
  const rootStyle: WorkspaceNodeWindowStyle =
    appearance === "embedded"
      ? {
          "--node-header-padding-x": "16px",
          ...resolvedStyle,
          width: "100%",
          height: "100%",
          transform: undefined,
          background: "transparent",
          border: "0",
          boxShadow: "none",
          backdropFilter: "none",
          WebkitBackdropFilter: "none"
        }
      : {
          "--node-header-padding-x": "16px",
          ...resolvedStyle,
          background: "transparent",
          border: "1px solid var(--node-window-border)",
          boxShadow: "var(--window-drop-shadow)",
          backdropFilter: "var(--node-window-backdrop-filter)",
          WebkitBackdropFilter: "var(--node-window-backdrop-filter)"
        };
  const resolvedResizeHandlePointerDown =
    resizeHandlePointerDown ?? handleResizePointerDown;

  return (
    <div
      {...restRootProps}
      className={cn(
        "workspace-node-window nowheel relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[12px] border border-[var(--node-window-border)] bg-transparent text-foreground shadow-[var(--window-drop-shadow)]",
        appearance === "embedded" &&
          "h-full w-full rounded-none border-0 shadow-none",
        className
      )}
      style={rootStyle}
      data-workspace-node-window-root="true"
      data-workspace-node-window-kind={kind}
      data-workspace-node-window-maximized={isMaximized ? "true" : "false"}
      data-workspace-node-window-muted={isMuted ? "true" : "false"}
      onClickCapture={
        onClickCapture ??
        ((event) => {
          if (event.button !== 0 || !(event.target instanceof Element)) {
            return;
          }

          if (event.target.closest(".nodrag")) {
            return;
          }

          event.stopPropagation();
          onInteractionStart?.({ shiftKey: event.shiftKey });
        })
      }
    >
      {hideHeader ? null : customHeader ? (
        customHeader
      ) : (
        <header
          className="workspace-node-window__header flex h-[var(--node-header-height)] min-h-[var(--node-header-height)] cursor-grab items-center gap-2 border-b border-[var(--node-header-border)] bg-[var(--node-header-surface)] px-2 pl-[var(--node-header-padding-x)] active:cursor-grabbing"
          style={{
            borderBottomColor: "var(--node-header-border)",
            background: "var(--node-header-surface)"
          }}
          data-workspace-node-window-header="true"
          data-node-drag-handle
          data-window-header="top"
          onDoubleClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(".nodrag")
            ) {
              return;
            }
            event.stopPropagation();
            onToggleMaximize?.();
          }}
        >
          <div
            className="workspace-node-window__title flex min-w-0 max-w-[280px] flex-1 items-center gap-2 text-[13px] leading-[18px] font-semibold text-foreground"
            // i18n-check-ignore: Test selector marker, not a tooltip.
            data-workspace-node-window-title="true"
            title={title}
          >
            {titleIcon ? (
              <span
                className="workspace-node-window__title-icon inline-flex flex-none items-center"
                data-workspace-node-window-title-icon="true"
              >
                {titleIcon}
              </span>
            ) : null}
            <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {title}
            </span>
            {titleAccessory ? (
              <span
                className="workspace-node-window__title-accessory nodrag inline-flex flex-none items-center"
                data-workspace-node-window-title-accessory="true"
              >
                {titleAccessory}
              </span>
            ) : null}
          </div>
          {headerAccessory ? (
            <div
              className="workspace-node-window__header-accessory nodrag inline-flex min-w-0 flex-none items-center gap-2"
              data-workspace-node-window-header-accessory="true"
            >
              {headerAccessory}
            </div>
          ) : null}
          <div
            className="workspace-node-window__controls nodrag inline-flex flex-none items-center gap-0.5"
            data-workspace-node-window-controls="true"
          >
            {controlStartAccessory}
            {onMinimize ? (
              <CanvasNodeMinimizeButton
                onMinimize={onMinimize}
                testId={`${kind}-node-minimize`}
                data-window-header="top"
              />
            ) : null}
            <WindowLayoutMenuButton
              windowId={nodeId}
              desktopSize={desktopSize}
            />
            {onToggleMaximize && !hideMaximizeButton ? (
              <CanvasNodeGhostIconButton
                aria-label={
                  isMaximized ? t("common.restore") : t("common.maximize")
                }
                title={isMaximized ? t("common.restore") : t("common.maximize")}
                data-window-header="top"
                onClick={onToggleMaximize}
              >
                {isMaximized ? (
                  <CanvasNodeMinimizeLinedIcon aria-hidden="true" />
                ) : (
                  <CanvasNodeMaximizeLinedIcon aria-hidden="true" />
                )}
              </CanvasNodeGhostIconButton>
            ) : null}
            <CanvasNodeGhostIconButton
              aria-label={t("common.close")}
              title={t("common.close")}
              data-window-header="top"
              onClick={onClose}
            >
              <CanvasNodeCloseIcon aria-hidden="true" />
            </CanvasNodeGhostIconButton>
          </div>
        </header>
      )}

      <div
        className={cn(
          "workspace-node-window__body flex min-h-0 min-w-0 flex-1 bg-[var(--node-surface)]",
          kind === "terminal" && "bg-[var(--terminal-node-surface)]",
          bodyClassName
        )}
        data-workspace-node-window-body="true"
      >
        {renderedChildren}
      </div>

      {!isMaximized ? (
        <NodeResizeHandles
          classNamePrefix="workspace-node-window"
          testIdPrefix={resizeTestIdPrefix}
          handleResizePointerDown={resolvedResizeHandlePointerDown}
        />
      ) : null}
    </div>
  );
}
