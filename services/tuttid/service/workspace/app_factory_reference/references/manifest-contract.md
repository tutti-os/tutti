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
    "listEndpoint": "/tutti/references/list",
    "searchEndpoint": "/tutti/references/search"
  },
  "window": {
    "minimizeBehavior": "keep-mounted",
    "minWidth": 720,
    "minHeight": 520
  },
  "authors": [
    {
      "name": "Tutti",
      "url": "https://github.com/tutti-os",
      "avatarUrl": "https://github.com/tutti-os.png"
    }
  ],
  "source": {
    "type": "github",
    "url": "https://github.com/tutti-os/example-app"
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
- `runtime.profile` is optional. Use `"node-static"` only for apps whose bootstrap launches a Node/static server and does not need Python. Use `"standalone"` only for apps whose package includes its own executable server and does not need the managed Python or Node runtime. Omit it for the default baseline runtime.
- `cli` is optional. Include it only when the app exposes commands through the Tutti CLI.
- `cli.manifest` must be a relative package path to a `tutti.app.cli.v1` manifest, usually `tutti.cli.json`.
- `references` is optional. Include it only when the app exposes browsable file references.
- `references.listEndpoint` must be a relative URL path that starts with `/` and has no scheme, host, query, hash, or percent-encoded characters.
- `references.searchEndpoint` is optional and declares that the app provides recursive search over its references. Include it when references should be searchable; omit it when the app can only list and per-level filter them.
- When `references.searchEndpoint` is present, Tutti marks the app as searchable and shows the picker search box for it. The endpoint must satisfy the same URL constraints as `listEndpoint`. Without it, the picker offers only the per-level `filterText` filtering of `listEndpoint`, never a global search.
- v1 references may only return groups and file references. File references must use `kind: "file"` and a `location` object. Tutti resolves the location to a filesystem path; apps must not emit host absolute paths.
- `location.type` must be `app-data-relative` for files under the app data directory or `app-package-relative` for files under the immutable app package directory.
- `location.path` must be a non-empty relative path using `/` separators. It must not contain a scheme, drive prefix, leading slash, NUL, or any `..` segment.
- `window` is optional. Omit it unless the app explicitly needs non-default window behavior or minimum dimensions.
- `window.minimizeBehavior` may be `keep-mounted` or `hibernate`; omitted defaults to `keep-mounted`.
- `window.minWidth` and `window.minHeight` are optional integer minimum dimensions for the app webview window.
- `window.minWidth` must be between `280` and `1600`; `window.minHeight` must be between `160` and `1200`.
- `authors` is optional but preferred for App Center source display. Use a flat list of people or teams; do not add maintainer/contributor role labels. Each author requires `name`; `url` and `avatarUrl` are optional non-empty strings.
- `author` is a legacy single-author fallback. Do not set both `author` and `authors` in new manifests.
- `source` is optional. Include it for GitHub-hosted apps as `{ "type": "github", "url": "https://github.com/org/repo" }`.
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

## Reference Search Runtime Protocol

When `references.searchEndpoint` is present, the app server must implement a JSON `POST` endpoint at that path. Unlike `filterText` on the list endpoint, search is **recursive across the app's entire reference tree** and is not scoped to a single group.

Request:

```json
{
  "query": "quarterly report",
  "limit": 20,
  "cursor": "opaque-next-page-token",
  "kinds": ["file"],
  "filters": ["image", "document"],
  "timeRange": {
    "fromMs": 1710000000000,
    "toMs": 1710259200000
  }
}
```

- `query` is already trimmed by Tutti. It may be **empty when `filters` is non-empty** ("filter-only" search): in that case return all references matching the filters, ordered by recency. When `query` is non-empty, match it recursively against each file reference's **own name** (the `displayName` you return for that file) across all groups and nested references; never restrict it to the root or a single `parentGroupId`. Match the file name **only** — do not match a reference solely because its `location.path`, containing folder/project, or `parentGroupLabel` contains the query, otherwise typing `2` would surface `cover.svg` just because it lives in a project named `2222`. (You may still use path/group text to break ties in ranking, but a file whose name does not contain the query must not appear.)
- There is no `parentGroupId`: search always spans the whole app.
- `limit` is clamped by Tutti to `1..50`.
- `cursor` is optional and opaque to Tutti.
- v1 only sends `kinds: ["file"]`.
- `filters` is an optional array of **global file-type category ids** (`image`, `video`, `document`, `webpage`, `other`). When present, return only file references whose name/type falls into one of the listed categories (OR semantics). Map each id to its file extensions: `image` = png/jpg/jpeg/gif/webp/svg/bmp/ico/heic; `video` = mp4/mov/avi/mkv/webm; `document` = pdf/doc/docx/txt/md/markdown/rtf/odt/pages/key/ppt/pptx **plus spreadsheets** xls/xlsx/csv/tsv/numbers; `webpage` = html/htm/mhtml/url/webloc; `other` = anything else (audio, code, archives, no-extension files). Ignore unknown ids. Filtering and search are a single capability — `query` and `filters` combine, and either alone is a valid query.
- `timeRange` is optional with the same inclusive `mtimeMs` semantics as the list protocol.

Response:

```json
{
  "items": [
    {
      "type": "reference",
      "reference": {
        "kind": "file",
        "displayName": "Q4-Report.md",
        "description": "Optional short context",
        "location": {
          "type": "app-data-relative",
          "path": "reports/Q4-Report.md"
        },
        "sizeBytes": 1234,
        "mtimeMs": 1710000000000,
        "mimeType": "text/markdown",
        "score": 0.92,
        "parentGroupLabel": "Q4 Planning"
      }
    }
  ],
  "nextCursor": null
}
```

- `items` is required and must contain only reference items. Do not return `group` items from search; results are a flat ranked list of insertable file references.
- Return results ordered by descending relevance and set `score` (`0..1`) so Tutti can preserve your ranking. When `score` is omitted Tutti keeps the returned order.
- Each reference item must include a valid file reference with a `location`; the same `location` rules and host-path prohibition as the list protocol apply.
- `nextCursor` is optional; omit it or return `null` when there is no next page.
- Return an empty `items` array (not an error) when nothing matches.
- `parentGroupLabel` is optional (string, max 160 chars). Because search is flattened across the whole app, set it to the name of the group/project the file lives in (e.g. the project a design belongs to) so users can tell results apart. Tutti shows each item's `displayName` as the title and `parentGroupLabel` as the context subtitle. When you omit it, Tutti falls back to your app's manifest display name as the subtitle, so still keep the manifest display name and each `displayName` meaningful.
