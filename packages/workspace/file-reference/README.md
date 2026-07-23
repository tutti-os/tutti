# @tutti-os/workspace-file-reference

Reusable workspace file reference contracts, picker state, and optional React UI.

This package owns host-neutral file reference selection behavior for workspace
surfaces that need to browse, search, upload, preview, open, or share file
references. Hosts provide concrete file-system access through package contracts;
desktop preload calls, tuttid transport wiring, host absolute paths, and
product-specific integration stay in the consuming host adapter.

The package uses logical workspace paths and keeps reference picking reusable
across shared workspace features such as the agent GUI and issue manager.

It also provides host-neutral provenance filter contracts, an external-store
controller, and a controlled filter view. Hosts inject available Agent/member
options; source implementations declare which dimensions they can enforce and
apply active constraints before pagination. The package does not fetch a
catalog or infer product-specific membership itself. Disabled catalog options
remain available to host logic but are hidden by the controlled filter view by
default; a host can opt into rendering them with `showDisabledOptions`.

## Content error recovery

`ReferenceSourcePicker` accepts `resolveContentErrorAction` when a host can
offer recovery for selected content errors. Return an action label for errors
that should be retryable, or `null` to keep the default message-only state.
Selecting the action reruns the failed browse, search, or filtered-tree request.

```tsx
<ReferenceSourcePicker
  resolveContentErrorAction={(error) =>
    isRecoverable(error) ? { label: copy.t("actions.retry") } : null
  }
  {...props}
/>
```
