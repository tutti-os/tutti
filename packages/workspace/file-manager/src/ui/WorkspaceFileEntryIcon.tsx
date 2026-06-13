import {
  FileCodeIcon,
  FileTextIcon,
  FolderFilledIcon,
  ImageFileIcon,
  LoadingIcon,
  VideoFileIcon,
  cn
} from "@tutti-os/ui-system";
import type { ReactElement } from "react";
import {
  resolveWorkspaceFileExtension,
  resolveWorkspaceFileVisualKind
} from "../services/workspaceFileManagerModel.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  resolveWorkspaceFileEntryIconCacheKey,
  isWorkspaceApplicationBundle,
  shouldUseWorkspaceFileExtensionDocumentIcon
} from "./workspaceFileEntryIconPolicy.ts";

export function WorkspaceFileEntryIcon({
  entry,
  frameClassName,
  iconClassName = "size-4",
  iconUrlByCacheKey,
  isEnteringDirectory = false
}: {
  entry: WorkspaceFileEntry;
  frameClassName?: string;
  iconClassName?: string;
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  isEnteringDirectory?: boolean;
}): ReactElement {
  const visualKind = resolveWorkspaceFileVisualKind(entry);
  const isAppBundle = isWorkspaceApplicationBundle(entry);
  const iconUrl =
    iconUrlByCacheKey?.get(resolveWorkspaceFileEntryIconCacheKey(entry)) ??
    null;

  return (
    <span
      className={cn(
        "grid flex-none place-items-center overflow-hidden",
        frameClassName,
        isEnteringDirectory
          ? "text-[var(--text-tertiary)]"
          : entryIconColorClassName(visualKind, isAppBundle)
      )}
    >
      {isEnteringDirectory ? (
        <LoadingIcon className={iconClassName + " animate-spin"} />
      ) : iconUrl ? (
        <img
          alt=""
          className={cn(iconClassName, "rounded-[4px] object-contain")}
          draggable={false}
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

function DefaultEntryIcon({
  entry,
  iconClassName,
  visualKind
}: {
  entry: WorkspaceFileEntry;
  iconClassName: string;
  visualKind: ReturnType<typeof resolveWorkspaceFileVisualKind>;
}): ReactElement {
  if (isWorkspaceApplicationBundle(entry)) {
    return <FileTextIcon className={iconClassName} />;
  }
  if (shouldUseWorkspaceFileExtensionDocumentIcon(entry)) {
    return (
      <ExtensionDocumentIcon entry={entry} iconClassName={iconClassName} />
    );
  }

  switch (visualKind) {
    case "directory":
      return <FolderFilledIcon className={iconClassName} />;
    case "image":
      return <ImageFileIcon className={iconClassName} />;
    case "video":
      return <VideoFileIcon className={iconClassName} />;
    case "markdown":
    case "document":
      return <FileTextIcon className={iconClassName} />;
    case "code":
      return <FileCodeIcon className={iconClassName} />;
    case "binary":
      return <FileTextIcon className={iconClassName} />;
    default:
      return <FileTextIcon className={iconClassName} />;
  }
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
  const showExtension = extension.length > 0 && iconClassName.includes("52px");

  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-block overflow-visible", iconClassName)}
    >
      <span className="absolute inset-[5%] rounded-[6px] border border-black/10 bg-linear-to-br from-white via-[#f8f8f8] to-[#ececec] shadow-[0_8px_16px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.85)]" />
      <span className="absolute top-[5%] right-[5%] h-[28%] w-[28%] overflow-hidden rounded-tr-[6px]">
        <span className="absolute top-0 right-0 h-full w-full origin-top-right -skew-x-3 rounded-bl-[4px] border-b border-l border-black/10 bg-linear-to-br from-white to-[#d9d9d9] shadow-[-2px_3px_5px_rgba(0,0,0,0.18)]" />
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
