# Workspace Domain

This document defines the current `workspace` domain boundaries inside `services/tuttid`.

## Purpose

The `workspace` domain owns the daemon's workspace catalog.

The current workspace record includes:

- `id`
- `name`
- `lastOpenedAt`

The domain supports catalog CRUD plus "open workspace" semantics through `tuttid` HTTP APIs and persists data in the local SQLite database.

A workspace record is not a persisted binding to one host-local directory. Local
workspace file access is resolved at runtime by workspace-scoped capabilities
and should use the resolved host absolute root instead of the legacy
`/workspace` alias.

## Current Code Layout

```text
services/tuttid/
  api/workspace/
    files.go
    service.go
    types.go
  biz/workspace/
    model.go
  data/workspace/
    local_files.go
    store.go
    sqlite_store.go
    migrations.go
  service/workspace/
    files.go
    service.go
```

## Layer Responsibilities

### `api/workspace`

Owns workspace transport support for the generated daemon HTTP adapter:

- `CatalogService` interface consumed by `api/DaemonAPI`
- mapping from domain models to generated OpenAPI response models
- mapping between generated workspace file DTOs and shared
  `packages/workspace/files` domain values

Request and response DTOs are generated from `services/tuttid/api/openapi/tuttid.v1.yaml`.
Do not reintroduce hand-maintained workspace HTTP DTOs or a parallel workspace HTTP handler.

`api/workspace` should not contain SQL or local file access.

### `biz/workspace`

Owns the smallest shared domain model that both `service/` and `data/` need:

- `Summary`

Keep this layer small and domain-local. Do not move HTTP DTOs here.

### `service/workspace`

Owns use-case orchestration:

- validate required business inputs
- generate workspace IDs for create
- update recent-open metadata when a workspace is opened
- resolve workspace-scoped capabilities without binding the catalog record to a
  stored host path
- compose the shared `packages/workspace/files` domain service with
  daemon-owned adapters
- accept transport-agnostic inputs
- return domain results for transport mapping
- call the configured store

Exception:

- `WorkbenchSnapshot*` is a shared repository-owned contract synchronized from
  `packages/workbench/snapshot`
- `service/workspace` may consume the shared `packages/workbench/service`
  package, including the synchronized Go snapshot contract it owns, when that
  avoids a parallel hand-maintained mirror type
- this exception does not move HTTP decoding, status-code mapping, or
  route-specific validation ownership out of `api/workspace`

`service/workspace` should not write HTTP responses, shape HTTP DTOs, or perform direct SQL.

### `data/workspace`

Owns concrete persistence for the `workspace` domain.

Current responsibilities:

- define the `CatalogStore` interface
- expose `ErrWorkspaceNotFound`
- open the SQLite store
- run schema migration
- implement CRUD and open semantics against the `workspaces` table
- implement the daemon-owned local workspace file adapter that maps paths under
  the runtime-resolved host root; the current local-host implementation resolves
  that root from the user's home directory instead of a persisted workspace
  field

`data/workspace` must not depend on `api/workspace`.

## HTTP Surface

OpenAPI is the single source of truth for exact request and response shapes, as described in [API Contracts](./api-contracts.md):

```text
services/tuttid/api/openapi/tuttid.v1.yaml
```

This section records the workspace domain semantics behind the current generated HTTP surface, not a parallel schema.

Current workspace route semantics:

| Route                                    | Domain meaning                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/workspaces`                     | Lists the workspace catalog.                                                                                                                                                  |
| `POST /v1/workspaces`                    | Creates a workspace record.                                                                                                                                                   |
| `GET /v1/workspaces/startup`             | Resolves the daemon-side startup workspace, including fallback selection and first-run default creation, so desktop does not infer restore policy from the full catalog list. |
| `GET /v1/workspaces/{workspaceID}`       | Reads one registered workspace by id.                                                                                                                                         |
| `POST /v1/workspaces/{workspaceID}/open` | Marks the workspace as recently opened and is used by desktop startup and dashboard launch flows.                                                                             |
| `PATCH /v1/workspaces/{workspaceID}`     | Updates mutable workspace catalog fields.                                                                                                                                     |
| `DELETE /v1/workspaces/{workspaceID}`    | Removes the workspace from the catalog.                                                                                                                                       |

Workspace file route semantics:

| Route                                              | Domain meaning                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /v1/workspaces/{workspaceID}/files/directory` | Lists direct children for one logical workspace directory.                     |
| `GET /v1/workspaces/{workspaceID}/files/search`    | Searches workspace files by logical path using shared filename-first scoring.  |
| `PUT /v1/workspaces/{workspaceID}/files/file`      | Creates one empty file under the current runtime-resolved host root.           |
| `PUT /v1/workspaces/{workspaceID}/files/directory` | Creates one directory under the current runtime-resolved host root.            |
| `DELETE /v1/workspaces/{workspaceID}/files/entry`  | Deletes one file or directory; deleting the runtime-resolved root is rejected. |

Workspace file responses use paths under the runtime-resolved host root, such as
`/Users/example/project/src/main.ts`, rather than the legacy `/workspace/...`
alias.

Workspace file routes operate on logical paths only. They must not imply that a
workspace catalog record persists a bound host directory. In the current
`tuttid` local-host implementation, the logical root is the user's home
directory at runtime.

## Workspace File Search Ranking Rules

Workspace file search is a product-facing relevance surface, not just a raw
filesystem scan. When changing `GET /v1/workspaces/{workspaceID}/files/search`
or the shared scoring logic in `packages/workspace/files`, keep these rules:

- backend search owns primary relevance; the daemon should return the right
  candidates in the right order before any renderer-specific presentation work
- renderer search UI may still apply lightweight grouping or stale-result
  suppression, but it must not become the primary place where workspace-file
  relevance is fixed
- filename-first relevance is the default behavior; a query that does not
  express path intent should strongly prefer basename matches over deep-path
  fallback matches
- path-aware relevance should activate when the query expresses path intent,
  especially when it includes `/`; in that mode, score by path-segment order
  and segment-prefix quality rather than treating the entire path as one loose
  string
- direct visible-label matches should outrank hidden-term or fallback-only
  matches; do not let a candidate rank highly just because the query can be
  stretched across an unrelated deep path
- prefix and tight-span matches should receive a strong bonus; contiguous or
  near-contiguous matches near the start of a basename or path segment should
  beat scattered subsequence matches
- deeper paths, hidden paths, and known noise directories should carry a clear
  penalty unless the query explicitly targets them
- daemon-owned workspace file browse and search endpoints should own hidden-item
  filtering behind one shared `includeHidden` switch; default behavior should
  exclude dot-prefixed files and directories, platform-hidden/system/temporary
  entries, Office `~$` lock files, and `.crdownload` partial downloads;
  renderer packages should not re-implement that filtering in parallel
- direct file-manager reveal or navigation requests whose target directory path
  already contains a dot-prefixed segment may set `includeHidden` for that
  request only; do not persist this as a global "show hidden files" mode
- search behavior should preserve enough metadata for the caller to explain the
  result, such as whether the primary hit came from basename or path matching
  and, when practical, the matched character positions for highlighting

Current inspiration:

- small candidate sets should follow Codex-style local fuzzy ranking: prefer
  visible-name hits first, then fallback terms, while rewarding prefix and
  tight-span matches
- file-path search should follow a dedicated path-search model rather than
  forcing one generic loose-string matcher to handle both basename and
  hierarchical path intent

Review questions for workspace-file search changes:

1. Does the change improve backend relevance directly, or is it trying to hide a
   backend ranking problem in renderer-only code?
2. For queries without `/`, do obvious basename matches still beat deep-path
   incidental matches?
3. For queries with `/`, does the scorer respect segment boundaries and segment
   order instead of rewarding arbitrary scattered path subsequences?
4. Can the UI still explain why the top result won, either from score shape,
   match target, or highlight metadata?

## Error Semantics

Current rules:

- empty `name` returns `400`
- empty `workspaceID` returns `400`
- missing workspace returns `404`
- missing workspace file entries return `404`
- invalid workspace file paths, root deletion, path escape attempts, and invalid
  entry kinds return `400`
- unexpected store failures return `502`

Workspace API handlers should classify domain and adapter failures through
`services/tuttid/apierrors` before writing HTTP responses. For this domain:

- stable client behavior should depend on protocol `code` plus optional `reason`
- interpolation context should flow through structured `params` when needed
- `developerMessage` is diagnostic support and must not become renderer-owned UI copy
- domain-specific sentinel errors still originate from `data/workspace` and
  shared workspace-file packages, but transport mapping belongs at the API seam

The not-found sentinel for this domain is `data/workspace.ErrWorkspaceNotFound`.
The shared workspace file domain owns file-specific sentinels such as
`workspacefiles.ErrEntryNotFound`, `workspacefiles.ErrPathEscapesRoot`, and
`workspacefiles.ErrRootDeleteForbidden`.

## Local Storage

The `workspace` domain currently persists to the daemon-local SQLite database:

- default path: `<state-dir>/tuttid.db`
- state root rules are defined in [Local State Storage](./local-state-storage.md)

Current schema in `data/workspace/migrations.go`:

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_opened_at_unix_ms INTEGER
);
```

Current query behavior:

- list order is `last_opened_at_unix_ms DESC, updated_at_unix_ms DESC, id ASC`
- create sets both `created_at_unix_ms` and `updated_at_unix_ms`
- update refreshes `updated_at_unix_ms`
- open refreshes both `updated_at_unix_ms` and `last_opened_at_unix_ms`

## Review Rules

When reviewing `workspace` changes, ask:

1. Does the new type belong to `api/workspace`, `biz/workspace`, `service/workspace`, or `data/workspace`?
2. Is a transport DTO being pushed into global `types/` instead of staying under `api/workspace`?
3. Is `data/workspace` depending on `api/workspace` by accident?
4. Is a persistence concern leaking into `service/` or `api/`?
5. Is the new field or behavior reflected in the HTTP contract, recent-open semantics, and SQLite schema where needed?
