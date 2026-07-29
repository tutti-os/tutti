# Workspace App Tabs Design

## Goal

Present the app catalog and every opened workspace app inside one application
window with a browser-like tab strip.

## Interaction

- The app catalog is the permanent first tab and cannot be closed
- Opening an app creates a tab after the catalog tab and selects it
- Opening an app that already has a tab selects the existing tab
- The add button selects the catalog tab so the user can open another app
- Closing the active app tab selects the adjacent app tab, or the catalog when
  no app tabs remain
- Closing an inactive app tab preserves the current selection
- App tabs display the localized app name and app icon when available

## Architecture

The app-center view state remains the source of truth. It gains an ordered list
of open app ids alongside the existing active app id, so the tab session is
included in workbench snapshots. Normal workspace launches will target the
singleton app-center node instead of creating one workbench window per app.

The existing inline app body already keeps multiple app webviews mounted and
only exposes the active one. It will read the persisted tab list directly and
unmount a webview when its tab closes. The current standalone-agent presenter
and the normal workbench presenter will share the same view-state semantics.

The tab strip will use existing UI System buttons, icons, semantic tokens, and
the dimensions already established by Browser Node. This is app-center chrome,
not a second business state store.

## Compatibility And Errors

Restored view state without an app-id list is normalized by deriving a list
from the legacy active app id. Invalid, blank, and duplicate ids are removed.
If app preparation fails, the presenter restores the tab state from before the
attempt. Existing standalone and legacy app-webview definitions remain readable
so older workbench snapshots do not become invalid.

## Verification

- Unit-test view-state normalization, deduplication, equality, selection, close
  fallback, and launch rollback
- Unit-test that normal workspace launches focus the singleton app-center node
- Run app-center and desktop targeted tests
- Run i18n, UI, renderer boundary, TypeScript, and desktop build checks
- Hot-update the desktop development environment once after verification
