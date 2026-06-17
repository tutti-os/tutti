import type {
  RichTextMentionAttrs,
  RichTextMentionInsert,
  RichTextMentionPresentation,
  RichTextMentionPlugin,
  RichTextResolvedMention,
  RichTextResolvedMentionView
} from "../types/mention.ts";

const richTextMentionTrigger = "@";

function normalizeOptionalString(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMentionLabel(value: string): string {
  return value.trim().replace(/^@+/, "").trim();
}

function normalizeStringRecord(
  values?: Readonly<Record<string, string>> | null
): Readonly<Record<string, string>> | undefined {
  if (!values) {
    return undefined;
  }

  const nextEntries = Object.entries(values)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);

  if (nextEntries.length === 0) {
    return undefined;
  }

  return Object.freeze(Object.fromEntries(nextEntries));
}

function normalizeMentionPresentation(
  presentation?: RichTextMentionPresentation | null
): RichTextMentionPresentation | undefined {
  if (!presentation) {
    return undefined;
  }

  const normalized: RichTextMentionPresentation = {};
  for (const key of richTextMentionPresentationKeys) {
    const value = normalizeOptionalString(presentation[key]);
    if (value) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0
    ? Object.freeze(normalized)
    : undefined;
}

const richTextMentionPresentationKeys = [
  "agentProviderId",
  "agentIconUrl",
  "iconUrl",
  "thumbnailUrl",
  "subtitle",
  "description",
  "participant",
  "status",
  "statusDataStatus",
  "statusLabel",
  "statusPulse",
  "userAvatarPlaceholderUrl"
] as const satisfies readonly (keyof RichTextMentionPresentation)[];

export function createRichTextMentionAttrs(
  providerId: string,
  mention: RichTextMentionInsert
): RichTextMentionAttrs {
  const normalizedProviderId = providerId.trim();
  const entityId = mention.entityId.trim();
  const label = normalizeMentionLabel(mention.label);

  if (!normalizedProviderId) {
    throw new Error("Rich text mention provider id is required.");
  }
  if (!entityId) {
    throw new Error("Rich text mention entityId is required.");
  }
  if (!label) {
    throw new Error("Rich text mention label is required.");
  }

  const attrs: RichTextMentionAttrs = {
    trigger: richTextMentionTrigger,
    providerId: normalizedProviderId,
    entityId,
    label
  };
  const scope = normalizeStringRecord(mention.scope);
  const presentation = normalizeMentionPresentation(mention.presentation);
  if (scope) {
    attrs.scope = scope;
  }
  if (presentation) {
    attrs.presentation = presentation;
  }
  return attrs;
}

export function isRichTextMentionAttrs(
  value: unknown
): value is RichTextMentionAttrs {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RichTextMentionAttrs>;
  return (
    candidate.trigger === richTextMentionTrigger &&
    typeof candidate.providerId === "string" &&
    candidate.providerId.trim().length > 0 &&
    typeof candidate.entityId === "string" &&
    candidate.entityId.trim().length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0
  );
}

export function getRichTextMentionDisplayText(
  attrs: RichTextMentionAttrs
): string {
  const label = normalizeMentionLabel(attrs.label);
  return label ? `@${label}` : "";
}

export function resolveRichTextMentionView(
  mention: RichTextMentionAttrs,
  resolved?: RichTextResolvedMention | null
): RichTextResolvedMentionView {
  const state = resolved?.state ?? "active";
  const label = normalizeMentionLabel(resolved?.label ?? mention.label);
  const tooltip = normalizeOptionalString(resolved?.tooltip);

  return {
    state,
    label,
    tooltip,
    presentation: normalizeMentionPresentation(
      resolved?.presentation ?? mention.presentation
    ),
    entity: resolved?.entity,
    interactive: state === "active"
  };
}

export function createRichTextMentionPlugin<TItem, TResolved = unknown>(
  plugin: RichTextMentionPlugin<TItem, TResolved>
): RichTextMentionPlugin<TItem, TResolved> {
  const id = plugin.id.trim();
  if (!id) {
    throw new Error("Rich text mention plugin id is required.");
  }

  return {
    ...plugin,
    id,
    trigger: richTextMentionTrigger
  };
}
