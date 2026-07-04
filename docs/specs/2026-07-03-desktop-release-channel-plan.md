# Desktop release and prerelease channel plan

Date: 2026-07-03

## Source Context

This plan starts from
`/Users/wwcome/work/tutti-lab/tsh-commerce/docs/mac-installer-release-flow.md`.
That document sets the release-channel rule we should copy for Tutti desktop:

- beta and RC builds are GitHub pre-releases and must not become `latest`.
- stable builds are GitHub releases and are the only builds that should become
  `latest`.
- testing the final external installer is best done with a stable-version draft
  release, then publishing the same release after QA passes.
- if an RC commit is accepted, publish a new stable tag from the same commit
  instead of exposing the RC tag as the external stable release.

## Current Tutti Findings

- `.github/workflows/desktop-release.yml` already resolves
  `release_prerelease` and `release_make_latest`. Stable versions set
  `make_latest=true`; RC versions set `make_latest=false`.
- The GitHub release step respects those outputs through `prerelease` and
  `make_latest`.
- The same publish job mirrors every release's assets to S3 under the immutable
  tag directory.
- Before this change, the publish job built `release-latest.json` and uploaded
  it to the S3 prefix root as `latest.json` whenever
  `TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL` was configured. It now gates that path
  on `release_make_latest`.
- `apps/desktop/scripts/build-release-latest.mjs` records the release tag,
  version, base URL, all mirrored asset URLs, and stable channel identity; it
  rejects prerelease tags.
- `docs/conventions/desktop-release.md` says RC releases must not replace the
  stable GitHub `Latest`, and also documents the mirrored root `latest.json`.
  It does not yet state that mirrored `latest.json` is stable-only.
- App update preferences support `stable` and `rc`; the default should be
  `stable`, with `rc` left as an explicit internal QA opt-in. Stored `rc`
  values from the older default should migrate back to `stable` once, then
  later user selections of `rc` should be preserved.
- `createAppUpdateService` configures electron-updater with `channel="latest"`
  and `allowPrerelease=false` for stable, or `channel="rc"` and
  `allowPrerelease=true` for RC.
- The prefixed GitHub release fallback filters `stable` to plain semver releases
  and `rc` to prerelease versions whose first prerelease identifier is `rc`.
- The workflow already accepts `target_commitish`, so a stable release can be
  built from the same commit that produced an accepted RC.

## Decision Summary

Use a stable-only public latest surface.

Pre-release packages may be uploaded to immutable S3 tag directories for QA, but
they must not overwrite the public S3 root `latest.json` that backs the external
download worker.

The Cloudflare download worker should still defend the public path by rejecting
or ignoring prerelease `latest.json` content. That guard is a backstop, not the
primary release-channel mechanism.

## Question 1: Public Download Worker and S3 `latest.json`

Recommended behavior:

- Stable release:
  - publish GitHub Release as non-prerelease;
  - set GitHub `Latest`;
  - upload immutable assets to S3 tag directory;
  - build and upload root `latest.json`;
  - external worker returns the stable `release-latest` download URL.
- Pre-release:
  - publish GitHub Release as prerelease;
  - do not set GitHub `Latest`;
  - upload immutable assets to S3 tag directory if internal QA needs direct CDN
    assets;
  - do not overwrite root `latest.json`.

Implementation shape:

1. Gate `Build desktop release latest metadata` and
   `Upload desktop release latest metadata to AWS S3` in
   `.github/workflows/desktop-release.yml` with
   `needs.resolve.outputs.release_make_latest == 'true'`.
2. Add a regression assertion in `tools/scripts/desktop-release-config.test.mjs`
   that both latest metadata steps are stable-only.
3. Extend `docs/conventions/desktop-release.md` to state that the mirrored root
   `latest.json` is the public stable channel and must not be updated by RCs.
4. If the Cloudflare worker code lives outside this repo, update it separately
   so the public endpoint validates the fetched `latest.json`:
   - require schema version `tutti.desktop.release.latest.v1`;
   - require `version` to be plain semver with no prerelease segment;
   - prefer the macOS universal `.dmg` for the external download URL;
   - fail closed or fall back to the previous known stable URL when metadata is
     malformed.

Answer: do both layers. Pre-release should not enter the public S3
`latest.json`, and the worker should be hardened so a future pipeline mistake
does not expose an RC to external users.

## Question 2: Auto-update Strategy

Recommended default:

- Public/default installs use `stable`.
- Internal QA installs can opt into `rc` from Developer settings.
- Stable channel checks `latest` update metadata and must not accept prerelease
  versions.
- RC channel checks RC update metadata and may accept prerelease versions.

Impact if a prerelease build checks only stable latest:

- If current app is `1.2.4-rc.1` and stable latest becomes `1.2.4`, semver
  ordering treats `1.2.4` as newer than `1.2.4-rc.1`, so updating from RC to
  final stable is expected.
- If current app is `1.2.5-rc.1` and stable latest is `1.2.4`, no downgrade
  should occur because the updater sets `allowDowngrade=false`.
- The main downside is product/process, not version conflict: RC users would not
  receive later RC builds through auto-update if they are forced onto the stable
  channel.

Implementation shape:

1. Change `defaultDesktopUpdateChannel` from `rc` to `stable`.
2. Keep the user preference / internal setting for `rc` so QA can subscribe to
   frequent pre-release validation builds.
3. Add a Developer settings control for the desktop update channel:
   - `Stable release`: public stable packages only, the default for normal
     users.
   - `Pre-release / RC`: internal QA channel for prerelease validation.
   - Wire it to the existing desktop preferences `updateChannel` field and
     `changeUpdateChannel` service path rather than adding a second setting.
4. Migrate old stored `rc` defaults back to `stable` once, then preserve `rc`
   if the user selects it again from Developer settings.
5. Add or update tests around:
   - default desktop preferences;
   - `createAppUpdateService.configure` mapping stable to
     `channel="latest", allowPrerelease=false`;
   - `createAppUpdateService.configure` mapping RC to
     `channel="rc", allowPrerelease=true`;
   - prefixed release fallback filtering stable versus RC.
6. Update `docs/conventions/desktop-release.md` so it no longer says
   "stable channel only" if RC auto-update remains supported for internal QA.
   Instead, document stable as the public default and RC as an internal
   opt-in channel.

Answer: defaulting all public installs to `release/latest` is safe. An RC build
checking stable latest will not normally corrupt the update path, but it will
stop receiving new RCs. Keep RC as an internal opt-in channel if QA needs
frequent prerelease auto-updates.

## Question 3: Turning an Accepted Pre-release Commit Into Stable

Simple operator path for the usual case:

1. Latest stable is `v1.2.3`.
2. QA accepts `v1.2.4-rc.1`.
3. Run `workflow_dispatch` for `.github/workflows/desktop-release.yml`.
4. Select `patch_release`.
5. Set `target_commitish` to `v1.2.4-rc.1`, or to that tag's commit SHA.
6. The workflow should reserve/build/publish `v1.2.4` from the RC code.

This is the simplest path when the accepted RC is for the next patch stable.
`target_commitish` is honored by `patch_release`, `minor_release`,
`major_release`, `patch_rc_release`, and `explicit_version_release`; it chooses
which commit/tag to build from.

Use the explicit path when the version must be pinned exactly:

1. Find the commit SHA behind the accepted RC tag.
2. Run `workflow_dispatch` for `.github/workflows/desktop-release.yml`.
3. Select `explicit_version_release`.
4. Set `version` to the stable semver, for example `1.2.4`.
5. Set `target_commitish` to the accepted RC commit SHA, or to an existing tag
   such as `v1.2.4-rc.1`.
6. Publish the resulting stable release.

Choose `explicit_version_release` instead of `patch_release` when the latest
stable tag has moved. For example, if `v1.2.4` already exists, `patch_release`
will calculate the next patch, `v1.2.5`, even if `target_commitish` is
`v1.2.4-rc.1`.

This must create a new stable tag and rebuild with the stable app version. Do
not simply relabel `v1.2.4-rc.1` as the external stable release, because app
version, updater metadata, asset names, release notes, and user-visible version
checks should say `1.2.4`, not `1.2.4-rc.1`.

The package version is release output, not the source of truth during CI. The
workflow checks out `target_commitish`, resolves or reserves the release tag,
then runs `apps/desktop/scripts/apply-ci-release-version.mjs` so
`apps/desktop/package.json` matches that release tag before packaging. In other
words, using an RC tag as the source ref is supported, but the final package
version still comes from the stable release `version` input or stable release
tag.

If operators want a "package-version release" mode that reads
`apps/desktop/package.json` from the target ref and uses that as the release
version, add it as an explicit workflow mode. Do not overload
`explicit_version_release`, because the current desktop package version is
normally `0.0.0` in source and is intentionally aligned only inside CI.

If QA must test the exact final stable installer before external release, add a
separate workflow option that creates the stable-version GitHub Release as a
draft, mirrors assets to a stable draft tag directory if needed, and only writes
public `latest.json` after the draft is published. The tsh-commerce document
recommends this draft-release path when the exact final installer must be
verified before release.

## Proposed Work Breakdown

### Step 1: Guard Public Latest

- Add stable-only conditions to the S3 root latest metadata build/upload steps.
- Add workflow text tests that catch RC latest metadata publication.
- Update desktop release conventions for mirrored `latest.json`.

### Step 2: Make Update Defaults Match Product Release Policy

- Change the default desktop update channel to `stable`.
- Keep RC as an opt-in internal channel.
- Expose the existing `updateChannel` preference in Developer settings as a
  stable versus pre-release selector.
- Add focused unit tests for the default preference and updater driver
  configuration.
- Align desktop release docs with the two-channel behavior.

### Step 3: Document Stable Promotion From RC Commit

- Add an operational section to `docs/conventions/desktop-release.md` for
  "promote accepted RC commit to stable".
- Include the `workflow_dispatch` inputs and the rule that stable release uses a
  new stable version/tag.
- Decide whether a stable draft workflow mode is needed before implementing it.

### Step 4: Harden External Download Worker

- Update the production `tutti-desktop-download` Worker directly in the
  Cloudflare Dashboard, because its source is currently maintained there rather
  than in this repository.
- Update the public endpoint to read the stable-only `latest.json`, validate
  that it is not prerelease metadata, and select the intended asset.
- Consider a private/internal endpoint or parameter for RC downloads only if QA
  needs Cloudflare-mediated RC links. That endpoint should read separate RC
  metadata such as `channels/rc/latest.json`, not the public root `latest.json`.

## Validation

For the repo changes:

- `node --test tools/scripts/desktop-release-config.test.mjs`
- `node --import apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types apps/desktop/src/main/update/appUpdateService.test.ts apps/desktop/src/main/update/prefixedDesktopReleaseResolver.test.ts`
- `pnpm check:changed --tail-lines 80`

For release operations:

- Run an RC workflow and confirm:
  - GitHub Release is prerelease;
  - GitHub Latest remains the previous stable release;
  - S3 immutable tag directory exists;
  - S3 root `latest.json` remains unchanged.
- Run a stable workflow and confirm:
  - GitHub Release is not prerelease;
  - GitHub Latest points to the stable tag;
  - S3 root `latest.json` points to the stable tag;
  - Cloudflare external download resolves to the stable universal macOS DMG.

## Open Questions

- Is the Cloudflare worker source tracked in a separate repository, or is it
  edited only in the dashboard today?
- Should RC assets be mirrored to S3 immutable tag directories, or should RC
  downloads use only GitHub Release asset URLs?
- Do internal QA users need auto-update across RC builds, or are fixed RC links
  enough?
- Do we need a stable draft workflow mode so QA can verify the exact final
  stable installer before public `latest.json` is updated?
