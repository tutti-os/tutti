# Agent Session Replay

Owns portable Cassette contracts, checkpoint readiness, and final-state
transport verification for Agent Session Replay.

Read [README.md](README.md) before changing projection, compare, or cassette
schema rules.

## Composer settings contract

`settings.equal` checkpoint readiness and final-state
`CompareTuttiReplayState` must share one composer-settings contract:

- require every **recorded** key
- treat empty defaults (`false`, `""`, `null`) as equivalent to absent
- ignore live-only extras that current product materializes

Do **not** add per-field `delete(settings, "…")` special cases in compare
code when Tutti introduces a new default composer setting. Extend the shared
`composerSettingsEqual` helpers / empty-default rules, or update the portable
projection if the field is not part of the semantic contract at all.

Explicit non-default recorded values (for example `codexSaverMode: true`)
remain fail-closed.

## Cassette reuse

| Change                                                                                                  | Action                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| New live-only default / omitempty field                                                                 | Fix shared settings contract or projection; keep old cassettes    |
| Runtime id / wall-clock rematerialization                                                               | Alpha-equivalence or strip volatile fields; keep old cassettes    |
| Path / cwd / provider-home portability                                                                  | Project to `${REPLAY_CWD}` / `${REPLAY_HOME}`; keep old cassettes |
| Semantic contract change (turn shape, tool protocol, permission/model meaning, checkpoint schema major) | Re-record affected cassettes                                      |

Default response to `agent_session_replay_transport_mismatch` on settings is
to align compare/projection with the contract above, not to mass-rewrite
Cases Console cassettes.
