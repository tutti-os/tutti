# Tutti App Manifest Contract

Create `tutti.app.json` in the package root with this shape:

```json
{
  "schemaVersion": "tutti.app.manifest.v1",
  "appId": "APP_ID_FROM_PROMPT",
  "version": "0.1.0",
  "name": "Display Name",
  "description": "Short user-facing description.",
  "icon": {
    "type": "asset",
    "src": "icon.svg"
  },
  "runtime": {
    "bootstrap": "bootstrap.sh",
    "healthcheckPath": "/healthz"
  },
  "cli": {
    "manifest": "tutti.cli.json"
  },
  "references": {
    "listEndpoint": "/tutti/references/list"
  },
  "window": {
    "minimizeBehavior": "keep-mounted",
    "minWidth": 720,
    "minHeight": 520
  },
  "author": {
    "name": "Tutti"
  },
  "tags": ["generated"]
}
```

Rules:

- Use the exact `appId`, version, name, and description from the prompt unless the user explicitly asked otherwise.
- If a prompt omits metadata, choose conservative values that describe the app's actual behavior.
- Use a package-local icon asset and make sure the referenced file exists.
- Do not include `runtime.kind`; Tutti manages the runtime baseline outside the app package.
- `runtime.bootstrap` must be a relative package path.
- `runtime.healthcheckPath` must start with `/`.
- `cli` is optional. Include it only when the app exposes commands through the Tutti CLI.
- `cli.manifest` must be a relative package path to a `tutti.app.cli.v1` manifest, usually `tutti.cli.json`.
- `references` is optional. Include it only when the app exposes browsable file references.
- `references.listEndpoint` must be a relative URL path that starts with `/` and has no scheme, host, query, hash, or percent-encoded characters.
- v1 references may only return groups and file references. File references must use `kind: "file"` and a `location` object. Tutti resolves the location to a filesystem path; apps must not emit host absolute paths.
- `location.type` must be `app-data-relative` for files under the app data directory or `app-package-relative` for files under the immutable app package directory.
- `location.path` must be a non-empty relative path using `/` separators. It must not contain a scheme, drive prefix, leading slash, NUL, or any `..` segment.
- `window` is optional. Omit it unless the app explicitly needs non-default window behavior or minimum dimensions.
- `window.minimizeBehavior` may be `keep-mounted` or `hibernate`; omitted defaults to `keep-mounted`.
- `window.minWidth` and `window.minHeight` are optional integer minimum dimensions for the app webview window.
- `window.minWidth` must be between `280` and `1600`; `window.minHeight` must be between `160` and `1200`.
- `localizationInfo` is optional. Omit it when the app only needs the default manifest language.
- When the user asks for localized app metadata, keep `name`, `description`, and `tags` as the default language, then add `localizationInfo.defaultLocale` and one `additionalLocales` entry for each non-default locale.
- Each `localizationInfo.additionalLocales[].file` must be a relative package path.
- Example `localizationInfo`:

```json
{
  "defaultLocale": "en",
  "additionalLocales": [
    {
      "locale": "zh-CN",
      "file": "locales/zh-CN/manifest.json"
    }
  ]
}
```

- Each locale file must be JSON with optional localized `name`, `description`, and `tags`, for example:

```json
{
  "name": "显示名称",
  "description": "面向用户的简短描述。",
  "tags": ["标签"]
}
```

- Do not use demo app ids.

## Reference List Runtime Protocol

When `references.listEndpoint` is present, the app server must implement a JSON `POST` endpoint at that path.

Request:

```json
{
  "parentGroupId": "opaque-group-id",
  "filterText": "report",
  "limit": 20,
  "cursor": "opaque-next-page-token",
  "kinds": ["file"],
  "timeRange": {
    "fromMs": 1710000000000,
    "toMs": 1710259200000
  }
}
```

- `parentGroupId` is optional. Omit it or return `null` to list the root level.
- `filterText` is optional and already trimmed by Tutti. It filters only direct children of `parentGroupId`; it is not a recursive search.
- `limit` is clamped by Tutti to `1..50`.
- `cursor` is optional and opaque to Tutti.
- v1 only sends `kinds: ["file"]`.
- `timeRange` is optional. `fromMs` and `toMs` are inclusive Unix epoch millisecond bounds. File reference lists should apply the range to `mtimeMs` when available.

Response:

```json
{
  "items": [
    {
      "type": "group",
      "id": "reports",
      "displayName": "Reports",
      "description": "Monthly reports",
      "referenceCount": 12
    },
    {
      "type": "reference",
      "reference": {
        "kind": "file",
        "displayName": "Report.md",
        "description": "Optional short context",
        "location": {
          "type": "app-data-relative",
          "path": "reports/Report.md"
        },
        "sizeBytes": 1234,
        "mtimeMs": 1710000000000,
        "mimeType": "text/markdown",
        "score": 0.8
      }
    }
  ],
  "nextCursor": null
}
```

- `items` is required and must be an array of direct children.
- Group items are navigational only. Group `id` values are opaque and may represent nested groups.
- `referenceCount` is required for groups, must be exact under `kinds` and `timeRange`, and is not affected by `filterText`.
- Reference items are insertable artifacts and must include a valid file reference in `reference`.
- `nextCursor` is optional; omit it or return `null` when there is no next page.
- File `displayName`, `description`, `sizeBytes`, `mtimeMs`, `mimeType`, and `score` are optional. `score` must be between `0` and `1` when present.
- Apps must return `location`, not an absolute `path`. Tutti resolves valid locations to absolute paths before exposing results to desktop clients.
