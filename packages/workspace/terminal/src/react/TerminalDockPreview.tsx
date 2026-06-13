import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  TerminalPreviewSegmentStyle,
  TerminalPreviewSnapshot,
  TerminalTheme
} from "../contracts/index.ts";

export interface TerminalDockPreviewProps {
  frame?: TerminalDockPreviewFrame | null;
  snapshot: TerminalPreviewSnapshot;
  theme?: TerminalTheme | null;
}

export interface TerminalDockPreviewFrame {
  height: number;
  width: number;
}

interface TerminalDockPreviewStyle extends CSSProperties {
  "--workspace-terminal-dock-preview-background"?: string;
  "--workspace-terminal-dock-preview-foreground"?: string;
  "--workspace-terminal-dock-preview-scale"?: string;
  "--workspace-terminal-dock-preview-source-height"?: string;
  "--workspace-terminal-dock-preview-source-width"?: string;
  "--workspace-terminal-dock-preview-height"?: string;
  "--workspace-terminal-dock-preview-width"?: string;
}

const terminalDockPreviewLineHeight = 1.35;
const terminalDockPreviewCharacterWidth = 0.62;
const terminalDockPreviewFontSize = 13;
const terminalDockPreviewPadding = 16;

export function TerminalDockPreview({
  frame = null,
  snapshot,
  theme = null
}: TerminalDockPreviewProps) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [layout, setLayout] = useState({
    height: 0,
    scale: 1,
    sourceHeight: 0,
    sourceWidth: 0,
    width: 0
  });
  const style: TerminalDockPreviewStyle = {};
  if (theme?.background) {
    style["--workspace-terminal-dock-preview-background"] = theme.background;
  }
  if (theme?.foreground) {
    style["--workspace-terminal-dock-preview-foreground"] = theme.foreground;
  }
  if (layout.width > 0 && layout.height > 0) {
    style["--workspace-terminal-dock-preview-height"] = `${layout.height}px`;
    style["--workspace-terminal-dock-preview-width"] = `${layout.width}px`;
    style["--workspace-terminal-dock-preview-scale"] = String(layout.scale);
    style["--workspace-terminal-dock-preview-source-height"] =
      `${layout.sourceHeight}px`;
    style["--workspace-terminal-dock-preview-source-width"] =
      `${layout.sourceWidth}px`;
  }

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const updateFontSize = () => {
      const availableSize = readTerminalDockPreviewAvailableSize(container);
      const availableWidth = availableSize.width;
      const availableHeight = availableSize.height;
      const previewRatio = resolveTerminalDockPreviewRatio(frame, snapshot);
      const sourceSize = resolveTerminalDockPreviewSourceSize(frame, snapshot);
      const fittedSize = fitTerminalDockPreviewSize({
        availableHeight,
        availableWidth,
        ratio: previewRatio
      });
      const nextScale =
        sourceSize.width > 0 && sourceSize.height > 0
          ? Math.min(
              fittedSize.width / sourceSize.width,
              fittedSize.height / sourceSize.height
            )
          : 1;
      setLayout((current) => {
        if (
          Math.abs(current.height - fittedSize.height) < 0.5 &&
          Math.abs(current.scale - nextScale) < 0.001 &&
          Math.abs(current.sourceHeight - sourceSize.height) < 0.5 &&
          Math.abs(current.sourceWidth - sourceSize.width) < 0.5 &&
          Math.abs(current.width - fittedSize.width) < 0.5
        ) {
          return current;
        }
        return {
          height: fittedSize.height,
          scale: nextScale,
          sourceHeight: sourceSize.height,
          sourceWidth: sourceSize.width,
          width: fittedSize.width
        };
      });
    };
    updateFontSize();
    const observer = new ResizeObserver(updateFontSize);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [frame, snapshot.cols, snapshot.lines.length]);

  return (
    <span
      className="workspace-terminal__dock-preview-frame"
      data-terminal-dock-preview=""
      ref={containerRef}
    >
      <span className="workspace-terminal__dock-preview-viewport" style={style}>
        <span className="workspace-terminal__dock-preview">
          {snapshot.lines.map((line, index) => (
            <span className="workspace-terminal__dock-preview-line" key={index}>
              {line.segments.length > 0
                ? line.segments.map((segment, segmentIndex) => (
                    <span
                      className="workspace-terminal__dock-preview-segment"
                      key={segmentIndex}
                      style={resolveTerminalDockPreviewSegmentStyle(
                        segment.style
                      )}
                    >
                      {segment.text}
                    </span>
                  ))
                : " "}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function readTerminalDockPreviewAvailableSize(element: HTMLElement) {
  const computedStyle = window.getComputedStyle(element);
  const computedWidth = Number.parseFloat(computedStyle.width);
  const computedHeight = Number.parseFloat(computedStyle.height);
  if (
    Number.isFinite(computedWidth) &&
    computedWidth > 0 &&
    Number.isFinite(computedHeight) &&
    computedHeight > 0
  ) {
    return {
      height: computedHeight,
      width: computedWidth
    };
  }

  return {
    height: Math.max(0, element.clientHeight),
    width: Math.max(0, element.clientWidth)
  };
}

function resolveTerminalDockPreviewRatio(
  frame: TerminalDockPreviewFrame | null,
  snapshot: TerminalPreviewSnapshot
) {
  if (frame && frame.width > 0 && frame.height > 0) {
    return frame.width / frame.height;
  }
  const rowCount = Math.max(1, snapshot.lines.length);
  const colCount = Math.max(1, Math.min(snapshot.cols, 160));
  return (
    (colCount * terminalDockPreviewCharacterWidth) /
    (rowCount * terminalDockPreviewLineHeight)
  );
}

function resolveTerminalDockPreviewSourceSize(
  frame: TerminalDockPreviewFrame | null,
  snapshot: TerminalPreviewSnapshot
) {
  if (frame && frame.width > 0 && frame.height > 0) {
    return {
      height: frame.height,
      width: frame.width
    };
  }

  const rowCount = Math.max(1, snapshot.lines.length);
  const colCount = Math.max(1, Math.min(snapshot.cols, 160));
  return {
    height:
      rowCount * terminalDockPreviewFontSize * terminalDockPreviewLineHeight +
      terminalDockPreviewPadding,
    width:
      colCount *
        terminalDockPreviewFontSize *
        terminalDockPreviewCharacterWidth +
      terminalDockPreviewPadding
  };
}

function fitTerminalDockPreviewSize(input: {
  availableHeight: number;
  availableWidth: number;
  ratio: number;
}) {
  if (
    input.availableHeight <= 0 ||
    input.availableWidth <= 0 ||
    !Number.isFinite(input.ratio) ||
    input.ratio <= 0
  ) {
    return { height: 0, width: 0 };
  }

  const widthFromFullHeight = input.availableHeight * input.ratio;
  if (widthFromFullHeight <= input.availableWidth) {
    return {
      height: input.availableHeight,
      width: widthFromFullHeight
    };
  }

  return {
    height: input.availableWidth / input.ratio,
    width: input.availableWidth
  };
}

function resolveTerminalDockPreviewSegmentStyle(
  segmentStyle: TerminalPreviewSegmentStyle | undefined
): CSSProperties | undefined {
  if (!segmentStyle) {
    return undefined;
  }

  const style: CSSProperties = {};
  if (segmentStyle.background) {
    style.backgroundColor = segmentStyle.background;
  }
  if (segmentStyle.color) {
    style.color = segmentStyle.color;
  }
  if (segmentStyle.bold) {
    style.fontWeight = 700;
  }
  if (segmentStyle.dim) {
    style.opacity = 0.64;
  }
  if (segmentStyle.italic) {
    style.fontStyle = "italic";
  }

  const decorations: string[] = [];
  if (segmentStyle.underline) {
    decorations.push("underline");
  }
  if (segmentStyle.strikethrough) {
    decorations.push("line-through");
  }
  if (segmentStyle.overline) {
    decorations.push("overline");
  }
  if (decorations.length > 0) {
    style.textDecorationLine = decorations.join(" ");
  }

  return style;
}
