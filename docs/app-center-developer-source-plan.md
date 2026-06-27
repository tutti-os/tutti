# App Center Developer Source Plan

## Product Decision

App cards can optionally show a compact source row for the people and repository behind an app. This is intended for developer mode and is disabled by default.

Use `authors` as the manifest field. Do not introduce a separate `developers` label in the UI, because showing both `author` and `developers` creates a hierarchy that is hard to explain on small cards. The existing singular `author` field remains a legacy fallback only.

## Card Interaction

Default card row:

- Left: up to two author avatars, then the primary author name or `N authors`.
- Official apps: show `Tutti 官方` and an `官方` badge.
- Third-party apps: show author identity without role labels.
- Right: GitHub icon when repository or author links exist.

Hover/focus on the source row:

- Replace the right GitHub icon with a chevron.
- The row becomes the click target.

Click:

- Opens a compact popover.
- Lists all authors as flat peers.
- Shows the GitHub repository when available.
- Every linked author/repository opens its GitHub page.

## Data Model

Manifest:

```json
{
  "authors": [
    {
      "name": "2042217959",
      "avatarUrl": "https://github.com/2042217959.png",
      "url": "https://github.com/2042217959"
    }
  ],
  "source": {
    "type": "github",
    "url": "https://github.com/tutti-os/design-review"
  }
}
```

Runtime/API:

- `authors` is always normalized to an array.
- `source` is exposed as `repository` in daemon API and events.
- Missing `authors` falls back to legacy `author` when present.

## Settings

Add a Developer settings switch:

- Label: show app developer sources.
- Default: off.
- Scope: desktop preferences, persisted through tuttid and synced by preference events.

This keeps the default App Center lightweight while allowing review, QA, and developer users to inspect provenance.
