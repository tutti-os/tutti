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

## Host Conformance

Stable host integrations must also run the public, test-runner-neutral suite:

```ts
import {
  createTuttiExternalConformanceController,
  type TuttiExternalConformanceDriver
} from "@tutti-os/workspace-external-core/host/conformance";

const driver: TuttiExternalConformanceDriver = {
  createHost() {
    // Construct the product's real bridge and transport here. `port` controls
    // that transport; it must not replace the product adapter.
    return createProductConformanceHost();
  }
};

const controller = createTuttiExternalConformanceController(driver);

// Register each case with node:test, Vitest, Jest, or another runner.
for (const conformanceCase of controller.cases) {
  test(conformanceCase.title, () => controller.runCase(conformanceCase));
}
```

The driver is not given the expected profile: it must construct capabilities
from the product's normal production factory/configuration. The fixed
`stable26` profile cannot be narrowed by a host. It requires exactly
26 operations, all six mention providers, all six workspace features, all six
Agent providers, and every managed-AI provider in the public contract. The
exhaustive typed fixtures and framework-neutral cases cover operation routing,
value domains, input/result normalization, structured errors, event ordering,
listener isolation, cleanup, and upload progress/abort behavior. Product tests
must map `TuttiExternalConformanceHostPort` to their real transport and factory;
using a host adapter directly in place of the product factory does not prove
integration conformance.

The exported cases, including each `run` function, are deeply frozen. Their
public case type is readonly, and the exported `stable26` profile type preserves
the exact required readonly operation/provider/feature tuples rather than the
optional capability shape used by general hosts.

Concretely, the stable suite calls all ten activation-gated operations while
inactive and requires zero transport calls; rejects an invalid result for every
request and upload operation whose result is constrained (while preserving the
unknown `app.getContext()` result); routes every public mention, workspace,
Agent, and managed-AI value; checks request and notification error mapping; and
exercises initial-before-live ordering and cleanup for all three event streams.
It additionally verifies latest-value replay for app context and user projects,
and verifies that equal launch intents are not deduplicated.
The upload case also pauses a real product transfer after prepare, aborts it
through `AbortSignal`, and requires exactly one cancel with no completion.

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
