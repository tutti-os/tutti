# Desktop Release

This document defines the durable release conventions for the Tutti desktop app.

## Scope

Desktop releases for `apps/desktop` use two GitHub Release shapes:

- stable releases such as `tutti-desktop-v1.12.20`, which should become `Latest`
- release candidates such as `tutti-desktop-v1.12.19-rc.0`, which should remain `Pre-release`

The current release flow intentionally includes:

- GitHub Release publishing
- macOS, Windows, and Linux desktop artifacts
- Electron auto-update metadata
- release candidate (`rc`) prereleases
- Feishu release notification

The current release flow intentionally excludes:

- nightly releases
- S3 runtime artifacts

## Workflow Status

The desktop release workflow is currently soft-disabled.

`.github/workflows/desktop-release.yml` only runs release jobs when this repository variable is set:

```text
TUTTI_DESKTOP_RELEASE_WORKFLOW_ENABLED=true
```

When the variable is missing or set to any other value, the workflow may be triggered by GitHub, but the release jobs are skipped.

Use this switch when release infrastructure exists in the repository but should not publish artifacts yet.

## Release Workflow

The release workflow file is `.github/workflows/desktop-release.yml`.

Supported triggers:

- pushing a tag matching `tutti-desktop-v*`
- scheduled run at `01:30 UTC` every day
- manual `workflow_dispatch`

Supported manual modes:

- `patch_rc_release`: default manual mode, used for the usual next RC such as `1.12.21-rc.0` then `1.12.21-rc.1`
- `patch_release`: resolve the next patch stable tag and publish it
- `minor_release`: resolve the next minor stable tag and publish it
- `major_release`: resolve the next major stable tag and publish it
- `explicit_version_release`: publish an explicit release semver such as `0.1.0`, `0.1.0-rc.0`, `1.13.0-rc.0`, or `2.0.0`
- `unsigned_dry_run`: build unsigned artifacts without publishing a GitHub Release

Less common RC bump shapes are still supported by the release resolver, but the manual workflow form intentionally keeps `minor_rc_release` and `major_rc_release` behind explicit version entry to reduce operator choice overload.

The release tag prefix is:

```text
tutti-desktop-v
```

The desktop package version is aligned from the release tag during CI.

Stable releases must use plain semver such as `1.12.20`.

Release candidates must use the `-rc.<n>` suffix, such as `1.12.19-rc.0`.

Do not introduce nightly-only desktop version suffixes. Use `rc` prereleases instead when a build should be published ahead of the next stable release.

## Artifacts

Packaging is driven by:

```text
tools/scripts/build-desktop-package.sh
```

Before running `electron-builder`, the script builds `services/tuttid` and places the daemon under:

```text
apps/desktop/build/tuttid/
```

For macOS packages, the bundled `tuttid` daemon and `tutti` CLI must be universal binaries. Build both `darwin/arm64` and `darwin/amd64`, merge them with `lipo`, and verify the resulting binary contains `arm64` and `x86_64` slices before packaging.

`electron-builder` then packages that daemon into the desktop app as:

```text
Contents/Resources/bin/tuttid
```

On Windows the bundled daemon filename is `tuttid.exe`.

Expected release artifacts include:

- macOS x64, arm64, and universal `.dmg`
- macOS x64, arm64, and universal `.zip`
- Windows `.exe`
- Linux `.AppImage`
- update metadata such as `.yml` and `.blockmap`
- `SHA256SUMS.txt`

Release notes and Feishu notifications should point the primary macOS download at the universal `.dmg`. The x64 and arm64 artifacts remain attached to the GitHub Release for users or deployment tools that want an architecture-specific installer.

## Auto Update

The desktop app uses `electron-updater` and GitHub Releases as the update source.

Current updater behavior:

- stable channel only
- packaged builds only
- default policy is `prompt`
- scheduled update check interval is three hours
- macOS update checks are disabled for unsupported unsigned or ad-hoc bundles

macOS auto-update metadata must keep x64, arm64, and universal zip entries in `latest-mac.yml`. The file names must include `${arch}` so `electron-updater` can distinguish `mac-x64`, `mac-arm64`, and `mac-universal` assets.

For automatic updates, electron-updater should download the same-architecture zip first: Intel Macs use `mac-x64.zip`, Apple Silicon Macs use `mac-arm64.zip`, and `mac-universal.zip` remains a fallback and the primary manual download. Do not make universal the only auto-update zip while architecture-specific packages exist.

Policy meanings:

- `off`: update checks are disabled
- `prompt`: check for updates and let the user choose when to download and restart
- `auto`: download automatically and install on app quit

Renderer update copy must stay in the desktop i18n resources.

## Feishu Notification

Release notification is handled by:

```text
apps/desktop/scripts/send-release-feishu-card.mjs
```

After a successful publish, the workflow sends a Feishu card when:

- `notify_feishu` is true
- the `FEISHU_RELEASE_WEBHOOK_URL` secret is configured

If the webhook secret is missing, the workflow skips notification instead of failing the release.

The card links to available macOS, Windows, Linux, GitHub Release, and workflow run URLs.

When `TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL` is configured, the download buttons prefer the mirrored release asset base URL instead of GitHub asset URLs. If the explicit base URL is absent but S3 mirroring is configured, the workflow falls back to the S3 accelerate base URL.

After a successful mirrored upload, the workflow also upserts a managed `Direct Downloads` section into the GitHub Release body so the release description matches the Feishu direct links.

The mirrored desktop release also writes mutable `latest.json` metadata at the release asset prefix root. That file lists the current desktop release tag, version, and CloudFront/static URLs for every uploaded asset:

```text
https://<asset-base-url>/latest.json
```

## Required Secrets

Signed macOS releases require:

- `MACOS_CSC_LINK`
- `MACOS_CSC_KEY_PASSWORD`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Feishu notification requires:

- `FEISHU_RELEASE_WEBHOOK_URL`

`GITHUB_TOKEN` is provided by GitHub Actions.

## Optional Release Asset Mirror

Desktop release assets can optionally be mirrored to AWS S3 and exposed through CloudFront or another static base URL.

Repository variables:

- `AWS_REGION`
- `TUTTI_ARTIFACTS_AWS_ROLE_ARN`
- `TUTTI_DESKTOP_RELEASE_ASSETS_S3_BUCKET`
- `TUTTI_DESKTOP_RELEASE_ASSETS_S3_PREFIX`
- `TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL`

Recommended setup:

- set `TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL` to the CloudFront distribution path, such as `https://d111111abcdef8.cloudfront.net/desktop-release-assets`
- keep the S3 bucket and prefix configured so the workflow can upload mirrored assets

If `TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL` is omitted, the workflow falls back to:

```text
https://<bucket>.s3-accelerate.amazonaws.com/<prefix>
```

## Local Validation

Before changing release infrastructure, run the narrowest useful checks first, then broaden.

Useful commands:

```bash
pnpm --filter @tutti-os/desktop build
pnpm --filter @tutti-os/desktop build:unpack
pnpm check:full
```

Use `build:unpack` to verify that the Electron bundle can be assembled locally and that `tuttid` is present under the packaged app resources.

## Operational Notes

Stable releases should remain the only builds that claim the GitHub `Latest` slot.

Release candidates should always publish as GitHub prereleases and must not replace the current stable `Latest` release.

Workspace app runtime artifacts are a separate release surface owned by [Workspace App Runtime](./workspace-app-runtime.md). Do not publish or rebuild those artifacts from the desktop release workflow.

When changing desktop release behavior, update this document in the same change.
