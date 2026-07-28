# `@tutti-os/commerce`

Host-neutral Commerce contracts, policies, visual assets, and React
presentation for Tutti products.

The package does not fetch APIs or own authentication, feature flags,
navigation, clipboard, notifications, Electron, or VM state. Product hosts
provide normalized data, labels, links, and callbacks.

The Account shell (avatar, popover, sign-in/out, settings, and UID copy)
belongs to each Host. `CommerceMenuContent` renders only membership, credits,
and account-center rows. `AgentConfigCommerceContent` is the compact account,
clickable credits balance with inline refresh, membership, and account-center
presentation for an Agent config menu. Clicking Credits opens the Host-provided
`usageUrl`. The Host still supplies the account name, state, labels, refresh
command, and navigation.

Host actions may be asynchronous. `CommerceMenuContent` catches rejected
external-link actions and forwards them to the optional `onActionError`
callback; the Host owns user-facing failure notification.

```ts
import {
  resolveInsufficientCreditsSemantic,
  resolveMembershipAction
} from "@tutti-os/commerce";
import {
  AgentConfigCommerceContent,
  CommerceMenuContent,
  MembershipTierIcon
} from "@tutti-os/commerce/react";
```

`basic` is the canonical tier key for the Basic plan. It intentionally maps to
the existing Lite visual asset for parity with the Tutti desktop product.
