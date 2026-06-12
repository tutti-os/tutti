# Workspace App Catalog

Workspace App Center can show built-in apps from two sources:

- embedded app packages committed in `services/nextopd/builtin-apps`
- remote built-in app packages listed by a JSON catalog

Remote built-in apps are optional. App Center can show their name, description, and icon before the package is downloaded. The package zip is downloaded only when the user installs the app.

## Runtime Overrides

`NEXTOP_APP_CATALOG_FILE` points nextopd at a local catalog JSON file and has priority over `NEXTOP_APP_CATALOG_URL`.

When `NEXTOP_APP_CATALOG_URL` is unset, nextopd loads the default published catalog:

```text
https://d1x7gb6wqsqmnm.cloudfront.net/nextop-app-releases/catalog.json
```

Staging releases use a separate catalog and must not write production
`latest.json` objects:

```text
https://d1x7gb6wqsqmnm.cloudfront.net/nextop-app-releases-staging/catalog.json
```

`NEXTOP_APP_CATALOG_URL` points nextopd at a public HTTP(S) catalog JSON file, usually served through CloudFront or S3. Set it to an empty string to disable the default remote catalog.

Example local mock:

```sh
NEXTOP_APP_CATALOG_FILE=/tmp/nextop-app-catalog/catalog.json pnpm dev:desktop
```

## Refresh Behavior

`nextopd` is the source of truth for remote catalog retrieval, manifest validation, artifact URLs, and artifact SHA-256 values. Renderer code should ask `nextopd` to refresh the catalog instead of fetching the CDN catalog directly.

App Center opening should call `POST /v1/workspaces/{workspaceID}/apps/catalog/refresh`. The refresh request is in-flight deduplicated by `nextopd`, keeps local and previously loaded apps visible while loading, and retries retryable network or 5xx failures for a total of three attempts.

## Catalog Shape

```json
{
  "schemaVersion": "nextop.app.catalog.v1",
  "apps": [
    {
      "manifest": {
        "schemaVersion": "nextop.app.manifest.v1",
        "appId": "vibe-design",
        "version": "0.1.0+abc123",
        "name": "Vibe Design",
        "description": "Design workspace",
        "icon": {
          "type": "asset",
          "src": "icon.svg"
        },
        "runtime": {
          "bootstrap": "bootstrap.sh",
          "healthcheckPath": "/"
        }
      },
      "distribution": {
        "kind": "remote",
        "artifactUrl": "https://cdn.example.test/apps/vibe-design/0.1.0%2Babc123/vibe-design-0.1.0%2Babc123.zip",
        "artifactSha256": "64-char-sha256",
        "iconUrl": "https://cdn.example.test/apps/vibe-design/0.1.0%2Babc123/icon.svg"
      }
    }
  ]
}
```

Remote catalog entries must include `distribution.iconUrl`, `distribution.artifactUrl`, `distribution.artifactSha256`, and a manifest icon asset. The zip package must contain a complete app package with `nextop.app.json`, `bootstrap.sh`, `AGENTS.md`, and the manifest icon asset.

Workspace app packages do not declare runtime kind or bundle Python/Node. Managed runtime release and download rules belong to [Workspace App Runtime](./workspace-app-runtime.md).

## Release Flow

External app repositories should call `.github/workflows/publish-nextop-app-release.yml` from this repository. The reusable workflow:

1. Checks out the app repository.
2. Serializes releases per app and branch.
3. Automatically bumps the committed source app manifest and commits the bump
   unless `release_version` is provided or `auto_bump_version` is disabled.
4. Runs the app repository package command.
5. Runs `@tutti-os/app-release-tools`.
6. Generates a zip, immutable `release.json`, and mutable `latest.json`.
7. Refuses to overwrite an existing immutable release version.
8. Uploads the release directory and `latest.json` to S3.
9. Optionally merges the app into `catalog.json` when `publish_catalog` is
   enabled.

External repositories that use automatic bumping must commit a source manifest
at `version_manifest_path`, which defaults to root `nextop.app.json`. That
manifest is the only source of automatic release version state. Do not derive
automatic release versions from mutable S3 metadata, package build output,
`package.json`, or git tags. App package scripts must copy or render the package
manifest from the source manifest named by `version_manifest_path` so the
released package contains the bumped version. This also applies in monorepos:
the app package's `package.json` may have a separate package version and must
not overwrite `nextop.app.json.version`.

Caller repositories should test this contract directly. After running the
package command, `package_dir/nextop.app.json` must have the same `version` as
`version_manifest_path`. A mismatch is a release blocker because the reusable
workflow resolves the uploaded release version from the generated package
manifest.

When automatic bumping is enabled, the default release version is the bumped
manifest version. When automatic bumping is disabled, the default release
version remains `manifest.version+<short git sha>`. Callers can pass
`release_version` to override it.

Callers that use the default automatic bump must grant `contents: write` and
`id-token: write` permissions so the workflow can push the version bump commit
and assume the release upload role.

When `publish_catalog` is enabled, releases targeting the same S3 bucket and
prefix are serialized so concurrent app releases cannot overwrite each other's
catalog merge. The release workflow reads the existing catalog from the same S3
prefix when it exists, merges the newly published app `latest.json`, verifies
the merged catalog artifact metadata, uploads `catalog.json`, and optionally
invalidates the catalog path when `catalog_cloudfront_distribution_id` is set.
The release upload role must be allowed to read and write that `catalog.json`
object, and must have CloudFront invalidation permissions when invalidation is
enabled.

The release workflow also supports `catalog_only: true` for catalog repair and
refresh operations. In catalog-only mode it skips package build, version bump,
release metadata generation, and immutable artifact upload, then merges the
existing `apps/<appId>/latest.json` from the target S3 prefix into
`catalog.json`. App repositories may expose this as a manual input; the Tutti
catalog workflows provide the same repair path when a caller workflow does not
expose catalog-only dispatch.

Retrying a release version is allowed only when the existing immutable
`release.json` matches the newly generated release metadata. In that case the
workflow repairs mutable state such as `latest.json`, catalog metadata, and
CloudFront invalidation without re-uploading immutable artifacts.

Each app uploads under:

```text
apps/<appId>/<version>/
apps/<appId>/latest.json
```

The Tutti repository owns `.github/workflows/publish-nextop-app-catalog.yml`.
That workflow reads selected `apps/<appId>/latest.json` files from S3 and
publishes one shared `catalog.json`. It defaults to merge mode, which preserves
existing catalog apps and updates only selected app ids. Replace mode publishes
only the selected app ids and should be used only for deliberate full catalog
replacement.

There are three normal publishing modes:

1. Release only: `publish_catalog: false` and `catalog_only: false`. This
   uploads a new app version and updates `apps/<appId>/latest.json`. App Center
   will see it after a later `catalog.json` publish.
2. Release and catalog: `publish_catalog: true`. This uploads the app release
   and immediately merges that release into `catalog.json`.
3. Catalog only: `catalog_only: true`, or the Tutti catalog workflow in merge
   mode with `app_ids: <appId>`. Use this after a release already succeeded
   when catalog was skipped, or when validation should happen before catalog
   publication. It must not bump or upload a new app version.

Catalog merges are explicit. App repository release workflows are scoped to the
current `app_id`: `publish_catalog: true` and `catalog_only: true` merge only
that app's `apps/<appId>/latest.json` into `catalog.json`. If app A published a
release without catalog publication, app B's later release with
`publish_catalog: true` preserves the existing catalog and updates B only; it
does not discover and add A. To add or refresh multiple apps at once, use the
Tutti catalog workflow with every desired app listed in `app_ids`, or run each
app's catalog-only dispatch separately. No catalog path scans S3 for all
published `apps/*/latest.json`.

Production and staging release metadata must stay on separate S3 prefixes:

```text
nextop-app-releases/apps/<appId>/latest.json
nextop-app-releases/catalog.json

nextop-app-releases-staging/apps/<appId>/latest.json
nextop-app-releases-staging/catalog.json
```

Use `.github/workflows/publish-nextop-app-catalog-staging.yml` to publish a
staging catalog. Use `.github/workflows/publish-nextop-app-catalog.yml` to
publish the production catalog. Production catalog publishing must read only
production release metadata; staging catalog publishing must read only staging
release metadata. In merge mode, an empty app id input refreshes the existing
catalog and invalidates CloudFront without changing the app set, as long as an
existing `catalog.json` is already present.
