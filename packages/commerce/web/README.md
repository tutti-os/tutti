# `@tutti-os/commerce`

Host-neutral Commerce contracts, policies, visual assets, and React
presentation for Tutti products.

The package does not fetch APIs or own authentication, feature flags,
navigation, clipboard, notifications, Electron, or VM state. Product hosts
provide normalized data, labels, links, and callbacks.

The Account shell (avatar, popover, sign-in/out, settings, and UID copy)
belongs to each Host. `CommerceMenuContent` renders only membership, credits,
and account-center rows.

Host actions may be asynchronous. `CommerceMenuContent` catches rejected
external-link actions and forwards them to the optional `onActionError`
callback; the Host owns user-facing failure notification.

```ts
import {
  resolveInsufficientCreditsSemantic,
  resolveMembershipAction
} from "@tutti-os/commerce";
import {
  CommerceMenuContent,
  MembershipTierIcon
} from "@tutti-os/commerce/react";
```

`basic` is the canonical tier key for the Basic plan. It intentionally maps to
the existing Lite visual asset for parity with the Tutti desktop product.
