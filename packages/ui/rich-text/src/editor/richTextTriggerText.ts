import {
  createDefaultRichTextI18nRuntime,
  type RichTextI18nRuntime
} from "../i18n/richTextI18n.ts";

export interface RichTextTriggerTextOverrides {
  loadFailedLabel?: string;
  loadingLabel?: string;
  noMatchesLabel?: string;
  removeReferenceActionLabel?: string;
}

export interface ResolvedRichTextTriggerText {
  loadFailedLabel: string;
  loadingLabel: string;
  noMatchesLabel: string;
  removeReferenceActionLabel: string;
}

const defaultRichTextI18n = createDefaultRichTextI18nRuntime();

export function resolveRichTextTriggerText(
  overrides?: RichTextTriggerTextOverrides,
  removeDecorationAriaLabel?: string,
  i18n: RichTextI18nRuntime = defaultRichTextI18n
): ResolvedRichTextTriggerText {
  return {
    loadFailedLabel:
      overrides?.loadFailedLabel?.trim() || i18n.t("richTextAt.loadFailed"),
    loadingLabel:
      overrides?.loadingLabel?.trim() || i18n.t("richTextAt.loading"),
    noMatchesLabel:
      overrides?.noMatchesLabel?.trim() || i18n.t("richTextAt.noMatches"),
    removeReferenceActionLabel:
      removeDecorationAriaLabel?.trim() ||
      overrides?.removeReferenceActionLabel?.trim() ||
      i18n.t("richTextAt.removeReferenceActionLabel")
  };
}

export const defaultRichTextTriggerText = resolveRichTextTriggerText();
