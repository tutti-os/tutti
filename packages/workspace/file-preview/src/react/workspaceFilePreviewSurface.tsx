/**
 * Thin built-in preview surface (image / video / text) plus host renderer hooks.
 *
 * Resolve order: host renderer for previewKind → built-in text degradation →
 * unsupported/fallback messaging already present in state.
 *
 * Ownership rules: packages/workspace/file-preview/CONTRACT.md
 */

import type { ReactElement, ReactNode } from "react";
import type { WorkspaceFilePreviewKind } from "../core/workspaceFilePreviewKinds.ts";

export type WorkspaceFilePreviewSurfaceState<TEntry> =
  | { status: "empty" }
  | { entry: TEntry; status: "directory" }
  | {
      entry: TEntry;
      previewKind?: WorkspaceFilePreviewKind;
      status: "loading";
    }
  | {
      content: string;
      entry: TEntry;
      previewKind: WorkspaceFilePreviewKind;
      status: "text";
    }
  | {
      entry: TEntry;
      objectUrl: string;
      previewKind: "image";
      status: "image";
    }
  | {
      entry: TEntry;
      objectUrl: string;
      previewKind: "video";
      status: "video";
    }
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string | null;
      entry: TEntry;
      previewKind: WorkspaceFilePreviewKind;
      status: "bytes";
    }
  | {
      entry: TEntry;
      message: string;
      previewKind?: WorkspaceFilePreviewKind;
      status: "readonly";
    }
  | {
      entry: TEntry;
      message: string;
      previewKind?: WorkspaceFilePreviewKind;
      status: "unsupported";
    }
  | {
      entry: TEntry;
      message: string;
      previewKind?: WorkspaceFilePreviewKind;
      status: "error";
    };

export type WorkspaceFilePreviewSurfaceVariant =
  | "canvas"
  | "compact"
  | "detail";

export interface WorkspaceFilePreviewHostRendererProps<TEntry> {
  entry: TEntry;
  previewKind: WorkspaceFilePreviewKind;
  variant: WorkspaceFilePreviewSurfaceVariant;
  /** Present when the controller decoded text (including text-degradable kinds). */
  content?: string;
  /** Present for hook-only kinds loaded as raw bytes. */
  bytes?: Uint8Array<ArrayBuffer>;
  contentType?: string | null;
  /** Present for built-in media kinds when a host still overrides rendering. */
  objectUrl?: string;
}

export type WorkspaceFilePreviewHostRenderer<TEntry> = (
  props: WorkspaceFilePreviewHostRendererProps<TEntry>
) => ReactNode;

/**
 * Host renderer registry keyed by previewKind. `variant` is passed as props;
 * optional (kind, variant) specificity may be added later.
 */
export type WorkspaceFilePreviewHostRenderers<TEntry> = Partial<
  Record<WorkspaceFilePreviewKind, WorkspaceFilePreviewHostRenderer<TEntry>>
>;

export interface WorkspaceFilePreviewSurfaceProps<TEntry> {
  directoryMessage: string;
  emptyMessage: string;
  imageAlt: (entry: TEntry) => string;
  loadingIndicator: ReactNode;
  loadingMessage: string;
  /**
   * Optional host renderers registered by previewKind. When present for the
   * current kind, they win over built-in image / video / text shells.
   */
  renderers?: WorkspaceFilePreviewHostRenderers<TEntry>;
  renderIcon: (entry: TEntry) => ReactNode;
  state: WorkspaceFilePreviewSurfaceState<TEntry>;
  variant: WorkspaceFilePreviewSurfaceVariant;
}

export function WorkspaceFilePreviewSurface<TEntry>({
  directoryMessage,
  emptyMessage,
  imageAlt,
  loadingIndicator,
  loadingMessage,
  renderers,
  renderIcon,
  state,
  variant
}: WorkspaceFilePreviewSurfaceProps<TEntry>): ReactElement {
  const styles = workspaceFilePreviewSurfaceStyles[variant];
  const hostRendered = renderHostPreview({
    renderers,
    state,
    variant
  });
  if (hostRendered !== null) {
    return (
      <WorkspaceFilePreviewFrame className={styles.frame}>
        {hostRendered}
      </WorkspaceFilePreviewFrame>
    );
  }

  switch (state.status) {
    case "directory":
      return (
        <WorkspaceFilePreviewFrame className={styles.frame}>
          <div className="flex flex-col items-center justify-center gap-2.5 text-center text-[13px] leading-5 text-[var(--text-tertiary)]">
            {renderIcon(state.entry)}
            <span>{directoryMessage}</span>
          </div>
        </WorkspaceFilePreviewFrame>
      );
    case "loading":
      return (
        <WorkspaceFilePreviewFrame className={styles.frame}>
          <div className="space-y-3 px-4 text-center text-[13px] text-[var(--text-tertiary)]">
            {loadingIndicator}
            <span>{loadingMessage}</span>
          </div>
        </WorkspaceFilePreviewFrame>
      );
    case "image":
      return (
        <WorkspaceFilePreviewFrame
          className={joinClassNames(styles.frame, styles.imageFrame)}
        >
          <img
            alt={imageAlt(state.entry)}
            className={styles.image}
            src={state.objectUrl}
          />
        </WorkspaceFilePreviewFrame>
      );
    case "text":
      return (
        <WorkspaceFilePreviewFrame
          className={joinClassNames(styles.frame, styles.textFrame)}
        >
          <pre className={styles.text}>{state.content}</pre>
        </WorkspaceFilePreviewFrame>
      );
    case "video":
      return (
        <WorkspaceFilePreviewFrame
          className={joinClassNames(styles.frame, styles.videoFrame)}
        >
          <video
            aria-label={imageAlt(state.entry)}
            className={styles.video}
            muted
            playsInline
            preload="metadata"
            src={state.objectUrl}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.duration > 0 && video.currentTime === 0) {
                video.currentTime = Math.min(0.1, video.duration / 2);
              }
            }}
          />
        </WorkspaceFilePreviewFrame>
      );
    case "bytes":
      // Hook-only kinds without a registered renderer fall through to the
      // unsupported messaging path via host-projected state; if bytes somehow
      // arrive without a hook, show the generic unsupported shell.
      return (
        <WorkspaceFilePreviewFrame className={styles.frame}>
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center text-[13px] text-[var(--text-tertiary)]">
            {renderIcon(state.entry)}
            <span className={styles.message}>{emptyMessage}</span>
          </div>
        </WorkspaceFilePreviewFrame>
      );
    case "readonly":
    case "unsupported":
    case "error":
      return (
        <WorkspaceFilePreviewFrame className={styles.frame}>
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center text-[13px] text-[var(--text-tertiary)]">
            {renderIcon(state.entry)}
            <span className={styles.message}>{state.message}</span>
          </div>
        </WorkspaceFilePreviewFrame>
      );
    case "empty":
      return (
        <WorkspaceFilePreviewFrame className={styles.frame}>
          <span className={styles.message}>{emptyMessage}</span>
        </WorkspaceFilePreviewFrame>
      );
  }
}

function renderHostPreview<TEntry>(input: {
  renderers: WorkspaceFilePreviewHostRenderers<TEntry> | undefined;
  state: WorkspaceFilePreviewSurfaceState<TEntry>;
  variant: WorkspaceFilePreviewSurfaceVariant;
}): ReactNode | null {
  const { renderers, state, variant } = input;
  if (!renderers) {
    return null;
  }

  switch (state.status) {
    case "text": {
      const renderer = renderers[state.previewKind];
      return renderer
        ? renderer({
            content: state.content,
            entry: state.entry,
            previewKind: state.previewKind,
            variant
          })
        : null;
    }
    case "image":
    case "video": {
      const renderer = renderers[state.previewKind];
      return renderer
        ? renderer({
            entry: state.entry,
            objectUrl: state.objectUrl,
            previewKind: state.previewKind,
            variant
          })
        : null;
    }
    case "bytes": {
      const renderer = renderers[state.previewKind];
      return renderer
        ? renderer({
            bytes: state.bytes,
            contentType: state.contentType,
            entry: state.entry,
            previewKind: state.previewKind,
            variant
          })
        : null;
    }
    default:
      return null;
  }
}

const workspaceFilePreviewSurfaceStyles: Record<
  WorkspaceFilePreviewSurfaceVariant,
  {
    frame: string;
    image: string;
    imageFrame: string;
    message: string;
    text: string;
    textFrame: string;
    video: string;
    videoFrame: string;
  }
> = {
  compact: {
    frame:
      "flex aspect-[3/2] w-full flex-col items-center justify-center overflow-hidden rounded-[8px] border border-[var(--line-2,var(--border-2))] bg-[var(--transparency-block)] p-0 text-center",
    image: "max-h-full max-w-full rounded-[6px] object-contain",
    imageFrame: "p-3",
    message:
      "mx-auto max-w-[24ch] text-center text-[13px] leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]",
    text: "h-full w-full overflow-auto p-3 text-left text-[11px] leading-5 whitespace-pre-wrap break-words text-[var(--text-primary)]",
    textFrame: "items-stretch justify-stretch",
    video: "block max-h-full max-w-full rounded-[6px] object-contain",
    videoFrame: "p-3"
  },
  detail: {
    frame:
      "flex h-60 min-h-60 max-h-60 items-center justify-center overflow-hidden rounded-lg bg-[var(--transparency-block)]",
    image: "max-h-full max-w-full rounded-[6px] object-contain",
    imageFrame: "p-4",
    message:
      "max-w-[24ch] text-center text-[13px] leading-5 text-[var(--text-tertiary)] [overflow-wrap:anywhere]",
    text: "h-full overflow-auto p-4 text-[11px] leading-5 whitespace-pre-wrap break-words text-[var(--text-primary)]",
    textFrame: "items-stretch justify-stretch",
    video: "block max-h-full max-w-full rounded-[6px] object-contain",
    videoFrame: "p-4"
  },
  canvas: {
    frame:
      "flex h-full min-h-0 min-w-0 w-full items-center justify-center overflow-hidden bg-[var(--background-fronted)] text-[var(--text-tertiary)]",
    image: "block max-h-full max-w-full object-contain",
    imageFrame: "overflow-auto p-3",
    message:
      "max-w-[24ch] text-center text-[13px] leading-5 text-[var(--text-tertiary)] [overflow-wrap:anywhere]",
    text: "m-0 h-full min-h-0 min-w-0 w-full overflow-auto whitespace-pre-wrap break-words p-3 font-[var(--tsh-font-mono)] text-[11px] leading-[18px] text-[var(--text-secondary)]",
    textFrame: "items-stretch justify-stretch",
    video: "block max-h-full max-w-full object-contain",
    videoFrame: "overflow-auto p-3"
  }
};

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
