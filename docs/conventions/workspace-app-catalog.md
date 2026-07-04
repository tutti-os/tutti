# Workspace App Catalog

Workspace App Center can show built-in apps from two sources:

- embedded app packages committed in `services/tuttid/builtin-apps`
- remote built-in app packages listed by a JSON catalog

Remote built-in apps are optional. App Center can show their name, description, and icon before the package is downloaded. The package zip is downloaded only when the user installs the app.

## Runtime Overrides

`TUTTI_APP_CATALOG_FILE` points tuttid at a local catalog JSON file and has priority over `TUTTI_APP_CATALOG_URL`.

When `TUTTI_APP_CATALOG_URL` is unset, tuttid loads the default published catalog:

```text
https://d1x7gb6wqsqmnm.cloudfront.net/tutti-app-releases/catalog.json
```

Staging releases use a separate catalog and must not write production
`latest.json` objects:

```text
https://d1x7gb6wqsqmnm.cloudfront.net/tutti-app-releases-staging/catalog.json
```

`TUTTI_APP_CATALOG_URL` points tuttid at a public HTTP(S) catalog JSON file, usually served through CloudFront or S3. Set it to an empty string to disable the default remote catalog.

Example local mock:

```sh
TUTTI_APP_CATALOG_FILE=/tmp/tutti-app-catalog/catalog.json pnpm dev:desktop
```

## Refresh Behavior

`tuttid` is the source of truth for remote catalog retrieval, manifest validation, artifact URLs, and artifact SHA-256 values. Renderer code should ask `tuttid` to refresh the catalog instead of fetching the CDN catalog directly.

App Center opening should call `POST /v1/workspaces/{workspaceID}/apps/catalog/refresh`. The refresh request is in-flight deduplicated by `tuttid`, keeps local and previously loaded apps visible while loading, and retries retryable network or 5xx failures for a total of three attempts.

## App Center Grouping

App Center uses the same daemon catalog snapshot for recommended and community
apps. `tuttid` should not add a separate community source enum for this
presentation split. The reusable App Center UI keeps "My apps" for local and
local-dev apps, and splits non-local catalog apps between "Official apps"
and "Community apps" by app id in
`packages/workspace/app-center/src/core/appCenterAppOrdering.ts`.

When moving an app between recommended and community presentation, update the
central app id list and the App Center ordering tests in the same change.
Community app cards show a developer entry first in the card action menu when
the app metadata has an author URL. Prefer publishing author metadata through
the app catalog; desktop-local app id overrides are acceptable only as a
temporary bridge for community apps whose catalog metadata has not caught up.

## Catalog Shape

```json
{
  "schemaVersion": "tutti.app.catalog.v1",
  "apps": [
    {
      "localizations": [
        {
          "locale": "zh-CN",
          "name": "产品原型设计",
          "description": "创建并迭代产品原型设计",
          "tags": ["设计", "原型"]
        }
      ],
      "manifest": {
        "schemaVersion": "tutti.app.manifest.v1",
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

Remote catalog entries must include `distribution.iconUrl`, `distribution.artifactUrl`, `distribution.artifactSha256`, and a manifest icon asset. The zip package must contain a complete app package with `tutti.app.json`, `bootstrap.sh`, `AGENTS.md`, and the manifest icon asset.

When a package manifest declares `localizationInfo`, release tooling reads the
referenced package-local manifest locale files and writes their `name`,
`description`, and `tags` into the catalog entry `localizations` field. App
Center uses this catalog metadata for uninstalled remote apps, because it must
not download or unzip the app package just to render localized catalog cards.

Workspace app packages do not declare arbitrary runtime kinds or bundle Python/Node. Packages that only need the managed Node/static runtime may declare `runtime.profile: "node-static"`; all other managed runtime release and download rules belong to [Workspace App Runtime](./workspace-app-runtime.md).

## Release Flow

External app repositories should call `.github/workflows/publish-tutti-app-release.yml` from this repository. The reusable workflow:

1. Checks out the app repository.
2. Serializes releases per app and branch.
3. Resolves the release version from `release_bump` and existing release tags,
   or from the package manifest for staging-style runs.
4. Runs the app repository package command.
5. Runs `@tutti-os/app-release-tools`.
6. Generates a zip, immutable `release.json`, and mutable `latest.json`.
7. Refuses to overwrite an existing immutable release version.
8. Uploads the release directory and `latest.json` to S3.
9. Creates the release tag when `create_release_tag` is enabled.
10. Optionally merges the app into `catalog.json` when `publish_catalog` is
    enabled.

Production app releases are manually dispatched from GitHub Actions with a
`release_bump` value of `patch`, `minor`, or `major`. The reusable workflow
fetches existing tags with the configured `release_tag_prefix` (default
`<appId>-v`), reads the packaged manifest version, calculates the next stable
semver version from the greater of those sources, publishes the S3 release,
verifies the artifact, then creates an annotated release tag such as
`vibe-design-v1.2.4`. The workflow never edits or commits the source manifest.

Staging app releases do not create release tags. When `release_bump` is empty,
the reusable workflow publishes `manifest.version+<short git sha>` from the
packaged manifest.

Staging caller workflows should run automatically on `push` to `main`, which is
the event produced after a pull request is merged. Push-triggered staging runs
should publish the staging catalog by default so App Center sees the merged app
without a second manual dispatch. Manual staging dispatch remains useful for
catalog repair, reruns, and targeted validation.

When `publish_catalog` is enabled, releases targeting the same S3 bucket and
prefix are serialized so concurrent app releases cannot overwrite each other's
catalog merge. The release workflow reads the existing catalog from the same S3
prefix when it exists, merges the newly published app `latest.json`, verifies
the merged catalog artifact metadata, uploads `catalog.json`, and optionally
invalidates the catalog path when `catalog_cloudfront_distribution_id` is set.
The release upload role must be allowed to read and write that `catalog.json`
object, and must have CloudFront invalidation permissions when invalidation is
enabled.

Caller workflows usually pass `catalog_cloudfront_distribution_id` from
`TUTTI_APP_RELEASES_PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID` or the shared
`TUTTI_APP_RELEASES_CLOUDFRONT_DISTRIBUTION_ID` variable. Prefer configuring
shared CloudFront distribution ids as organization variables with selected
repository access, and use repository variables only for repository-specific
overrides or temporary setup. When neither variable is configured, the input is
empty, invalidation is skipped, and catalog readers rely on the `catalog.json`
cache TTL.

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

The Tutti repository owns `.github/workflows/publish-tutti-app-catalog.yml`.
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
tutti-app-releases/apps/<appId>/latest.json
tutti-app-releases/catalog.json

tutti-app-releases-staging/apps/<appId>/latest.json
tutti-app-releases-staging/catalog.json
```

The staging asset base URL must also point at the staging prefix, for example
`https://d1x7gb6wqsqmnm.cloudfront.net/tutti-app-releases-staging`. Do not
reuse the production `TUTTI_APP_RELEASES_BASE_URL` for staging, because the
published `latest.json` and `catalog.json` would then reference production
artifact URLs. For private app repositories that cannot read organization
variables, set the Tutti release variables as repository variables on each app
repository.

Use `.github/workflows/publish-tutti-app-catalog-staging.yml` to publish a
staging catalog. Use `.github/workflows/publish-tutti-app-catalog.yml` to
publish the production catalog. Production catalog publishing must read only
production release metadata; staging catalog publishing must read only staging
release metadata. In merge mode, an empty app id input refreshes the existing
catalog and invalidates CloudFront without changing the app set, as long as an
existing `catalog.json` is already present.
