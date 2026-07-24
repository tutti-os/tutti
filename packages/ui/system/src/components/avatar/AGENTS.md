# Avatar Delivery Contract

## Scope

This file applies to the shared `Avatar` primitive in this directory. `Avatar`
is consumed by Tutti and TSH through the stable
`@tutti-os/ui-system/components` entrypoint.

## Usage

Callers provide a stable accessible `label` and a directly consumable image
URL:

```tsx
<Avatar label={user.displayName} size={40} src={user.avatarUrl} />
```

For an HTTP(S) URL, the default `delivery="auto"` mode:

- measures the rendered avatar box
- requests twice its width and height
- rounds each requested dimension up to
  `32, 48, 64, 96, 128, 192, 256, 384, or 512`
- sets `format=webp` and `fit=inside`
- preserves unrelated query parameters

Use `delivery="original"` when the source must be requested unchanged:

```tsx
<Avatar delivery="original" label={user.displayName} src={user.avatarUrl} />
```

No delivery parameters means the original image. `data:`, `blob:`, `file:`,
relative, and other non-HTTP(S) sources are left unchanged.

## URL Contract

- `src` must already be directly consumable by the browser.
- Production avatar URLs must point to the CloudFront image-delivery domain.
- The URL must identify the original image and allow the browser to append the
  `width`, `height`, `format`, and `fit` query parameters.
- Callers must never pass a bucket, object key, storage credential, or
  business-specific resource locator to this component.
- Do not persist the generated transformed URL. Persist only the resource
  identity or original delivery URL owned by the service contract.
- Treat `width`, `height`, `format`, and `fit` as reserved delivery parameters.
  Change them only together with the Image Handler Lambda validation and the
  CloudFront cache-query allowlist.

If transformed delivery fails, `Avatar` retries the unmodified `src` once.
When the original also fails, it uses the requested initial or empty fallback.

## Component Boundary

Keep identity lookup, API calls, authorization, signing, storage selection, and
resource lifecycle management in the host or service. This primitive owns only
render sizing, URL derivation, image loading, and visual fallback.

Do not add:

- calls to tsh-server, account, daemon, Electron, router, or application stores
- bucket or object-key parsing
- user-specific cache or persistence
- business copy or identity-resolution rules

## Required Tests

When changing this component, cover:

- 2x sizing and bucket selection
- WebP and `fit=inside` query parameters
- preservation of unrelated query parameters
- rendered-size updates through `ResizeObserver`
- explicit original mode and non-HTTP(S) sources
- transformed-image failure, original retry, and final fallback

Run:

```bash
pnpm --filter @tutti-os/ui-system test -- avatar
pnpm --filter @tutti-os/ui-system typecheck
pnpm check:ui-boundaries
```
