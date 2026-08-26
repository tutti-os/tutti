# @tutti-os/connector-renderer

Host-neutral Connector frontend application services and shared React UI.

The package exposes three narrow entries and no root barrel:

```ts
import {
  ConnectorMarketModule,
  IConnectorMarketModule
} from "@tutti-os/connector-renderer/application";
import {
  ConnectorAccessSelectionPanel,
  type ConnectorAccessSelectionItem,
  type ConnectorAccessSelectionPanelLabels,
  type ConnectorAccessSelectionPanelProps,
  type ConnectorAccessSelectionState,
  ConnectorComposerMenu,
  ConnectorMarketDialogHost,
  ConnectorMarketPanel,
  ConnectorPaletteItem,
  ConnectorSelectionList
} from "@tutti-os/connector-renderer/ui";
import {
  connectorMarketI18nResources,
  createConnectorMarketI18nRuntime
} from "@tutti-os/connector-renderer/i18n";
```

## Ownership

`src/application` is React-free. It owns host-neutral backend/event/admission
ports, Root/Lifecycle/StartupJob services, state, View projection, dialog
intents, and declarative authorization mapping.

`src/ui` is the only owner of Connector-specific React, including Catalog,
dialogs, authorization rendering, access selection, Composer controls,
selection chips, Palette items, icons, toolbar, and default i18n resources. It
uses the repository UI System and accepts neutral Connector models,
caller-localized labels, and semantic callbacks.

Desktop supplies generated-client, account, event, and navigation adapters.
AgentGUI owns Agent draft and prompt semantics, then projects those models into
the neutral Renderer UI contracts. Neither host is imported by this package.

Wire authorization schemas and the OpenAPI fragment are published by
`@tutti-os/connector-contracts`.

When a newly received Authorization View is an `external_link`, Connector
Renderer opens its activation URL once. A `device_code` View instead replaces
the contents of the existing authorization dialog without opening the browser.
The user can copy its code and explicitly activate the dialog action when they
are ready to open the verification URL.

Hosts that compile Tailwind utilities from published packages must include the
Renderer build output as a source, for example:

```css
@source "../../node_modules/@tutti-os/connector-renderer/dist";
```

`ConnectorAccessSelectionPanel` is controlled: the host owns catalog loading,
selected-key ordering, policy persistence, localized labels, and semantic
callbacks. The package owns the Connector-specific loading, error, empty,
selection, disabled, and busy presentation.

## Validation

```sh
pnpm --filter @tutti-os/connector-renderer test
pnpm --filter @tutti-os/connector-renderer typecheck
pnpm --filter @tutti-os/connector-renderer build
pnpm check:connector-boundaries
```
