import { en } from "../../shared/i18n/locales/en.ts";
import { zhCN } from "../../shared/i18n/locales/zh-CN.ts";

export function resolveWorkspaceWindowUnknownErrorMessage(input: {
  documentLanguage: string;
  search: string;
}): string {
  const locale =
    normalizeLocale(input.documentLanguage) ??
    normalizeLocale(new URLSearchParams(input.search).get("lang"));
  return locale?.startsWith("zh")
    ? zhCN.common.unknownError
    : en.common.unknownError;
}

function normalizeLocale(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}
