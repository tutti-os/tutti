import type { ReactNode } from "react";
import {
  resolveMentionFileThumbnailUrl,
  resolveMentionFileVisualKind,
  type MentionFileVisualKind
} from "./mentionFileVisualKind.ts";
import {
  renderMentionReferenceLeading,
  type MentionReferenceProviderKind
} from "./mentionReferenceIcon.ts";
import type {
  MentionRowItem,
  MentionRowPlainItem,
  MentionRowStatusTag
} from "./mentionRowTypes.ts";
import type {
  MentionRowStatusTone,
  MentionRowStatusVariant
} from "./mentionStatusTone.ts";
import type {
  RichTextMentionPresentation,
  RichTextTriggerQueryMatch
} from "../types/index.ts";

export type MentionTriggerRowProviderId =
  | "agent-generated-file"
  | "agent-session"
  | "file"
  | "workspace-app"
  | "workspace-issue";

export interface MentionTriggerRowLeadingContext<
  TMatch extends RichTextTriggerQueryMatch = RichTextTriggerQueryMatch
> {
  description: string | null;
  fileVisualKind?: MentionFileVisualKind;
  iconUrl: string | null;
  label: string;
  match: TMatch;
  providerKind: MentionReferenceProviderKind;
  thumbnailUrl: string | null;
}

export interface MentionTriggerRowItemOptions<
  TMatch extends RichTextTriggerQueryMatch = RichTextTriggerQueryMatch
> {
  getAgentIconUrl?: (match: TMatch) => string | null | undefined;
  getChildCountLabel?: (match: TMatch) => string | null | undefined;
  getDescription?: (match: TMatch) => string | null | undefined;
  getFileEntryKind?: (match: TMatch) => string | null | undefined;
  getFileMentionNavigation?: (match: TMatch) => string | null | undefined;
  getFileThumbnailUrl?: (match: TMatch) => string | null | undefined;
  getFileVisualKind?: (
    match: TMatch
  ) => MentionFileVisualKind | null | undefined;
  getStatusTag?: (
    match: TMatch,
    variant: MentionRowStatusVariant
  ) => MentionRowStatusTag | null | undefined;
  getUserAvatarPlaceholderUrl?: (match: TMatch) => string | null | undefined;
  getUserAvatarUrl?: (match: TMatch) => string | null | undefined;
  getWorkspaceAppIconFallbackUrl?: (match: TMatch) => string | null | undefined;
  renderLeading?: (
    context: MentionTriggerRowLeadingContext<TMatch>
  ) => ReactNode | undefined;
}

const SUPPORTED_MENTION_TRIGGER_ROW_PROVIDER_IDS = new Set<string>([
  "agent-generated-file",
  "agent-session",
  "file",
  "workspace-app",
  "workspace-issue"
]);

export function richTextTriggerQueryMatchToMentionRowItem<
  TMatch extends RichTextTriggerQueryMatch = RichTextTriggerQueryMatch
>(
  match: TMatch,
  options: MentionTriggerRowItemOptions<TMatch> = {}
): MentionRowItem {
  const presentation = mentionPresentation(match);
  const label = resolveMentionRowLabel(match);
  const description = resolveMentionRowDescription(match, options);
  const providerKind = mentionReferenceProviderKind(match.providerId);
  const iconUrl = resolveMentionRowIconUrl(match, presentation, options);
  const thumbnailUrl = resolveMentionRowThumbnailUrl(
    match,
    presentation,
    options
  );
  const fileVisualKind = isFileMentionProvider(match.providerId)
    ? resolveMentionRowFileVisualKind(match, options)
    : undefined;
  const customLeading = options.renderLeading?.({
    description,
    fileVisualKind,
    iconUrl,
    label,
    match,
    providerKind,
    thumbnailUrl
  });

  if (customLeading !== undefined) {
    return mentionRowPlainItem({
      description,
      label,
      leading: customLeading
    });
  }

  if (match.providerId === "workspace-app") {
    return {
      kind: "app",
      description,
      iconUrl,
      name: label
    };
  }

  if (match.providerId === "workspace-issue") {
    return {
      kind: "issue",
      creatorName: description,
      statusTag: resolveMentionRowStatusTag(match, "issue", options),
      title: label
    };
  }

  if (isFileMentionProvider(match.providerId)) {
    const entryKind = resolveFileEntryKind(match, options);
    const mentionNavigation = resolveFileMentionNavigation(match, options);
    const visualKind = fileVisualKind ?? "document";
    return {
      kind: "file",
      childCountLabel: normalizedText(options.getChildCountLabel?.(match)),
      entryKind,
      mentionNavigation,
      name: label,
      thumbnailUrl:
        resolveMentionFileThumbnailUrl({
          thumbnailUrl,
          visualKind
        }) ?? null,
      visualKind
    };
  }

  if (match.providerId === "agent-session") {
    const session = agentSessionMentionRowItem(match, {
      description,
      iconUrl,
      options,
      presentation
    });
    if (session) {
      return session;
    }
  }

  return mentionRowPlainItem({
    description,
    label,
    leading: renderMentionReferenceLeading({
      fileVisualKind,
      iconUrl,
      kind: providerKind,
      label,
      thumbnailUrl
    })
  });
}

export function isMentionTriggerRowProviderId(
  providerId: string
): providerId is MentionTriggerRowProviderId {
  return SUPPORTED_MENTION_TRIGGER_ROW_PROVIDER_IDS.has(providerId);
}

export function workspaceAppIconFallbackUrlFromTriggerMatch(
  match: RichTextTriggerQueryMatch
): string | null {
  const appId = mentionEntityId(match) || match.key.trim();
  if (!appId) {
    return null;
  }
  return `tutti://workspace-apps/${encodeURIComponent(appId)}/icon.png`;
}

export function mentionRowStatusTagFromPresentation(
  match: RichTextTriggerQueryMatch,
  input: {
    tone?: MentionRowStatusTone;
    variant: MentionRowStatusVariant;
  }
): MentionRowStatusTag | null {
  const presentation = mentionPresentation(match);
  const label = normalizedText(presentation?.statusLabel);
  if (!label) {
    return null;
  }
  const dataStatus =
    normalizedText(presentation?.statusDataStatus) ??
    normalizedText(presentation?.status);
  return {
    dataStatus: dataStatus ?? undefined,
    label,
    pulse: presentation?.statusPulse === "true",
    tone: input.tone ?? "neutral",
    variant: input.variant
  };
}

function agentSessionMentionRowItem<TMatch extends RichTextTriggerQueryMatch>(
  match: TMatch,
  input: {
    description: string | null;
    iconUrl: string | null;
    options: MentionTriggerRowItemOptions<TMatch>;
    presentation: RichTextMentionPresentation | null;
  }
): MentionRowItem | null {
  const agentIconUrl =
    normalizedText(input.options.getAgentIconUrl?.(match)) ??
    normalizedText(input.presentation?.agentIconUrl) ??
    input.iconUrl;
  const userAvatarPlaceholderUrl =
    normalizedText(input.options.getUserAvatarPlaceholderUrl?.(match)) ??
    normalizedText(input.presentation?.userAvatarPlaceholderUrl);
  if (!agentIconUrl || !userAvatarPlaceholderUrl) {
    return null;
  }
  return {
    kind: "session",
    agentIconUrl,
    participant:
      normalizedText(input.presentation?.participant) ??
      resolveMentionRowLabel(match),
    statusTag: resolveMentionRowStatusTag(match, "activity", input.options),
    summary: input.description,
    userAvatarPlaceholderUrl,
    userAvatarUrl:
      normalizedText(input.options.getUserAvatarUrl?.(match)) ?? null
  };
}

function mentionRowPlainItem(input: {
  description: string | null;
  label: string;
  leading?: ReactNode;
}): MentionRowPlainItem {
  return {
    kind: "plain",
    description: input.description,
    label: input.label,
    leading: input.leading
  };
}

function resolveMentionRowLabel(match: RichTextTriggerQueryMatch): string {
  return (
    normalizedText(
      match.insertResult.kind === "mention"
        ? match.insertResult.mention.label
        : match.insertResult.kind === "markdown-link"
          ? match.insertResult.label
          : undefined
    ) ??
    normalizedText(match.label) ??
    match.key
  );
}

function resolveMentionRowDescription<TMatch extends RichTextTriggerQueryMatch>(
  match: TMatch,
  options: Pick<MentionTriggerRowItemOptions<TMatch>, "getDescription">
): string | null {
  const presentation = mentionPresentation(match);
  return (
    normalizedText(options.getDescription?.(match)) ??
    normalizedText(presentation?.description) ??
    normalizedText(presentation?.subtitle) ??
    normalizedText(match.subtitle) ??
    null
  );
}

function resolveMentionRowIconUrl<TMatch extends RichTextTriggerQueryMatch>(
  match: TMatch,
  presentation: RichTextMentionPresentation | null,
  options: Pick<
    MentionTriggerRowItemOptions<TMatch>,
    "getWorkspaceAppIconFallbackUrl"
  >
): string | null {
  return (
    normalizedText(presentation?.iconUrl) ??
    normalizedText(match.iconUrl) ??
    (match.providerId === "workspace-app"
      ? (normalizedText(options.getWorkspaceAppIconFallbackUrl?.(match)) ??
        workspaceAppIconFallbackUrlFromTriggerMatch(match))
      : null) ??
    null
  );
}

function resolveMentionRowThumbnailUrl<
  TMatch extends RichTextTriggerQueryMatch
>(
  match: TMatch,
  presentation: RichTextMentionPresentation | null,
  options: Pick<MentionTriggerRowItemOptions<TMatch>, "getFileThumbnailUrl">
): string | null {
  return (
    normalizedText(options.getFileThumbnailUrl?.(match)) ??
    normalizedText(presentation?.thumbnailUrl) ??
    normalizedText(readStringProperty(match.item, "thumbnailUrl")) ??
    (isFileMentionProvider(match.providerId)
      ? normalizedText(match.iconUrl)
      : null) ??
    null
  );
}

function resolveMentionRowFileVisualKind<
  TMatch extends RichTextTriggerQueryMatch
>(
  match: TMatch,
  options: Pick<
    MentionTriggerRowItemOptions<TMatch>,
    "getFileEntryKind" | "getFileMentionNavigation" | "getFileVisualKind"
  >
): MentionFileVisualKind {
  const override = options.getFileVisualKind?.(match);
  if (override) {
    return override;
  }
  return resolveMentionFileVisualKind({
    baseVisualKind: inferMentionFileVisualKind(
      markdownLinkHref(match) ??
        normalizedText(match.subtitle) ??
        normalizedText(match.label) ??
        match.key
    ),
    entryKind: resolveFileEntryKind(match, options),
    mentionNavigation: resolveFileMentionNavigation(match, options)
  });
}

function resolveMentionRowStatusTag<TMatch extends RichTextTriggerQueryMatch>(
  match: TMatch,
  variant: MentionRowStatusVariant,
  options: Pick<MentionTriggerRowItemOptions<TMatch>, "getStatusTag">
): MentionRowStatusTag | null {
  return (
    options.getStatusTag?.(match, variant) ??
    mentionRowStatusTagFromPresentation(match, { variant })
  );
}

function resolveFileEntryKind<TMatch extends RichTextTriggerQueryMatch>(
  match: TMatch,
  options: Pick<MentionTriggerRowItemOptions<TMatch>, "getFileEntryKind">
): string | null {
  return (
    normalizedText(options.getFileEntryKind?.(match)) ??
    normalizedText(readStringProperty(match.item, "entryKind")) ??
    normalizedText(readStringProperty(match.item, "kind")) ??
    null
  );
}

function resolveFileMentionNavigation<TMatch extends RichTextTriggerQueryMatch>(
  match: TMatch,
  options: Pick<
    MentionTriggerRowItemOptions<TMatch>,
    "getFileMentionNavigation"
  >
): string | null {
  return (
    normalizedText(options.getFileMentionNavigation?.(match)) ??
    normalizedText(readStringProperty(match.item, "mentionNavigation")) ??
    null
  );
}

function mentionReferenceProviderKind(
  providerId: string
): MentionReferenceProviderKind {
  if (providerId === "workspace-app") {
    return "workspace-app";
  }
  if (providerId === "workspace-issue") {
    return "workspace-issue";
  }
  if (providerId === "agent-session") {
    return "agent-session";
  }
  if (providerId === "agent-generated-file") {
    return "agent-generated-file";
  }
  if (providerId === "file") {
    return "file";
  }
  return "generic";
}

function isFileMentionProvider(providerId: string): boolean {
  return providerId === "file" || providerId === "agent-generated-file";
}

function mentionPresentation(
  match: RichTextTriggerQueryMatch
): RichTextMentionPresentation | null {
  return match.insertResult.kind === "mention"
    ? (match.insertResult.mention.presentation ?? null)
    : null;
}

function mentionEntityId(match: RichTextTriggerQueryMatch): string | null {
  return match.insertResult.kind === "mention"
    ? (normalizedText(match.insertResult.mention.entityId) ?? null)
    : null;
}

function markdownLinkHref(match: RichTextTriggerQueryMatch): string | null {
  return match.insertResult.kind === "markdown-link"
    ? (normalizedText(match.insertResult.href) ?? null)
    : null;
}

function inferMentionFileVisualKind(pathOrName: string): MentionFileVisualKind {
  const normalized = pathOrName.trim().toLowerCase();
  if (!normalized) {
    return "document";
  }
  if (normalized.endsWith("/")) {
    return "folder";
  }
  const extension = normalized.match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1] ?? "";
  if (
    ["apng", "avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(
      extension
    )
  ) {
    return "image";
  }
  if (["avi", "m4v", "mkv", "mov", "mp4", "webm"].includes(extension)) {
    return "video";
  }
  if (["markdown", "md", "mdx"].includes(extension)) {
    return "markdown";
  }
  if (
    [
      "c",
      "cpp",
      "css",
      "go",
      "h",
      "hpp",
      "html",
      "java",
      "js",
      "jsx",
      "json",
      "kt",
      "php",
      "py",
      "rb",
      "rs",
      "sh",
      "sql",
      "swift",
      "toml",
      "ts",
      "tsx",
      "xml",
      "yaml",
      "yml"
    ].includes(extension)
  ) {
    return "code";
  }
  return "document";
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record[key] === "string" ? record[key] : undefined;
}

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
