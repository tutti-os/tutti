---
name: nextop-app-release
description: "Set up, review, run, or debug external repositories that publish a Nextop workspace app through the reusable Nextop App Release GitHub Actions workflow. Use for caller workflows, nextop.app.json manifests, @tutti-os/app-release-tools, S3/CloudFront release hosting, latest.json, catalog.json, catalog-only repairs, and App Center visibility issues."
---

# Nextop App Release

Use this skill when an external app repository publishes a remote Nextop workspace app into App Center release metadata.

The external repository calls the reusable workflow from the Nextop/Tutti repository:

```yaml
uses: tutti-os/tutti/.github/workflows/publish-nextop-app-release.yml@main
```

That workflow builds one app package, runs `@tutti-os/app-release-tools`, uploads immutable release files plus mutable `latest.json`, and can optionally merge that app into the shared `catalog.json`.

## Operating Rules

Inspect before acting:

- Read the caller workflow, `nextop.app.json`, package script, and recent GitHub Actions runs.
- Confirm whether the user wants a new app release, a catalog refresh, or CI debugging. Do not rerun a release just to repair catalog state.

For catalog publication:

- There are three valid modes. Explain them explicitly when helping a user choose.
- Release only: `publish_catalog: false`. This uploads a new app version and updates `apps/<appId>/latest.json`; App Center will see it the next time `catalog.json` is published.
- Release and catalog: `publish_catalog: true`. This uploads the app release, then immediately merges that release into `catalog.json`.
- Catalog only: `catalog_only: true`. Use this after a release already succeeded when the user forgot to publish catalog, wants to validate first, or wants to refresh catalog without bumping or uploading a new version.
- Do not rerun a full app release just to repair catalog state.
- If the app caller workflow exposes `catalog_only`, use that. If it does not, use the Tutti catalog workflow directly or add the caller input when the user wants that repo to support catalog-only dispatch.

For automatic versioning:

- `auto_bump_version: true` requires a committed source manifest at `version_manifest_path`, defaulting to root `nextop.app.json`.
- The package command must copy or render `package_dir/nextop.app.json` from the same source manifest named by `version_manifest_path`.
- Do not derive or overwrite the package manifest version from S3 `latest.json`, package build output, git tags, or `package.json`. Those make release behavior depend on mutable external state or unrelated app package versions.
- After packaging, verify that `version_manifest_path` and `package_dir/nextop.app.json` have the same `version`. If they differ, fix the caller repository packaging script before publishing.
- Add or update caller repository tests that assert the packaged manifest version equals the source manifest version.
- If a repository does not have a source manifest, add one instead of adding compatibility logic to the reusable workflow.

For reusable workflow changes:

- Keep long-lived release behavior in the Tutti reusable workflows and app release tools.
- Keep caller workflows small and stable: app id, package command/dir, runner/tool versions when needed, and environment-specific AWS/CDN values.
- Avoid requiring app repositories to change for catalog repair behavior. Use an existing catalog-only path for that.

## Release Contract

The caller repository must be compatible with pnpm. The reusable workflow runs `pnpm install --frozen-lockfile` before `package_command`, so the repository should commit `pnpm-lock.yaml` and define the package script used by `package_command`.

The caller repository must commit a source manifest:

```text
nextop.app.json
```

The generated package directory must contain:

- `nextop.app.json`
- `bootstrap.sh`
- `AGENTS.md`
- the manifest icon asset, such as `icon.png` or `icon.svg`
- all runtime files and assets

The source and package manifests must use `schemaVersion: "nextop.app.manifest.v1"`. `appId` must match the workflow `app_id` input. `version` must be stable semver `x.y.z` when automatic bumping is enabled.

The package manifest version must be copied from the source manifest that the
workflow bumps. This is especially important in monorepos where the app's
`package.json` may have a separate package version. Do not set
`nextop.app.json.version` from `package.json`.

The workflow writes release objects under:

```text
apps/<appId>/<version>/
apps/<appId>/latest.json
```

By default, the release version is the bumped source manifest version. For example, `0.1.0` becomes `0.1.1` with `version_bump: patch`. If `auto_bump_version` is disabled and `release_version` is empty, the workflow uses `manifest.version+<short git sha>`.

## Reference Caller Workflow

Use this as the default single-app production caller. Keep new app repositories
as close to this reference as their package command allows.

```yaml
name: Publish Nextop App Production

on:
  workflow_dispatch:
    inputs:
      release_version:
        description: Optional release version override. Defaults to the automatic manifest patch bump.
        required: false
        type: string
      publish_catalog:
        description: Whether to publish the production App Center catalog after this release.
        required: false
        type: boolean
        default: false
      catalog_only:
        description: Whether to skip app release upload and only publish the existing latest release to catalog.
        required: false
        type: boolean
        default: false
  push:
    branches:
      - main

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    uses: tutti-os/tutti/.github/workflows/publish-nextop-app-release.yml@main
    with:
      app_id: your-app-id
      package_command: pnpm package:nextop
      package_dir: build/nextop-app/package
      icon_path: build/nextop-app/package/icon.png
      release_version: ${{ inputs.release_version || '' }}
      auto_bump_version: true
      version_bump: patch
      publish_catalog: ${{ github.event_name == 'workflow_dispatch' && inputs.publish_catalog }}
      catalog_only: ${{ github.event_name == 'workflow_dispatch' && inputs.catalog_only }}
      aws_region: ${{ vars.NEXTOP_APP_RELEASES_PRODUCTION_AWS_REGION || vars.NEXTOP_APP_RELEASES_AWS_REGION }}
      aws_role_arn: ${{ vars.NEXTOP_APP_RELEASES_PRODUCTION_AWS_ROLE_ARN || vars.NEXTOP_APP_RELEASES_AWS_ROLE_ARN }}
      s3_bucket: ${{ vars.NEXTOP_APP_RELEASES_PRODUCTION_S3_BUCKET || vars.NEXTOP_APP_RELEASES_S3_BUCKET }}
      s3_prefix: ${{ vars.NEXTOP_APP_RELEASES_PRODUCTION_S3_PREFIX || vars.NEXTOP_APP_RELEASES_S3_PREFIX }}
      release_assets_base_url: ${{ vars.NEXTOP_APP_RELEASES_PRODUCTION_BASE_URL || vars.NEXTOP_APP_RELEASES_BASE_URL }}
      catalog_cloudfront_distribution_id: ${{ vars.NEXTOP_APP_RELEASES_PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID || vars.NEXTOP_APP_RELEASES_CLOUDFRONT_DISTRIBUTION_ID || '' }}
```

Use only `workflow_dispatch` for staging unless every merge should publish
staging too. Keep staging and production on separate S3 prefixes and base URLs.

Pin the reusable workflow ref only when the caller needs reproducible release behavior:

```yaml
uses: tutti-os/tutti/.github/workflows/publish-nextop-app-release.yml@<tag-or-commit-sha>
```

For monorepos that publish multiple apps, keep the caller shape the same but
resolve a target matrix from repository config. Each matrix target should expose
the same reusable workflow inputs:

```yaml
app_id: ${{ matrix.target.app_id }}
package_command: ${{ matrix.target.package_command }}
package_dir: ${{ matrix.target.package_dir }}
icon_path: ${{ matrix.target.icon_path }}
version_manifest_path: ${{ matrix.target.version_manifest_path }}
```

Each matrix target's `package_command` must produce `package_dir/nextop.app.json`
from that target's `version_manifest_path`. Treat mismatches as release
blockers, because the reusable workflow resolves the uploaded release version
from the generated package manifest.

## Reusable Workflow Inputs

Required release inputs:

- `app_id`: app id, matching the source and package `nextop.app.json`.
- `aws_region`: AWS region for the release bucket.
- `aws_role_arn`: IAM role assumed through GitHub OIDC.
- `s3_bucket`: bucket receiving release files.

Conditionally required inputs:

- `package_command`: builds or copies the final package. Required unless `catalog_only` is true.
- `package_dir`: package directory produced by `package_command`. Required unless `catalog_only` is true.
- `release_assets_base_url`: public base URL for `s3_bucket` plus `s3_prefix`. Required unless `catalog_only` is true.

Optional release/version inputs:

- `icon_path`: package-local icon path override. Use when the manifest icon should be resolved from a generated package path.
- `release_version`: explicit release version. Leave empty for automatic bumping; use sparingly because it bypasses `version_bump`.
- `auto_bump_version`: whether to bump and commit the source manifest before packaging. Default: `true`.
- `version_bump`: semver bump applied when `auto_bump_version` is true. Values: `major`, `minor`, `patch`. Default: `patch`.
- `version_manifest_path`: source manifest to bump. Default: `nextop.app.json`. In monorepos, pass the app package source manifest, for example `apps/daily-tech-radar/nextop-package/nextop.app.json`.

Optional catalog inputs:

- `publish_catalog`: after uploading the app release, merge that release into `catalog.json`. Default: `false`.
- `catalog_only`: skip package build, version bump, release metadata generation, and app release upload; merge existing `apps/<appId>/latest.json` into `catalog.json`. Default: `false`.
- `catalog_cloudfront_distribution_id`: CloudFront distribution id for invalidating `/<s3_prefix>/catalog.json` after catalog upload. Default: empty.

Optional runtime/tooling inputs:

- `runner`: GitHub runner label. Default: `ubuntu-latest`.
- `node_version`: Node.js version. Default: `24`.
- `pnpm_version`: pnpm version. Default: `10.11.0`.
- `release_tools_package`: app release tools package spec. Default: `@tutti-os/app-release-tools@latest`. Pin this only when debugging or when the reusable workflow depends on a version not yet intended for general use.

## Catalog Publication

An app release writes `apps/<appId>/latest.json`. App Center sees it only after the shared catalog includes that app.

Publishing modes:

- Release only: run the app release workflow with `publish_catalog: false` and `catalog_only: false`. This updates `apps/<appId>/latest.json`; catalog changes wait until a later catalog publish.
- Release and catalog: run the app release workflow with `publish_catalog: true`. This publishes the app and then updates `catalog.json` in the same run.
- Catalog only: run with `catalog_only: true` after a release already exists. This reads the existing `apps/<appId>/latest.json` and updates `catalog.json` without rebuilding, uploading, or bumping a new app version.

Catalog merge semantics:

- App repository release workflows are scoped to their current `app_id`. `publish_catalog: true` and `catalog_only: true` merge only that app's `apps/<appId>/latest.json` into `catalog.json`.
- A release-only app that is not already in `catalog.json` will not be picked up by another app's later `publish_catalog: true` run.
- The Tutti catalog workflows can merge one or more explicitly selected app ids through `app_ids`. Use that path when refreshing multiple apps, or run each app's catalog-only dispatch separately.
- Neither path scans S3 for every published `apps/*/latest.json`. Every app that should be added or refreshed must be the current caller app id or be explicitly listed in `app_ids`.

Catalog-only can be exposed by the app repository caller workflow, or run from the Tutti catalog workflows:

- Production: <https://github.com/tutti-os/tutti/actions/workflows/publish-nextop-app-catalog.yml>
- Staging: <https://github.com/tutti-os/tutti/actions/workflows/publish-nextop-app-catalog-staging.yml>

Recommended inputs for refresh/repair:

- `catalog_mode`: `merge`
- `app_ids`: the released remote app id, such as `vibe-design`
- Leave AWS, S3, prefix, and CloudFront inputs empty unless overriding repository variables.

Use `replace` only for deliberate full catalog replacement. Built-in app ids such as `automation` are not published through the remote catalog workflow.

Catalog writes:

```text
s3://<s3_bucket>/<s3_prefix>/catalog.json
```

If `catalog.json` changed but App Center still shows old metadata, check CloudFront invalidation and confirm `NEXTOP_APP_CATALOG_URL` points at the expected staging or production URL.

## AWS Requirements

The caller repository needs a GitHub OIDC role that can write release files:

```text
s3://<s3_bucket>/<s3_prefix>/apps/<appId>/<version>/*
s3://<s3_bucket>/<s3_prefix>/apps/<appId>/latest.json
```

When `publish_catalog` or `catalog_only` is used in the app release workflow, that role also needs catalog read/write access:

```text
s3://<s3_bucket>/<s3_prefix>/catalog.json
```

CloudFront invalidation requires permission for the matching distribution id. Store non-secret configuration such as role ARN and bucket name in GitHub Actions variables when possible.

## Local Validation

Before relying on GitHub Actions, validate the package locally:

```sh
pnpm --package @tutti-os/app-release-tools@latest dlx build-nextop-app-release \
  --app-id your-app-id \
  --package-dir build/nextop-app/package \
  --output-dir /tmp/nextop-app-release \
  --base-url https://cdn.example.com/nextop-app-releases \
  --version 0.1.0+local \
  --git-sha local
```

Expected output:

- `/tmp/nextop-app-release/apps/<appId>/<version>/<appId>-<version>.zip`
- `/tmp/nextop-app-release/apps/<appId>/<version>/release.json`
- `/tmp/nextop-app-release/apps/<appId>/latest.json`

When automatic bumping is enabled, also compare the source and generated
package manifests before building release metadata:

```sh
node -e '
  const fs = require("fs");
  const source = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const packaged = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (source.version !== packaged.version) {
    console.error(`manifest version mismatch: source=${source.version} package=${packaged.version}`);
    process.exit(1);
  }
' nextop.app.json build/nextop-app/package/nextop.app.json
```

For monorepos, replace `nextop.app.json` with the target's
`version_manifest_path`, for example
`apps/daily-tech-radar/nextop-package/nextop.app.json`.

## Completion Checklist

- Caller workflow uses `tutti-os/tutti/.github/workflows/publish-nextop-app-release.yml`.
- Automatic bumping has `contents: write`, `id-token: write`, and a committed source `nextop.app.json`.
- `package_command` produces `package_dir`.
- `package_dir/nextop.app.json` is valid JSON and `appId` matches workflow `app_id`.
- Package contains `bootstrap.sh`, `AGENTS.md`, icon asset, and runtime files.
- `s3_prefix` and `release_assets_base_url` point to the same public release root.
- Staging and production use separate prefixes.
- Catalog refresh after an existing successful release uses `catalog_only` or the Tutti catalog workflow instead of a new release.

## Common Failures

- `manifest appId must match app id`: align workflow `app_id` and manifest `appId`.
- `missing nextop.app.json`: fix source manifest or package generation. Automatic bumping requires a committed source manifest; packaging requires a package manifest.
- `manifest version must be stable semver`: source manifest version must be `x.y.z` for automatic bumping.
- `manifest icon asset missing`: include the asset inside the package or pass `icon_path`.
- AWS `AccessDenied`: check OIDC trust policy, role ARN, bucket policy, region, prefix, and catalog/CloudFront permissions.
- Release succeeded but App Center does not show it: publish or refresh the catalog with `catalog_only` or the Tutti catalog workflow in merge mode.
