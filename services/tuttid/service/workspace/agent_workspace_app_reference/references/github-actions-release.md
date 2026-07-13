# GitHub Actions Release Workflows

Use this reference when creating or updating GitHub Actions that publish a Tutti app package to the Tutti App Center release bucket and catalog.

## When To Add

Add release workflows when the target repository is expected to publish a Tutti app from GitHub. Do not add them for local-only prototypes, throwaway demos, or repositories that cannot use GitHub OIDC to assume the Tutti release AWS role.

Create both files for app repositories that need normal staging/production publishing:

- `.github/workflows/publish-tutti-app-staging.yml`
- `.github/workflows/publish-tutti-app.yml`

Keep PR checks separate from publishing. PR workflows should build, test, run i18n checks, and run `pnpm package:tutti`; only manual dispatch or protected release flows should upload release artifacts or catalogs.

## Shared Workflow

Use the reusable Tutti release workflow instead of reimplementing S3/catalog logic:

```yaml
uses: tutti-os/tutti/.github/workflows/publish-tutti-app-release.yml@main
```

This reusable workflow builds, publishes, and verifies the app package. It can also create a release tag and publish the App Center catalog.

## Version compatibility contract

Declare one exact stable SemVer in `min_tutti_version` for every normal release. Choose the earliest Tutti version that contains every host API and runtime contract used by the app. Use `0.0.0` only when the app requires no minimum Tutti version. Publish a new app version when this minimum changes.

The Agent CLI catalog schema v2 and composer visibility contract ship in the `0.1.19` release line. Production apps that use the `@tutti-os/agent-acp-kit/tutti` auto facade require `min_tutti_version: "0.1.19"` or later and must pin the exact stable kit version validated with that Tutti release.

## Production Workflow Template

Fill `app_id`, `package_command`, `package_dir`, `icon_path`, `release_tag_prefix`, `runner`, and `pnpm_version` from the app repository.

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
        description: Whether to refresh this app in the catalog without publishing a new release.
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
      app_id: <app-id>
      min_tutti_version: <minimum-supported-tutti-semver>
      package_command: pnpm package:tutti
      package_dir: build/tutti-app/package
      icon_path: build/tutti-app/package/icon.png
      release_tag_prefix: <app-id>-v
      release_bump: ${{ inputs.release_bump }}
      create_release_tag: ${{ !inputs.catalog_only }}
      runner: ubuntu-latest
      pnpm_version: 10.26.2
      aws_region: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_AWS_REGION || vars.TUTTI_APP_RELEASES_AWS_REGION }}
      aws_role_arn: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_AWS_ROLE_ARN || vars.TUTTI_APP_RELEASES_AWS_ROLE_ARN }}
      s3_bucket: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_S3_BUCKET || vars.TUTTI_APP_RELEASES_S3_BUCKET }}
      s3_prefix: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_S3_PREFIX || vars.TUTTI_APP_RELEASES_S3_PREFIX }}
      release_assets_base_url: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_BASE_URL || vars.TUTTI_APP_RELEASES_BASE_URL }}
      publish_catalog: ${{ inputs.publish_catalog }}
      catalog_only: ${{ inputs.catalog_only }}
      catalog_cloudfront_distribution_id: ${{ vars.TUTTI_APP_RELEASES_PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID || vars.TUTTI_APP_RELEASES_CLOUDFRONT_DISTRIBUTION_ID || '' }}
```

Use `macos-latest` only when packaging depends on macOS-only tooling. Prefer `ubuntu-latest` for web/server-only apps.

## Staging Workflow Template

Staging should not require semver bump or tag creation. It can publish a build-addressed release and optionally refresh the staging catalog.

```yaml
name: Publish Tutti App Staging

on:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      publish_catalog:
        description: Whether to publish the staging App Center catalog after this release. Main branch pushes always publish the catalog.
        required: false
        type: boolean
        default: false
      catalog_only:
        description: Whether to refresh this app in the staging catalog without publishing a new release.
        required: false
        type: boolean
        default: false

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    uses: tutti-os/tutti/.github/workflows/publish-tutti-app-release.yml@main
    with:
      app_id: <app-id>
      min_tutti_version: <minimum-supported-tutti-semver>
      package_command: pnpm package:tutti
      package_dir: build/tutti-app/package
      icon_path: build/tutti-app/package/icon.png
      runner: ubuntu-latest
      pnpm_version: 10.26.2
      aws_region: ${{ vars.TUTTI_APP_RELEASES_STAGING_AWS_REGION || vars.TUTTI_APP_RELEASES_AWS_REGION }}
      aws_role_arn: ${{ vars.TUTTI_APP_RELEASES_STAGING_AWS_ROLE_ARN || vars.TUTTI_APP_RELEASES_AWS_ROLE_ARN }}
      s3_bucket: ${{ vars.TUTTI_APP_RELEASES_STAGING_S3_BUCKET || vars.TUTTI_APP_RELEASES_S3_BUCKET }}
      s3_prefix: ${{ vars.TUTTI_APP_RELEASES_STAGING_S3_PREFIX || 'tutti-app-releases-staging' }}
      release_assets_base_url: ${{ vars.TUTTI_APP_RELEASES_STAGING_BASE_URL }}
      publish_catalog: ${{ github.event_name == 'push' || inputs.publish_catalog }}
      catalog_only: ${{ github.event_name == 'workflow_dispatch' && inputs.catalog_only }}
      catalog_cloudfront_distribution_id: ${{ vars.TUTTI_APP_RELEASES_STAGING_CLOUDFRONT_DISTRIBUTION_ID || vars.TUTTI_APP_RELEASES_CLOUDFRONT_DISTRIBUTION_ID || '' }}
```

## Variables

Prefer organization-level GitHub Actions variables for shared Tutti release infrastructure so new app repositories can reuse the same workflows without copying repo-local configuration. Grant the organization variables only to repositories that are allowed to publish Tutti apps.

Recommended organization variables:

- `TUTTI_APP_RELEASES_AWS_REGION`
- `TUTTI_APP_RELEASES_AWS_ROLE_ARN`
- `TUTTI_APP_RELEASES_S3_BUCKET`
- `TUTTI_APP_RELEASES_S3_PREFIX`
- `TUTTI_APP_RELEASES_BASE_URL`
- `TUTTI_APP_RELEASES_CLOUDFRONT_DISTRIBUTION_ID`
- `TUTTI_APP_RELEASES_STAGING_AWS_REGION`
- `TUTTI_APP_RELEASES_STAGING_AWS_ROLE_ARN`
- `TUTTI_APP_RELEASES_STAGING_S3_BUCKET`
- `TUTTI_APP_RELEASES_STAGING_S3_PREFIX`
- `TUTTI_APP_RELEASES_STAGING_BASE_URL`
- `TUTTI_APP_RELEASES_STAGING_CLOUDFRONT_DISTRIBUTION_ID`
- `TUTTI_APP_RELEASES_PRODUCTION_AWS_REGION`
- `TUTTI_APP_RELEASES_PRODUCTION_AWS_ROLE_ARN`
- `TUTTI_APP_RELEASES_PRODUCTION_S3_BUCKET`
- `TUTTI_APP_RELEASES_PRODUCTION_S3_PREFIX`
- `TUTTI_APP_RELEASES_PRODUCTION_BASE_URL`
- `TUTTI_APP_RELEASES_PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID`

Use repository-level variables for app-specific overrides, migration periods, repositories that publish to a separate bucket, prefix, base URL, or role, and private repositories that cannot read organization variables. Do not create long-lived AWS secrets for this flow; the release workflow uses GitHub OIDC with `id-token: write` and an AWS role ARN.

Staging callers must set `TUTTI_APP_RELEASES_STAGING_BASE_URL` explicitly. Do not let staging inherit `TUTTI_APP_RELEASES_BASE_URL`, because that can write production asset URLs into staging release metadata.

## Validation

Before considering the release workflows ready:

- Run `pnpm package:tutti` locally or in CI.
- Confirm `package_dir` contains `tutti.app.json`, `bootstrap.sh`, icon assets, built web assets, server bundle, and locales.
- Confirm the app id in `tutti.app.json`, `app_id`, and `release_tag_prefix` are consistent.
- Confirm the selected runner can build the app package.
- Confirm the organization or repository variables are visible to the app repository.
- When `min_tutti_version` is greater than `0.0.0`, confirm a lower Tutti version does not select the release.
- Confirm the declared minimum or a newer Tutti version selects the release. For `0.0.0`, also test the oldest supported Tutti version.
- Run the staging workflow first, then production only after the staging release and optional staging catalog are verified.
