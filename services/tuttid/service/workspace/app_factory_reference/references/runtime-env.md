# Runtime Environment

The runner starts `bootstrap.sh` with no arguments from `TUTTI_APP_RUNTIME_DIR`.

Use these environment variables:

- `TUTTI_APP_HOST`: host to bind, normally `127.0.0.1`.
- `TUTTI_APP_PORT`: port to bind.
- `TUTTI_APP_BASE_URL`: local base URL.
- `TUTTI_APP_ID`: current workspace app id from `tutti.app.json`.
- `TUTTI_APP_INSTALLATION_ID`: current `<workspace-id>:<app-id>` installation id.
- `TUTTI_APP_PACKAGE_DIR`: package files, read-only at runtime.
- `TUTTI_APP_RUNTIME_DIR`: scratch/runtime files.
- `TUTTI_APP_DATA_DIR`: durable app data.
- `TUTTI_APP_LOG_DIR`: app logs.
- `TUTTI_APP_TOOLCHAIN_ROOT`: shared daemon-owned toolchain cache for app-managed binaries that are safe to reuse across workspace app installations.
- `TUTTI_APP_NODE`: managed Node.js executable path for generated apps.
- `TUTTI_APP_NPM`: managed npm executable path for generated apps.
- `TUTTI_APP_PYTHON`: managed Python interpreter path for existing Python apps or explicitly Python-based requests.
- `TUTTI_API_BASE_URL`: base URL for server-side calls to the Tutti daemon API.
- `TUTTI_APP_SERVER_TOKEN`: bearer token for this app server's scoped Tutti API calls.
- `TUTTI_CLI`: explicit command path for invoking local Tutti CLI capabilities. This is the stable app-runtime entrypoint across development and packaged production.
- `TUTTI_WORKSPACE_ID`: current workspace id.
- `TUTTI_WORKSPACE_NAME`: current workspace display name.
- `TUTTI_WORKSPACE_ROOT`: workspace path, read-only unless the user explicitly asked the app to write workspace files.

`PATH` includes the managed runtime bin directories, but generated apps must still use the explicit `TUTTI_APP_NODE`, `TUTTI_APP_NPM`, and, when applicable, `TUTTI_APP_PYTHON` variables. Do not rely on system `node`, `npm`, `python`, or `python3` commands.

Read `TUTTI_APP_SERVER_TOKEN` only in the app server process. Never send it to browser code, persist it, or write it to logs. Use it with `TUTTI_API_BASE_URL`, `TUTTI_WORKSPACE_ID`, and `TUTTI_APP_ID` for workspace-app scoped daemon routes.

For local Tutti capabilities, use `TUTTI_CLI`.

Tutti keeps the managed runtime baseline outside app packages under daemon-owned state. Operators can override the cache with `TUTTI_APP_RUNTIME_CACHE_ROOT`, point at an exact prepared runtime with `TUTTI_APP_RUNTIME_ROOT`, or override first-use runtime downloads with `TUTTI_APP_RUNTIME_CATALOG`. App packages must not set these variables themselves.

tuttid may preload the managed runtime during daemon startup or an explicit runtime-preparation workflow, but listing App Center apps does not preload runtimes as a side effect. If the runtime is still missing when an installed app starts, Tutti reports the app as `preparing` while it resolves or downloads the runtime, then moves to `starting` only when `bootstrap.sh` is about to launch.

Default newly generated apps to a small Node server, using Node built-ins when they are enough. Use Python only when adapting an existing Python project or when the user explicitly requests Python. Agent-enabled apps must use a Node server because `@tutti-os/agent-acp-kit` is Node-only. Avoid startup-time dependency installation. If build or install steps are necessary, put them in executable `prepare.sh`, not `bootstrap.sh`. `prepare.sh` may use the managed runtime variables for dependency installation and build commands. `bootstrap.sh` should only launch the already prepared app server.

## Browser External Context

Workspace apps should not encode locale or theme in their launch URL query.

When an app needs localized in-app copy, read the current locale from the optional host-injected browser context. Locale should fall back to `document.documentElement.lang`, `navigator.languages`, and `navigator.language`:

```js
async function readHostLocale() {
  const getContext = window.tuttiExternal?.app?.getContext;
  if (typeof getContext !== "function") return null;
  try {
    const context = await getContext();
    return context?.locale || context?.language || null;
  } catch {
    return null;
  }
}

function subscribeHostLocale(listener) {
  const subscribe = window.tuttiExternal?.app?.subscribe;
  if (typeof subscribe !== "function") return () => {};
  return subscribe((context) => {
    listener(context?.locale || context?.language || null);
  });
}
```

`subscribe` replays the latest context after registration, so apps do not need host-injected DOM events for initial locale delivery. Provider lists, default provider, and agent composer options are not part of browser external context. Agent-enabled apps should expose an app-owned backend endpoint backed by Tutti workspace-app scoped daemon APIs. Follow `$tutti-agent-workspace-app` and its `references/dynamic-agent-providers.md`; use `@tutti-os/agent-acp-kit` for runtime execution and standalone detection. Use `TUTTI_CLI` only for non-agent Tutti platform or app-to-app capabilities. The context is optional so generated apps continue to run in a normal browser during development.

For theme, use CSS media queries and `matchMedia`:

```css
:root {
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
  }
}
```

```js
const isDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
```

Do not read `theme`, `themeSource`, `locale`, or `lang` from URL search params for host settings.

## Browser File Uploads

Browser apps can ask the host to persist a `File` or `Blob` into the app's
durable data area:

```js
const abortController = new AbortController();
const uploaded = await window.tuttiExternal?.files?.upload?.(file, {
  purpose: "app-asset",
  name: file.name,
  mimeType: file.type || "application/octet-stream",
  onProgress(progress) {
    console.log(progress.loadedBytes, progress.totalBytes, progress.ratio);
  },
  signal: abortController.signal
});
```

The result contains `{ path, name, mimeType, sizeBytes, sha256 }`. The returned
path is a host-managed file under the installed app's durable data directory.
`onProgress` reports browser-to-host transfer progress. Aborting `signal` cancels
the in-flight upload session and temporary bytes when possible. `files.upload()`
only uploads bytes and returns file metadata; it does not create app-specific
asset records. Apps that manage media libraries should store their own asset
rows/documents after upload using the returned metadata.

## Browser Frontend Diagnostics

When a workspace app runs inside Tutti Desktop, prefer writing browser-side diagnostics through the optional host bridge instead of posting to an app-owned `/api/log` route:

```js
window.tuttiExternal?.logs?.write?.({
  event: "page.loaded",
  level: "info",
  details: { route: location.pathname }
});
```

`logs.write()` is fire-and-forget. Invalid payloads and write failures are ignored in the app. Use optional chaining so the same frontend keeps working when opened directly in a normal browser.

Tutti Desktop appends these entries to the workspace app log directory as `web.log`, alongside `runtime.log`. Reserve `$TUTTI_APP_LOG_DIR` for backend/server-side logs written by the app process itself.
