import {
  createRichTextMentionInsertResult,
  createRichTextTriggerProvider
} from "@tutti-os/ui-rich-text/plugins";
import type {
  RichTextMentionInsert,
  RichTextMentionPresentation,
  RichTextMentionResolved,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";
import type {
  DesktopRichTextAtCapability,
  DesktopRichTextTriggerProviderRequest
} from "../richTextAtService.interface";

export interface DesktopRichTextAtContributor {
  capability: DesktopRichTextAtCapability;
  getProviders: (
    input: DesktopRichTextTriggerProviderRequest
  ) => readonly RichTextTriggerProvider<unknown>[];
}

const presentationKeys = [
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
  "userAvatarPlaceholderUrl",
  "referencesListSupported"
] as const satisfies readonly (keyof RichTextMentionPresentation)[];

export { createRichTextTriggerProvider };

export function createDesktopRichTextMentionInsertResult(
  mention: RichTextMentionInsert
) {
  return createRichTextMentionInsertResult(mention);
}

export function compactStringRecord(
  values: Readonly<Record<string, string | null | undefined>>
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(values)
    .map(([key, value]) => [key.trim(), value?.trim() ?? ""] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function compactMentionPresentation(
  presentation: RichTextMentionPresentation
): RichTextMentionPresentation | undefined {
  const compacted: RichTextMentionPresentation = {};
  for (const key of presentationKeys) {
    const value = presentation[key]?.trim();
    if (value) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function scopeString(
  scope: Readonly<Record<string, string>> | undefined,
  key: string
): string {
  return scope?.[key]?.trim() ?? "";
}

export async function resolveMentionSafely(
  resolve: () => Promise<RichTextMentionResolved | null>
): Promise<RichTextMentionResolved | null> {
  try {
    return await resolve();
  } catch {
    return null;
  }
}
