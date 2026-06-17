import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createRichTextI18nRuntime,
  richTextI18nResources
} from "./richTextI18n.ts";
import { resolveRichTextTriggerText } from "../editor/richTextTriggerText.ts";

test("rich text i18n runtime resolves package-local defaults", () => {
  const i18n = createRichTextI18nRuntime();

  assert.equal(i18n.t("richTextAt.loading"), "Loading...");
  assert.equal(i18n.t("richTextAt.noMatches"), "No matches");
  assert.equal(
    i18n.t("richTextAt.removeReferenceActionLabel"),
    "Remove reference"
  );
});

test("rich text i18n runtime follows merged host locale resources", () => {
  const runtime = createI18nRuntime({
    dictionaries: [richTextI18nResources["zh-CN"]]
  });
  const i18n = createRichTextI18nRuntime(runtime);

  assert.equal(i18n.t("richTextAt.loading"), "正在加载...");
  assert.equal(i18n.t("richTextAt.noMatches"), "没有匹配项");
});

test("resolveRichTextTriggerText prefers overrides over i18n defaults", () => {
  const runtime = createI18nRuntime({
    dictionaries: [richTextI18nResources["zh-CN"]]
  });
  const i18n = createRichTextI18nRuntime(runtime);

  assert.deepEqual(
    resolveRichTextTriggerText(
      {
        noMatchesLabel: "Nothing here"
      },
      undefined,
      i18n
    ),
    {
      loadingLabel: "正在加载...",
      noMatchesLabel: "Nothing here",
      removeReferenceActionLabel: "移除引用"
    }
  );
});
