# Validation Checklist

Before finishing:

- Run `scripts/validate_tutti_app_package.py <package-root>` from this skill when filesystem access is available.
- `tutti.app.json` is valid JSON and matches the manifest contract.
- If `tutti.app.json` declares `cli.manifest`, the referenced CLI manifest exists and matches the CLI manifest contract.
- The manifest icon `src` points to an existing package-local asset.
- If `localizationInfo` is present, every `additionalLocales[].file` points to an existing package-local JSON file with localized manifest metadata.
- If the app has localized in-app copy, app-owned locale dictionaries use stable keys and each locale has the same flattened key set as the default locale.
- The package `AGENTS.md` explains how future maintainers add or rename localized copy keys.
- `bootstrap.sh` is executable.
- `bootstrap.sh` starts a server with no arguments.
- `bootstrap.sh` launches the prepared app and does not install dependencies.
- `bootstrap.sh` and `prepare.sh`, when present, use `TUTTI_APP_PYTHON`, `TUTTI_APP_NODE`, or `TUTTI_APP_NPM` instead of bare system `python`, `python3`, `node`, or `npm` commands.
- The server binds `127.0.0.1:$TUTTI_APP_PORT` or `$TUTTI_APP_HOST:$TUTTI_APP_PORT`.
- The healthcheck endpoint returns a 2xx response.
- If `tutti.app.json` declares `references.listEndpoint`, that endpoint accepts JSON `POST` requests with optional `parentGroupId`, `filterText`, `cursor`, `timeRange`, and returns direct group/reference items using `location`, not host absolute `path`.
- Durable app data is written only under `TUTTI_APP_DATA_DIR`.
- Runtime scratch data is written only under `TUTTI_APP_RUNTIME_DIR`.
- Logs are written only under `TUTTI_APP_LOG_DIR`.
- In-app localization reads optional app context or browser locale APIs, not launch URL query params.
- Theme rendering uses `prefers-color-scheme`, not launch URL query params.
- `AGENTS.md` describes package layout, runtime command, endpoints, data storage, and modification guidance.
- The package root contains generated app files only; reference files stay outside the package root.
- Demo ids, demo names, and demo descriptions were not copied into a new app unless the user explicitly requested the demo.
