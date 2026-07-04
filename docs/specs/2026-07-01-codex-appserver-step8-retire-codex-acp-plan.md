# Codex App-Server Step 8 Retire Codex ACP Plan

Step 8 removes the legacy Codex-over-ACP adapter after Codex has been routed
through app-server. The generic ACP stack remains supported for non-Codex
providers.

## Scope

- Delete `runtime/codex_adapter.go` and the legacy Codex/Nexight test file that
  existed for that adapter.
- Move shared pending approval/request helpers into a generic ACP helper file
  because Codex app-server and standard ACP still use them.
- Move Nexight onto `standard_acp_adapter.go` so removing `codex_adapter.go`
  does not remove the Nexight provider.
- Prune Codex-only branches in shared ACP code. `standard_acp_adapter.go`,
  `acp_client.go`, `acp_live_state.go`, `acp_restore_errors.go`, and
  `acp_turn_normalizer.go` stay in place.

## Validation

- Step 0 corpus stays green.
- Generic ACP tests stay green:
  `go test ./runtime/ -run 'TestStandardACP|TestACP|TestRestore|TestNexight' -count=1`
- `go test ./runtime/ -count=1`
- `go build ./runtime/...`
