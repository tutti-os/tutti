import {
  ArrowLeftIcon,
  Badge,
  FileCodeIcon,
  FileTextIcon,
  FolderIcon,
  ImageFileIcon,
  LocateFolderIcon,
  ProductIcon,
  StatusDot,
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
import type {
  MentionRowFileItem,
  MentionRowItem,
  MentionRowSessionItem,
  MentionRowStatusTag
} from "./mentionRowTypes.ts";
import { mentionStatusBadgeClassName } from "./mentionStatusTone.ts";

/**
 * Default file kind-icon shapes for surfaces that do NOT ship the agent's
 * CSS-masked glyph stylesheet. These mirror the agent's mask glyph shapes
 * (`agentactivity.css`: folder-filled / doc-filled / code-filled / image-filled
 * / video-filled / arrow-left-filled) using ui-system icon components, so a
 * file row renders a real glyph without `agentactivity.css`. The agent composer
 * passes its own `fileIcon` class and keeps rendering the masked `<span>`.
 */
const MENTION_FILE_VISUAL_KIND_ICON: Record<
  MentionFileVisualKind,
  (props: IconProps) => React.JSX.Element
> = {
  back: ArrowLeftIcon,
  folder: FolderIcon,
  document: FileTextIcon,
  // The agent maps markdown to `product-filled.svg`; ProductIcon is the
  // matching boundary-safe ui-system glyph.
  markdown: ProductIcon,
  code: FileCodeIcon,
  image: ImageFileIcon,
  video: VideoFileIcon
};

/**
 * Structural class-name hooks for the elements a {@link MentionRow} renders that
 * rely on a stylesheet (file icon/thumb, the app fallback kind-icon, and the
 * session avatar placeholder modifier). Every key is optional and defaults to a
 * PACKAGE-OWNED `rich-text-at-mention-*` class whose CSS ships with
 * `mentionPalette.css`, so any consumer renders styled rows out of the box.
 *
 * Surfaces with their own stylesheet (e.g. the agent composer) pass their exact
 * existing class names here so their rendered DOM stays byte-identical.
 */
export interface MentionRowClassNames {
  /** The masked file kind-icon `<span>`. */
  fileIcon?: string;
  /** The image-thumbnail wrapper `<span>` (rendered for image files). */
  fileThumb?: string;
  /** The fallback app icon glyph rendered when no `iconUrl` is present. */
  kindIcon?: string;
  /**
   * Modifier class added to the session user avatar `<img>` when the user has no
   * avatar URL and the placeholder asset is shown.
   */
  avatarImgUserPlaceholder?: string;
}

export interface MentionRowRenderOptions {
  classNames?: MentionRowClassNames;
  dataAttributeMode?: MentionRowDataAttributeMode;
  /**
   * 当提供时,issue / app 行末尾渲染一个「查看产物文件」入口图标(独立点击热区,
   * 不触发整行选中)。点击回调由调用方注入(如打开引用文件 picker 并定位到该实体)。
   */
  onOpenReferences?: () => void;
  /** 入口图标的无障碍标签 / tooltip 文案。 */
  openReferencesLabel?: string;
}

interface ResolvedMentionRowRenderOptions {
  classNames?: MentionRowClassNames;
  dataAttributeMode: MentionRowDataAttributeMode;
  onOpenReferences?: () => void;
  openReferencesLabel?: string;
}

const DEFAULT_MENTION_ROW_CLASS_NAMES = {
  fileIcon: "rich-text-at-mention-file-icon",
  fileThumb: "rich-text-at-mention-file-thumb",
  kindIcon: "rich-text-at-mention-kind-icon",
  avatarImgUserPlaceholder: "rich-text-at-mention-avatar-img--user-placeholder"
} as const satisfies Required<MentionRowClassNames>;

function resolveMentionRowClassNames(
  classNames?: MentionRowClassNames
): Required<MentionRowClassNames> {
  return {
    fileIcon: classNames?.fileIcon ?? DEFAULT_MENTION_ROW_CLASS_NAMES.fileIcon,
    fileThumb:
      classNames?.fileThumb ?? DEFAULT_MENTION_ROW_CLASS_NAMES.fileThumb,
    kindIcon: classNames?.kindIcon ?? DEFAULT_MENTION_ROW_CLASS_NAMES.kindIcon,
    avatarImgUserPlaceholder:
      classNames?.avatarImgUserPlaceholder ??
      DEFAULT_MENTION_ROW_CLASS_NAMES.avatarImgUserPlaceholder
  };
}

function resolveMentionRowRenderOptions(
  options?: MentionRowClassNames | MentionRowRenderOptions
): ResolvedMentionRowRenderOptions {
  if (isMentionRowRenderOptions(options)) {
    return {
      classNames: options.classNames,
      dataAttributeMode: options.dataAttributeMode ?? "shared",
      onOpenReferences: options.onOpenReferences,
      openReferencesLabel: options.openReferencesLabel
    };
  }
  return {
    classNames: options,
    dataAttributeMode: "shared"
  };
}

function isMentionRowRenderOptions(
  options: MentionRowClassNames | MentionRowRenderOptions | undefined
): options is MentionRowRenderOptions {
  return (
    options !== undefined &&
    ("classNames" in options || "dataAttributeMode" in options)
  );
}

/**
 * Render the inner content of a single `@`-mention palette row from a
 * fully-resolved {@link MentionRowItem}. The surrounding option button / active
 * state is provided by the shared `MentionPalette` shell; this renders only the
 * row body.
 *
 * Pass {@link classNames} to override the package-owned structural class hooks
 * (e.g. so the agent composer keeps emitting its own stylesheet's class names).
 */
export function renderMentionRow(
  item: MentionRowItem,
  options?: MentionRowClassNames | MentionRowRenderOptions
): React.ReactNode {
  const {
    classNames,
    dataAttributeMode,
    onOpenReferences,
    openReferencesLabel
  } = resolveMentionRowRenderOptions(options);
  const resolved = resolveMentionRowClassNames(classNames);
  const referencesButton = onOpenReferences ? (
    <MentionOpenReferencesButton
      label={openReferencesLabel}
      onOpenReferences={onOpenReferences}
      dataAttributeMode={dataAttributeMode}
    />
  ) : null;
  if (item.kind === "file") {
    return (
      <MentionFileRow
        item={item}
        classNames={resolved}
        dataAttributeMode={dataAttributeMode}
      />
    );
  }

  if (item.kind === "session") {
    return (
      <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <span className="flex min-w-0 items-center gap-2 overflow-hidden">
          <MentionSessionAvatarStack
            item={item}
            classNames={resolved}
            dataAttributeMode={dataAttributeMode}
          />
          <span className="min-w-0 truncate text-[13px] font-semibold leading-[16px] text-[var(--text-primary)]">
            <MentionSessionTitle item={item} />
          </span>
        </span>
        {item.statusTag ? (
          <MentionStatusBadge
            statusTag={item.statusTag}
            dataAttributeMode={dataAttributeMode}
          />
        ) : null}
      </span>
    );
  }

  if (item.kind === "app") {
    return (
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        <MentionWorkspaceAppIcon
          iconUrl={item.iconUrl}
          kindIconClassName={resolved.kindIcon}
          dataAttributeMode={dataAttributeMode}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden">
          <span className="min-w-0 max-w-[40%] shrink-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {item.name}
          </span>
          {item.description ? (
            <span className="min-w-0 flex-1 truncate text-[13px] font-normal text-[var(--text-secondary)]">
              {item.description}
            </span>
          ) : null}
        </span>
        {referencesButton}
      </span>
    );
  }

  if (item.kind === "app-factory") {
    return (
      <span className="grid min-w-0 overflow-hidden gap-1">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {item.name}
        </span>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-2 overflow-hidden">
      <span className="grid min-w-0 flex-1 overflow-hidden gap-1">
        <span className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {item.title}
          </span>
          {item.statusTag ? (
            <MentionStatusBadge
              statusTag={item.statusTag}
              dataAttributeMode={dataAttributeMode}
            />
          ) : null}
        </span>
        {item.creatorName ? (
          <span className="truncate text-[13px] font-normal text-[var(--text-secondary)]">
            {item.creatorName}
          </span>
        ) : null}
      </span>
      {referencesButton}
    </span>
  );
}

/**
 * 「查看产物文件」入口图标。issue / app 行末尾的独立点击热区:点击只触发
 * {@link onOpenReferences}(如打开引用文件 picker 并定位),阻断冒泡以免触发整行选中。
 * 行外层按钮的 `[&_svg]:pointer-events-none` 使图标本身不吃事件,点击落在此 `<span>` 上。
 */
function MentionOpenReferencesButton({
  label,
  onOpenReferences,
  dataAttributeMode
}: {
  label?: string;
  onOpenReferences: () => void;
  dataAttributeMode: MentionRowDataAttributeMode;
}): React.JSX.Element {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      className="ml-auto grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-[5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--transparency-active)] hover:text-[var(--text-secondary)]"
      {...mentionRowDataAttribute(dataAttributeMode, "openReferences", "true")}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenReferences();
      }}
    >
      <LocateFolderIcon size={16} />
    </span>
  );
}

function MentionFileRow({
  item,
  classNames,
  dataAttributeMode
}: {
  item: MentionRowFileItem;
  classNames: Required<MentionRowClassNames>;
  dataAttributeMode: MentionRowDataAttributeMode;
}): React.JSX.Element {
  return (
    <span
      className="flex min-w-0 items-center gap-2"
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
      />
      <span className="flex min-w-0 items-baseline gap-1 overflow-hidden">
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {item.name}
        </span>
        {item.childCountLabel ? (
          <span className="shrink-0 text-[13px] font-normal text-[var(--text-secondary)]">
            {item.childCountLabel}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function MentionFileIcon({
  item,
  classNames,
  dataAttributeMode
}: {
  item: MentionRowFileItem;
  classNames: Required<MentionRowClassNames>;
  dataAttributeMode: MentionRowDataAttributeMode;
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
          className="h-full w-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }

  // Surfaces that ship a custom file-icon stylesheet (e.g. the agent composer
  // via `agentactivity.css`) render the empty CSS-masked `<span>` so their DOM
  // stays byte-identical. Surfaces using the package default class have no such
  // stylesheet, so render a real ui-system kind glyph instead of an empty box.
  const usesDefaultFileIcon =
    classNames.fileIcon === DEFAULT_MENTION_ROW_CLASS_NAMES.fileIcon;
  if (usesDefaultFileIcon) {
    const Icon = MENTION_FILE_VISUAL_KIND_ICON[item.visualKind];
    return (
      <span
        className={cn(
          classNames.fileIcon,
          "grid h-4 w-4 shrink-0 place-items-center text-[var(--text-secondary)]"
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

function MentionWorkspaceAppIcon({
  iconUrl,
  kindIconClassName,
  dataAttributeMode
}: {
  iconUrl?: string | null;
  kindIconClassName: string;
  dataAttributeMode: MentionRowDataAttributeMode;
}): React.JSX.Element {
  const normalizedIconUrl = iconUrl?.trim() ?? "";
  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-[5px] bg-block text-[var(--text-secondary)]"
      {...mentionRowDataAttribute(dataAttributeMode, "appIcon", "true")}
      data-workspace-app-icon="true"
      aria-hidden="true"
    >
      {normalizedIconUrl ? (
        <img
          src={normalizedIconUrl}
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className={cn(kindIconClassName, "h-4 w-4")} />
      )}
    </span>
  );
}

function MentionSessionAvatarStack({
  item,
  classNames,
  dataAttributeMode
}: {
  item: MentionRowSessionItem;
  classNames: Required<MentionRowClassNames>;
  dataAttributeMode: MentionRowDataAttributeMode;
}): React.JSX.Element {
  const userAvatarUrl = item.userAvatarUrl?.trim() ?? "";
  const placeholderUrl = item.userAvatarPlaceholderUrl;
  const userImageUrl = userAvatarUrl || placeholderUrl;
  return (
    <span
      className="relative isolate block h-5 w-9 shrink-0"
      aria-hidden="true"
    >
      <span
        className="absolute left-0 top-0 z-0 grid h-5 w-5 overflow-hidden rounded-full bg-block"
        {...mentionRowDataAttribute(dataAttributeMode, "userAvatar", "true")}
      >
        <img
          src={userImageUrl}
          alt=""
          className={cn(
            "h-full w-full object-cover",
            !userAvatarUrl && classNames.avatarImgUserPlaceholder
          )}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={(event) => {
            if (event.currentTarget.dataset.fallbackAvatarApplied === "true") {
              return;
            }
            event.currentTarget.dataset.fallbackAvatarApplied = "true";
            event.currentTarget.src = placeholderUrl;
            event.currentTarget.classList.add(
              classNames.avatarImgUserPlaceholder
            );
          }}
        />
      </span>
      <span
        className="absolute left-4 top-0 z-10 grid h-5 w-5 overflow-hidden rounded-full bg-block"
        {...mentionRowDataAttribute(dataAttributeMode, "agentAvatar", "true")}
      >
        <img
          src={item.agentIconUrl}
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    </span>
  );
}

function MentionSessionTitle({
  item
}: {
  item: MentionRowSessionItem;
}): React.JSX.Element {
  return (
    <>
      <span className="text-[13px] leading-[16px]">{item.participant}</span>
      <span className="text-[13px] font-normal leading-[16px] text-[var(--text-secondary)]">
        {" "}
        {item.summary ?? ""}
      </span>
    </>
  );
}

function MentionStatusBadge({
  statusTag,
  dataAttributeMode
}: {
  statusTag: MentionRowStatusTag;
  dataAttributeMode: MentionRowDataAttributeMode;
}): React.JSX.Element {
  if (statusTag.variant === "issue") {
    return (
      <Badge
        variant="secondary"
        className={cn(
          "shrink-0 text-[13px]",
          mentionStatusBadgeClassName({
            tone: statusTag.tone,
            variant: "issue"
          })
        )}
        {...mentionRowDataAttribute(dataAttributeMode, "statusTag", "true")}
        {...(statusTag.dataStatus
          ? { "data-status": statusTag.dataStatus }
          : {})}
      >
        {statusTag.label}
      </Badge>
    );
  }

  return (
    <Badge
      variant="secondary"
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-[11px] font-semibold leading-none",
        mentionStatusBadgeClassName({
          tone: statusTag.tone,
          variant: "activity"
        })
      )}
      {...mentionRowDataAttribute(dataAttributeMode, "statusTag", "true")}
      {...(statusTag.dataStatus ? { "data-status": statusTag.dataStatus } : {})}
      data-tone={statusTag.tone}
      title={statusTag.label}
    >
      <StatusDot
        tone={statusTag.tone}
        pulse={statusTag.pulse ?? false}
        size="xs"
        title={statusTag.label}
      />
      <span>{statusTag.label}</span>
    </Badge>
  );
}
