# Getting Started Onboarding Package

This package is the installed Tutti runtime for the Getting Started onboarding
app.

- `tutti.app.json` declares `bootstrap.sh` as the single runtime entrypoint.
  Tutti invokes it through the host shell adapter, and the script selects the
  matching binary from the fat package by `TUTTI_PLATFORM`.
- `server.go` is built into `bin/<platform>/tutti-onboarding-server[.exe]`
  during packaging. One fat package carries all declared platform binaries.
  The selected binary serves packaged static assets, exposes `/healthz`,
  and handles `POST /tutti/cli/read` for the `onboarding read` CLI command without
  requiring `$TUTTI_APP_NODE`.
- `tutti.cli.json` exposes `onboarding read`, which returns the bundled
  `tutti-guide.md` as JSON for agents and other apps.
- The app is read-only and stores no durable data. If storage is introduced
  later, write only under `$TUTTI_APP_DATA_DIR`.
- In-app copy is bundled from the authoring app's React i18n dictionaries:
  `src/i18n/locales/en-US/onboarding.json` and
  `src/i18n/locales/zh-CN/onboarding.json`.
- Manifest metadata localization lives in `locales/zh-CN/manifest.json`.
- Locale is read from `window.tuttiExternal.app.getContext()` /
  `subscribe()` with browser locale fallback. Query params are for local web
  debugging only.

Treat `TUTTI_APP_PACKAGE_DIR` as read-only after startup.
