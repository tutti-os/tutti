# AGENTS.md

## App Overview

`services/tuttid/builtin-apps/trae-solo-bridge` owns the built-in Trae Solo Bridge workspace app package.

Product scope:

- expose a local web UI that sends workspace prompts to the standalone Trae Solo CN app
- support Trae Solo Work, Code, and Design modes
- keep Trae Solo control in the background; do not intentionally bring Trae Solo to the foreground
- keep this as a workspace app bridge, not a Tutti Agent Provider Adapter

## Validation

```bash
pnpm --filter @tutti-os/builtin-trae-solo-bridge test
pnpm --filter @tutti-os/builtin-trae-solo-bridge package:builtin
pnpm --filter @tutti-os/builtin-trae-solo-bridge package:builtin:check
pnpm generate:builtin-apps
cd services/tuttid && go test ./builtin-apps
```

## Runtime Notes

The package uses the managed Node runtime profile.

- `tutti-package/bootstrap.sh` launches `server.js` with `TUTTI_APP_NODE`.
- Runtime data belongs under `TUTTI_APP_DATA_DIR`.
- The package reads Trae Solo state from macOS application support paths and talks to Trae Solo through its CLI plus DevTools/CDP.
- CDP control should avoid `activate`; startup uses hidden/background launch where possible and hides the app after operations.

When adding user-visible browser copy, prefer introducing a real frontend/i18n layer instead of spreading more inline strings through `server.js`.
