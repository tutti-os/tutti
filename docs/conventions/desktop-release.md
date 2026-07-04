# Desktop Release

This document defines the durable release conventions for the Tutti desktop app.

## Scope

Desktop releases for `apps/desktop` use three GitHub Release shapes:

- stable releases such as `v1.12.20`, which should become `Latest`
- release candidates such as `v1.12.19-rc.0`, which should remain `Pre-release`
- beta releases such as `v1.12.19-beta.0`, which should remain `Pre-release`

The current release flow intentionally includes:

- GitHub Release publishing
- macOS, Windows, and Linux desktop artifacts
- Electron auto-update metadata
- release candidate (`rc`) prereleases
- beta prereleases for development-branch packaging
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

- pushing a tag matching `v*`
- scheduled run at `20:16 UTC` every day (`04:16` Beijing time)
- manual `workflow_dispatch`

Supported manual modes:

- `patch_rc_release`: default manual mode, used for the usual next RC such as `1.12.21-rc.0` then `1.12.21-rc.1`
- `patch_beta_release`: resolve the next patch beta tag, publish it as an isolated development-branch prerelease, and keep it out of stable latest metadata
- `patch_release`: resolve the next patch stable tag and publish it
- `minor_release`: resolve the next minor stable tag and publish it
- `major_release`: resolve the next major stable tag and publish it
- `explicit_version_release`: publish an explicit release semver such as `0.1.0`, `0.1.0-beta.0`, `0.1.0-rc.0`, `1.13.0-rc.0`, or `2.0.0`
- `unsigned_dry_run`: build unsigned artifacts without publishing a GitHub Release

Less common RC bump shapes are still supported by the release resolver, but the manual workflow form intentionally keeps `minor_rc_release` and `major_rc_release` behind explicit version entry to reduce operator choice overload.

The release tag prefix is:

```text
v
```

The desktop package version is aligned from the release tag during CI.

Stable releases must use plain semver such as `1.12.20`.

Release candidates must use the `-rc.<n>` suffix, such as `1.12.19-rc.0`.

Beta builds must use the `-beta.<n>` suffix, such as `1.12.19-beta.0`.

Use beta for earlier development-branch packaging that should not affect RC validation or stable public downloads. Use RC for release-candidate validation after the team believes a stable release is close.

Do not introduce nightly-only desktop version suffixes. Use `beta` or `rc` prereleases instead when a build should be published ahead of the next stable release.

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

Vendored Node runtimes that bring their own Mach-O binaries, such as `claude-sdk-sidecar`, must be compatible with Electron's universal merge. If the same packaged binary is copied into both the x64 and arm64 app bundles, cover that path with `build.mac.x64ArchFiles` so `@electron/universal` can skip `lipo` for the duplicate resource.

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

- stable packages default to the stable release channel
- RC packages default to the `rc` release channel when no stored preference exists
- `rc` release channel is available as an internal opt-in from developer settings
- beta release artifacts can be published independently, but beta auto-update is not exposed in developer settings yet
- packaged builds only
- default policy is `prompt`
- scheduled update check interval is three hours
- macOS update checks are disabled for unsupported unsigned or ad-hoc bundles
- packaged macOS builds launched from `/Volumes` must stop before the main
  desktop services start, prompt the user to move Tutti to `/Applications`, and
  quit if the user declines or the automatic move cannot complete
- macOS update installs must let `quitAndInstall()` trigger the app quit, then
  use the desktop `before-quit` gate to stop managed `tuttid`, destroy windows,
  and allow the app process to exit before Squirrel.Mac replaces the bundle

Channel meanings:

- `stable`: maps to electron-updater `channel="latest"` with `allowPrerelease=false`
- `rc`: maps to electron-updater `channel="rc"` with `allowPrerelease=true`
- `beta`: reserved for beta prerelease artifacts such as `v1.12.19-beta.0`; expose it in developer settings only if the team decides beta users should auto-update between beta builds

When no desktop preference has been stored yet, the initial update channel follows the package version: plain stable versions use `stable`, `-rc.N` versions use `rc`, and `-beta.N` versions still use `stable` until beta auto-update is explicitly exposed. Existing stored `rc` defaults from older stable builds are migrated back to `stable` once. After that migration, users who explicitly select `rc` in developer settings keep that preference.

Prerelease auto-update depends on both release shape and update metadata:

- RC tags must use semver prerelease shape, such as `v1.12.21-rc.1`
- beta tags must use semver prerelease shape, such as `v1.12.21-beta.1`
- RC GitHub Releases must remain `Pre-release` and must not become GitHub `Latest`
- beta GitHub Releases must remain `Pre-release` and must not become GitHub `Latest`
- prerelease build artifacts must include channel updater metadata such as `rc-mac.yml` or `beta-mac.yml`; the release workflow materializes `${channel}-mac.yml` from the generated macOS updater metadata before uploading prerelease artifacts

macOS auto-update metadata must keep x64, arm64, and universal zip entries in `latest-mac.yml` and prerelease channel equivalents such as `rc-mac.yml` or `beta-mac.yml`. The file names must include `${arch}` so `electron-updater` can distinguish `mac-x64`, `mac-arm64`, and `mac-universal` assets.

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

Stable mirrored desktop releases also write mutable `latest.json` metadata at the release asset prefix root. That file lists the current stable desktop release tag, version, channel, preferred downloads, and CloudFront/static URLs for every uploaded asset:

```text
https://<asset-base-url>/latest.json
```

The prefix-root `latest.json` is a public stable contract. Release candidates and beta builds may upload immutable assets under their tag directory, but they must not update the prefix-root `latest.json`.

Prerelease builds may also update channel-scoped latest metadata:

```text
https://<asset-base-url>/channels/preview/latest.json
https://<asset-base-url>/channels/rc/latest.json
https://<asset-base-url>/channels/beta/latest.json
```

`preview` is the user-facing name for the RC channel. RC releases write both `channels/preview/latest.json` and `channels/rc/latest.json`. Beta releases write only `channels/beta/latest.json`.

The `latest.json` metadata must include stable-identifying fields:

- `channel: "stable"`
- `prerelease: false`
- a plain semver `version`, without `-rc` or `-beta`
- a stable `tag`, such as `v1.12.20`
- `preferredDownloads.macosUniversalDmg`

External download workers should treat these fields as a fail-closed contract. If the metadata is missing, malformed, or points at an RC or beta tag, the worker must not return that package as the public download.

The download worker may expose `channel=preview` and `channel=beta` query parameters for internal links. Missing `channel` must default to `stable`. `channel=preview` must read RC metadata only; it must not fall back to beta.

The `tutti-desktop-download` Worker is currently maintained directly in the Cloudflare Dashboard production editor, not in this repository. Update the production Worker there and keep this document aligned with the public contract.

The Worker supports:

```text
/desktop/download?platform=macos&arch=universal&format=dmg
/desktop/download?channel=stable&platform=macos&arch=universal&format=dmg
/desktop/download?channel=preview&platform=macos&arch=universal&format=dmg
/desktop/download?channel=beta&platform=macos&arch=universal&format=dmg
```

Stable mirrored releases also update the aggregate changelog feed:

```text
https://<asset-base-url>/changelog.json
```

`changelog.json` is updated only for stable releases. RC and beta builds can still generate per-run summaries for Feishu and GitHub Release notes, but they should not appear on the public changelog feed unless that policy is changed explicitly.

## Release Summaries

The desktop release workflow generates `release-summary.json` for every published desktop release.

Summary generation is best-effort:

- if `AGNES_API_KEY` is configured, the workflow asks Agnes to summarize commits and diff stats
- if the key is missing, the API fails, or the response is invalid, the workflow falls back to a deterministic commit-based summary

The summary is used to:

- upsert a managed English `Release Summary` section into the GitHub Release body
- enrich the Feishu release card with the Chinese summary when Feishu notification is enabled
- update `changelog.json` for stable releases

Do not commit real model API keys. Configure `AGNES_API_KEY` as a GitHub secret.

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

Release candidates and beta builds should always publish as GitHub prereleases and must not replace the current stable `Latest` release.

Workspace app runtime artifacts are a separate release surface owned by [Workspace App Runtime](./workspace-app-runtime.md). Do not publish or rebuild those artifacts from the desktop release workflow.

When changing desktop release behavior, update this document in the same change.
