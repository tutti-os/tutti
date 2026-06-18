# Tutti Agent Skills Repository

This document defines the proposed external repository shape for publishing the
Tutti workspace app factory skill as both:

- an agent plugin
- a skill repository installable with `npx skills add`

The goal is to publish one external package that is easy for outside users to
install while preserving the current built-in App Factory flow in this
repository.

## Current State

The built-in App Factory skill currently lives at:

```text
services/tuttid/service/workspace/app_factory_reference/
```

That directory contains:

```text
SKILL.md
references/
  manifest-contract.md
  cli-manifest-contract.md
  runtime-env.md
  tutti-cli-commands.md
  validation-checklist.md
  demos/simple-python-static-app/
```

The App Factory service embeds this directory with Go `embed`, then passes it to
agent sessions as an extra provider-native skill. The skill is copied into the
session-scoped provider skill root. It is not installed into the user's global
skill directory.

For Codex sessions, the runtime preparer writes the skill under:

```text
<runtimeRoot>/codex-home/skills/app-factory/
```

and sets:

```text
CODEX_HOME=<runtimeRoot>/codex-home
```

For Claude Code sessions, the runtime preparer writes the skill under the
session-scoped Tutti plugin directory:

```text
<runtimeRoot>/claude-plugin/tutti-cli/skills/app-factory/
```

Because this internal path is deep inside the Tutti main repository,
`npx skills add <repository-root> --list` does not reliably expose it as a public
installable skill. Directly pointing `npx skills add` at the skill directory does
work, but that is not a good public installation contract.

## Proposed External Repository

Use one external repository that is both a plugin repository and a skills
repository. The repository name should not be tied to one agent provider.

Recommended repository name:

```text
tutti-agent-skills
```

Recommended structure:

```text
tutti-agent-skills/
  .agents/
    plugins/
      marketplace.json
  .codex-plugin/
    plugin.json
  plugins/
    tutti/
      .codex-plugin/
        plugin.json
      skills/
        tutti-workspace-app-factory/
          SKILL.md
          agents/
            openai.yaml
          references/
            ...
  skills/
    tutti-workspace-app-factory/
      SKILL.md
      agents/
        openai.yaml
      references/
        manifest-contract.md
        cli-manifest-contract.md
        runtime-env.md
        tutti-cli-commands.md
        validation-checklist.md
        demos/
          simple-python-static-app/
  scripts/
    pull-from-tutti-main.sh
    check-tutti-main-sync.sh
```

This layout has two intended consumers:

- Codex marketplace import reads `.agents/plugins/marketplace.json`, then loads the
  `tutti` plugin from `plugins/tutti/`.
- Direct plugin ingestion reads `.codex-plugin/plugin.json` and the `skills` pointer.
- `npx skills add` discovers the skill under `skills/tutti-workspace-app-factory`.

Keep the skill name stable:

```yaml
name: tutti-workspace-app-factory
```

## Plugin Manifest

Create `.codex-plugin/plugin.json` with a minimal plugin manifest. Do not declare
`apps`, `mcpServers`, or `hooks` until those companion files actually exist.

Initial manifest:

```json
{
  "name": "tutti",
  "version": "0.1.0",
  "description": "Tutti workspace app authoring tools for agent runtimes.",
  "author": {
    "name": "Tutti"
  },
  "repository": "https://github.com/tutti-os/tutti-agent-skills",
  "license": "MIT",
  "keywords": ["tutti", "workspace-apps", "agent-skills"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Tutti",
    "shortDescription": "Create and repair Tutti workspace apps",
    "longDescription": "Skills for generating, validating, and repairing self-contained Tutti workspace app packages.",
    "developerName": "Tutti",
    "category": "Developer Tools",
    "capabilities": ["Write"],
    "websiteURL": "https://tutti.sh/",
    "defaultPrompt": [
      "Create a Tutti workspace app package.",
      "Repair this Tutti workspace app package.",
      "Validate a Tutti workspace app manifest."
    ]
  }
}
```

Before publishing, validate whether the plugin registry accepts the selected
`interface.capabilities` values. If validation rejects `Write`, replace it with
an accepted capability value or omit optional capability metadata.

## Skill Metadata

The skill directory should include `agents/openai.yaml` for UI metadata:

```yaml
interface:
  display_name: "Tutti Workspace App Factory"
  short_description: "Create Tutti workspace app packages"
  default_prompt: "Use $tutti-workspace-app-factory to create or repair a self-contained Tutti workspace app package."

policy:
  allow_implicit_invocation: true
```

The `SKILL.md` frontmatter must contain only `name` and `description`.

Example:

```yaml
---
name: tutti-workspace-app-factory
description: "Create or repair a self-contained Tutti workspace app package from a user request. Use for mention://workspace-app-factory/create handoffs, mention://workspace-app-factory handoffs, Tutti workspace app generation, repair, validation, manifests, bootstrap scripts, package-local AGENTS.md, local HTTP runtimes, healthchecks, app assets, optional app-runtime Tutti CLI integration, and TUTTI_APP_* storage rules."
---
```

## Skill Runtime Modes

The current built-in skill assumes the Tutti App Factory handoff always provides
`context.json`. External users may install the skill directly and run it outside
that handoff. The public skill must support both modes.

Add this rule near the top of `SKILL.md`:

```markdown
## Required Context

If the current working directory contains `context.json`, or the task includes
`mention://workspace-app-factory/create` or `mention://workspace-app-factory`,
operate in Tutti factory handoff mode. Read `context.json` before writing files,
then follow its metadata, output rules, workspace context, and constraints
exactly.

If `context.json` is absent, operate in standalone mode. Treat the current
working directory as the app authoring workspace, create the app package under
`package/`, and infer missing metadata conservatively from the user request.
```

Handoff mode must preserve the existing behavior:

- read `context.json` before writing files
- use `output.packageRoot` as the package root
- do not copy `context.json` into generated app outputs
- follow all manifest, runtime, storage, CLI, and validation references

Standalone mode should keep the same generated package contract, but with
default output:

```text
package/
  tutti.app.json
  bootstrap.sh
  AGENTS.md
  ...
```

## Sync Direction

Short term, keep the Tutti main repository built-in directory as the source of truth because
that is where the runtime integration is currently tested.

Sync direction:

```text
tutti-main/services/tuttid/service/workspace/app_factory_reference/
  -> tutti-agent-skills/skills/tutti-workspace-app-factory/
  -> tutti-agent-skills/plugins/tutti/skills/tutti-workspace-app-factory/
```

Put this script in the external repository as `scripts/pull-from-tutti-main.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="${1:?usage: $0 /path/to/tutti-main}"
SRC_DIR="$SOURCE_REPO/services/tuttid/service/workspace/app_factory_reference/"
DST_DIR="skills/tutti-workspace-app-factory/"
PLUGIN_DST_DIR="plugins/tutti/skills/tutti-workspace-app-factory/"

rsync -a --delete "$SRC_DIR" "$DST_DIR"
rsync -a --delete "$SRC_DIR" "$PLUGIN_DST_DIR"
```

Use it from the external repository:

```bash
./scripts/pull-from-tutti-main.sh /path/to/tutti-main
```

Add a drift check script as `scripts/check-tutti-main-sync.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="${1:?usage: $0 /path/to/tutti-main}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/skills/tutti-workspace-app-factory"
rsync -a --delete \
  "$SOURCE_REPO/services/tuttid/service/workspace/app_factory_reference/" \
  "$TMP_DIR/skills/tutti-workspace-app-factory/"

diff -ru "$TMP_DIR/skills/tutti-workspace-app-factory" \
  "skills/tutti-workspace-app-factory"

diff -ru "$TMP_DIR/skills/tutti-workspace-app-factory" \
  "plugins/tutti/skills/tutti-workspace-app-factory"
```

Run the drift check in CI when the external repository is updated. If the
external repository becomes the source of truth later, reverse the sync
direction and add a Tutti main repository-side check that compares the embedded copy to the
external repository content.

Avoid casual two-way sync. Pick one source of truth for each phase.

## Tutti Repository Pull Request Workflow

Use a pull-request-stage workflow first. The workflow should run when a Tutti main repository
PR changes the built-in App Factory skill directory:

```yaml
on:
  pull_request:
    paths:
      - "services/tuttid/service/workspace/app_factory_reference/**"
```

This workflow must not push to `tutti-agent-skills` and must not open or update
external repository pull requests. A Tutti main repository PR is still review content, not a
published source of truth.

The pull request workflow should:

1. check out Tutti main repository
2. create a temporary `tutti-agent-skills` repository layout in the workflow
   workspace
3. copy `services/tuttid/service/workspace/app_factory_reference/` into
   `skills/tutti-workspace-app-factory/`
4. validate the temporary plugin and skill layout
5. upload the temporary repository layout as an artifact
6. comment on the Tutti main repository PR with validation results and the intended external
   repository paths

Example workflow:

```yaml
name: Preview Tutti Agent Skills Sync

on:
  pull_request:
    paths:
      - "services/tuttid/service/workspace/app_factory_reference/**"

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Tutti main repository
        uses: actions/checkout@v4

      - name: Build temporary skills repository layout
        run: |
          mkdir -p /tmp/tutti-agent-skills/skills/tutti-workspace-app-factory
          rsync -a --delete \
            services/tuttid/service/workspace/app_factory_reference/ \
            /tmp/tutti-agent-skills/skills/tutti-workspace-app-factory/
          mkdir -p /tmp/tutti-agent-skills/.codex-plugin

      - name: Write temporary plugin manifest
        run: |
          cat > /tmp/tutti-agent-skills/.codex-plugin/plugin.json <<'JSON'
          {
            "name": "tutti",
            "version": "0.1.0",
            "description": "Tutti workspace app authoring tools for agent runtimes.",
            "author": { "name": "Tutti" },
            "repository": "https://github.com/tutti-os/tutti-agent-skills",
            "license": "MIT",
            "keywords": ["tutti", "workspace-apps", "agent-skills"],
            "skills": "./skills/",
            "interface": {
              "displayName": "Tutti",
              "shortDescription": "Create and repair Tutti workspace apps",
              "longDescription": "Skills for generating, validating, and repairing self-contained Tutti workspace app packages.",
              "developerName": "Tutti",
              "category": "Developer Tools",
              "capabilities": ["Write"],
              "websiteURL": "https://tutti.sh/",
              "defaultPrompt": [
                "Create a Tutti workspace app package.",
                "Repair this Tutti workspace app package.",
                "Validate a Tutti workspace app manifest."
              ]
            }
          }
          JSON

      - name: Upload preview artifact
        uses: actions/upload-artifact@v4
        with:
          name: tutti-agent-skills-preview
          path: /tmp/tutti-agent-skills
```

The temporary manifest in this workflow is only for preview validation. The real
manifest must live in the external `tutti-agent-skills` repository.

The PR comment should communicate:

```text
This PR changes the built-in Tutti workspace app factory skill.

External repository target:
  skills/tutti-workspace-app-factory/

Preview artifact:
  tutti-agent-skills-preview

This workflow did not push to the external repository. After this PR lands,
sync the external repository through the release/update process.
```

This keeps Tutti main repository PR feedback fast while preventing unmerged Tutti main repository changes from
appearing in the public skills repository.

## External Repository Update Workflow

After a Tutti main repository PR lands, update the external repository automatically from the
Tutti main repository `main` branch. This keeps the external repository in sync without asking
a human to remember a second manual workflow.

```yaml
on:
  push:
    branches:
      - main
    paths:
      - "services/tuttid/service/workspace/app_factory_reference/**"
```

The update workflow should:

1. check out Tutti main repository at the pushed `main` commit
2. check out `tutti-agent-skills`
3. copy the built-in skill into `skills/tutti-workspace-app-factory/`
4. bump the plugin cachebuster or version metadata when needed
5. run plugin and skill validation
6. open or update a pull request in `tutti-agent-skills`
7. enable auto-merge on that pull request when all protection checks pass
8. notify the original Tutti main repository PR or commit with the external PR and merge status

Auto-merge is allowed only for generated sync pull requests that satisfy all of
these conditions:

- the PR author is the sync bot or GitHub Actions bot
- the PR branch name matches the reserved sync prefix, for example
  `sync/workspace-app-factory-skill`
- the changed files are limited to:
  - `skills/tutti-workspace-app-factory/**`
  - `.codex-plugin/plugin.json` when the workflow bumps plugin metadata
- plugin and skill validation passed
- repository branch protection checks passed

Do not auto-merge if the sync PR changes workflow files, scripts, marketplace
configuration, repository settings, or any path outside the generated mirror
surface. Those changes require human review.

Example update workflow shape:

```yaml
name: Sync Tutti Agent Skills

on:
  push:
    branches:
      - main
    paths:
      - "services/tuttid/service/workspace/app_factory_reference/**"

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Tutti main repository
        uses: actions/checkout@v4
        with:
          path: source-repository

      - name: Checkout skills repository
        uses: actions/checkout@v4
        with:
          repository: tutti-os/tutti-agent-skills
          token: ${{ secrets.TUTTI_AGENT_SKILLS_SYNC_TOKEN }}
          path: tutti-agent-skills

      - name: Sync built-in skill
        run: |
          rsync -a --delete \
            tutti-main/services/tuttid/service/workspace/app_factory_reference/ \
            tutti-agent-skills/skills/tutti-workspace-app-factory/

      - name: Create sync pull request
        id: sync-pr
        uses: peter-evans/create-pull-request@v6
        with:
          path: tutti-agent-skills
          token: ${{ secrets.TUTTI_AGENT_SKILLS_SYNC_TOKEN }}
          branch: sync/workspace-app-factory-skill
          delete-branch: true
          title: "Sync workspace app factory skill"
          commit-message: "Sync workspace app factory skill from Tutti main repository"
          body: |
            Mirrors Tutti main repository services/tuttid/service/workspace/app_factory_reference.

            Source commit: ${{ github.sha }}

      - name: Enable auto-merge
        if: steps.sync-pr.outputs.pull-request-number != ''
        env:
          GH_TOKEN: ${{ secrets.TUTTI_AGENT_SKILLS_SYNC_TOKEN }}
        run: |
          gh pr merge \
            "${{ steps.sync-pr.outputs.pull-request-number }}" \
            --repo tutti-os/tutti-agent-skills \
            --squash \
            --auto
```

Keep the token narrowly scoped to the external skills repository. It needs
permission to push the sync branch, open the sync PR, and enable auto-merge.

## Notifications

The automation must leave a notification trail in Tutti main repository so the sync does not
become invisible.

At minimum, the workflow should publish a GitHub Actions job summary containing:

- source repository commit
- whether a sync PR was created, updated, auto-merge-enabled, or skipped
- external sync PR URL
- validation result

When the source commit belongs to a merged Tutti main repository PR, the workflow should also
comment back on that Tutti main repository PR:

```text
Tutti agent skills sync started.

External repository:
  tutti-os/tutti-agent-skills

Sync PR:
  <external PR URL>

Auto-merge:
  enabled after required checks pass

Source commit:
  <Tutti main repository commit SHA>
```

If the sync fails, the comment should include the failing workflow URL and the
manual recovery command:

```bash
./scripts/pull-from-tutti-main.sh /path/to/tutti-main
```

Team chat notifications are optional. If they are added later, send them only on
sync failure or when auto-merge is blocked; successful syncs can rely on the
Tutti main repository PR comment and workflow summary.

## Validation

Run these checks in the external repository:

```bash
npx --yes skills add . --list
npx --yes skills add ./skills/tutti-workspace-app-factory --list
python3 /Users/wwcome/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
python3 /Users/wwcome/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py ./plugins/tutti
python3 /Users/wwcome/.codex/skills/.system/skill-creator/scripts/quick_validate.py ./skills/tutti-workspace-app-factory
```

The root-level `npx skills add . --list` discovery must be tested with the real
external repository. If root discovery does not find `skills/tutti-workspace-app-factory`,
document this fallback installation command:

```bash
npx --yes skills add ./skills/tutti-workspace-app-factory --skill tutti-workspace-app-factory
```

Also test the public GitHub form before announcing the repository:

```bash
npx --yes skills add tutti-os/tutti-agent-skills
npx --yes skills add tutti-os/tutti-agent-skills --list
npx --yes skills add tutti-os/tutti-agent-skills --skill tutti-workspace-app-factory
```

The first command is the preferred public installation path. It installs every
skill discovered under the repository's `skills/` directory. The `--skill`
command is only for users who want a single skill.

Also test the Codex marketplace form with an empty sparse path so the importer
discovers `.agents/plugins/marketplace.json` from the repository root.

## Open Questions

These require real install validation rather than assumptions:

- whether `npx skills add . --list` always scans a root-level `skills/` directory
- whether plugin ingestion imports `skills: "./skills/"` exactly as expected
- whether `interface.capabilities: ["Write"]` is accepted by the plugin validator
- whether the external repository should eventually become the source of truth
  for the embedded Tutti main repository copy

## Rollout Plan

1. Create `tutti-agent-skills` with `.codex-plugin/plugin.json`.
2. Copy the current built-in App Factory skill to
   `skills/tutti-workspace-app-factory/`.
3. Add `agents/openai.yaml`.
4. Update `SKILL.md` to support handoff mode and standalone mode.
5. Add sync and drift-check scripts.
6. Add the Tutti main repository pull-request preview workflow.
7. Add the post-merge external sync workflow with guarded auto-merge.
8. Add Tutti main repository PR comments or workflow summaries for sync notifications.
9. Run local skill discovery and plugin validation.
10. Run public GitHub `npx skills add` validation.
11. Keep Tutti main repository embedding the built-in copy until there is a deliberate decision
    to reverse the source-of-truth direction.
