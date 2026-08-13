---
name: tutti-record-agent-session-replay
description: >-
  From a Tutti checkout, run, audit, freshly replay, publish, or diagnose
  Session Replay cassettes that are driven by case-repository scenario scripts
  (CDP), not by interactive UI recording. Use for real-Provider capture while a
  scenario.mjs executes, cassette transport or semantic-state mismatches, fresh
  replay qualification, AgentGUI replay evidence, and product-side support for a
  new Agent Target beyond local:codex / local:claude-code. Do not use to author
  Case metadata or scenario scripts (case repository write-replay-case), or for
  executionKind "ui" Cases.
---

# Qualify Tutti Agent Session Replay Cassettes

Work from the Tutti checkout. Keep product implementation and the generic
runner in Tutti; keep Case metadata, **scenario scripts**, fixtures, qualified
Cassettes, and evidence in the external case repository (`tutti-os/tutti-replay`).

Mental model (script-first, not UI recording):

1. Humans/agents **write** a deterministic `scenarios/*.mjs` (prepare / drive /
   assert) in the case repository — that script is the recording plan.
2. **Record** means: Tutti runner launches Desktop, CDP-executes that script
   against a **live** Provider, and captures the Cassette. There is no separate
   click-to-record UI workflow for Session Replay.
3. Day-to-day Record/Replay is usually triggered from the case repository QA
   console; this skill is for Tutti-side CLI qualification, diagnosis, runner
   or Replay product defects, and new Provider capture support.

Prove qualification in this order:

`existing scenario script -> live Record (script + Provider) -> structural audit -> fresh Replay -> optional publication`

Never call a Cassette qualified until Record, audit, and a fresh isolated
Replay have all passed. If the scenario script itself is missing or wrong,
stop and use the case repository `write-replay-case` skill — do not invent
Cases inside Tutti.

Qualification is assertion-specific, not command-specific. A `replay passed`
exit proves transport and semantic playback, but does not prove that every
Case action ran during Replay. Build a four-column matrix for each core
assertion: `Record proof | Cassette proof | Replay proof | Evidence`. Stop and
repair the scenario when any required Replay cell is empty.

## Start the QA console (case repository)

Browsing Cases, Test Plans, and one-click Record/Replay (which run the same
scenario scripts) live in the **case repository** (sibling checkout, commonly
`../tutti-replay`; GitHub: `tutti-os/tutti-replay`).

From the case repository root:

```bash
pnpm install
pnpm dev
```

Open only `http://127.0.0.1:3333` (never the API port `:3334`). In the UI,
set the Tutti checkout absolute path, create a Test Plan, then Record or
Replay. First-time machine setup: that repository's `SETUP.md`. Authoring or
mirroring scenario scripts: `.agents/skills/write-replay-case/`.

For a long-lived LAN service on macOS use `pnpm replay:service install`
(port `2333`); do not run `pnpm dev` and the stable service at the same time.

## Establish scope

1. Read the Tutti root and closest `AGENTS.md` files.
2. Read `docs/architecture/agent-session-replay.md` (Provider support: developer
   recording currently accepts `local:codex` and `local:claude-code` only).
3. For AgentGUI behavior, also read `docs/architecture/agent-gui-node.md` and
   `packages/agent/gui/AGENTS.md`.
4. For Session, Turn, Goal, or runtime-operation lifecycle behavior, read
   `packages/agent/host/README.md`; lifecycle semantics remain in Host.
5. Inspect `git status --short` in both repositories and preserve pre-existing
   work.
6. Resolve the case repository from the user-provided path, the configured
   cases path, or the sibling `../tutti-replay` checkout. Do not guess another
   location if none exists.

Read the selected Case before planning:

- `cases/<case-id>/case.json`
- every `cases/<case-id>/scenarios/*.mjs` except `*.impl.mjs`
- referenced shared scenario helpers and `runtime-fixtures/`
- existing `cassettes/`, `evidence/`, and relevant Run artifacts
- the case repository's `README.md` and `CONTEXT.md` when publication or Case
  lifecycle is involved

If `case.json` declares `executionKind: "ui"`, stop this Session Replay
workflow. Pure UI Cases are still script-driven (`defineUiScenario` + CDP),
but they use **ui-drive** and publish `ui/` screenshots — they do not Record
Provider Cassettes. Author and run them via the case repository
`write-replay-case` skill and the QA console; do not use this skill's
`--record` / Cassette audit path for them.

Use CDP through Tutti's repository runner. Do not use Computer Use unless the
user explicitly requests it.

## Maintain the ownership boundary

- Add or update Case scenarios only under
  `cases/<case-id>/scenarios/*.mjs` in the case repository.
- Put reusable scenario helpers in that repository's `scenario-runtime/`.
- Do not add Case registries, Case-specific scenarios, fixtures, or qualified
  Cassettes to Tutti.
- Change Tutti only for generic product, runner, protocol, or Replay defects.
- Fix root causes. Do not relax transport matching, semantic verification,
  terminal assertions, or checkpoint requirements to accept a broken Case.

## Add a new Provider (product vs case repository)

Today Replay recording targets are `local:codex` and `local:claude-code`. The
shared Session Replay core is provider-neutral, but each new Agent Target still
needs Tutti capture + fail-closed playback before any Case work is useful.

Split work explicitly:

| Layer   | Where           | Who                                   | Scope                                                                                                                                                                                       |
| ------- | --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product | Tutti           | experienced / mentored                | Adapter capture, projected tape, portability, structural audit, outbound verification, input-unit barriers, isolated Provider home, deterministic fail-closed Replay for `local:<provider>` |
| Cases   | case repository | can hand to intern after product gate | `providerProfiles`, `KNOWN_PROVIDERS`, `defineMirroredRecordScenario` mirrors, Record via console, publish cassettes                                                                        |

Do **not** start by writing Cases for an unsupported Provider. Product must
accept `--agent-target-id local:<provider>` for Record and Replay first.

### Tutti checklist (this repository)

Copy and tick:

```
- [ ] 1. Provider adapter can Record real traffic into a Cassette
- [ ] 2. Projected tape + portability (paths/homes) match session-replay contract
- [ ] 3. Structural audit passes (manifest, frames, activity causality)
- [ ] 4. Fresh isolated Replay is fail-closed (no live Provider fallback)
- [ ] 5. Runner accepts --agent-target-id local:<provider>
- [ ] 6. docs/architecture/agent-session-replay.md Provider support updated
- [ ] 7. Hand off to case repository write-replay-case for mirrors + console Record
```

Prove with one smoke scenario from the case repository (or a temporary
scenario file) using the Tutti runner Record → audit → fresh Replay loop below.
Keep account secrets out of logs and reports.

### Case repository handoff

After the product gate is green, follow that repository's
`write-replay-case` skill section on multi-provider mirrors. Typical touch
points there (not in Tutti): `scenario-runtime/shared.mjs` `providerProfiles`,
`src/shared/agent-target.ts` `KNOWN_PROVIDERS`, mirrored `*.impl.mjs` + variant
Case dirs, then console Record/Replay publication.

## Scenario scripts (owned by the case repository)

Session Replay drive logic is **authored as scripts**, not captured from
manual UI interaction. Prefer the case repository's `write-replay-case` skill
and `defineMirroredRecordScenario` / `defineRecordScenario` helpers.

When diagnosing or qualifying from Tutti, still require that the loaded
scenario:

- exports `prepare`, `drive`, and `assert`;
- sets Provider via profile/helper (not a hard-coded Codex-only identity);
- sets every behavior-affecting composer default explicitly;
- uses one stable prompt per intended Turn, with exact markers / final tokens;
- uses accessible labels, test IDs, or semantic DOM state instead of coordinates;
- waits before each interaction; answers each approval/question/plan once;
- asserts a terminal state with no enabled stale controls;
- declares `expectedRecordingMode` when continuing an existing Session.

Know the runner hook boundary before accepting the scenario:

- Record calls `prepare`, `drive`, `assert(phase="terminal")`, and
  `assert(phase="recorded")`.
- Fresh Replay does **not** call `scenario.assert`; it replays Cassette traffic
  and calls `settleForScreenshot` at eligible checkpoints.
- `captureEvidence` proves a Record state only. `captureFrame` inside
  `settleForScreenshot` proves a Replay checkpoint state.

For each action under test, require one Replay mechanism:

1. **Cassette-native**: the action appears in `activity-events.jsonl` as the
   expected intent/effect or direct stimulus and is consumed by a checkpoint.
2. **Replay driver**: when the action is not recorded (for example a local UI
   action after Turn completion), `settleForScreenshot` performs it through
   the real product UI/API at one exact checkpoint, asserts before/after state,
   and captures transient evidence.

If neither exists, classify the assertion as Record-only. Do not call the Case
Replay-qualified or infer coverage from the final UI looking correct.

For question cards, the script must trigger the Provider's real user-input
request. For plan Cases, wait for the completed plan and implementation
decision before driving the real action.

If the script needs to change, edit it in the case repository — then re-Record.

## Record = execute the scenario script with a live Provider

From the Tutti root, run the repository runner so it CDP-drives the scenario
file and captures a Cassette. Derive scenario ID, Cassette name, and Agent
Target from the loaded scenario:

```bash
pnpm e2e:agent-gui -- \
  --record .tmp/cassettes/<cassette-name> \
  --scenario <scenario-id> \
  --scenario-file <case-repository>/cases/<case-id>/scenarios/<scenario-id>.mjs \
  --agent-target-id <agent-target-id> \
  --keep-runtime \
  --timeout-ms 300000 \
  --stall-timeout-ms 60000
```

Prefer the case console Test Plan「录制」for routine work; use this CLI when
debugging runner/Replay behavior or when the console is unavailable.

Omit `--headless` while debugging; add it for unattended execution. Keep the
runtime only long enough to inspect or collect its artifacts.

Inspect failures from the smallest relevant evidence set:

- record screenshots and checkpoint screenshots;
- `logs/desktop.log`;
- `state/logs/tuttid.log`;
- `state/tuttid.db` through targeted queries;
- the incomplete Cassette and a small decoded Provider-frame window.

Do not dump an entire Provider stream or expose account data.

## Audit each Cassette

Run the bundled structural audit from the Tutti root:

```bash
node .codex/skills/tutti-record-agent-session-replay/scripts/audit-cassette.mjs \
  .tmp/cassettes/<cassette-name>
```

Require:

- Cassette inventory, hashes, and size policy verify;
- the Provider manifest is complete;
- global and per-connection frame sequences are continuous;
- Activity sequences are continuous;
- intent-to-effect causality satisfies
  `packages/agent/session-replay/activity-contract.json`;
- expected interactions, plan decisions, tools, exits, terminal Turns, and
  final response state match `case.json` and the scenario assertions.
- every Case-critical action expected to replay is present in
  `activity-events.jsonl` / `checkpoint-plan.json`, or is explicitly owned by
  a checkpoint Replay driver.

The bundled audit proves structural invariants and emits a semantic summary.
It does not replace Case-specific assertions or a fresh Replay.

Before Replay, compare the audit output and raw checkpoint plan with the Case's
coverage matrix. Counts alone are insufficient: for example, an Activity
stream containing only `activation/requested` + `session/activate` cannot prove
a later Undo/Reapply click.

## Run a fresh Replay

Replay from a fresh isolated Tutti runtime and pass the scenario so checkpoint
screenshot settling runs. Remember that `scenario.assert` does not run here:

```bash
pnpm e2e:agent-gui -- \
  --replay .tmp/cassettes/<cassette-name> \
  --scenario <scenario-id> \
  --scenario-file <case-repository>/cases/<case-id>/scenarios/<scenario-id>.mjs \
  --screenshot-checkpoints \
  --keep-runtime \
  --timeout-ms 300000 \
  --stall-timeout-ms 60000
```

Require the runner's `replay passed` result, all planned checkpoints, the
expected AgentGUI terminal state, and a fully drained Provider transport.
Provider transport remains fail-closed; only repository-declared observer-only
probes may yield to causal traffic.

Then prove each target assertion through its selected Replay mechanism:

- Cassette-native: show the matching Activity/direct stimulus and resulting
  checkpoint state.
- Replay driver: show its before/after assertions completed and inspect the
  named `captureFrame` screenshots, including transient states rather than
  only the final stable UI.
- External filesystem/process side effects: prove how the fresh Replay project
  receives the minimal deterministic pre-action state. Cassette semantic state
  does not by itself recreate arbitrary Provider filesystem mutations.

Never report “Record & Replay cover the behavior” when only Record executed
the Case action. Report transport/semantic Replay separately from
assertion-level behavior coverage.

When one Case owns multiple scenarios, Record and audit every resulting
Cassette, then qualify them together through one Replay Workspace. Let the
case repository workflow generate the workspace manifest; do not invent a
second Case registry in Tutti.

## Publish only qualified artifacts

Prefer the case repository's publication workflow because it records the Run,
archives prior artifacts, and publishes `cassettes/` plus `evidence/` only
after qualification.

If the user explicitly requests manual publication:

1. Stage all new Cassettes and evidence without touching the qualified copies.
2. Verify every staged Cassette completed Record, audit, and fresh Replay.
3. Replace `cases/<case-id>/cassettes/` and `evidence/` as one Case operation,
   preserving the previous qualified artifacts in the case repository's
   archive convention.
4. Re-read every published manifest and evidence directory.

Do not infer Case lifecycle from a successful command. Run status, manual
acceptance, and `case.json` lifecycle status are distinct. Do not set
`status: "confirmed"` or `acceptedAt` unless the case repository's acceptance
requirements have been satisfied.

## Finish

- If Tutti implementation changed, run the validation selected by
  `docs/conventions/testing.md` plus any closest-area checks.
- If case metadata or scenarios changed, run the case repository's metadata,
  scenario, and type checks.
- Recheck both worktrees and separate pre-existing changes from this task.
- Perform the Tutti documentation-impact check.

Report:

- Case and Cassette names;
- Record, audit, and fresh Replay results;
- Provider-frame, Activity, interaction, tool, Turn, and final-state summaries;
- the assertion coverage matrix and exact Replay mechanism for each core action;
- Tutti implementation changes and case repository artifact changes;
- changed-line distribution by functional area, excluding pre-existing work;
- documentation impact;
- failed gates and unimplemented scope.
