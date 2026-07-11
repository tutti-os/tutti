# @tutti-os/workspace-external-core

Contracts and host-agnostic helpers for the workspace app external bridge.

Workspace apps are trusted installed app packages. The external bridge is a
privileged host integration surface, not a web-style permission sandbox. User
activation gates disruptive host UI such as dialogs and navigation, while
trusted app APIs may read or update host workspace state directly.

`window.tuttiExternal` currently exposes:

- `app.getContext()` and `app.subscribe()` for host workspace/app context.
- `activity.reportActive()` for best-effort app activity reporting.
- `browser.openUrl()` for user-activated external HTTP(S) navigation.
- `at.query()` for host-provided mention candidates.
- `files.select()` for user-activated workspace file picking.
- `files.open()` for user-activated host opening/revealing of a known workspace file path.
- `files.upload()` for trusted app upload of a browser `File`/`Blob` into the
  app's managed durable data path, with optional progress and `AbortSignal`
  cancellation. It returns file metadata only; app-specific asset records remain
  owned by the calling app.
- `permissions.request()` for user-activated host permission grants such as managed AI model access.
- `pdf.printHtmlToPdf()` for user-activated host PDF generation from print-ready HTML.
- `settings.open()` for user-activated host settings navigation, including the managed models tab.
- `workspace.onLaunchIntent()` for initial and repeated route launches.
- `userProjects.*` for trusted app access to local user project paths, default
  project selection, project directory creation, and recently used project
  state.
- `workspace.openFeature()` for user-activated host workspace navigation, such as opening the message center.
- `references.open()` for user-activated `mention://` reference routing.
- `logs.write()` for fire-and-forget frontend diagnostics that append to the workspace app `web.log`.

## Host Integration

Electron hosts should construct the bridge through the host-neutral factory
instead of implementing the 26-method object tree themselves:

```ts
import {
  createTuttiExternalBridge,
  type TuttiExternalHostAdapter
} from "@tutti-os/workspace-external-core/host";

const bridge = createTuttiExternalBridge({
  adapter: hostAdapter,
  isUserActivationActive: () => navigator.userActivation.isActive
});
```

The shared factory owns the canonical operation roster, activation policy,
input/result validation, structured errors, event replay/ordering and upload
abort/progress behavior. A host adapter owns only its transport, trusted runtime
identity, UI/domain handlers and binary upload protocol. Host code must validate
untrusted IPC input again at the main-process or daemon boundary.

`TuttiExternalBridge.capabilities` is additive. Apps running against an older
host without this property should continue to call and handle failures. New
hosts expose only operations and value domains whose full semantics are
implemented. Subscription methods throw a structured `unsupported_operation`
synchronously when absent; Promise-returning methods reject.

The package root intentionally does not re-export the `./host` runtime, so
ordinary Workspace Apps do not bundle host construction code.

## Rich Text At Providers

Workspace apps that use `@tutti-os/ui-rich-text` can adapt host mention
candidates from `window.tuttiExternal.at.query()` directly into rich-text trigger
providers:

```ts
import { createTuttiExternalAtRichTextTriggerProviders } from "@tutti-os/workspace-external-core/rich-text";

const triggerProviders = createTuttiExternalAtRichTextTriggerProviders({
  bridge: window.tuttiExternal,
  providerIds: ["workspace-app", "agent-session", "agent-generated-file"]
});
```

Each external at provider becomes one `RichTextTriggerProvider` with the same
provider id. This keeps rich-text categories and sections aligned with the host
contract, while the app still owns local-only mention sources, caching policy,
i18n labels, palette categories, row rendering, and insertion side effects.

See `@tutti-os/ui-rich-text` for the generic trigger-provider and at-panel
contracts.
