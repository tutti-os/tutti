import type { ReactElement, ReactNode } from "react";

export type WorkspaceFilePreviewSurfaceState<TEntry> =
  | { status: "empty" }
  | { entry: TEntry; status: "directory" }
  | { entry: TEntry; status: "loading" }
  | { content: string; entry: TEntry; status: "text" }
  | { entry: TEntry; objectUrl: string; status: "image" }
  | { entry: TEntry; message: string; status: "readonly" }
  | { entry: TEntry; message: string; status: "unsupported" }
  | { entry: TEntry; message: string; status: "error" };

export interface WorkspaceFilePreviewSurfaceProps<TEntry> {
  directoryMessage: string;
  emptyMessage: string;
  frameClassName: string;
  imageAlt: (entry: TEntry) => string;
  imageFrameClassName?: string;
  imageClassName?: string;
  loadingIndicator: ReactNode;
  loadingMessage: string;
  messageClassName?: string;
  renderIcon: (entry: TEntry) => ReactNode;
  state: WorkspaceFilePreviewSurfaceState<TEntry>;
  textClassName?: string;
  textFrameClassName?: string;
}

export function WorkspaceFilePreviewSurface<TEntry>({
  directoryMessage,
  emptyMessage,
  frameClassName,
  imageAlt,
  imageClassName = "max-h-full max-w-full rounded-[6px] object-contain",
  imageFrameClassName,
  loadingIndicator,
  loadingMessage,
  messageClassName = "max-w-[24ch] text-center text-[13px] leading-5 text-[var(--text-tertiary)] [overflow-wrap:anywhere]",
  renderIcon,
  state,
  textClassName = "h-full overflow-auto p-4 text-[11px] leading-5 whitespace-pre-wrap break-words text-[var(--text-primary)]",
  textFrameClassName
}: WorkspaceFilePreviewSurfaceProps<TEntry>): ReactElement {
  switch (state.status) {
    case "directory":
      return (
        <WorkspaceFilePreviewFrame className={frameClassName}>
          <div className="flex flex-col items-center justify-center gap-2.5 text-center text-[13px] leading-5 text-[var(--text-tertiary)]">
            {renderIcon(state.entry)}
            <span>{directoryMessage}</span>
          </div>
        </WorkspaceFilePreviewFrame>
      );
    case "loading":
      return (
        <WorkspaceFilePreviewFrame className={frameClassName}>
          <div className="space-y-3 px-4 text-center text-[13px] text-[var(--text-tertiary)]">
            {loadingIndicator}
            <span>{loadingMessage}</span>
          </div>
        </WorkspaceFilePreviewFrame>
      );
    case "image":
      return (
        <WorkspaceFilePreviewFrame
          className={joinClassNames(frameClassName, imageFrameClassName)}
        >
          <img
            alt={imageAlt(state.entry)}
            className={imageClassName}
            src={state.objectUrl}
          />
        </WorkspaceFilePreviewFrame>
      );
    case "text":
      return (
        <WorkspaceFilePreviewFrame
          className={joinClassNames(frameClassName, textFrameClassName)}
        >
          <pre className={textClassName}>{state.content}</pre>
        </WorkspaceFilePreviewFrame>
      );
    case "readonly":
    case "unsupported":
    case "error":
      return (
        <WorkspaceFilePreviewFrame className={frameClassName}>
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center text-[13px] text-[var(--text-tertiary)]">
            {renderIcon(state.entry)}
            <span className={messageClassName}>{state.message}</span>
          </div>
        </WorkspaceFilePreviewFrame>
      );
    case "empty":
      return (
        <WorkspaceFilePreviewFrame className={frameClassName}>
          <span className={messageClassName}>{emptyMessage}</span>
        </WorkspaceFilePreviewFrame>
      );
  }
}

function WorkspaceFilePreviewFrame({
  children,
  className
}: {
  children: ReactNode;
  className: string;
}): ReactElement {
  return <div className={className}>{children}</div>;
}

function joinClassNames(
  ...classNames: Array<string | false | null | undefined>
): string {
  return classNames.filter(Boolean).join(" ");
}
