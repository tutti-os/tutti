# Desktop Release

This document defines the durable release conventions for the Tutti desktop app.

## Scope

Desktop releases for `apps/desktop` use three GitHub Release shapes:

- stable releases such as `v1.12.20`, which should become `Latest`
- release candidates such as `v1.12.19-rc.0`, which should remain `Pre-release`
- beta releases such as `v1.12.19-beta.0`, which should remain `Pre-release`

The formal desktop release flow currently includes:

- GitHub Release publishing
- macOS desktop artifacts
- default unsigned Windows RC/stable artifacts
- Electron auto-update metadata
- release candidate (`rc`) prereleases
- beta prereleases for development-branch packaging
- Feishu release notification

The current release flow intentionally excludes:

- nightly releases
- S3 runtime artifacts
- Linux artifacts
- Microsoft Store RC/beta products and package flights

Windows packaging remains available through
`.github/workflows/windows-desktop-alpha.yml` for smoke validation. Pull
requests always run Windows tests and build the Desktop bundles, while only
packaging-input changes build and smoke-test the unsigned NSIS installer.
Manual Alpha runs always build the installer. The workflow generates builtin
apps once and then uses `build:win:prepared`; that command requires
`pnpm generate:builtin-apps` to have completed first. The formal
`.github/workflows/desktop-release.yml` workflow always builds Windows. It
builds an unsigned Windows NSIS
installer and stages its `.exe`, `.blockmap`, and updater `.yml` beside the
macOS draft assets. Scheduled RC builds, pushed RC/stable tags, and manual
RC/stable releases therefore all require Windows to succeed. See
[Windows Platform Support](../architecture/windows-platform-support.md) for the
promotion gates.

## Workflow Status

The desktop release workflow has a repository-level soft-enable guard.

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

RC and beta releases promote automatically after staging. Stable releases
always stop as a candidate and require the separate Promotion workflow and its
protected Environment approval before publication. There is no manual
publication-mode switch.

Windows is included by default and is intentionally unsigned for now. A
Windows build or artifact validation failure blocks staging so an RC or stable
release cannot silently publish only macOS assets.

Manual RC and stable release modes (`patch_rc_release`, `patch_release`, `minor_release`, and `major_release`) are branch-gated before tag resolution or artifact builds:

- the workflow dispatch branch must be `main` or `release/*`
- if any remote `release/*` branch exists, stable releases must be dispatched from a `release/*` branch instead of `main`

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

The Electron 43 desktop runtime supports macOS 12 and later. Release CI must
run `pnpm --filter @tutti-os/desktop exec install-electron` after the frozen
workspace install so packaging never relies on Electron's lazy runtime
download.

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

Vendored Node bundles (`claude-sdk-sidecar`, `browser-mcp`) must stay free of platform-specific Mach-O binaries so every architecture ships identical resources. The Claude native binary (`@anthropic-ai/claude-agent-sdk-<platform>`, ~230MB per platform) is deliberately excluded from the bundle: `vendor-claude-sdk-sidecar.mjs` installs with `--omit=optional`, and tuttid provisions the binary at runtime from the CDN published by `publish-claude-code-binaries.yml` (npm mirrors as fallback; see `services/tuttid/service/agentstatus/claude_binary.go`). When the pinned `@anthropic-ai/claude-agent-sdk` version changes, that workflow must publish the matching binaries before the release ships.

`electron-builder` then packages that daemon into the desktop app as:

```text
Contents/Resources/bin/tuttid
```

The Electron `app.asar` file list is allowlisted to built `out/**` runtime
outputs plus the package manifest. Do not package repository `src/**`, tests,
scripts, or documentation into the application archive. Production
`node_modules` dependencies remain managed by `electron-builder`.
Assets served through `tutti-asset://` must be emitted explicitly into
`out/renderer/assets/tutti-asset/<route>` and resolved by that exact route.
Packaged builds must not depend on repository source paths or hashed filename
prefix scans as a runtime fallback.

On Windows the bundled daemon filename is `tuttid.exe`.

The formal release workflow currently produces:

- macOS x64, arm64, and universal `.dmg`
- macOS x64, arm64, and universal `.zip`
- macOS update metadata such as `.yml` and `.blockmap`
- `SHA256SUMS.txt`

Windows `.exe`/`.blockmap`/`.yml` are required formal-release artifacts. Linux
`.AppImage` remains a target
artifact shape, not a formal-release output. Windows assets are staged on the
GitHub Release and mirror. Promotion verifies the staged installer, blockmap,
channel updater metadata (version, installer path, and SHA-512), and the size
and checksum of each mirrored S3/CloudFront object before moving the public
channel pointer. Stable/public channel promotion remains controlled by the
existing release promotion gates.

The Store build is deliberately separate from the Direct artifact set. It uses
`build:win:store` to produce one x64 AppX whose identity, publisher, and display
name come from the selected GitHub Environment. It must not add AppX files to
the Direct GitHub Release, S3 mirror, CloudFront updater metadata, or
`SHA256SUMS.txt`.

The Store manifest explicitly targets Windows `10.0.17763.0` or later and
declares `10.0.26100.0` as `MaxVersionTested`. The minimum is the Windows 10
1809 floor required by the current Microsoft Store MSIX submission path. This
is higher than the legacy AppX package that was previously accepted for the
product, so a Store package built from this configuration may not be offered as
an update to devices below that OS version.

Store visual assets must retain transparent pixels, and the manifest must use
`BackgroundColor="transparent"`; otherwise Windows composites the logo over the
declared tile color even when the PNG has an alpha channel. The manifest also
sets `AppListEntry="default"` explicitly so Tutti is registered in the Start
menu's All Apps list. It declares a native `desktop7:Shortcut` targeting the
user's desktop so supported Windows versions create `Tutti.lnk` during package
registration. Because that extension requires Windows build `19645` or later,
the `desktop7` namespace remains ignorable so older supported Windows releases
still install the package and retain the Start menu entry.

The desktop package description is the product tagline
`Where people and agents build in tune.`. Electron-builder injects this value
into the Store manifest description and the desktop package metadata. The
English welcome copy uses the same tagline; technical `local-first` terms in
architecture docs, tests, and catalog strategy values are intentionally not
rewritten as product copy.

`.github/workflows/desktop-store-submit.yml` supports two modes:

- a manual test run can build and validate the package with `submit=false`;
- a stable release can submit the package to Partner Center with `submit=true`.

Manual validation may set `verify_release_tag=false` when the target is an
untagged branch commit. Production and release-triggered calls keep the default
`verify_release_tag=true` guard.

The Microsoft Store Developer CLI cannot complete an application's first
submission from a loose MSIX file. Complete the first submission once in
Partner Center by uploading the validated AppX artifact and filling the Store
listing, properties, age rating, pricing, and availability. After that first
submission exists, the workflow can publish later package updates
automatically. Electron-builder produces the validated AppX payload; the
workflow creates a byte-identical `.msix` submission alias because the CLI
recognizes loose MSIX inputs but does not recognize the equivalent `.appx`
extension. The alias is created and hash-checked before any Partner Center
submission.

The automatic stable call is enabled only when the repository variable below
is true:

```text
TUTTI_WINDOWS_STORE_SUBMISSION_ENABLED=true
```

It always selects the protected `microsoft-store-production` Environment and
accepts only plain stable tags and starts after Direct promotion succeeds. RC
and beta runs continue through the existing Direct NSIS/CDN flow without a
production Store submission. The Store job is downstream from Direct
promotion, so Store certification delay or failure cannot block or roll back
Direct promotion.

The release workflow builds macOS x64, arm64, and universal packages as a
three-entry GitHub Actions matrix. Each architecture uploads an isolated
intermediate artifact. The stage job flattens those artifacts and rebuilds one
channel updater manifest (`latest-mac.yml`, `rc-mac.yml`, or `beta-mac.yml`)
from the three signed ZIP files, including fresh SHA-512 digests and sizes.
This prevents same-named per-architecture updater manifests from overwriting
one another when matrix artifacts are downloaded.

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
- Windows Store packages disable `electron-updater` and hide the Direct release
  channel control; Microsoft Store is their only update owner
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

The update channel follows the installed package whenever the packaged app version changes: plain stable versions use `stable`, `-rc.N` versions use `rc`, and `-beta.N` versions still use `stable` until beta auto-update is explicitly exposed. The desktop records the last installed version after aligning the persisted preference, so ordinary restarts of the same version preserve a user's manual channel selection. Existing stored `rc` defaults from older stable builds are migrated back to `stable` once; the installed-version alignment then applies the channel of the package that is actually running.

Prerelease auto-update depends on both release shape and update metadata:

- RC tags must use semver prerelease shape, such as `v1.12.21-rc.1`
- beta tags must use semver prerelease shape, such as `v1.12.21-beta.1`
- RC GitHub Releases must remain `Pre-release` and must not become GitHub `Latest`
- beta GitHub Releases must remain `Pre-release` and must not become GitHub `Latest`
- prerelease build artifacts must include channel updater metadata such as `rc-mac.yml` or `beta-mac.yml`; the release workflow materializes `${channel}-mac.yml` from the generated macOS updater metadata before uploading prerelease artifacts

macOS auto-update metadata must keep x64, arm64, and universal zip entries in `latest-mac.yml` and prerelease channel equivalents such as `rc-mac.yml` or `beta-mac.yml`. The file names must include `${arch}` so `electron-updater` can distinguish `mac-x64`, `mac-arm64`, and `mac-universal` assets.

For automatic updates, electron-updater should download the same-architecture zip first: Intel Macs use `mac-x64.zip`, Apple Silicon Macs use `mac-arm64.zip`, and `mac-universal.zip` remains a fallback and the primary manual download. Do not make universal the only auto-update zip while architecture-specific packages exist.

The pinned `electron-updater` macOS selection behavior also accepts a
universal-only updater manifest on both x64 and arm64. Keep this fallback under
test so a future updater dependency change cannot silently break universal
compatibility, even though normal releases continue to prefer matching
architecture-specific ZIP files.

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

After a successful stage or promotion, the workflow sends a Feishu card when:

- `notify_feishu` is true
- the `FEISHU_RELEASE_WEBHOOK_URL` secret is configured

If the webhook secret is missing, the workflow skips notification instead of failing the release.

For a stable candidate, the card shows up to six user-facing Chinese changes, links to candidate downloads and the editable Draft Release, and opens the Promotion workflow for review submission. It deliberately omits commit IDs, candidate IDs, compare ranges, branches, and QA-only notes. Sending the card does not update `latest.json`, `changelog.json`, or the floating `stable` release.

The card links to available macOS and Windows downloads, the GitHub Release, the workflow run, and—for stable candidates—the Promotion workflow.

When `TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL` is configured, the download buttons prefer the mirrored release asset base URL instead of GitHub asset URLs. If the explicit base URL is absent but S3 mirroring is configured, the workflow falls back to the S3 accelerate base URL.

Notification jobs must resolve release asset names through the authenticated
GitHub Release API. They must not download the full promoted or draft artifact
set again merely to construct mirrored download URLs.

After a successful mirrored upload, the workflow also upserts a managed `Direct Downloads` section into the GitHub Release body so the release description matches the Feishu direct links.

GitHub does not offer a supported API to pin an arbitrary release to the top of its public Releases list. Therefore, concrete stable releases and the floating `stable` alias are public, while RC and beta GitHub Releases remain drafts. RC and beta packages remain available through their immutable S3 asset directories and `channels/preview`, `channels/rc`, and `channels/beta` metadata; they are not public GitHub Release entries. The workflow also archives any legacy published prerelease as a draft, so the next successful release repairs the public list without deleting its artifacts.

After every desktop release, the workflow refreshes a floating GitHub Release named `stable`. This release is a navigation alias for the current concrete stable version, such as `v1.12.20`. The alias must be recreated with `--latest=false`, and the concrete stable version release remains the GitHub `Latest` release. Each Feishu card links to that build's matching GitHub Release, including RC and beta drafts for authorized release testers, while its download buttons use mirrored preview-download links.

Create a new alias commit after each desktop release with the exact tree of the concrete stable commit and that concrete commit as its parent. Verify both the tree and parent before moving the lightweight `stable` tag to the alias commit. The alias commit is tag-only and must not be added to a branch; its purpose is release navigation, while the concrete semver tag remains the canonical stable identity. Unless commit signing is added to the release runner, GitHub may display this bot-created alias commit without a `Verified` badge. Move the lightweight `stable` tag to the validated alias commit before deleting and recreating the floating GitHub Release. Do not create an annotated `stable` tag, use `gh release delete --cleanup-tag`, or delete `refs/tags/stable`; those paths require extra Git identity or can leave the alias tag missing when recreation fails.

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

The packaged desktop updater consumes the stable and RC pointer contracts. Before
each update check it reads `latest.json` for the stable channel or
`channels/rc/latest.json` for the RC channel, validates the schema, expected
channel, tag/version relationship, and configured CloudFront prefix, then sets
the `electron-updater` generic feed to the immutable `<tag>/` directory. The
updater reads `latest-mac.yml` for stable or `rc-mac.yml` for RC from that
directory and verifies the signed ZIP normally. It does not discover desktop
updates through GitHub Releases.

Packaged Tutti also checks the shared public minimum-version policy before any
Dashboard or Workspace window is created. The check has a three-second total
startup budget and fails open on network/server errors. A required update uses
the existing immutable pointer and updater flow, while keeping the user's
normal update preference unchanged. Foreground checks are main-process owned,
limited to once per 30 minutes, and prompt at most once per process.

This makes a Draft RC intentionally updateable without exposing it on the
public GitHub Releases page. Publish the immutable assets and updater YAML
first, then mutate the relevant pointer; the current pointer cache is 60
seconds. Before announcing a release, verify HTTP 200 for the channel pointer,
its `<tag>/latest-mac.yml` or `<tag>/rc-mac.yml`, and the ZIP referenced by that
YAML, plus the Windows `.exe`, `.exe.blockmap`, and matching `latest.yml` or
`rc.yml`.

The `latest.json` metadata must include stable-identifying fields:

- `channel: "stable"`
- `prerelease: false`
- a plain semver `version`, without `-rc` or `-beta`
- a stable `tag`, such as `v1.12.20`
- `preferredDownloads.macosUniversalDmg`
- `preferredDownloads.windowsX64Exe`

External download workers should treat these fields as a fail-closed contract. If the metadata is missing, malformed, or points at an RC or beta tag, the worker must not return that package as the public download.

The download worker may expose `channel=preview` and `channel=beta` query parameters for internal links. Missing `channel` must default to `stable`. `channel=preview` must read RC metadata only; it must not fall back to beta.

The `tutti-desktop-download` Worker is currently maintained directly in the Cloudflare Dashboard production editor, not in this repository. Do not enable the Store website route until its source, staging deployment, and rollback version are under version control.

The Worker supports:

```text
/desktop/download?platform=macos&arch=universal&format=dmg
/desktop/download?channel=stable&platform=macos&arch=universal&format=dmg
/desktop/download?channel=preview&platform=macos&arch=universal&format=dmg
/desktop/download?channel=beta&platform=macos&arch=universal&format=dmg
```

The Desktop Store runtime reserves these Windows contracts for the Worker
implementation:

```text
/desktop/download?channel=stable&platform=windows&arch=x64
/desktop/download?channel=stable&platform=windows&arch=x64&distribution=direct&format=exe
/desktop/download?channel=rc&platform=windows&arch=x64&distribution=direct&format=exe
```

The first route must return a temporary redirect to
`https://get.microsoft.com/installer/download/{PRODUCT_ID}` only after the
production product reaches `In Microsoft Store`. The explicit Direct route
must preserve the existing NSIS fallback. These routes are not implemented in
this repository because the Worker source is unavailable.

Stable mirrored releases also update the aggregate changelog feed:

```text
https://<asset-base-url>/changelog.json
```

`changelog.json` is updated only for stable releases. RC and beta builds can still generate per-run summaries for Feishu and GitHub Release notes, but they should not appear on the public changelog feed unless that policy is changed explicitly.

If a published stable release is missing from the aggregate feed, use the
manual `Repair Desktop Release Changelog` workflow with that exact stable tag.
The repair validates the checksummed `release-summary.json` attached to the
published GitHub Release for its tag, target commit, and comparison metadata,
then rebuilds the public summary from the current human-reviewed Release Notes
section. This keeps later editorial corrections authoritative without mutating
the staged candidate asset. It upserts only that entry under the same
`desktop-release-promotion` concurrency lock used by normal promotion and must
not republish the GitHub Release, upload immutable installers, or move any
stable/RC/beta pointer.

## Draft Promotion

External publication is owned by `.github/workflows/desktop-release-promote.yml`. RC and beta builds may call it automatically. A stable candidate must be submitted manually from the Feishu link and then pass the `desktop-stable-release` GitHub Environment approval.

Configure that Environment with only `SingleMai`, `jomeswang`, and `vorshen` as required reviewers, with self-review allowed. This reviewer policy is repository configuration rather than workflow YAML; keep it synchronized with this convention.

Promotion performs these checks before changing public state:

- the GitHub Release exists and its stable, RC, or beta shape matches the tag
- for stable candidates, the formal tag is absent or already points to the candidate commit after an interrupted promotion
- the production managed app runtime catalog publishes at least the target
  commit's locked `runtimeVersion` for every supported platform
- `release-candidate.json` binds the planned tag, target commit, source ref, generated summary, checksums, and candidate asset path
- `SHA256SUMS.txt` exists and the downloaded draft assets match it
- the reviewed bilingual notes still produce the approval digest captured before the Environment gate
- the target version does not move the selected public channel backwards

When `config/tutti.app-runtime.lock.json` changes, run `Publish Tutti App
Runtime` and verify the production catalog before promoting the desktop release.
The promotion gate reads the lock from the exact release target, so a later
manual promotion cannot bypass this ordering.

It then extracts the human-reviewed summary, copies stable candidate objects from `candidates/<candidate-id>/` to the immutable `<tag>/` path, creates the formal stable tag, updates release notes and assets, publishes the GitHub Release, writes the channel pointer and changelog, refreshes the stable alias, verifies the public pointer, and sends the published card. Promotion never rebuilds installers or calls the summary model. Editing notes or replacing assets after submission changes the approval digest and forces a new approval run. Promotion is serialized because channel pointers are shared mutable state.

The internal candidate manifest remains attached until every fallible promotion
check succeeds. If a run stops after the stable GitHub Release becomes public,
the next Promotion run may select that same published release, revalidate the
candidate and reviewed notes, and resume the idempotent remaining steps. The
manifest is removed only as the final successful promotion action.

RC and beta promotions preserve the existing GitHub policy: their GitHub Releases remain drafts while their AWS channel pointers become available. Stable promotion changes the GitHub Release from draft to public and marks it Latest.

## Release Summaries

The desktop release workflow generates `release-summary.json` for every published desktop release.

Summary generation is best-effort:

- if `AGNES_API_KEY` is configured, the workflow asks Agnes to summarize commits and diff stats
- if the key is missing, the API fails, or the response is invalid, the workflow falls back to a deterministic commit-based summary

The Stage job adds the generated summary before checksums and seeds a clearly marked bilingual review section in the Draft Release body. Operators edit only that review section; rebuilding the same unpublished version refreshes generated suggestions while preserving the edited review. Promotion converts the review section to a `human-reviewed` `release-summary.json` and removes machine suggestions from the public Release body. The summary is used to:

- maintain editable Chinese and English release notes in the GitHub Release body
- enrich the Feishu release card with the Chinese summary when Feishu notification is enabled
- update `changelog.json` for stable releases

The desktop release pointer does not contain a release-notes URL. The renderer
opens the official localized changelog landing page instead of a GitHub
Release: `https://tutti.sh/zh/changelog` for `zh-CN`, and
`https://tutti.sh/en/changelog` for English. It never appends a version or
anchor, so the website owns the release-history presentation. Older pointers
may still contain `releaseNotesUrl`; desktop clients ignore that legacy field.

Before staging the Draft Release, generate GitHub's detailed release notes with
an explicit comparison tag. RC and beta notes compare against the newest tag in
the same version/channel series, falling back to the newest stable tag; stable
notes compare against the newest stable tag. Do not rely on GitHub's implicit
previous-release selection because RC and beta GitHub Releases remain drafts
and therefore are not valid published-release comparison anchors.

Managed summary and direct-download sections must be preserved when release
notes approach GitHub's 125,000-character body limit. Trim only the generated
detail entries and leave a visible truncation notice.

Do not commit real model API keys. Configure `AGNES_API_KEY` as a GitHub secret.

Stable drafts use a mutable internal `candidate-vX.Y.Z` tag; the formal `vX.Y.Z` tag is created only after approval. Before that point, dispatching the same explicit version moves the internal candidate tag, replaces the Draft's exact asset set, and writes a new candidate path without invalidating public caches. Once the formal stable tag exists, do not rebuild different code under that version; retry the same promotion or use a new patch version.

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

Each Microsoft Store GitHub Environment keeps one complete Partner Center
account and product profile. Store submission requires these secrets:

- `MICROSOFT_STORE_TENANT_ID`
- `MICROSOFT_STORE_CLIENT_ID`
- `MICROSOFT_STORE_CLIENT_SECRET`
- `MICROSOFT_STORE_SELLER_ID`

It also requires these non-secret Environment variables:

- `TUTTI_MICROSOFT_STORE_PRODUCT_ID`
- `TUTTI_STORE_APPLICATION_ID`
- `TUTTI_STORE_DISPLAY_NAME`
- `TUTTI_STORE_IDENTITY_NAME`
- `TUTTI_STORE_PUBLISHER`
- `TUTTI_STORE_PUBLISHER_DISPLAY_NAME`

Never mix account credentials from one Environment with a product identity
from another. Switching from a test account/application to production means
replacing the complete Environment profile and rebuilding the package; a test
package cannot be promoted unchanged to a different Store identity.

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
- apply a 30-day lifecycle expiration to objects under `<prefix>/candidates/`; never apply that rule to formal `<tag>/` paths

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
pnpm --filter @tutti-os/desktop build:win:store
pnpm check:full
```

The Store command requires Windows packaging identity variables and a plain
stable `TUTTI_DESKTOP_BUILD_VERSION`. A local package proves only package
assembly. End-to-end Store evidence additionally requires a Partner Center test
product and a real Windows install/update cycle.

Use `build:unpack` to verify that the Electron bundle can be assembled locally and that `tuttid` is present under the packaged app resources.

## Operational Notes

Stable releases should remain the only builds that claim the GitHub `Latest` slot.

Release candidates and beta builds should always publish as GitHub prereleases and must not replace the current stable `Latest` release.

Workspace app runtime artifacts are a separate release surface owned by [Workspace App Runtime](./workspace-app-runtime.md). Do not publish or rebuild those artifacts from the desktop release workflow.

When changing desktop release behavior, update this document in the same change.
