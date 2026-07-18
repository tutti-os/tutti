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
  `at.resolve()` and `at.subscribe()` for exact mention hydration and dirty
  invalidation.
- `files.select()` for user-activated workspace file picking.
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
  state.
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
  providerIds: ["workspace-app", "agent-session", "agent-generated-file"],
});
```

Pass that instance to `RichTextMentionServiceProvider` and dispose it with the
app root. App-local providers can be supplied once through
`appLocalProviders`; leaf inputs and message lists should not recreate adapters.

The adapter feature-detects optional bridge methods. New hosts use exact
`at.resolve()` and `at.subscribe()`. On an older query-only host, resolution
first queries by the persisted fallback label, then uses a bounded empty-keyword
query and exact provider/entity/scope match. The service TTL supplies eventual
refresh for hosts or provider sources without a real-time dirty event. The existing
`createTuttiExternalAtRichTextTriggerProviders` factory remains available for
older bundles.

Provider ids and palette sections stay aligned with the host contract. The app
still owns local-only mention sources, i18n labels, palette categories, row
rendering, and insertion side effects; the shared service owns caching and
invalidation.

See `@tutti-os/ui-rich-text` for the generic trigger-provider and at-panel
contracts.
