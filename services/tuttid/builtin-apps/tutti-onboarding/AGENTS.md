# AGENTS.md

## App Overview

`services/tuttid/builtin-apps/tutti-onboarding` owns the Tutti built-in Getting
Started onboarding app UI and its packaged media assets.

Product scope:

- keep the UI, copy, and interactions aligned with the desktop onboarding
  experience
- serve compressed onboarding screenshots and video as inspectable media
- preserve the host bridge behavior for agent binding, app center, task panel,
  and agent chat actions

## Validation

```bash
pnpm --filter @tutti-os/builtin-tutti-onboarding typecheck
pnpm --filter @tutti-os/builtin-tutti-onboarding test
pnpm --filter @tutti-os/builtin-tutti-onboarding build
pnpm generate:builtin-apps
```

## Runtime Notes

This app is a static Vite app. The package runtime builds
`tutti-package/server.go` into small standalone binaries that serve built
assets and `/healthz` without the managed Node runtime.

The UI entrypoint is React:

- `src/App.jsx` owns the page structure and interactions.
- `src/i18n/app-context.js` reads locale from `window.tuttiExternal.app`.
- `src/i18n/locales/en-US/onboarding.json` and
  `src/i18n/locales/zh-CN/onboarding.json` own all user-facing copy.
- `src/styles.css`, `components.json`, `src/lib/utils.js`, and
  `src/components/ui/` provide Tailwind CSS v4 + shadcn/ui foundation.
  Keep the current 1:1 onboarding page on `public/styles.css`; use shadcn for
  new UI surfaces unless the built-in onboarding source changes.

When adding or renaming a copy key, update both locale JSON files and run
`pnpm --filter @tutti-os/builtin-tutti-onboarding test`. Query params `?locale=` and
`?lang=` are supported only for local web debugging.
