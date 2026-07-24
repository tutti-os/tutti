# Conventions

Use this directory for repository conventions such as naming, layering, testing, and review rules.

These documents should reflect the current stable rules of the repository rather than one-off implementation history. If a scoped spec or plan becomes durable, promote the enduring rule here.

Current documents:

- [API Contracts](./api-contracts.md)
- [Desktop Layering](./desktop-layering.md)
- [Desktop Release](./desktop-release.md)
- [Desktop Visual Language](./desktop-visual-language.md)
- [Deprecated Workspace App Agent APIs](./deprecated-workspace-app-agent-apis.md)
- [Feature Flags](./feature-flags.md)
- [Local Git Hooks](./local-git-hooks.md)
- [Local State Storage](./local-state-storage.md)
- [Logging](./logging.md)
- [Tuttid Layering](./tuttid-layering.md)
- [npm Package Release](./npm-package-release.md)
- [Runtime Overrides](./runtime-overrides.md)
- [Runtime Image Assets](./runtime-image-assets.md)
- [Static Analysis](./static-analysis.md)
- [Testing](./testing.md)
- [Troubleshooting](./troubleshooting/README.md)
- [Tutti Agent Skills Repository](./tutti-agent-skills-repository.md)
- [Tutti CLI Contract](./tutti-cli-contract.md)
- [UI System](../../packages/ui/system/ui-system.md)
- [Workbench](./workbench.md)
- [Workspace App Catalog](./workspace-app-catalog.md)
- [Workspace App Runtime](./workspace-app-runtime.md)
- [Workspace Domain](./workspace-domain.md)

## Change Routing Matrix

Use this matrix when a change touches a durable boundary and the right follow-up is not obvious.

| Change touches                                                                                                              | Durable source to check or update                                                                                                                                                                | Validation to run                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon-owned CLI commands or app CLI compatibility                                                                          | [Tutti CLI Contract](./tutti-cli-contract.md), plus [API Contracts](./api-contracts.md) when invoke or capability HTTP shapes change                                                             | focused daemon CLI tests; OpenAPI changes also need `pnpm generate:api` and `pnpm check:api-generated`                                                                |
| daemon HTTP request or response contracts                                                                                   | [API Contracts](./api-contracts.md) and `services/tuttid/api/openapi/tuttid.v1.yaml`                                                                                                             | `pnpm generate:api`, `pnpm check:api-generated`                                                                                                                       |
| daemon business rules, persistence, or domain workflows                                                                     | [Tuttid Layering](./tuttid-layering.md), and a domain convention such as [Workspace Domain](./workspace-domain.md) when one exists                                                               | `pnpm lint:go`, `cd services/tuttid && go test ./... && go build ./...`                                                                                               |
| desktop Electron, preload, renderer layering, IPC, or daemon supervision                                                    | [Desktop Layering](./desktop-layering.md), [Desktop Transport](../architecture/desktop-transport.md), and [Desktop Windows](../architecture/desktop-windows.md) as relevant                      | `pnpm check:electron-runtime-boundaries`, `pnpm --filter @tutti-os/desktop typecheck`, `pnpm --filter @tutti-os/desktop build`                                        |
| desktop packaging, signing, auto-update, GitHub Release, or release notification                                            | [Desktop Release](./desktop-release.md)                                                                                                                                                          | `pnpm --filter @tutti-os/desktop build:unpack`, then `pnpm check:full` when practical                                                                                 |
| workspace app managed runtime artifacts, runtime catalog, or runtime CDN publishing                                         | [Workspace App Runtime](./workspace-app-runtime.md)                                                                                                                                              | `node --test ./tools/scripts/build-tutti-app-runtime-catalog.test.mjs`, `pnpm lint:ts`; downloader changes also need focused tuttid and desktop checks                |
| Agent Extension host contracts, trusted sources, installation, or verification                                              | [Agent Extensions](../architecture/agent-extensions.md); publisher implementation and rollout guidance live in `tutti-os/tutti-agent-extension-skill`                                            | downloader and verifier changes need focused tuttid and desktop checks                                                                                                |
| public npm package releases, package build output, pack contents, or beta package publishing                                | [npm Package Release](./npm-package-release.md)                                                                                                                                                  | `pnpm release:pack:check`, `pnpm typecheck`, `pnpm lint:ts`                                                                                                           |
| renderer feature structure or imports                                                                                       | [Desktop Layering](./desktop-layering.md)                                                                                                                                                        | `pnpm check:renderer-boundaries`                                                                                                                                      |
| renderer React render boundaries, store subscription shape, component splitting, or effect usage                            | [Desktop Layering](./desktop-layering.md) and [Workbench/Renderer Troubleshooting](./troubleshooting/workbench-renderer.md) for recurring external-store subscription traps                      | `pnpm check:renderer-boundaries`, `pnpm --filter @tutti-os/desktop typecheck`, `pnpm --filter @tutti-os/desktop build`                                                |
| Workbench snapshot contracts, shared Workbench packages, desktop Workbench host adapters, or daemon snapshot reconciliation | [Workbench](./workbench.md), [API Contracts](./api-contracts.md) for synchronized schemas, and [Workspace Domain](./workspace-domain.md) for daemon workspace ownership                          | `pnpm check:renderer-boundaries`, `pnpm --filter @tutti-os/workbench-surface typecheck`, `pnpm --filter @tutti-os/workbench-surface test`, Workbench-focused Go tests |
| product UI text, Electron dialog labels, empty states, status copy, or user-facing errors                                   | nearest feature docs plus the desktop i18n layer                                                                                                                                                 | `pnpm check:i18n`                                                                                                                                                     |
| shared UI tokens, primitives, icons, exports, or CSS entrypoints                                                            | [UI System](../../packages/ui/system/ui-system.md) and [Desktop Visual Language](./desktop-visual-language.md)                                                                                   | `pnpm check:ui-boundaries`, `pnpm typecheck`                                                                                                                          |
| runtime raster images, icon resolution, or retained design sources                                                          | [Runtime Image Assets](./runtime-image-assets.md)                                                                                                                                                | inspect intrinsic dimensions and compare the optimized image at its largest rendered size                                                                             |
| repository-owned defaults under `config/tutti.defaults.json`                                                                | [Local State Storage](./local-state-storage.md), [Logging](./logging.md), or [Desktop Transport](../architecture/desktop-transport.md) as relevant                                               | `pnpm generate:defaults`, `pnpm check:defaults-generated`                                                                                                             |
| local state paths or new `TUTTI_*` / `TUTTID_*` override variables                                                          | [Runtime Overrides](./runtime-overrides.md), [Local State Storage](./local-state-storage.md), [Logging](./logging.md), and [Desktop Transport](../architecture/desktop-transport.md) as relevant | path-specific tests plus `pnpm smoke:desktop-transport` when transport or listener setup changes                                                                      |
| repository-managed checks, hooks, lint rules, or validation scripts                                                         | [Local Git Hooks](./local-git-hooks.md) and [Static Analysis](./static-analysis.md)                                                                                                              | the changed script directly, then `pnpm check:full` when practical                                                                                                    |
| recurring bug patterns, debugging traps, or reusable fix checklists                                                         | [Troubleshooting](./troubleshooting/README.md)                                                                                                                                                   | the validation steps recorded by the entry plus the affected package or surface checks                                                                                |

Keep `AGENTS.md` files as short action guides. Put stable explanations, review rules, and ownership decisions in this directory or in `docs/architecture`.
