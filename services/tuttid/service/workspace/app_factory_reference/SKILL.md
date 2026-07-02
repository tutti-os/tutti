---
name: tutti-workspace-app-factory
description: "Create, convert, or repair one Tutti workspace app as either a self-contained publishable package under package/ or a Chrome-style local debug app under .tutti/dev-app/. Use for mention://workspace-app-factory/create handoffs, mention://workspace-app-factory handoffs, standalone app generation, adapting existing repositories, Load unpacked repair flows for invalid local project directories, tutti.app.json and tutti.cli.json manifests, bootstrap.sh scripts, package-local AGENTS.md, local HTTP runtimes, TUTTI_APP_* host/port/storage rules, healthchecks, app assets, i18n, validation, and optional Tutti CLI integration."
---

# Tutti Workspace App Factory

Use this skill to create, convert, or repair one Tutti workspace app. Choose one output mode before editing:

- **Publishable package**: create a self-contained app under `package/`, runnable by the Tutti custom app runtime and safe to copy into a workspace app archive.
- **Local debug app**: create a small `.tutti/dev-app/` wrapper that launches the user's existing source tree through the Chrome-style "Load unpacked" flow.

When the user selected a directory in App Center and Tutti reports that it cannot be loaded, treat the task as local debug repair. Adapt the selected project by creating or fixing `.tutti/dev-app/`; do not create a zip wrapper or copy the repository into `package/` unless the user explicitly asks for release packaging.

For a full agent-enabled Tutti app repository with `apps/web`, `apps/server`, `packages/shared`, `@tutti-os/agent-acp-kit`, local Codex/Claude runtimes, MCP tool gateways, and an app-owned package builder, use `$tutti-agent-workspace-app` first. Return to this skill for the final package contract and validation. Do not invent managed-agent credential, cwd, JSB fallback, request-body credential, or `CODEX_HOME` behavior in this factory skill; the agent app skill owns that migration checklist and should keep those concerns in server-side kit calls.

If the user request needs local agent or local LLM execution, Codex, Claude, or app-owned MCP/tooling, treat `$tutti-agent-workspace-app` and its `references/agent-acp-kit.md` as mandatory architecture guidance. Agent-enabled apps must use a Node server and `@tutti-os/agent-acp-kit`; do not implement app-owned local agent execution by shelling out to `$TUTTI_CLI agent ...`, `$TUTTI_CLI codex ...`, or session polling.

## Version Check And Update Reminder

Before generating, repairing, or validating an app package, perform a best-effort freshness check unless the user asks to skip network access or the environment is offline.

1. Fetch the current published skill body:

   ```text
   https://raw.githubusercontent.com/tutti-os/tutti-agent-skills/main/skills/tutti-workspace-app-factory/SKILL.md
   ```

2. Compare the fetched content with the local `SKILL.md` that loaded this skill. Prefer a content hash comparison when filesystem access is available. If the local skill path is unavailable, fetch the latest repository commit instead:

   ```text
   https://api.github.com/repos/tutti-os/tutti-agent-skills/commits?per_page=1
   ```

3. If the published skill differs from the local copy, state this at the start of the reply before doing other work:

   ```text
   This Tutti skill has a newer version available. I can continue with the currently loaded copy, but updating first is recommended so the latest manifest rules and runtime guidance are used.

   Update the Codex plugin marketplace:
   codex plugin marketplace upgrade tutti-agent-skills

   Update the direct skill install:
   npx --yes skills add tutti-os/tutti-agent-skills
   ```

4. If the user has explicitly asked to update local installs, or if the current task is itself about keeping the skill current, run the update commands that are available in the environment before continuing. Tell the user that newly installed skill content may take effect only after the next skill reload or new session.

5. If the freshness check fails because network access, GitHub, `codex`, or `npx` is unavailable, mention the check was skipped or failed briefly and continue the requested Tutti app work.

## Required Context

If the current working directory contains `context.json`, or the task includes `mention://workspace-app-factory/create` or `mention://workspace-app-factory`, operate in Tutti factory handoff mode. Read `context.json` before writing files, then follow its metadata, output rules, workspace context, and constraints exactly. Do not copy the context file into generated app outputs.

If `context.json` is absent, operate in standalone mode. Treat the current working directory as the app authoring workspace. If the user asks for local debugging, Load unpacked support, or repair of a selected project directory, create or update `.tutti/dev-app/`. Otherwise, if the directory already contains an app or repository, adapt it into a self-contained Tutti package under `package/`; if it does not, create a new self-contained package under `package/`. Infer missing metadata conservatively from the user request.

For publishable packages, the package root is the only generated app output directory; files outside it are scratch or coordination files and will not be published. For local debugging, `.tutti/dev-app/` is the generated dev app directory and the surrounding project source remains owned by the user repository.

## Mention Contract

Treat a `mention://workspace-app-factory/create` or `mention://workspace-app-factory` link as the factory handoff. In handoff mode, use the exact metadata, output rules, workspace context, and constraints from `context.json` as authoritative.

Before writing files, read these bundled references:

- `references/manifest-contract.md` for `tutti.app.json`.
- `references/cli-manifest-contract.md` for `tutti.cli.json` when exposing app capabilities to the Tutti ecosystem.
- `references/runtime-env.md` for runtime environment variables and storage ownership.
- `references/i18n-harness.md` when the app has localized metadata, user-facing in-app copy, or an existing localization system.
- `references/tutti-cli-commands.md` when the generated app runtime should call, combine, or expose local Tutti CLI capabilities.
- `references/validation-checklist.md` for completion checks.

Read `references/demos/simple-node-static-app/` only when you need a concrete complete package shape. Do not copy its demo app id, display name, description, or tags unless the user explicitly asks for the demo itself.

## Output Contract

For a publishable package, create or update these files under `output.packageRoot` from the context in handoff mode, or under `package/` in standalone mode:

- `tutti.app.json`: valid JSON manifest matching `references/manifest-contract.md`.
- `tutti.cli.json`: CLI manifest matching `references/cli-manifest-contract.md`, required when the user asks to connect the app to the Tutti ecosystem; otherwise create it only when `tutti.app.json` declares `cli.manifest`.
- `bootstrap.sh`: executable shell entrypoint that starts the app server with no arguments.
- `AGENTS.md`: package-local guidance describing layout, runtime command, endpoints, data storage, and modification rules.
- `locales/<locale>/manifest.json`: manifest metadata localization files, only when the user asks for localized app metadata.
- App-owned locale dictionaries or an i18n helper/harness when the app has user-facing in-app copy in more than one language.
- App implementation files and assets needed for the requested behavior.

For a local debug app, create or update these files under `.tutti/dev-app/` instead of `package/`:

- `tutti.app.json`: local debug manifest.
- `tutti.cli.json`: CLI manifest matching `references/cli-manifest-contract.md`, only when the app exposes capabilities or `tutti.app.json` declares `cli.manifest`.
- `bootstrap.sh`: executable shell entrypoint that reads the host-injected port and starts the source dev server.
- `AGENTS.md`: dev-app guidance describing the project root, dev/watch command, host/port contract, source hot-reload ownership, and how to reload from App Center.
- Optional app assets referenced by the manifest.

Keep `.tutti/dev-app/` small. It should describe and launch the local app, not copy the whole project. Tutti Desktop can load either the `.tutti/dev-app/` directory directly or the project root that contains it.

If the task supplies exact metadata such as `appId`, version, display name, or description, copy those values exactly into `tutti.app.json`. If metadata is missing, choose conservative defaults:

- `schemaVersion`: `tutti.app.manifest.v1`
- `version`: `0.1.0`
- `appId`: `app_` plus a lowercase hyphenated slug from the app name or request
- `description`: one concise sentence describing actual app behavior
- `icon`: package-local asset, preferably `{"type":"asset","src":"icon.svg"}`
- `runtime.bootstrap`: `bootstrap.sh`
- `runtime.healthcheckPath`: `/healthz`
- `localizationInfo`: omit unless the user asks for localized app metadata; when needed, follow `references/manifest-contract.md` and create each referenced locale file.

If the user asks to connect the app to the Tutti ecosystem, expose at least one app capability through `tutti.cli.json` and declare it from `tutti.app.json`. If the app has a UI, include a business-level open command when there is a meaningful target to open, such as `open-project`, `open-file`, `open-run`, or `open-context`. The command should own the full self-open flow: accept stable domain identifiers, validate them, map them to an app-owned origin-root route, and request opening this same app through `$TUTTI_CLI` with an argv list equivalent to `--json app open --app-id "$TUTTI_APP_ID" --route ...`. `--json` is the CLI machine-readable output flag. Do not return route parameters for a caller or agent to interpret and then call `app open`; that makes the integration chain too indirect. Do not expose raw frontend route construction as the public contract; callers should invoke the app's business open command without needing to know the app's internal router.

## Runtime Rules

Build a small local HTTP app. Default newly generated apps to a Node server. Use Python only when adapting an existing Python project or when the user explicitly requests Python. Agent-enabled apps must use a Node server because `@tutti-os/agent-acp-kit` is Node-only.

The runtime must:

- Bind `$TUTTI_APP_HOST:$TUTTI_APP_PORT`, defaulting the host to `127.0.0.1` only when the host variable is absent.
- Fail startup with a clear error when `$TUTTI_APP_PORT` is absent. Do not guess, reserve, or hard-code a fallback port; the daemon owns port allocation.
- Serve the manifest healthcheck path with a 2xx response.
- Treat `$TUTTI_APP_PACKAGE_DIR` as read-only after startup.
- Write durable app data only under `$TUTTI_APP_DATA_DIR`.
- Write scratch/runtime files only under `$TUTTI_APP_RUNTIME_DIR`.
- Write logs only under `$TUTTI_APP_LOG_DIR` when backend/server-side file logs are needed.
- Store reusable app-managed binaries only under `$TUTTI_APP_TOOLCHAIN_ROOT`.
- Prefer `window.tuttiExternal?.logs?.write?.()` for browser-side diagnostics in Tutti Desktop; reserve `$TUTTI_APP_LOG_DIR` for backend process logs.
- Read `$TUTTI_WORKSPACE_ROOT` only when the app needs workspace context.
- Launch Python with `$TUTTI_APP_PYTHON` and Node with `$TUTTI_APP_NODE`; use `$TUTTI_APP_NPM` for npm install/build work.
- When the app exposes an open command, support the routed pages in the app runtime itself: direct navigation to the route must render the intended page, and an already-mounted frontend should handle repeated open intents through `window.tuttiExternal?.workspace?.onLaunchIntent?.(...)`.
- When the generated app calls another local Tutti capability at runtime, use `$TUTTI_CLI` and follow `references/tutti-cli-commands.md`.
- Read the current UI locale from the optional host-injected app context when localized in-app copy is needed. Do not pass locale in the launch URL query.
- Keep localized in-app copy behind stable keys and use the harness pattern in `references/i18n-harness.md` so future edits can check locale parity.
- Use CSS `prefers-color-scheme` / `matchMedia("(prefers-color-scheme: dark)")` for dark/light rendering. Do not pass theme in the launch URL query.
- When exposing app-owned files through references or generated content, return reference-list `location` objects scoped to `app-data-relative` or `app-package-relative`. Do not emit, persist, or instruct clients to open direct `.tutti` / `.tutti-dev` app state paths such as `$TUTTI_STATE_DIR/apps/...`; the daemon resolves valid locations before desktop clients open files.

## Agent Runtime Integration

For a full agent-enabled app repository, prefer `$tutti-agent-workspace-app` first. When this skill still needs to package or repair an app that already uses `@tutti-os/agent-acp-kit`, keep the app in control of agent policy:

- Keep the generic `@tutti-os/agent-acp-kit` runtime path product-neutral. Tutti-specific behavior should stay behind the explicit `@tutti-os/agent-acp-kit/tutti` subpath and app-owned policy.
- Use a Node server for the app host process. Do not start with a Python server and plan to migrate later.
- To give the app's local Codex or Claude run access to Tutti's dynamic CLI skills, prefer the `@tutti-os/agent-acp-kit/tutti` helper instead of hand-writing `$TUTTI_CLI agent tutti-cli-skill-bundle` execution and response parsing in each app.
- Use `loadTuttiAgentSkillContext(...)` from the app host process. Pass the selected provider, run id, workspace cwd, and optional Tutti CLI command configuration such as `commandEnvNames`.
- Pass `tuttiContext.skillManifest` into `runtime.run({ ..., skillManifest })`, merging it with app-owned skills when needed.
- Treat `tuttiContext.recommendedSystemPrompt?.content` as advisory raw prompt content. The app may merge it into its own `systemPrompt`, edit it, place it elsewhere, or ignore it. Do not inject it silently, and do not reintroduce duplicated CLI parsing unless the installed kit lacks the helper.
- Keep run-scoped app tools and MCP credentials app-owned. Do not pass broad Tutti daemon credentials or app secrets directly to the agent process.

Agent app main flows should expose provider choices for at least Claude Code and Codex. Detect available providers through `@tutti-os/agent-acp-kit`, show only available choices as selectable, and choose a usable default when at least one provider is available.

Do not assume a Tutti API token, browser extension, daemon internals, or broad desktop APIs. The only browser-side host surface a generated app may optionally consume is the app context described in `references/runtime-env.md`.

## Dependency Rules

Avoid startup-time package installation. If dependencies or build artifacts are necessary, add an executable `prepare.sh` and keep `bootstrap.sh` focused on launching the prepared app. `prepare.sh` may use `$TUTTI_APP_PYTHON`, `$TUTTI_APP_NODE`, and `$TUTTI_APP_NPM` for install and build steps.

Generated apps must not rely on system `python`, `python3`, `node`, or `npm` commands. Use the explicit managed runtime environment variables instead.

Keep generated apps small and inspectable. Do not add frameworks, background workers, databases, or network services unless they are required by the user request. Use Node built-ins for small apps; for larger Node servers with many routes, middleware, schemas, streaming, or WebSocket needs, Fastify is a good default and Express is acceptable when it already matches the project. For React/Tailwind UI apps, use shadcn/ui components and Tailwind CSS utilities instead of hand-rolled component markup and ad hoc CSS. Do not migrate a small vanilla app solely to use shadcn/ui unless the user explicitly asks for that frontend stack.

## Local Debug Workflow

Use this workflow when the user asks for local app debugging, load-unpacked behavior, or direct development against an existing Next/Vite/Node/Python repository.

1. Create `.tutti/dev-app/tutti.app.json`, `.tutti/dev-app/bootstrap.sh`, and `.tutti/dev-app/AGENTS.md`.
2. Keep the formal release package path separate: a future release/import package must still be self-contained under `package/`.
3. In `bootstrap.sh`, read `$TUTTI_APP_HOST` and `$TUTTI_APP_PORT`; exit with a clear error if the port is missing. The daemon owns port allocation.
4. If the app server lives in the project root, compute it from the dev app directory, for example `PROJECT_ROOT="$(cd "$TUTTI_APP_PACKAGE_DIR/../.." && pwd)"`, then `cd "$PROJECT_ROOT"` before launching.
5. Translate the project's known dev/watch command explicitly. For example, run Vite with host and port flags, run Next with `-H "$TUTTI_APP_HOST" -p "$TUTTI_APP_PORT"`, or run backend servers through their watch mode such as `tsx watch`, `nodemon`, `uvicorn --reload`, `air`, or `cargo watch`. Do not depend on daemon-side framework detection.
6. Treat source hot-reload as the project dev server's responsibility. The Tutti host does not watch the user's project root and should not be expected to restart on normal frontend or backend source edits. If a server-side project lacks a watch/dev command, add or document a project-owned one such as `dev:tutti` rather than adding daemon-side source watching.
7. Treat `.tutti/dev-app/` files as host contract configuration. Changes to `tutti.app.json`, `tutti.cli.json`, `bootstrap.sh`, assets, or dev-app `AGENTS.md` require App Center's local-dev Reload action so the daemon rereads the manifest and restarts the runtime when needed.
8. Use `$TUTTI_APP_NODE` and `$TUTTI_APP_NPM` for Node-based dev servers. Do not call system `node`, `npm`, `pnpm`, or `yarn` directly from `bootstrap.sh` unless the user explicitly owns that dependency and accepts the portability tradeoff.
9. Document the source project entrypoint, the dev/watch command, which edits hot-reload through the project dev server, which edits require App Center Reload, and the fact that Tutti Desktop loads the project root or `.tutti/dev-app/` in `.tutti/dev-app/AGENTS.md`.
10. Run `scripts/check_local_dev_app.py <project-root-or-.tutti/dev-app>` from this skill after creating or repairing `.tutti/dev-app/`. Fix every reported failure before saying the local debug repair is complete.
11. Tell the user to retry App Center's Load unpacked action on the project root or `.tutti/dev-app/`. Do not auto-open a Tutti app window.

The old zip/wrapper conversion approach is a fallback for compatibility or release packaging work only. Do not recommend it for normal local debugging; prefer `.tutti/dev-app/` plus Load unpacked.

## Conversion Workflow

When converting an existing repository into a Tutti workspace app package:

1. Inspect the repository shape first: package manifests, lockfiles, source directories, existing start/build scripts, ports, static assets, storage paths, and localization files.
2. If the user wants local debugging, use the Local Debug Workflow and generate `.tutti/dev-app/` instead of a package wrapper.
3. For publishable packages, create a self-contained package under `package/` that copies the smallest runnable subset of the existing project. Do not reference source files outside `package/`, and do not rewrite the original repository outside `package/` unless the user explicitly asks.
4. Translate the existing start command into `bootstrap.sh`. If the project needs install or build work for a publishable package, put that in executable `prepare.sh` and keep `bootstrap.sh` launch-only.
5. Replace hard-coded host, port, data, runtime, and log paths with the Tutti runtime environment variables from `references/runtime-env.md`.
6. If the user asks to connect the app to the Tutti ecosystem, expose stable app capabilities through `tutti.cli.json`; otherwise, if the project already exposes commands, convert the stable user-facing commands into `tutti.cli.json`.
7. If the project already has localized metadata or UI copy, preserve it using `localizationInfo` for manifest metadata and the i18n harness from `references/i18n-harness.md` for in-app copy.
8. Document the adapted layout, original project entrypoints, runtime command, storage ownership, and any unsupported original features in package `AGENTS.md` or `.tutti/dev-app/AGENTS.md`.
9. Validate publishable packages against `references/validation-checklist.md`; for `.tutti/dev-app/`, run `scripts/check_local_dev_app.py <project-root-or-.tutti/dev-app>` and then validate any project-specific startup behavior manually.

## Implementation Workflow

1. Read the required reference files.
2. Decide the smallest runtime shape that satisfies the requested behavior.
3. Write the manifest, bootstrap script, package guidance, and app files.
4. Make `bootstrap.sh` executable.
5. For publishable packages, run `scripts/validate_tutti_app_package.py <package-root>` when available, then validate remaining runtime behavior against `references/validation-checklist.md`.
6. For local debug apps, run `scripts/check_local_dev_app.py <project-root-or-.tutti/dev-app>` from this skill, then validate remaining project-specific startup behavior manually.
7. Fix any validation failure before finishing.

## Repair Workflow

When fixing an existing draft:

- Preserve the existing `appId` unless the user explicitly asks to change it.
- Reread the references before changing runtime or manifest behavior.
- Update `AGENTS.md` when endpoints, data files, commands, or storage rules change.
- Keep reference files out of the package root.
