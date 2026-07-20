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

## Key contract

The daemon registry is the key contract:

- Go: `services/tuttid/biz/preferences/lab_flags.go`
- Renderer mirror: `apps/desktop/src/shared/featureFlags/catalog.ts`

Both must carry **identical keys and defaults**. When adding, renaming, or
removing a flag, change both sides in the same change. Storage and push are
already generic (`DesktopPreferences.FeatureFlags`,
`NormalizeDesktopFeatureFlags`, preferences eventstream updates), so a new
flag only needs registry entries and copy.

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
of feature-owned semantics: it reads the raw flag map, derives its own keys
(`"agent.extension."+source.Key`), and decides what disabled means for Agent
Extension sources (reconcile and stop). New consumers should prefer the
registry constants and `IsLabFlagEnabled` over poking the raw map, while
keeping their own off semantics in the owning feature, exactly as the Agent
Extension manager does.
