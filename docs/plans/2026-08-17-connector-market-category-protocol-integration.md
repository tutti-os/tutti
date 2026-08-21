# Connector Market Dynamic Category Protocol Integration

> Status: implemented; under review in PR #2441. Scope: the Tutti Connector
> Market consumer path. The `tsh-server` protocol and runtime are already on main
> and are not changed by this plan.
>
> Baselines: `tutti` `origin/main` at `33c5182ad`; provider artifacts pinned to
> `tsh-server` commit `d257868a661af964835b3ac2263252128f731b25`.

## Decision

Tutti treats the Market service as the source of truth for category identity,
kind, order, count, and localized names. The daemon projects those accepted
facts through its local OpenAPI boundary, and the renderer selects the name for
the active locale. The client never derives a title from `categoryId`.

The remote boundary uses provider-generated protobuf and HTTP artifacts instead
of extending hand-written Market DTOs. Tutti pins those artifacts in the
market-neutral `packages/clients/market-go` module. Connector passes
`itemType=connector`; a future Skills Market can reuse the same remote client
with `itemType=skill` while keeping its own domain and UI state.

## Goals

- Consume `categoryId`, `kind`, `sortOrder`, `itemCount`, `displayNameZh`, and
  `displayNameEn` without losing information between the service and renderer.
- Allow the service to add, rename, reorder, or disable categories without a
  Tutti release.
- Preserve the exact category ID as the pagination `sectionId`; do not rewrite
  `development` to `developer-tools` or perform any other aliasing.
- Keep the remote Market protocol separate from the local daemon OpenAPI
  protocol.
- Support the service deployment and client rollback window.
- Establish a reusable remote client boundary without implementing Skills
  Market UI in this change.

## Non-goals

- Changing the Connector publication manifest, installation, authorization,
  runtime, or artifact protocols.
- Persisting remote categories in local SQLite.
- Adding category administration to Tutti.
- Merging Connector and Skills renderer state.
- Inferring category placement from a Connector key or manifest.

## Protocol ownership

The Market service owns these fields:

| Field           | Contract in Tutti                                          |
| --------------- | ---------------------------------------------------------- |
| `categoryId`    | Preserve as an opaque identifier and pagination section ID |
| `kind`          | Accept `featured` or `category`                            |
| `sortOrder`     | Sort ascending without a client-defined category order     |
| `itemCount`     | Require a non-negative count                               |
| `displayNameZh` | Prefer for locales whose normalized value starts with `zh` |
| `displayNameEn` | Prefer for all other locales                               |

`packages/clients/market-go` owns only transport concerns: generated request and
response types, protobuf JSON decoding, the host-provided HTTP transport and
timeout, gateway base paths, request authorization, and bounded response bodies.
It has no Connector, Skills, UI, or daemon product semantics.

`packages/connector/daemon.CatalogSource` is the Connector adapter. It fixes
`itemType` to `connector`, validates the remote response, and explicitly maps
generated types into `packages/connector/host.CatalogCategory`.

`packages/connector/market/openapi/connector-market.v1.yaml` remains the local
renderer-facing protocol. Generated Go and TypeScript types come from this
OpenAPI source rather than exposing the remote protobuf types.

## Data flow

```text
tsh-server Market schema
-> pinned provider-generated artifacts
-> packages/clients/market-go
-> packages/connector/daemon CatalogSource
-> packages/connector/host.CatalogCategory
-> services/tuttid API projection
-> Connector Market local OpenAPI
-> generated @tutti-os/client-tuttid-ts types
-> Connector Market domain and view state
-> ConnectorCatalog locale-aware title selection
```

The following bypasses are intentionally forbidden:

```text
renderer -> remote Market API
UI -> generated title or slug from categoryId
manifest -> inferred category
remote generated DTO -> local OpenAPI or renderer
Connector adapter -> rewritten categoryId
```

## Generated client pinning

`packages/clients/market-go/source.lock.json` records the provider repository,
exact commit, source file paths, target file paths, and SHA-256 values. The
vendored files make CI checks network-independent.

Verify the pinned files:

```sh
pnpm check:api-generated
```

Update from an authorized checkout of the matching provider commit:

```sh
pnpm generate:market-go-client -- --source-root /path/to/tsh-server
```

The sync command deliberately requires a local provider checkout and verifies
that its HEAD matches the pinned provider commit before copying files. It does
not fetch a private repository anonymously or import the `tsh-server` root Go
module.

## Compatibility window

The local OpenAPI name fields are optional during the consume phase. This keeps
Tutti compatible with a service rolling deployment and allows a client rollback.

When either localized name is present, the renderer uses the preferred locale
and falls back to the other available name. When both names are absent, only
the categories from the earlier released response are accepted:

- `featured`
- `productivity`
- `development`
- `other`

Those four IDs use existing package-local i18n during the compatibility window.
An unknown category with no server-owned name is rejected at the remote adapter
boundary. The UI also has a defensive generic translated label and never renders
the raw slug.

`installed` is a Tutti-local virtual section and continues to use local i18n.

After every supported domestic and overseas service deployment returns names,
the rollback window is closed, and the minimum supported Tutti version includes
this consumer, a separate contract cleanup can:

- make both local OpenAPI fields required;
- make the Go and TypeScript domain fields non-optional;
- remove the legacy category switch and its i18n keys;
- retain cross-language fallback as defensive presentation behavior.

## Implemented changes

- Added `packages/clients/market-go` with the generated client, source lock,
  bounded transport adapter, tests, and update instructions.
- Replaced the Connector daemon's hand-written Market response DTOs and raw GET
  path with the generated client.
- Added localized category names to the Connector host model and local OpenAPI,
  then regenerated the Go and TypeScript API types.
- Preserved localized names through Connector Market state and view projection.
- Added a pure locale-aware category title resolver and used it in the catalog.
- Added compatibility, dynamic-ID, exact-pagination-ID, additive-field,
  market-neutral item type, and response-size coverage.
- Documented the generated-client ownership and dynamic category flow in the
  durable architecture and project-structure documentation.

No new renderer primitives or styles were needed. The existing Connector Market
UI continues to use `@tutti-os/ui-system`; this change only replaces title data.

## Validation

The implementation is validated with:

```sh
node tools/scripts/sync-market-go-client.mjs --check
go test -race ./... # packages/clients/market-go
go test -race ./... # packages/connector/daemon
go test ./...       # packages/connector/host
go test ./api       # services/tuttid
pnpm --filter @tutti-os/client-tuttid-ts test
pnpm --filter @tutti-os/client-tuttid-ts typecheck
pnpm --filter @tutti-os/connector-market test
pnpm --filter @tutti-os/connector-market typecheck
pnpm check:api-generated
pnpm check:i18n
pnpm release:pack:check -- --packages-json '["@tutti-os/connector-market"]'
pnpm check:changed
```

## Rollback

- The service fields are additive, so old clients remain compatible.
- The local OpenAPI fields stay optional during the consume phase.
- Category IDs and listings are not migrated locally, so no data rollback is
  required.
- If the generated transport integration must be rolled back, revert the Tutti
  release; do not restore a second hand-written implementation as a permanent
  path.

## Follow-up PR

The later contract-cleanup PR is intentionally separate. It requires production
evidence that both localized names are consistently present and that the service
rollback window is closed. It will not add category data, Connector listings, or
Skills Market UI.

## Acceptance criteria

- A newly administered category appears in Tutti in service order and with the
  correct localized name without a code change.
- `developer-tools`, `communication`, `creativity`, and
  `business-operations` never render as slugs.
- Locale changes only select presentation data and do not refetch the catalog.
- Pagination uses the exact category ID returned by the service.
- Domestic and overseas markets can return different counts and listings while
  using the same category-name protocol.
- A future Skills consumer can reuse the Market client with `itemType=skill`
  without importing Connector renderer types.
- Tutti has no new hand-written remote Market category response DTO or remote
  category title enumeration.
