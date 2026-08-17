# Feature Flags

Feature flags in Tutti are **pure config distribution**: durable storage in
daemon preferences, push to clients over the eventstream, a key registry, and
a query helper. The infrastructure is semantics-free — it stores and
distributes `map[string]bool` and nothing more. Each feature owns what "off"
means; that logic never belongs to the flag infrastructure.

## Taxonomy

- **Capability flags** gate daemon-enforced behavior (writes, orchestration,
  runtime operations). The daemon must enforce them server-side so toggling
  the UI cannot bypass the gate. Query them through the daemon registry
  helper, never by poking the raw map.
- **UI-preference flags** only show or hide renderer surfaces. The renderer
  catalog is sufficient; no daemon enforcement is required.

A flag can start as UI-preference and gain daemon enforcement later; keep the
same key when that happens.

`lab.connectors` is a capability flag whose owning surfaces span renderer
settings, daemon composition, and daemon-projected Composer Options. The daemon
reads it fail-closed during startup. When it is off, the Connector market,
runtime, MCP gateway, Agent runtime projection, and `tutti connector` command
provider are not constructed; consequently Connector policy is not injected
into Agent system prompts. Existing installed state remains on disk. Changing
the flag takes effect for daemon-owned Connector capabilities after the daemon
restarts. Renderer off semantics also remove the Connectors settings entry,
connector setup deep links, and connector entries from the Agent composer, and
the AgentGUI footer uses Tutti Mode as that slot's fallback. Renderer
projections must filter cached connector palette rows while the daemon-backed
Composer Options reread is in flight.

## Key contract

The daemon registry is the key contract:

- Go: `services/tuttid/biz/preferences/lab_flags.go`
- Renderer mirror: `apps/desktop/src/shared/featureFlags/catalog.ts`

Both must carry **identical keys and defaults**. When adding, renaming, or
removing a flag, change both sides in the same change. Storage and push are
already generic (`DesktopPreferences.FeatureFlags`,
`NormalizeDesktopFeatureFlags`, preferences eventstream updates), so a new
flag only needs registry entries and copy.

When a feature graduates, remove its registry entries and every owning-feature
gate in the same change. Historical stored values may remain in generic
preferences for compatibility, but graduated features must not consult them;
this makes the feature available to existing profiles even when their old
value was `false`.

Resolution rule on both sides: a stored value wins; absent keys fall back to
the registry default; absent unregistered keys resolve to `false`
(`IsLabFlagEnabled` in Go, `isFeatureEnabled` in TS).

## Defaults and off semantics

- Defaults are **fail-closed**: every Lab flag defaults to `false`. A flag
  that must default on needs an explicit product decision recorded in the PR.
- Recommended default-off semantics (guidance, not a mandate): while a flag is
  off, new writes are rejected or hidden, but existing data and already
  running behavior are left unaffected. The owning feature decides and
  documents its exact semantics.

## Naming

- `lab.*` for Lab experiments surfaced in the Lab settings section.
- Domain-scoped dotted keys for everything else, for example
  `agent.extension.<source>` or `browser.chromeCookieImport`.
- Keys are lowercase camelCase segments joined by dots.

## Existing reference pattern

`services/tuttid/service/agentextension/manager.go` is the existing example
of feature-owned semantics: stable sources are enabled by generated product
configuration and ignore retired stored activation values, while Early Access
sources derive their own keys (`"agent.extension."+source.Key`) and decide what
disabled means (reconcile and stop). New consumers should prefer registry
constants and `IsLabFlagEnabled` over poking the raw map, while keeping their
own off and graduation semantics in the owning feature, exactly as the Agent
Extension manager does.
