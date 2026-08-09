# @tutti-os/workspace-external-core

Contracts and host-agnostic helpers for the workspace app external bridge.

Workspace apps are trusted installed app packages. The external bridge is a
privileged host integration surface, not a web-style permission sandbox. User
activation gates disruptive host UI such as dialogs and navigation, while
trusted app APIs may read or update host workspace state directly.

`window.tuttiExternal` currently exposes:

- `app.getContext()` and `app.subscribe()` for host workspace/app context.
- `agentActivity.*` for trusted automation apps to list exact Agent targets,
  inspect composer options, create visible sessions, send or cancel turns, and
  read the host-owned Activity snapshot. These calls delegate to the same
  runtime and state used by Agent GUI; workspace apps must not create a second
  Activity engine or provider adapter around this surface.
- `at.query()` for host-provided mention candidates, plus optional
  `at.queryDirectory()` for provider-owned direct-child browsing and optional
  `at.resolve()` and `at.subscribe()` for exact mention hydration and dirty
  invalidation.
- `files.select()` for user-activated workspace file picking.
- `references.select()` for the user-activated multi-source reference picker.
  Tutti Desktop currently offers project files, local files, and application
  artifacts on this workspace-app surface. The result contains concrete paths
  for files/folders and lazy `workspace-reference` handles for whole
  application artifact groups; issue artifacts are not part of this surface.
- `references.open()` for user-activated navigation from a serialized
  `mention://` reference back to its owning workspace surface.
- `files.open()` for user-activated host opening/revealing of a known workspace file path.
- `files.upload()` for trusted app upload of a browser `File`/`Blob` into the
  app's managed durable data path, with optional progress and `AbortSignal`
  cancellation. It returns file metadata only; app-specific asset records remain
  owned by the calling app.
- `permissions.request()` for user-activated host permission grants such as managed AI model access.
- `pdf.printHtmlToPdf()` for user-activated host PDF generation from print-ready HTML.
- `settings.open()` for user-activated host settings navigation, including the managed models tab.
- `userProjects.*` for trusted app access to local user project paths, default
  project selection, project directory creation, and recently used project
  state. Removing a project only removes the recent-project registration; host
  files and Agent conversations remain intact.
- `workspace.openFeature()` for user-activated host workspace navigation, such as opening the message center.
- `logs.write()` for fire-and-forget frontend diagnostics that append to the workspace app `web.log`.

## Agent Activity Automation

`agentActivity` is intended for testing, orchestration, and other trusted apps
that need to drive official Agent GUI sessions. Calls are scoped to the current
workspace by the host; callers provide exact `agentTargetId` values returned by
`listTargets()` and should set `visible: true` when users need to inspect the
created sessions in Agent GUI.

Supporting hosts advertise this surface as `agentActivity@1` in
`app.getContext().capabilities`. Apps should also feature-detect the bridge when
they need to remain usable in a normal browser or on an older host.

`listTargets().agents[].iconUrl` is a Host-resolved presentation URL and may be
a small `data:` URL when the source icon is local to the Desktop Host. Apps
should render it as an optional enhancement and keep a static or text fallback
for missing, rejected, or unloadable icons.

Use `getSnapshot()` to observe session, turn, and message outcomes. The browser
app may poll this method; the host remains the owner of synchronization and
provider-specific transport. Apps that need an independent, app-owned Agent
runtime should continue to use `@tutti-os/agent-acp-kit` instead.

## Rich Text At Providers

Workspace apps that use `@tutti-os/ui-rich-text` should create one mention
service at the app root:

```ts
import { createTuttiExternalRichTextMentionService } from "@tutti-os/workspace-external-core/rich-text";

const mentionService = createTuttiExternalRichTextMentionService({
  getBridge: () => window.tuttiExternal,
  providerIds: ["file"]
});
```

Pass that instance to `RichTextMentionServiceProvider` and dispose it with the
app root. App-local providers can be supplied once through
`appLocalProviders`; leaf inputs and message lists should not recreate adapters.

The adapter feature-detects optional bridge methods. New hosts use exact
`at.queryDirectory()`, `at.resolve()`, and `at.subscribe()`. A file provider
only advertises its hierarchy methods when the current bridge supports
`at.queryDirectory()`, so an older host keeps the existing flat ranked search.
On an older query-only host, resolution first queries by the persisted fallback
label, then uses a bounded empty-keyword query and exact
provider/entity/scope match. The service TTL supplies eventual refresh for
hosts or provider sources without a real-time dirty event. The existing
`createTuttiExternalAtRichTextTriggerProviders` factory remains available for
older bundles.

For a file-only external composer, register only the file provider and one file
category, then opt the shared editor into that provider's hierarchy:

```tsx
const mentionService = createTuttiExternalRichTextMentionService({
  getBridge: () => window.tuttiExternal,
  providerIds: ["file"]
});

<RichTextMentionServiceProvider service={mentionService}>
  <RichTextTriggerEditor
    value={draft}
    onChange={setDraft}
    palette={{
      categories: [{ id: "file", label: labels.file, providerIds: ["file"] }],
      defaultCategoryId: "file",
      labels: {
        tabHint: labels.tabHint,
        cycleFilter: labels.cycleFilter,
        moveSelection: labels.moveSelection
      },
      directoryNavigation: {
        providerId: "file",
        labels: {
          back: labels.back,
          enter: labels.enter,
          navigateHierarchy: labels.navigateHierarchy
        }
      }
    }}
  />
</RichTextMentionServiceProvider>;
```

The inserted value remains the host-provided file or folder path. The external
app does not recursively enumerate a folder or create a second path protocol;
the local Agent receives the serialized path in its prompt and owns execution.
An empty directory path addresses the file provider root. Desktop constrains
workspace-app directory traversal to that root and its descendants; arbitrary
absolute paths outside the provider root are not part of this bridge contract.
This workspace-app policy does not narrow AgentGUI's host-owned local-path
provider.

Provider ids and palette sections stay aligned with the host contract. The app
still owns local-only mention sources, i18n labels, palette categories, row
rendering, and insertion side effects; the shared service owns caching and
invalidation.

See `@tutti-os/ui-rich-text` for the generic trigger-provider and at-panel
contracts.

## Composer Reference Selection

Workspace apps should feature-detect `window.tuttiExternal.references.select`
before exposing a reference action. The host owns the available source set and
the picker interaction. Apps append the returned references to their serialized
rich-text prompt with `appendTuttiExternalReferenceSelections`; they must not
expand an application artifact group into every child path.

For a standard composer entry, use `WorkspaceReferenceAddControl` from
`@tutti-os/workspace-file-reference/ui`. Apps with an upload workflow pass
`onUploadFile` and receive an Upload / Browse menu. Apps without upload support
omit it and the plus button opens the reference picker directly. All visible
labels remain app-owned i18n input.
