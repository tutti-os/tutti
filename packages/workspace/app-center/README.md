# Workspace App Center

Host-neutral workspace app center contracts, validation, status mapping, view-model derivation, shared React UI, and package i18n defaults.

The package does not construct daemon clients, access desktop preload APIs, resolve host paths, spawn processes, or register workbench or dock contributions.

## Runtime Refresh Policy

`createWorkspaceAppCenterController` defaults to `refreshPolicy: "poll"` for
backward compatibility. In this mode, the controller schedules bounded refreshes
while installs and transient runtime states are active.

Event-driven hosts can pass `refreshPolicy: "event"`. This disables the
controller's per-app install refreshes and transient-runtime refresh timer. The
host must then subscribe to its daemon/runtime event stream and forward each app
change through `controller.applyAppUpdate(...)` with an `operationCursor`:

```ts
controller.applyAppUpdate({
  app,
  operationCursor: {
    desiredGeneration,
    operationId,
    sequence
  },
  workspaceId
});
```

Within an operation, `sequence` must increase. A replacement operation must use
a greater `desiredGeneration` and a new `operationId`; stale, duplicate, or
ambiguous updates are discarded. Event updates are accepted only while that
workspace's polling lifecycle is active. `endWorkspacePolling` is a full
workspace teardown and rejects late events from the disposed stream.

Event mode deliberately does not provide an app-state polling fallback. The host
owns reconnect handling. For a reconnect of the same active workspace, first
pause and guard delivery from the old stream, call
`resetWorkspaceEventCursors(workspaceId)`, fetch and apply a full
`WorkspaceAppCenterSnapshot`, and then resume ordered `applyAppUpdate` events
from the replacement stream. The reset keeps pending install/report state, while
the fresh snapshot establishes the new event-ordering baseline. Do not call
`endWorkspacePolling` for a reconnect; reserve it for leaving or disposing the
workspace. The catalog-loading refresh remains workspace-scoped and is
independent of app runtime event delivery.

## View State

`WorkspaceAppCenterViewState` preserves the selected app tab and may include an
`openAppId`. Hosts can use that id to replace the app list with the running app
in the same presentation region, then clear it to return to the preserved list.
The package only owns this host-neutral state contract; rendering and webview
lifecycle remain host responsibilities.

## Developer Sources

Developer/source presentation is host-controlled. `AppCenterPanel` and
`AppCard` accept `showDeveloperSources`, default it to `false`, and render the
developer/source row from app metadata only when enabled. The shared package
does not own the preference or persistence policy.

Desktop owns the `showAppDeveloperSources` preference, persists it through the
desktop-preferences service, and passes the resulting value into the App Center
pane. Keep preference UI, daemon storage, and host-specific source links out of
this package.
