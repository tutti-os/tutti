# @tutti-os/workspace-external-core

Contracts and host-agnostic helpers for the workspace app external bridge.

`window.tuttiExternal` currently exposes:

- `app.getContext()` and `app.subscribe()` for host workspace/app context.
- `at.query()` for host-provided mention candidates.
- `files.select()` for user-activated workspace file picking.
- `files.open()` for user-activated host opening/revealing of a known workspace file path.
- `permissions.request()` for user-activated host permission grants such as managed AI model access.
- `settings.open()` for user-activated host settings navigation, including the managed models tab.
