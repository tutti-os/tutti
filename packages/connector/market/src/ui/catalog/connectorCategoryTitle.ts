import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";

export function resolveConnectorCategoryTitle(input: {
  sectionId: string;
  displayNameZh?: string;
  displayNameEn?: string;
  locale: string;
  i18n: ConnectorMarketI18nRuntime;
}): string {
  if (input.sectionId === "installed") {
    return input.i18n.t("categoryInstalled");
  }
  const chinese = input.locale.trim().toLowerCase().startsWith("zh");
  const preferred = chinese ? input.displayNameZh : input.displayNameEn;
  const secondary = chinese ? input.displayNameEn : input.displayNameZh;
  if (preferred?.trim()) {
    return preferred;
  }
  if (secondary?.trim()) {
    return secondary;
  }
  // Compatibility for daemon/server versions released before category names.
  switch (input.sectionId) {
    case "featured":
      return input.i18n.t("categoryFeatured");
    case "productivity":
      return input.i18n.t("categoryProductivity");
    case "development":
      return input.i18n.t("categoryDevelopment");
    case "other":
      return input.i18n.t("categoryOther");
    default:
      return input.i18n.t("categoryUnnamed");
  }
}
