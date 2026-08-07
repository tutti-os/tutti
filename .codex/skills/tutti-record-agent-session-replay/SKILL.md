---
name: tutti-record-agent-session-replay
description: Record, audit, replay, publish, or diagnose deterministic Tutti AgentGUI Session Replay cassettes from a Tutti checkout while keeping the external case repository as the Case and artifact source of truth. Use for Tutti Session Replay Case scenarios, real Provider recordings, cassette transport or semantic-state mismatches, fresh replay qualification, and AgentGUI replay evidence. Do not use for cases whose case.json declares executionKind "ui".
---

# Record Tutti Agent Session Replay

Work from the Tutti checkout. Keep product implementation and the generic
runner in Tutti; keep Case metadata, scenarios, fixtures, qualified Cassettes,
and evidence in the external case repository.

Prove work in this order:

`Case -> scenario -> real Record -> structural audit -> fresh Replay -> optional publication`

Never call a Cassette qualified until Record, audit, and a fresh isolated
Replay have all passed.

## Establish scope

1. Read the Tutti root and closest `AGENTS.md` files.
2. Read `docs/architecture/agent-session-replay.md`.
3. For AgentGUI behavior, also read `docs/architecture/agent-gui-node.md` and
   `packages/agent/gui/AGENTS.md`.
4. For Session, Turn, Goal, or runtime-operation lifecycle behavior, read
   `packages/agent/host/README.md`; lifecycle semantics remain in Host.
5. Inspect `git status --short` in both repositories and preserve pre-existing
   work.
6. Resolve the case repository from the user-provided path, the configured
   cases path, or the sibling `../tutti-agent-session-replay-cases` checkout.
   Do not guess another location if none exists.

Read the selected Case before planning:

- `cases/<case-id>/case.json`
- every `cases/<case-id>/scenarios/*.mjs` except `*.impl.mjs`
- referenced shared scenario helpers and `runtime-fixtures/`
- existing `cassettes/`, `evidence/`, and relevant Run artifacts
- the case repository's `README.md` and `CONTEXT.md` when publication or Case
  lifecycle is involved

If `case.json` declares `executionKind: "ui"`, stop this workflow. It is a
UI-drive Case, not a Session Replay recording Case.

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

## Design a deterministic scenario

Use the case repository's existing scenario factory and provider profile
patterns. A scenario must export `prepare`, `drive`, and `assert`, set its
Provider explicitly or through the repository helper, and set every
behavior-affecting composer default explicitly.

Require all of the following:

- one stable prompt per intended Turn, with exact markers;
- an exact final token when an assistant reply is expected;
- harmless and reversible commands for approval Cases;
- accessible labels, test IDs, or semantic DOM state instead of coordinates;
- waits for each interaction before acting;
- exactly one response to each approval, question, or plan decision;
- an asserted terminal state and no enabled stale controls;
- a declared expected recording mode when continuing an existing Session;
- provider-derived scenario and Cassette identity rather than a hard-coded
  Codex target.

For question cards, trigger the Provider's real user-input request. For plan
Cases, wait for the completed plan and implementation decision before driving
the real action.

## Record with the Tutti runner

Run one real Provider recording per scenario from the Tutti root. Derive the
scenario ID, Cassette name, and Agent Target from the loaded scenario. For
example:

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

The bundled audit proves structural invariants and emits a semantic summary.
It does not replace Case-specific assertions or a fresh Replay.

## Run a fresh Replay

Replay from a fresh isolated Tutti runtime and pass the scenario so screenshot
settling and terminal assertions run:

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
- Tutti implementation changes and case repository artifact changes;
- changed-line distribution by functional area, excluding pre-existing work;
- documentation impact;
- failed gates and unimplemented scope.
