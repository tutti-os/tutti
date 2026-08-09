import {
  createI18nRuntime,
  createScopedI18nRuntime,
  createScopedLocaleObjectsI18nModuleManifest,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type RichTextI18nLocale = "en" | "zh-CN";

export const richTextI18nNamespace = "richText";
export const richTextI18nModule = createScopedLocaleObjectsI18nModuleManifest({
  localeObjectByLocale: {
    en: "richTextEn",
    "zh-CN": "richTextZhCN"
  },
  name: "ui-rich-text",
  namespace: richTextI18nNamespace,
  sourceRoot: "packages/ui/rich-text/src"
});

const richTextEn = {
  richTextAt: {
    loadFailed: "Unable to load references",
    loading: "Loading...",
    noMatches: "No matches",
    removeReferenceActionLabel: "Remove reference"
  }
} as const satisfies I18nDictionary;

const richTextZhCN = {
  richTextAt: {
    loadFailed: "无法加载引用",
    loading: "正在加载...",
    noMatches: "没有匹配项",
    removeReferenceActionLabel: "移除引用"
  }
} as const satisfies I18nDictionary;

export type RichTextI18nKey =
  | "richTextAt.loadFailed"
  | "richTextAt.loading"
  | "richTextAt.noMatches"
  | "richTextAt.removeReferenceActionLabel";

export type RichTextI18nRuntime = I18nRuntime<RichTextI18nKey>;

const richTextDefaults: Record<RichTextI18nLocale, I18nDictionary> = {
  en: richTextEn,
  "zh-CN": richTextZhCN
};

export const richTextI18nResources: Record<RichTextI18nLocale, I18nDictionary> =
  {
    en: {
      [richTextI18nNamespace]: richTextDefaults.en
    },
    "zh-CN": {
      [richTextI18nNamespace]: richTextDefaults["zh-CN"]
    }
  };

const defaultRichTextI18n = createI18nRuntime({
  dictionaries: [richTextI18nResources.en]
});

export function createRichTextI18nRuntime(
  runtime?: I18nRuntime<string>
): RichTextI18nRuntime {
  return createScopedI18nRuntime<RichTextI18nKey>(
    runtime ?? defaultRichTextI18n,
    richTextI18nNamespace
  );
}

export function createDefaultRichTextI18nRuntime(): RichTextI18nRuntime {
  return createRichTextI18nRuntime();
}
