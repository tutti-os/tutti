---
name: tutti-workspace-app-factory
description: "Create or repair a self-contained Tutti workspace app package from a user request. Use for mention://workspace-app-factory/create handoffs, mention://workspace-app-factory handoffs, standalone Tutti workspace app generation, repair, validation, manifests, bootstrap scripts, package-local AGENTS.md, local HTTP runtimes, healthchecks, app assets, optional app-runtime Tutti CLI integration, and TUTTI_APP_* storage rules."
---

# Tutti Workspace App Factory

Use this skill to create or repair one Tutti workspace app package. The app package must be self-contained, runnable by the Tutti custom app runtime, and safe to copy into a workspace app archive.

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

If `context.json` is absent, operate in standalone mode. Treat the current working directory as the app authoring workspace, create the app package under `package/`, and infer missing metadata conservatively from the user request.

The package root is the only generated app output directory; files outside it are scratch or coordination files and will not be published.

## Mention Contract

Treat a `mention://workspace-app-factory/create` or `mention://workspace-app-factory` link as the factory handoff. In handoff mode, use the exact metadata, output rules, workspace context, and constraints from `context.json` as authoritative.

Before writing files, read these bundled references:

- `references/manifest-contract.md` for `tutti.app.json`.
- `references/cli-manifest-contract.md` for optional `tutti.cli.json`.
- `references/runtime-env.md` for runtime environment variables and storage ownership.
- `references/tutti-cli-commands.md` when the generated app runtime should call, combine, or expose local Tutti CLI capabilities.
- `references/validation-checklist.md` for completion checks.

Read `references/demos/simple-python-static-app/` only when you need a concrete complete package shape. Do not copy its demo app id, display name, description, or tags unless the user explicitly asks for the demo itself.

## Output Contract

Create or update these files under `output.packageRoot` from the context in handoff mode, or under `package/` in standalone mode:

- `tutti.app.json`: valid JSON manifest matching `references/manifest-contract.md`.
- `tutti.cli.json`: optional CLI manifest matching `references/cli-manifest-contract.md`, only when `tutti.app.json` declares `cli.manifest`.
- `bootstrap.sh`: executable shell entrypoint that starts the app server with no arguments.
- `AGENTS.md`: package-local guidance describing layout, runtime command, endpoints, data storage, and modification rules.
- `locales/<locale>/manifest.json`: manifest metadata localization files, only when the user asks for localized app metadata.
- App implementation files and assets needed for the requested behavior.

If the task supplies exact metadata such as `appId`, version, display name, or description, copy those values exactly into `tutti.app.json`. If metadata is missing, choose conservative defaults:

- `schemaVersion`: `tutti.app.manifest.v1`
- `version`: `0.1.0`
- `appId`: `app_` plus a lowercase hyphenated slug from the app name or request
- `description`: one concise sentence describing actual app behavior
- `icon`: package-local asset, preferably `{"type":"asset","src":"icon.svg"}`
- `runtime.bootstrap`: `bootstrap.sh`
- `runtime.healthcheckPath`: `/healthz`
- `localizationInfo`: omit unless the user asks for localized app metadata; when needed, follow `references/manifest-contract.md` and create each referenced locale file.

## Runtime Rules

Build a small local HTTP app. Prefer Python standard library or Node built-ins unless the user request clearly needs another stack.

The runtime must:

- Bind `$TUTTI_APP_HOST:$TUTTI_APP_PORT`, defaulting the host to `127.0.0.1` only when the variable is absent.
- Serve the manifest healthcheck path with a 2xx response.
- Treat `$TUTTI_APP_PACKAGE_DIR` as read-only after startup.
- Write durable app data only under `$TUTTI_APP_DATA_DIR`.
- Write scratch/runtime files only under `$TUTTI_APP_RUNTIME_DIR`.
- Write logs only under `$TUTTI_APP_LOG_DIR` when file logs are needed.
- Read `$TUTTI_WORKSPACE_ROOT` only when the app needs workspace context.
- Launch Python with `$TUTTI_APP_PYTHON` and Node with `$TUTTI_APP_NODE`; use `$TUTTI_APP_NPM` for npm install/build work.
- When the generated app calls another local Tutti capability at runtime, use `$TUTTI_CLI` and follow `references/tutti-cli-commands.md`.
- Read the current UI locale from the optional host-injected app context when localized in-app copy is needed. Do not pass locale in the launch URL query.
- Use CSS `prefers-color-scheme` / `matchMedia("(prefers-color-scheme: dark)")` for dark/light rendering. Do not pass theme in the launch URL query.
- When exposing app-owned files through references or generated content, return reference-list `location` objects scoped to `app-data-relative` or `app-package-relative`. Do not emit, persist, or instruct clients to open direct `.tutti` / `.tutti-dev` app state paths such as `$TUTTI_STATE_DIR/apps/...`; the daemon resolves valid locations before desktop clients open files.

Do not assume a Tutti API token, browser extension, daemon internals, or broad desktop APIs. The only browser-side host surface a generated app may optionally consume is the app context described in `references/runtime-env.md`.

## Dependency Rules

Avoid startup-time package installation. If dependencies or build artifacts are necessary, add an executable `prepare.sh` and keep `bootstrap.sh` focused on launching the prepared app. `prepare.sh` may use `$TUTTI_APP_PYTHON`, `$TUTTI_APP_NODE`, and `$TUTTI_APP_NPM` for install and build steps.

Generated apps must not rely on system `python`, `python3`, `node`, or `npm` commands. Use the explicit managed runtime environment variables instead.

Keep generated apps small and inspectable. Do not add frameworks, background workers, databases, or network services unless they are required by the user request.

## Implementation Workflow

1. Read the required reference files.
2. Decide the smallest runtime shape that satisfies the requested behavior.
3. Write the manifest, bootstrap script, package guidance, and app files.
4. Make `bootstrap.sh` executable.
5. Validate against `references/validation-checklist.md`.
6. Fix any validation failure before finishing.

## Repair Workflow

When fixing an existing draft:

- Preserve the existing `appId` unless the user explicitly asks to change it.
- Reread the references before changing runtime or manifest behavior.
- Update `AGENTS.md` when endpoints, data files, commands, or storage rules change.
- Keep reference files out of the package root.
