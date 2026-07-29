import type { CSSProperties, ReactNode } from "react";
import type { WorkbenchSize } from "../core/types.ts";

export interface WorkbenchDockComponentPreviewFrameProps {
  children?: ReactNode;
  sourceSize: WorkbenchSize;
  viewport: WorkbenchSize;
}

export function WorkbenchDockComponentPreviewFrame({
  children,
  sourceSize,
  viewport
}: WorkbenchDockComponentPreviewFrameProps): ReactNode {
  const sourceHeight = Math.max(1, sourceSize.height);
  const sourceWidth = Math.max(1, sourceSize.width);
  const viewportHeight = Math.max(1, viewport.height);
  const viewportWidth = Math.max(1, viewport.width);
  const scale = Math.min(
    viewportWidth / sourceWidth,
    viewportHeight / sourceHeight
  );
  const frameStyle = {
    background: "transparent",
    borderRadius: "0.375rem",
    display: "block",
    height: `${viewportHeight}px`,
    overflow: "hidden",
    pointerEvents: "none",
    position: "relative",
    width: `${viewportWidth}px`
  } satisfies CSSProperties;
  const contentStyle = {
    display: "block",
    height: `${sourceHeight}px`,
    left: "50%",
    overflow: "hidden",
    pointerEvents: "none",
    position: "absolute",
    top: "50%",
    transform: `translate(-50%, -50%) scale(${scale})`,
    transformOrigin: "center",
    width: `${sourceWidth}px`
  } satisfies CSSProperties;

  return (
    <span
      aria-hidden="true"
      data-workbench-dock-component-preview-frame="true"
      style={frameStyle}
    >
      <span
        data-workbench-dock-component-preview-content="true"
        style={contentStyle}
      >
        {children}
      </span>
    </span>
  );
}
