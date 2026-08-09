# Windows Agent Runtime Setup Reliability

## Background and goal

Windows Agent installation currently depends on three independent conditions:
the daemon must inherit the same outbound proxy behavior as Desktop, the `uv`
bootstrap download must reach GitHub, and every consumer must select the same
installed agent executable. The goal is to remove the avoidable `uv` network
dependency, make static system-proxy handling symmetric with macOS, and prevent
stale Windows shims from splitting status/login/model/session behavior.

## Current architecture and chain

```text
Desktop -> tuttid -> Target installer -> download uv -> uv installs Python agent
                  -> provider resolver -> PATH/npm shim -> status/login/session
```

- macOS system proxy is converted to process proxy environment; Windows only
  receives explicit environment variables.
- `uv` is pinned and verified, but downloaded dynamically on first use.
- OpenCode installation may produce a complete managed npm package while an
  older PATH shim remains visible to some consumers.
- Kimi versions before `0.34.0` can initialize ACP yet reject API-key
  `session/new` as unauthenticated.

## Target architecture and chain

```text
Desktop package
  -> inject packaged uv archive root
  -> tuttid verifies cache or packaged archive; download only when absent
  -> uv installs the pinned Python agent dynamically

OS proxy adapter -> shared merge/cache -> daemon HTTP + every child process

provider resolver -> one absolute executable
                  -> status + login + model catalog + ACP session
```

## Repository and module changes

| Repository/module | Change |
| --- | --- |
| `tutti` Desktop packaging | Stage one official compressed `uv` archive per packaged architecture; inject `TUTTI_BUNDLED_UV_ROOT`. |
| `tutti` agent extension service | Verify size/SHA, safely extract packaged `uv`, keep verified cache and network fallback. |
| `tutti` runtime command | Split native proxy reads into Darwin/Windows/other build-tagged files; keep merge policy shared. |
| `tutti` agent status | Resolve a complete managed npm binary once and reuse it across OpenCode consumers. |
| Kimi extension | Pin install to `0.34.0`, require local `>=0.34.0 <1.0.0`, and verify API-key `session/new`. |
| Hermes extension | Document that the host owns `uv`; keep Hermes/Python installation dynamic and the package declarative. |

No public HTTP API or persisted-data schema is added. The only new interface is
the internal Desktop-to-daemon environment variable `TUTTI_BUNDLED_UV_ROOT`.

## Reuse and adapter boundary

Proxy precedence, bypass normalization, caching, child-process injection, and
HTTP transport behavior remain shared. Native adapters only read OS settings.
The existing UV artifact catalog, checksum, safe archive extraction, and
verified cache are reused; Desktop owns resource layout, while tuttid never
depends on Electron paths directly.

## Explicitly out of scope

- Bundling Node, Python, Kimi, Hermes, OpenCode, or their dependency graphs.
- Executing Windows PAC scripts or translating SOCKS proxies.
- Changing user credentials or publishing managed agent commands globally.
- Adding a new public service/API or migrating persisted records.

## Migration and compatibility

There is no data migration. Existing verified UV caches continue to win. A
package without the new resource uses the existing signed dynamic download.
Explicit proxy environment variables and `TUTTI_DISABLE_PROXY_AUTODETECT`
retain precedence. Kimi installations below `0.34.0` are not reused; the Target
installer creates/updates its isolated pinned runtime without overwriting the
user's global Kimi installation.

## Risk and rollback

- Package size grows by about 22–26 MiB compressed per shipped architecture.
  Production architecture-specific builds stage one archive; the local
  `MAC_ARCH=all` convenience build stages both Darwin archives into every
  artifact produced by that combined invocation.
- Native proxy state can be stale for at most the existing 60-second cache TTL.
- A corrupt packaged UV archive is never executed; tuttid falls back to the
  same checksum-verified official download and reports both causes if that
  download also fails.

Rollback is a normal code/package rollback: remove the Desktop resource and
environment injection to restore dynamic UV download; revert the Windows
adapter to restore explicit-env-only proxy behavior; revert the Kimi pin if the
upstream runtime regresses. No database rollback is required.

## Tests and acceptance

- Parser/precedence tests cover macOS and Windows proxy forms, bypasses, SOCKS
  rejection, and explicit-env priority; Windows and Darwin files compile.
- UV tests prove a verified bundle performs zero network requests and corrupt
  bundles are rejected; release staging verifies the real official archive.
- OpenCode tests plant a stale shim plus complete managed package and require
  the managed absolute command.
- Kimi tests require pinned version, API-key ACP `session/new`, commands, and
  Skill discovery.
- Packaged Windows acceptance blocks GitHub UV downloads, installs Hermes, and
  completes ACP initialize/session creation through the configured package
  index.

## Phased order

1. Land host proxy, bundled UV, and OpenCode resolution with compatibility
   fallback.
2. Land Kimi minimum-version/package pin and its ACP regression test.
3. Land Hermes host-contract documentation and run packaged Windows acceptance.
4. Monitor integrity/proxy diagnostics; promote Windows packaging only through
   its existing release gates.

## Pending confirmation

- Whether PAC support is required for managed enterprise Windows deployments.
- Final installer-size budget and whether universal macOS packages may include
  both architecture archives.
