import {
  FileCodeIcon,
  FileTextIcon,
  ImageFileIcon,
  LoadingIcon,
  VideoFileIcon,
  cn
} from "@tutti-os/ui-system";
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import {
  resolveWorkspaceFileExtension,
  resolveWorkspaceFileVisualKind
} from "@tutti-os/workspace-file-preview";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  workspaceArchiveFallbackIconUrl,
  workspaceFolderFallbackIconUrl
} from "../workspaceFileFallbackAssets.ts";
import {
  resolveWorkspaceFileEntryIconCacheKey,
  isWorkspaceApplicationBundle,
  shouldUseWorkspaceFileArchiveIcon,
  shouldUseWorkspaceFileExtensionDocumentIcon
} from "./workspaceFileEntryIconPolicy.ts";

export function WorkspaceFileEntryIcon({
  entry,
  frameClassName,
  iconClassName = "size-4",
  iconUrlByCacheKey,
  isEnteringDirectory = false,
  loadingIconClassName,
  onViewportLeave,
  onViewportEnter
}: {
  entry: WorkspaceFileEntry;
  frameClassName?: string;
  iconClassName?: string;
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  isEnteringDirectory?: boolean;
  loadingIconClassName?: string;
  onViewportLeave?: (entry: WorkspaceFileEntry) => void;
  onViewportEnter?: (entry: WorkspaceFileEntry) => void;
}): ReactElement {
  const visualKind = resolveWorkspaceFileVisualKind(entry);
  const isAppBundle = isWorkspaceApplicationBundle(entry);
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const iconUrl = iconUrlByCacheKey?.get(cacheKey) ?? null;
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const visibleEntryRef = useRef<WorkspaceFileEntry | null>(null);
  const visibleEntryCacheKeyRef = useRef<string | null>(null);

  useEffect(() => {
    function reportViewportLeave(): void {
      const visibleEntry = visibleEntryRef.current;
      if (!visibleEntry) {
        return;
      }
      visibleEntryRef.current = null;
      visibleEntryCacheKeyRef.current = null;
      onViewportLeave?.(visibleEntry);
    }

    function reportViewportEnter(): void {
      if (visibleEntryCacheKeyRef.current === cacheKey) {
        return;
      }
      reportViewportLeave();
      visibleEntryRef.current = entry;
      visibleEntryCacheKeyRef.current = cacheKey;
      onViewportEnter?.(entry);
    }

    if (!onViewportEnter || isEnteringDirectory) {
      reportViewportLeave();
      return;
    }

    const element = frameRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      reportViewportEnter();
      return () => {
        reportViewportLeave();
      };
    }

    const viewportRoot = resolveWorkspaceFileEntryIconViewport(element);
    const observer = new IntersectionObserver(
      (records) => {
        const intersecting = records.some(
          (record) => record.isIntersecting && record.intersectionRatio > 0
        );
        if (intersecting) {
          reportViewportEnter();
          return;
        }
        reportViewportLeave();
      },
      { root: viewportRoot, rootMargin: "0px", threshold: 0 }
    );
    observer.observe(element);
    const initiallyVisible = isWorkspaceFileEntryIconVisible(
      element,
      viewportRoot
    );
    if (initiallyVisible) {
      reportViewportEnter();
    } else {
      reportViewportLeave();
    }
    return () => {
      observer.disconnect();
      reportViewportLeave();
    };
  }, [cacheKey, entry, isEnteringDirectory, onViewportLeave, onViewportEnter]);

  return (
    <span
      ref={frameRef}
      className={cn(
        "grid flex-none place-items-center overflow-hidden",
        frameClassName,
        isEnteringDirectory
          ? "text-[var(--text-tertiary)]"
          : entryIconColorClassName(visualKind, isAppBundle)
      )}
    >
      {isEnteringDirectory ? (
        <LoadingIcon
          className={cn(loadingIconClassName ?? iconClassName, "animate-spin")}
        />
      ) : iconUrl ? (
        <img
          alt=""
          className={cn(
            iconClassName,
            visualKind === "image"
              ? "rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] object-contain"
              : "rounded-[4px] object-contain"
          )}
          decoding="async"
          draggable={false}
          loading="lazy"
          src={iconUrl}
        />
      ) : (
        <DefaultEntryIcon
          entry={entry}
          iconClassName={iconClassName}
          visualKind={visualKind}
        />
      )}
    </span>
  );
}

function resolveWorkspaceFileEntryIconViewport(
  element: HTMLElement
): HTMLElement | null {
  return element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
}

function isWorkspaceFileEntryIconVisible(
  element: HTMLElement,
  viewportRoot: HTMLElement | null
): boolean {
  const elementRect = element.getBoundingClientRect();
  const viewportRect =
    viewportRoot?.getBoundingClientRect() ??
    ({
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
      top: 0
    } satisfies Pick<DOMRect, "bottom" | "left" | "right" | "top">);

  return (
    elementRect.bottom > viewportRect.top &&
    elementRect.top < viewportRect.bottom &&
    elementRect.right > viewportRect.left &&
    elementRect.left < viewportRect.right
  );
}

function DefaultEntryIcon({
  entry,
  iconClassName,
  visualKind
}: {
  entry: WorkspaceFileEntry;
  iconClassName: string;
  visualKind: ReturnType<typeof resolveWorkspaceFileVisualKind>;
}): ReactElement {
  const vectorIconClassName = vectorFallbackIconClassName(iconClassName);
  if (isWorkspaceApplicationBundle(entry)) {
    return <FileTextIcon className={vectorIconClassName} />;
  }
  if (shouldUseWorkspaceFileArchiveIcon(entry)) {
    return <WorkspaceArchiveFallbackIcon className={iconClassName} />;
  }
  if (shouldUseWorkspaceFileExtensionDocumentIcon(entry)) {
    return (
      <ExtensionDocumentIcon
        entry={entry}
        iconClassName={vectorIconClassName}
      />
    );
  }

  switch (visualKind) {
    case "directory":
      return <WorkspaceFolderFallbackIcon className={iconClassName} />;
    case "image":
      return <WorkspaceImageFallbackIcon className={iconClassName} />;
    case "video":
      return <VideoFileIcon className={vectorIconClassName} />;
    case "markdown":
    case "document":
      return <FileTextIcon className={vectorIconClassName} />;
    case "code":
      return <FileCodeIcon className={vectorIconClassName} />;
    case "binary":
      return <FileTextIcon className={vectorIconClassName} />;
    default:
      return <FileTextIcon className={vectorIconClassName} />;
  }
}

function vectorFallbackIconClassName(iconClassName: string): string {
  return iconClassName.includes("size-[84px]") ? "size-[64px]" : iconClassName;
}

export function WorkspaceFolderFallbackIcon({
  className
}: {
  className: string;
}): ReactElement {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("object-contain", className)}
      decoding="async"
      draggable={false}
      src={workspaceFolderFallbackIconUrl}
    />
  );
}

export function WorkspaceArchiveFallbackIcon({
  className
}: {
  className: string;
}): ReactElement {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("object-contain", className)}
      decoding="async"
      draggable={false}
      src={workspaceArchiveFallbackIconUrl}
    />
  );
}

export function WorkspaceImageFallbackIcon({
  className
}: {
  className: string;
}): ReactElement {
  return <ImageFileIcon className={vectorFallbackIconClassName(className)} />;
}

function ExtensionDocumentIcon({
  entry,
  iconClassName
}: {
  entry: WorkspaceFileEntry;
  iconClassName: string;
}): ReactElement {
  const extension = resolveWorkspaceFileExtension(entry.name)
    .slice(0, 5)
    .toUpperCase();
  const showExtension =
    extension.length > 0 && !iconClassName.includes("size-4");

  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-block overflow-visible", iconClassName)}
    >
      <span className="absolute inset-[5%] rounded-[6px] border border-black/10 bg-linear-to-br from-white via-[#f8f8f8] to-[#ececec]" />
      <span className="absolute top-[5%] right-[5%] h-[28%] w-[28%] overflow-hidden rounded-tr-[6px]">
        <span className="absolute top-0 right-0 h-full w-full origin-top-right -skew-x-3 rounded-bl-[4px] border-b border-l border-black/10 bg-linear-to-br from-white to-[#d9d9d9]" />
      </span>
      {showExtension ? (
        <span className="absolute right-[12%] bottom-[14%] left-[12%] truncate text-center text-[10px] leading-none font-semibold tracking-wide text-[#7a7a7a]">
          {extension}
        </span>
      ) : null}
    </span>
  );
}

function entryIconColorClassName(
  visualKind: ReturnType<typeof resolveWorkspaceFileVisualKind>,
  isAppBundle: boolean
): string {
  if (isAppBundle) {
    return "text-[var(--text-tertiary)]";
  }
  return visualKind === "directory"
    ? "text-[var(--rich-text-mention-file)]"
    : "text-[var(--text-tertiary)]";
}
