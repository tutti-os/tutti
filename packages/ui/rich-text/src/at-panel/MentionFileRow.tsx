import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FileCodeIcon,
  FileTextIcon,
  FolderIcon,
  ImageFileIcon,
  ProductIcon,
  VideoFileIcon,
  cn,
  type IconProps
} from "@tutti-os/ui-system";
import type { MentionFileVisualKind } from "./mentionFileVisualKind.ts";
import {
  mentionRowDataAttribute,
  mentionRowRootDataAttributes,
  type MentionRowDataAttributeMode
} from "./mentionRowDataAttributes.ts";
import type { MentionRowFileItem } from "./mentionRowTypes.ts";

const MENTION_FILE_VISUAL_KIND_ICON: Record<
  MentionFileVisualKind,
  (props: IconProps) => React.JSX.Element
> = {
  back: ArrowLeftIcon,
  folder: FolderIcon,
  document: FileTextIcon,
  markdown: ProductIcon,
  code: FileCodeIcon,
  image: ImageFileIcon,
  video: VideoFileIcon
};

interface MentionFileRowClassNames {
  fileIcon: string;
  fileThumb: string;
}

export function MentionFileRow({
  item,
  classNames,
  dataAttributeMode,
  navigateIntoLabel,
  onNavigateInto,
  usesDefaultFileIcon
}: {
  item: MentionRowFileItem;
  classNames: MentionFileRowClassNames;
  dataAttributeMode: MentionRowDataAttributeMode;
  navigateIntoLabel?: string;
  onNavigateInto?: () => void;
  usesDefaultFileIcon: boolean;
}): React.JSX.Element {
  const pathPresentation = mentionFilePathPresentation(
    item.relativePath,
    item.name,
    item.disambiguationPrefixSegments
  );
  return (
    <span
      className="rich-text-at-mention-row rich-text-at-mention-row--file"
      {...mentionRowRootDataAttributes(dataAttributeMode, "file")}
      {...(item.entryKind
        ? mentionRowDataAttribute(
            dataAttributeMode,
            "fileEntryKind",
            item.entryKind
          )
        : {})}
      {...mentionRowDataAttribute(
        dataAttributeMode,
        "fileVisualKind",
        item.visualKind
      )}
      {...(item.mentionNavigation
        ? mentionRowDataAttribute(
            dataAttributeMode,
            "navigation",
            item.mentionNavigation
          )
        : {})}
    >
      <MentionFileIcon
        item={item}
        classNames={classNames}
        dataAttributeMode={dataAttributeMode}
        usesDefaultFileIcon={usesDefaultFileIcon}
      />
      <span
        className="rich-text-at-mention-row__file-text"
        title={pathPresentation?.fullPath}
      >
        {pathPresentation?.directory ? (
          <MentionFileDirectory presentation={pathPresentation.directory} />
        ) : null}
        <span className="rich-text-at-mention-row__file-name">{item.name}</span>
      </span>
      {item.childCountLabel ? (
        <span className="rich-text-at-mention-row__file-count">
          {item.childCountLabel}
        </span>
      ) : null}
      {onNavigateInto ? (
        <MentionNavigateIntoButton
          label={navigateIntoLabel}
          onNavigateInto={onNavigateInto}
          dataAttributeMode={dataAttributeMode}
        />
      ) : null}
    </span>
  );
}

function MentionNavigateIntoButton({
  label,
  onNavigateInto,
  dataAttributeMode
}: {
  label?: string;
  onNavigateInto: () => void;
  dataAttributeMode: MentionRowDataAttributeMode;
}): React.JSX.Element {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      className="rich-text-at-mention-row__navigate-into"
      {...mentionRowDataAttribute(dataAttributeMode, "navigateInto", "true")}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onNavigateInto();
      }}
    >
      <ArrowRightIcon size={16} />
    </span>
  );
}

interface MentionFileDirectoryPresentation {
  head: string;
  tail: string | null;
}

function MentionFileDirectory({
  presentation
}: {
  presentation: MentionFileDirectoryPresentation;
}): React.JSX.Element {
  if (!presentation.tail) {
    return (
      <span className="rich-text-at-mention-row__file-directory">
        {presentation.head}
      </span>
    );
  }
  return (
    <span className="rich-text-at-mention-row__file-directory rich-text-at-mention-row__file-directory--condensed">
      <span className="rich-text-at-mention-row__file-directory-head">
        {presentation.head}
      </span>
      <span className="rich-text-at-mention-row__file-directory-middle">
        /…/
      </span>
      <span className="rich-text-at-mention-row__file-directory-tail">
        {presentation.tail}
      </span>
    </span>
  );
}

function mentionFilePathPresentation(
  relativePath: string | null | undefined,
  fileName: string,
  disambiguationPrefixSegments: number | null | undefined
): {
  directory: MentionFileDirectoryPresentation | null;
  fullPath: string;
} | null {
  const normalized = relativePath
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (!normalized) {
    return null;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.at(-1) !== fileName) {
    return null;
  }
  const directories = segments.slice(0, -1);
  if (directories.length === 0) {
    return { directory: null, fullPath: normalized };
  }
  const prefixSegmentCount = Math.max(
    1,
    Math.min(
      directories.length,
      Number.isFinite(disambiguationPrefixSegments)
        ? Math.floor(disambiguationPrefixSegments ?? 0)
        : 2
    )
  );
  if (directories.length <= 3 || directories.length <= prefixSegmentCount + 1) {
    return {
      directory: { head: `${directories.join("/")}/`, tail: null },
      fullPath: normalized
    };
  }
  return {
    directory: {
      head: directories.slice(0, prefixSegmentCount).join("/"),
      tail: `${directories.at(-1)}/`
    },
    fullPath: normalized
  };
}

function MentionFileIcon({
  item,
  classNames,
  dataAttributeMode,
  usesDefaultFileIcon
}: {
  item: MentionRowFileItem;
  classNames: MentionFileRowClassNames;
  dataAttributeMode: MentionRowDataAttributeMode;
  usesDefaultFileIcon: boolean;
}): React.JSX.Element {
  const thumbnailUrl =
    item.visualKind === "image" ? item.thumbnailUrl?.trim() || "" : "";
  if (thumbnailUrl) {
    return (
      <span
        className={classNames.fileThumb}
        {...mentionRowDataAttribute(dataAttributeMode, "fileThumb", "true")}
        aria-hidden="true"
      >
        <img
          src={thumbnailUrl}
          alt=""
          className="rich-text-at-mention-row__media"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }

  if (item.visualKind === "back") {
    return (
      <span
        className={cn(
          classNames.fileIcon,
          "rich-text-at-mention-file-icon--glyph"
        )}
        {...mentionRowDataAttribute(
          dataAttributeMode,
          "fileVisualKind",
          item.visualKind
        )}
        aria-hidden="true"
      >
        <ArrowLeftIcon size={16} />
      </span>
    );
  }

  if (usesDefaultFileIcon) {
    const Icon = MENTION_FILE_VISUAL_KIND_ICON[item.visualKind];
    return (
      <span
        className={cn(
          classNames.fileIcon,
          "rich-text-at-mention-file-icon--glyph"
        )}
        {...mentionRowDataAttribute(
          dataAttributeMode,
          "fileVisualKind",
          item.visualKind
        )}
        aria-hidden="true"
      >
        <Icon size={16} />
      </span>
    );
  }

  return (
    <span
      className={classNames.fileIcon}
      {...mentionRowDataAttribute(
        dataAttributeMode,
        "fileVisualKind",
        item.visualKind
      )}
      aria-hidden="true"
    />
  );
}
