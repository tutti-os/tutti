# Getting Started Onboarding Package

This package is the installed Tutti runtime for the Getting Started onboarding
app.

- `bootstrap.sh` is the runtime entrypoint called by Tutti. It prefers
  `$TUTTI_APP_PACKAGE_DIR`, `$TUTTI_APP_HOST`, `$TUTTI_APP_PORT`,
  `$TUTTI_APP_RUNTIME_DIR`, and `$TUTTI_APP_DATA_DIR`.
- `server.go` is built into `bin/<platform>/tutti-onboarding-server` during
  packaging. The binary serves packaged static assets, exposes `/healthz`,
  and handles `POST /tutti/cli/read` for the `guide read` CLI command without
  requiring `$TUTTI_APP_NODE`.
- `tutti.cli.json` exposes `guide read`, which returns the bundled
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
