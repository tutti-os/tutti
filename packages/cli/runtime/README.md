# Tutti CLI Runtime

`github.com/tutti-os/tutti/packages/cli/runtime` is the public client-side
contract for Tutti CLI capability discovery and invocation.

It owns the wire DTOs, longest-prefix command matching, argv parsing,
positional shortcuts, help and output rendering, exit classification, the
embedded canonical manifest, and shared argv, HTTP-wire, rendering, gate, and
domain compatibility vectors. Product
endpoint discovery, bearer credentials, health/status commands, and daemon
business handlers stay in their owning applications and services.

The module is released from the repository's shared stable package workflow
with tags shaped as `packages/cli/runtime/vX.Y.Z`. External consumers must pin
a released tag and must not depend on `apps/cli` or `services/tuttid` internals.

Regenerate canonical metadata after changing daemon command definitions:

```sh
pnpm generate:cli-contract
pnpm check:cli-contract-generated
```
