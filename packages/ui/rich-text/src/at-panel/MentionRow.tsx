import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Badge,
  FileCodeIcon,
  FileTextIcon,
  FolderIcon,
  ImageFileIcon,
  ProductIcon,
  StatusDot,
  VideoFileIcon,
  cn,
  type IconProps
} from "@tutti-os/ui-system";
import { Fragment } from "react";
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
 * passes its own `fileIcon` class and keeps rendering masked `<span>` glyphs,
 * except `back` rows which always use {@link ArrowLeftIcon}.
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
   * 当提供时,issue / app 行末尾渲染一个「查看产物」入口(独立点击热区,
   * 不触发整行选中)。点击回调由调用方注入(如打开引用文件 picker 并定位到该实体)。
   */
  onOpenReferences?: () => void;
  /** 入口的无障碍标签 / tooltip 文案。 */
  openReferencesLabel?: string;
  /** 当提供时,文件夹行末尾渲染一个「进入下一级」箭头按钮。 */
  onNavigateInto?: () => void;
  /** 「进入下一级」箭头按钮的无障碍标签 / tooltip 文案。 */
  navigateIntoLabel?: string;
}

interface ResolvedMentionRowRenderOptions {
  classNames?: MentionRowClassNames;
  dataAttributeMode: MentionRowDataAttributeMode;
  onOpenReferences?: () => void;
  openReferencesLabel?: string;
  onNavigateInto?: () => void;
  navigateIntoLabel?: string;
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
      openReferencesLabel: options.openReferencesLabel,
      onNavigateInto: options.onNavigateInto,
      navigateIntoLabel: options.navigateIntoLabel
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
    ("classNames" in options ||
      "dataAttributeMode" in options ||
      "onOpenReferences" in options ||
      "onNavigateInto" in options)
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
    openReferencesLabel,
    onNavigateInto,
    navigateIntoLabel
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
        navigateIntoLabel={navigateIntoLabel}
        onNavigateInto={onNavigateInto}
      />
    );
  }

  if (item.kind === "plain") {
    return (
      <span className="rich-text-at-mention-row rich-text-at-mention-row--plain">
        {item.leading}
        <span className="rich-text-at-mention-row__text-stack">
          <span className="rich-text-at-mention-row__title">{item.label}</span>
          {item.description ? (
            <span className="rich-text-at-mention-row__description">
              {item.description}
            </span>
          ) : null}
        </span>
      </span>
    );
  }

  if (item.kind === "session") {
    return (
      <span className="rich-text-at-mention-row rich-text-at-mention-row--session">
        <MentionSessionAvatarStack
          item={item}
          classNames={resolved}
          dataAttributeMode={dataAttributeMode}
        />
        <span className="rich-text-at-mention-row__entity-text rich-text-at-mention-row__session-title">
          <MentionSessionTitle item={item} />
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
      <span className="rich-text-at-mention-row rich-text-at-mention-row--app">
        <MentionWorkspaceAppIcon
          iconUrl={item.iconUrl}
          kindIconClassName={resolved.kindIcon}
          dataAttributeMode={dataAttributeMode}
        />
        <span className="rich-text-at-mention-row__entity-text rich-text-at-mention-row__app-text">
          <span className="rich-text-at-mention-row__entity-name rich-text-at-mention-row__app-name">
            {item.name}
          </span>
          {item.description ? (
            <span className="rich-text-at-mention-row__entity-description rich-text-at-mention-row__app-description">
              {item.description}
            </span>
          ) : null}
        </span>
        {item.statusTag ? (
          <MentionStatusBadge
            statusTag={item.statusTag}
            dataAttributeMode={dataAttributeMode}
          />
        ) : null}
        {referencesButton}
      </span>
    );
  }

  if (item.kind === "app-factory") {
    return (
      <span className="rich-text-at-mention-row__text-stack">
        <span className="rich-text-at-mention-row__title">{item.name}</span>
      </span>
    );
  }

  return (
    <span className="rich-text-at-mention-row rich-text-at-mention-row--issue">
      <span className="rich-text-at-mention-row__text-stack rich-text-at-mention-row__text-stack--fill">
        <span className="rich-text-at-mention-row__inline">
          <span className="rich-text-at-mention-row__title">{item.title}</span>
        </span>
        {item.creatorName ? (
          <span className="rich-text-at-mention-row__description">
            {item.creatorName}
          </span>
        ) : null}
      </span>
      {item.statusTag ? (
        <MentionStatusBadge
          statusTag={item.statusTag}
          dataAttributeMode={dataAttributeMode}
        />
      ) : null}
      {referencesButton}
    </span>
  );
}

/**
 * 「查看产物」入口。issue / app 行末尾的独立点击热区:点击只触发
 * {@link onOpenReferences}(如打开引用文件 picker 并定位),阻断冒泡以免触发整行选中。
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
  const resolvedLabel = label?.trim() || "查看产物";
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={resolvedLabel}
      title={resolvedLabel}
      className="rich-text-at-mention-row__open-references"
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
      {resolvedLabel}
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

function MentionFileRow({
  item,
  classNames,
  dataAttributeMode,
  navigateIntoLabel,
  onNavigateInto
}: {
  item: MentionRowFileItem;
  classNames: Required<MentionRowClassNames>;
  dataAttributeMode: MentionRowDataAttributeMode;
  navigateIntoLabel?: string;
  onNavigateInto?: () => void;
}): React.JSX.Element {
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
      />
      <span className="rich-text-at-mention-row__file-text">
        <span className="rich-text-at-mention-row__title">{item.name}</span>
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
          className="rich-text-at-mention-row__media"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }

  // Back navigation always renders the ui-system back glyph so every surface
  // (including the agent composer's CSS-masked file icons) shares one source.
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
      className="rich-text-at-mention-app-icon"
      {...mentionRowDataAttribute(dataAttributeMode, "appIcon", "true")}
      data-workspace-app-icon="true"
      aria-hidden="true"
    >
      {normalizedIconUrl ? (
        <img
          src={normalizedIconUrl}
          alt=""
          className="rich-text-at-mention-row__media"
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span
          className={cn(
            kindIconClassName,
            "rich-text-at-mention-kind-icon--app"
          )}
        />
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
  const showUserAvatar = item.showUserAvatar !== false;
  if (!showUserAvatar) {
    return (
      <span
        className={cn(
          "rich-text-at-mention-avatar-stack",
          "rich-text-at-mention-avatar-stack--agent-only"
        )}
        aria-hidden="true"
      >
        <span
          className="rich-text-at-mention-avatar rich-text-at-mention-avatar--agent"
          {...mentionRowDataAttribute(dataAttributeMode, "agentAvatar", "true")}
        >
          <img
            src={item.agentIconUrl}
            alt=""
            className="rich-text-at-mention-row__media"
            decoding="async"
            loading="lazy"
            draggable={false}
          />
        </span>
      </span>
    );
  }

  const userAvatarUrl = item.userAvatarUrl?.trim() ?? "";
  const placeholderUrl = item.userAvatarPlaceholderUrl;
  const userImageUrl = userAvatarUrl || placeholderUrl;
  return (
    <span className="rich-text-at-mention-avatar-stack" aria-hidden="true">
      <span
        className="rich-text-at-mention-avatar rich-text-at-mention-avatar--user"
        {...mentionRowDataAttribute(dataAttributeMode, "userAvatar", "true")}
      >
        <img
          src={userImageUrl}
          alt=""
          className={cn(
            "rich-text-at-mention-row__media",
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
        className="rich-text-at-mention-avatar rich-text-at-mention-avatar--agent"
        {...mentionRowDataAttribute(dataAttributeMode, "agentAvatar", "true")}
      >
        <img
          src={item.agentIconUrl}
          alt=""
          className="rich-text-at-mention-row__media"
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
  const participantTruncatableSegments =
    item.participantTruncatableSegments?.map((segment) => segment.trim()) ?? [];
  const participantSegmentSeparator = item.participantSegmentSeparator ?? "";
  const participantFixedSuffix = item.participantFixedSuffix ?? "";
  const hasStructuredParticipant =
    participantTruncatableSegments.length > 0 &&
    participantTruncatableSegments.every((segment) => segment.length > 0) &&
    participantFixedSuffix.length > 0 &&
    `${participantTruncatableSegments.join(
      participantSegmentSeparator
    )}${participantFixedSuffix}` === item.participant;
  return (
    <>
      <span
        className={cn(
          "rich-text-at-mention-row__entity-name rich-text-at-mention-row__session-participant",
          hasStructuredParticipant &&
            "rich-text-at-mention-row__session-participant--structured"
        )}
        title={hasStructuredParticipant ? item.participant : undefined}
      >
        {hasStructuredParticipant ? (
          <>
            {participantTruncatableSegments.map((segment, index) => (
              <Fragment key={`${index}:${segment}`}>
                {index > 0 ? (
                  <span className="rich-text-at-mention-row__session-participant-separator">
                    {participantSegmentSeparator}
                  </span>
                ) : null}
                <span className="rich-text-at-mention-row__session-participant-entity">
                  <span className="rich-text-at-mention-row__session-participant-segment">
                    {segment}
                  </span>
                </span>
              </Fragment>
            ))}
            <span className="rich-text-at-mention-row__session-participant-suffix">
              {participantFixedSuffix}
            </span>
          </>
        ) : (
          item.participant
        )}
      </span>
      <span className="rich-text-at-mention-row__entity-description rich-text-at-mention-row__session-summary">
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
        size="sm"
        className={cn(
          "rich-text-at-mention-status rich-text-at-mention-status--issue",
          mentionStatusBadgeClassName({
            tone: statusTag.tone,
            variant: "issue"
          })
        )}
        {...mentionRowDataAttribute(dataAttributeMode, "statusTag", "true")}
        {...(statusTag.dataStatus
          ? { "data-status": statusTag.dataStatus }
          : {})}
        data-tone={statusTag.tone}
      >
        {statusTag.label}
      </Badge>
    );
  }

  return (
    <Badge
      variant="secondary"
      size="sm"
      className={cn(
        "rich-text-at-mention-status rich-text-at-mention-status--activity",
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
        tone={statusTag.tone === "purple" ? "neutral" : statusTag.tone}
        pulse={statusTag.pulse ?? false}
        size="xs"
        title={statusTag.label}
      />
      <span>{statusTag.label}</span>
    </Badge>
  );
}
