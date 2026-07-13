# I18n And Web Debugging

Use this reference for UI copy, language behavior, and web-first validation.

## I18n Rules

For larger React apps, prefer `i18next`, `react-i18next`, and `i18next-cli`.

- All user-visible web copy should use `t(...)`, `i18n.t(...)`, or a translated data source.
- Update every supported locale when adding or changing a key.
- Keep interpolation inside i18n resources.
- Allowlist only product names, provider/model labels, technical identifiers, file extensions, keyboard shortcuts, route names, and user-generated content.
- Do not introduce locale-prefixed routes or server-cookie rendering dependencies unless the app already uses them.
- App-local language switching must not mutate the host application's global language.

For app package manifest metadata, use `tutti.app.json` `localizationInfo` and package-local `locales/<locale>/manifest.json` files per `$tutti-workspace-app-factory`.

For smaller generated apps, use the factory skill's `references/i18n-harness.md`. For larger repos, add an app-level check similar to:

```bash
pnpm check:i18n
```

The check should verify:

- each locale has the same flattened key set
- every `t("key")` reference exists in every locale
- TSX/JSX visible copy is translated or allowlisted
- extracted keys do not leave unstaged translation drift in CI

## Locale Source

Locale may come from the app's own route or language switcher. When no app-local locale is set, read optional Tutti host app context and then fall back to browser locale APIs.

Do not read host locale from launch URL query parameters.

## Web-First Debugging

Prioritize web scenarios:

1. Run the local dev app.
2. Open the web UI and exercise the workflow there first.
3. Keep browser-visible state aligned with `packages/shared` contracts.
4. Add Playwright tests only for user flows that cross web/server boundaries.
5. Use server smoke tests for storage, runtime providers, local agents, CLI routes, and package generation.

Useful checks:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm check:i18n
pnpm package:tutti
```

When local agents are involved:

1. Load the provider catalog through `@tutti-os/agent-acp-kit/tutti`; it automatically uses Tutti CLI or standalone detection.
2. Verify the web settings/runtime panel or equivalent status UI.
3. Run isolated smoke tests for one available catalog provider turn.
4. Inspect run events, tool calls, generated files, and package-local data writes.
