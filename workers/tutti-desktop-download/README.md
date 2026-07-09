# Tutti Desktop Download Worker

This Worker owns the public desktop download endpoint:

```text
https://tutti.sh/desktop/download
```

It reads desktop release metadata from the mirrored release asset prefix and
redirects to a validated asset URL. The production Cloudflare service is
`tutti-desktop-download` under account `39fe2eae2688546b97e5d7e8da81cceb`.

## Configuration

The production asset base URL defaults to:

```text
https://d1x7gb6wqsqmnm.cloudfront.net/tutti-desktop-release-assets
```

Set this Worker variable only when overriding the production asset prefix:

```text
TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL=https://<asset-base-url>
```

Set these Worker variables to enable DataFinder Tea reporting:

```text
TUTTI_ANALYTICS_APP_ID=20004134
TUTTI_ANALYTICS_APP_KEY=<tea-app-key>
TUTTI_ANALYTICS_CHANNEL_DOMAIN=https://gator.uba.ap-southeast-1.volces.com
TUTTI_ANALYTICS_APP_VERSION=0.0.0
```

The base URL must expose:

```text
latest.json
channels/preview/latest.json
channels/rc/latest.json
channels/beta/latest.json
```

Stable requests read `latest.json`. Preview requests read
`channels/preview/latest.json`. Beta requests read `channels/beta/latest.json`.
If stable mirrored metadata is malformed or points at a prerelease, the Worker
falls back to GitHub's latest stable release.

## Endpoints

```text
/desktop/latest.json
/desktop/download
```

`/desktop/latest.json` rewrites asset `url` fields to public
`/desktop/download` URLs and keeps the original artifact URL in `cdnUrl`.

## Analytics

Successful `GET /desktop/download` redirects report a best-effort DataFinder
Tea event:

```text
desktop_download.clicked
```

The event includes normalized `platform`, `arch`, `format`, `release_channel`,
`release_tag`, `release_version`, `asset_name`, `download_url`, and `source`.
The `source` field comes from the download URL query string:

```text
/desktop/download?platform=macos&arch=universal&format=dmg&source=readme
```

When `source` is absent or empty, the Worker reports `source: "unknown"`.
Analytics failures are ignored so download redirects are not blocked.

## Local Checks

```bash
node --test workers/tutti-desktop-download/src/worker.test.mjs
```

## Deployment

Deploy from this package after confirming the production Worker variable:

```bash
pnpm --filter @tutti-os/desktop-download-worker deploy:production
```
