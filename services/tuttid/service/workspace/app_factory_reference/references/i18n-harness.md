# I18n Harness

Use this reference when an app has localized manifest metadata, user-facing in-app copy, or an existing localization system being converted into a Tutti package.

## Goals

- Keep all user-facing in-app copy behind stable keys.
- Preserve a default locale and every requested or existing non-default locale.
- Make missing or extra locale keys easy to detect during future edits.
- Read the current locale from the optional Tutti browser context or browser locale APIs, never from launch URL query parameters.

## Package Pattern

Prefer package-local JSON dictionaries when creating new apps:

```text
package/
  locales/
    en/
      manifest.json
      app.json
    zh-CN/
      manifest.json
      app.json
  static/
    i18n.js
```

Use `locales/<locale>/manifest.json` only for manifest metadata referenced by `tutti.app.json` `localizationInfo`. Use `locales/<locale>/app.json` or an equivalent app-owned dictionary for browser UI copy.

For converted projects, keep the existing framework i18n layout if it already has reliable key parity checks. Otherwise normalize the adapted package to the JSON dictionary pattern above.

## Browser Harness

The app should have one small helper that:

1. Defines the supported locales and default locale.
2. Normalizes language tags such as `zh-CN`, `zh_Hans`, and `en-US`.
3. Reads locale from `window.tuttiExternal?.app?.getContext()`.
4. Subscribes to `window.tuttiExternal?.app?.subscribe()` for later locale changes.
5. Falls back to `document.documentElement.lang`, `navigator.languages`, and `navigator.language`.
6. Resolves copy through keyed dictionaries with default-locale fallback.
7. Exposes a small development/test function that checks every locale has the same flattened key set as the default locale.

Minimal helper shape:

```js
const defaultLocale = "en";
const supportedLocales = ["en", "zh-CN"];
const messages = {
  en: {
    "app.title": "Display name",
    "app.empty": "No items yet."
  },
  "zh-CN": {
    "app.title": "显示名称",
    "app.empty": "暂无项目。"
  }
};

function normalizeLocale(value) {
  const tag = String(value || "")
    .trim()
    .replace(/_/g, "-");
  if (!tag) return defaultLocale;
  const exact = supportedLocales.find(
    (locale) => locale.toLowerCase() === tag.toLowerCase()
  );
  if (exact) return exact;
  const language = tag.split("-")[0].toLowerCase();
  return (
    supportedLocales.find(
      (locale) => locale.split("-")[0].toLowerCase() === language
    ) || defaultLocale
  );
}

function t(key) {
  const locale = normalizeLocale(document.documentElement.lang);
  return messages[locale]?.[key] || messages[defaultLocale]?.[key] || key;
}

function assertI18nParity() {
  const baseKeys = Object.keys(messages[defaultLocale]).sort();
  for (const locale of supportedLocales) {
    const keys = Object.keys(messages[locale] || {}).sort();
    const missing = baseKeys.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !baseKeys.includes(key));
    if (missing.length || extra.length) {
      throw new Error(
        `${locale} i18n mismatch: missing=${missing.join(",")} extra=${extra.join(",")}`
      );
    }
  }
}
```

For JSON dictionaries, `scripts/validate_tutti_app_package.py` performs a static key-parity check for matching dictionary files under `locales/<locale>/`.

## AGENTS.md Guidance

Document the app's i18n harness in package `AGENTS.md`:

- Default locale and supported locales.
- Where manifest metadata translations live.
- Where in-app copy dictionaries live.
- How to add or rename a copy key.
- The command to run the package validator.

## Validation

Before finishing:

- All localized manifest files referenced by `localizationInfo` exist.
- All app-owned locale dictionaries have the same flattened key set as the default locale.
- No UI text that should be localized is introduced outside the dictionary/helper pattern.
- Locale is read from Tutti app context or browser locale APIs, not URL query params.
