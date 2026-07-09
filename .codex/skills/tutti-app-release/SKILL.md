---
name: tutti-app-release
description: "Set up, review, run, or debug external repositories that publish a Tutti workspace app through the reusable Tutti App Release GitHub Actions workflow. Use for caller workflows, tutti.app.json manifests, @tutti-os/app-release-tools, S3/CloudFront release hosting, latest.json, versions.json, catalog.json, catalog-only repairs, and App Center visibility issues."
---

# Tutti App Release

Use this skill when an external app repository publishes a remote Tutti workspace app into App Center release metadata.

The external repository calls the reusable workflow from the Tutti/Tutti repository:

```yaml
uses: tutti-os/tutti/.github/workflows/publish-tutti-app-release.yml@main
```

That workflow builds one app package, runs `@tutti-os/app-release-tools`, uploads immutable release files plus mutable `latest.json` and `versions.json`, and can optionally merge that app into the shared `catalog.json`.

## Operating Rules

Inspect before acting:

- Read the caller workflow, `tutti.app.json`, package script, and recent GitHub Actions runs.
- Confirm whether the user wants a new app release, a catalog refresh, or CI debugging. Do not rerun a release just to repair catalog state.

For catalog publication:

- There are three valid modes. Explain them explicitly when helping a user choose.
- Release only: `publish_catalog: false`. This uploads a new app version and updates `apps/<appId>/latest.json` and `versions.json`; App Center will see it the next time `catalog.json` is published.
- Release and catalog: `publish_catalog: true`. This uploads the app release, then immediately merges that release into `catalog.json`.
- Catalog only: `catalog_only: true`. Use this after a release already succeeded when the user forgot to publish catalog, wants to validate first, or wants to refresh catalog without bumping or uploading a new version.
- Do not rerun a full app release just to repair catalog state.
- If the app caller workflow exposes `catalog_only`, use that. If it does not, use the Tutti catalog workflow directly or add the caller input when the user wants that repo to support catalog-only dispatch.

For versioning:

- Production releases should be workflow-driven. Run the production caller workflow with `release_bump` (`patch`, `minor`, or `major`); the reusable workflow calculates the next version from the greater of the packaged manifest version and existing release tags, then creates the tag after the S3 release verifies.
- The workflow never bumps or commits app manifest versions. Do not add caller-side release PRs or manifest bump commits to work around protected branches.
- Staging releases should leave `release_bump` empty. The workflow uses `manifest.version+<short git sha>` from the packaged manifest and does not create a release tag.

For reusable workflow changes:

- Keep long-lived release behavior in the Tutti reusable workflows and app release tools.
- Keep caller workflows small and stable: app id, package command/dir, runner/tool versions when needed, and environment-specific AWS/CDN values.
- Require callers to declare `min_tutti_version` explicitly. Use `0.0.0` only for releases that are safe for every legacy Tutti client.
- Avoid requiring app repositories to change for catalog repair behavior. Use an existing catalog-only path for that.

## Release Contract

The caller repository must be compatible with pnpm. The reusable workflow runs `pnpm install --frozen-lockfile` before `package_command`, so the repository should commit `pnpm-lock.yaml` and define the package script used by `package_command`.

The caller repository must commit a source manifest:

```text
tutti.app.json
```

The generated package directory must contain:

- `tutti.app.json`
- `bootstrap.sh`
- `AGENTS.md`
- the manifest icon asset, such as `icon.png` or `icon.svg`
- all runtime files and assets

The source and package manifests must use `schemaVersion: "tutti.app.manifest.v1"`. `appId` must match the workflow `app_id` input.

The workflow writes release objects under:

```text
apps/<appId>/<version>/
apps/<appId>/latest.json
apps/<appId>/versions.json
```

For production, the workflow derives the next release version by fetching
existing stable semver tags with the configured `release_tag_prefix` (default
`<appId>-v`), reading the packaged manifest version, and applying
`release_bump` to the greater version. It creates the annotated release tag after
the S3 release has been uploaded and verified. If `release_bump` is empty, the
workflow uses `manifest.version+<short git sha>` from the packaged manifest,
which is intended for staging.

## Reference Caller Workflow

Use this as the default single-app production caller. Production releases should
be workflow-driven so publishing does not need to write version bump commits back
to the protected source branch. Keep new app repositories as close to this
reference as their package command allows.

```yaml
name: Publish Tutti App Production

on:
  workflow_dispatch:
    inputs:
      release_bump:
        description: Semver bump to publish.
        required: true
        type: choice
        default: patch
        options:
          - patch
          - minor
          - major
      publish_catalog:
        description: Whether to publish the production App Center catalog after this release.
        required: false
        type: boolean
        default: true
      catalog_only:
        description: Whether to skip app release upload and only publish the existing latest release to catalog.
        required: false
        type: boolean
        default: false
permissions:
  contents: write
  id-token: write

jobs:
  publish:
    uses: tutti-os/tutti/.github/workflows/publish-tutti-app-release.yml@main
    with:
      app_id: your-app-id
      min_tutti_version: "REQUIRED_MIN_TUTTI_VERSION"
      package_command: pnpm package:tutti
      package_dir: build/tutti-app/package
      icon_path: build/tutti-app/package/icon.png
      release_tag_prefix: your-app-id-v
      release_bump: ${{ inputs.release_bump }}
      create_release_tag: ${{ !inputs.catalog_only }}
      publish_catalog: ${{ inputs.publish_catalog }}
      catalog_only: ${{ inputs.catalog_only }}
      aws_region: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_AWS_REGION || vars.TUTTI_APP_RELEASES_AWS_REGION }}
      aws_role_arn: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_AWS_ROLE_ARN || vars.TUTTI_APP_RELEASES_AWS_ROLE_ARN }}
      s3_bucket: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_S3_BUCKET || vars.TUTTI_APP_RELEASES_S3_BUCKET }}
      s3_prefix: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_S3_PREFIX || vars.TUTTI_APP_RELEASES_S3_PREFIX }}
      release_assets_base_url: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_BASE_URL || vars.TUTTI_APP_RELEASES_BASE_URL }}
      catalog_cloudfront_distribution_id: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID || vars.TUTTI_APP_RELEASES_CLOUDFRONT_DISTRIBUTION_ID || '' }}
```

Use only `workflow_dispatch` for staging unless every merge should publish
staging too. Keep staging and production on separate S3 prefixes and base URLs.

Pin the reusable workflow ref only when the caller needs reproducible release behavior:

```yaml
uses: tutti-os/tutti/.github/workflows/publish-tutti-app-release.yml@<tag-or-commit-sha>
```

For monorepos that publish multiple apps, keep the caller shape the same but
resolve a target matrix from repository config. Each matrix target should expose
the same reusable workflow inputs:

```yaml
app_id: ${{ matrix.target.app_id }}
min_tutti_version: ${{ matrix.target.min_tutti_version }}
package_command: ${{ matrix.target.package_command }}
package_dir: ${{ matrix.target.package_dir }}
icon_path: ${{ matrix.target.icon_path }}
release_tag_prefix: ${{ matrix.target.release_tag_prefix }}
release_bump: ${{ inputs.release_bump }}
create_release_tag: ${{ !inputs.catalog_only }}
```

## Reusable Workflow Inputs

Required release inputs:

- `app_id`: app id, matching the source and package `tutti.app.json`.
- `min_tutti_version`: minimum compatible Tutti SemVer for a normal release. It has no permissive default; catalog-only repairs read the stored rule from `versions.json`.
- `aws_region`: AWS region for the release bucket.
- `aws_role_arn`: IAM role assumed through GitHub OIDC.
- `s3_bucket`: bucket receiving release files.

Conditionally required inputs:

- `package_command`: builds or copies the final package. Required unless `catalog_only` is true.
- `package_dir`: package directory produced by `package_command`. Required unless `catalog_only` is true.
- `release_assets_base_url`: public base URL for `s3_bucket` plus `s3_prefix`. Required unless `catalog_only` is true.

Optional release/version inputs:

- `icon_path`: package-local icon path override. Use when the manifest icon should be resolved from a generated package path.
- `release_tag_prefix`: release tag prefix used when calculating and creating production release tags. Defaults to `<appId>-v`.
- `release_bump`: production semver bump. Valid values are `patch`, `minor`, and `major`. Leave empty for staging.
- `create_release_tag`: create the annotated release tag after the S3 release verifies. Production callers should set this to true; staging callers should leave it false.

Optional catalog inputs:

- `publish_catalog`: after uploading the app release, merge that release into `catalog.json`. Default: `false`.
- `catalog_only`: skip package build, release metadata generation, and app release upload; rebuild the app from `apps/<appId>/versions.json` into `catalog.json`. Default: `false`.
- `catalog_cloudfront_distribution_id`: CloudFront distribution id for invalidating `/<s3_prefix>/catalog.json` after catalog upload. Default: empty. Caller workflows normally read this from `TUTTI_APP_RELEASES_PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID` or `TUTTI_APP_RELEASES_CLOUDFRONT_DISTRIBUTION_ID`; prefer storing the shared value as an organization variable with selected repository access, and use repository variables only for overrides or when organization variables are unavailable. If neither variable is configured, invalidation is skipped and readers rely on the catalog cache TTL.

Optional runtime/tooling inputs:

- `runner`: GitHub runner label. Default: `ubuntu-latest`.
- `node_version`: Node.js version. Default: `24`.
- `pnpm_version`: pnpm version. Default: `10.11.0`.
- `release_tools_package`: app release tools package spec. Default: `@tutti-os/app-release-tools@latest`. Pin this only when debugging or when the reusable workflow depends on a version not yet intended for general use.

## Catalog Publication

An app release writes `apps/<appId>/latest.json` and updates `apps/<appId>/versions.json`. App Center sees it only after the shared catalog includes that app.

Publishing modes:

- Release only: run the app release workflow with `publish_catalog: false` and `catalog_only: false`. This updates `apps/<appId>/latest.json` and `versions.json`; catalog changes wait until a later catalog publish.
- Release and catalog: run the app release workflow with `publish_catalog: true`. This publishes the app and then updates `catalog.json` in the same run.
- Catalog only: run with `catalog_only: true` after a release already exists. This reads the existing `apps/<appId>/versions.json` and updates `catalog.json` without rebuilding, uploading, or bumping a new app version.

Catalog merge semantics:

- App repository release workflows are scoped to their current `app_id`. `publish_catalog: true` and `catalog_only: true` merge only that app's `apps/<appId>/versions.json` into `catalog.json`.
- A release-only app that is not already in `catalog.json` will not be picked up by another app's later `publish_catalog: true` run.
- The Tutti catalog workflows can merge one or more explicitly selected app ids through `app_ids`. Use that path when refreshing multiple apps, or run each app's catalog-only dispatch separately.
- Neither path scans S3 for every published app index. Every app that should be added or refreshed must be the current caller app id or be explicitly listed in `app_ids`.

`catalog.json` keeps schema `tutti.app.catalog.v1`. Its `apps[]` array contains the highest active `minTuttiVersion: 0.0.0` release for old clients. New clients read the additive compact `compatibility.apps` frontier. Mutable metadata writes use S3 ETag preconditions because GitHub concurrency groups do not serialize workflows across different repositories.

Catalog-only can be exposed by the app repository caller workflow, or run from the Tutti catalog workflows:

- Production: <https://github.com/tutti-os/tutti/actions/workflows/publish-tutti-app-catalog.yml>
- Staging: <https://github.com/tutti-os/tutti/actions/workflows/publish-tutti-app-catalog-staging.yml>

Recommended inputs for refresh/repair:

- `catalog_mode`: `merge`
- `app_ids`: the released remote app id, such as `vibe-design`
- Leave AWS, S3, prefix, and CloudFront inputs empty unless overriding organization or repository variables.

Use `replace` only for deliberate full catalog replacement. Built-in app ids such as `automation` are not published through the remote catalog workflow.

Catalog writes:

```text
s3://<s3_bucket>/<s3_prefix>/catalog.json
```

If `catalog.json` changed but App Center still shows old metadata, check CloudFront invalidation and confirm `TUTTI_APP_CATALOG_URL` points at the expected staging or production URL.

## AWS Requirements

The caller repository needs a GitHub OIDC role that can write release files:

```text
s3://<s3_bucket>/<s3_prefix>/apps/<appId>/<version>/*
s3://<s3_bucket>/<s3_prefix>/apps/<appId>/latest.json
s3://<s3_bucket>/<s3_prefix>/apps/<appId>/versions.json
```

When `publish_catalog` or `catalog_only` is used in the app release workflow, that role also needs catalog read/write access:

```text
s3://<s3_bucket>/<s3_prefix>/catalog.json
```

CloudFront invalidation requires permission for the matching distribution id. Store shared non-secret configuration such as the CloudFront distribution id in GitHub organization variables with selected repository access when possible; use repository variables only for repository-specific overrides.

## Local Validation

Before relying on GitHub Actions, validate the package locally:

```sh
pnpm --package @tutti-os/app-release-tools@latest dlx build-tutti-app-release \
  --app-id your-app-id \
  --package-dir build/tutti-app/package \
  --output-dir /tmp/tutti-app-release \
  --base-url https://cdn.example.com/tutti-app-releases \
  --version 0.1.0+local \
  --git-sha local
```

Expected output:

- `/tmp/tutti-app-release/apps/<appId>/<version>/<appId>-<version>.zip`
- `/tmp/tutti-app-release/apps/<appId>/<version>/release.json`
- `/tmp/tutti-app-release/apps/<appId>/latest.json`

Normal publishing also creates or updates the remote `apps/<appId>/versions.json` compatibility index.

## Completion Checklist

- Caller workflow uses `tutti-os/tutti/.github/workflows/publish-tutti-app-release.yml`.
- `package_command` produces `package_dir`.
- `package_dir/tutti.app.json` is valid JSON and `appId` matches workflow `app_id`.
- Package contains `bootstrap.sh`, `AGENTS.md`, icon asset, and runtime files.
- `s3_prefix` and `release_assets_base_url` point to the same public release root.
- Staging and production use separate prefixes.
- Catalog refresh after an existing successful release uses `catalog_only` or the Tutti catalog workflow instead of a new release.

## Common Failures

- `manifest appId must match app id`: align workflow `app_id` and manifest `appId`.
- `missing tutti.app.json`: fix package generation so the package directory contains a manifest.
- `release_bump must be one of major, minor, or patch`: production callers must pass a supported bump type.
- `create_release_tag requires release_bump`: release tags are only created for workflow-driven production bumps.
- `manifest icon asset missing`: include the asset inside the package or pass `icon_path`.
- AWS `AccessDenied`: check OIDC trust policy, role ARN, bucket policy, region, prefix, and catalog/CloudFront permissions.
- Release succeeded but App Center does not show it: publish or refresh the catalog with `catalog_only` or the Tutti catalog workflow in merge mode.
