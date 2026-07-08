package agentruntime

// ClaudeSDKDispatchDecision is the routing outcome for a sidecar event once
// RPC response waiters have been handled.
type ClaudeSDKDispatchDecision string

const (
	ClaudeSDKDispatchCompleteWaiter ClaudeSDKDispatchDecision = "complete_waiter"
	ClaudeSDKDispatchDropTerminal   ClaudeSDKDispatchDecision = "drop_terminal"
	ClaudeSDKDispatchPublish        ClaudeSDKDispatchDecision = "publish"
)

// decideClaudeSDKDispatch chooses whether a sidecar event completes a tracked
// Exec waiter, is dropped as an untracked terminal, or is published as a
// session event. Pure function for contract tests.
func decideClaudeSDKDispatch(waiter *claudeSDKTurnWaiter, terminal bool) ClaudeSDKDispatchDecision {
	if waiter != nil {
		return ClaudeSDKDispatchCompleteWaiter
	}
	if terminal {
		return ClaudeSDKDispatchDropTerminal
	}
	return ClaudeSDKDispatchPublish
}

// TurnOrigin classifies who minted a sidecar turn id (stamped by the sidecar
// as payload.turnOrigin on turn.* events). Controller-tracked exec turns echo
// the controller id (exec_echo); internal sidecar turns carry distinct
// origins. This is currently diagnostic-only: dispatch logs the origin of any
// dropped terminal (see dispatchClaudeSDKEvent) so a future fix for the
// dropped-terminal-strands-a-live-waiter class (Bug ①, deferred pending a
// confirmed repro) has real correlation data instead of guessing. Do not wire
// this into automatic remapping without that data — see
// docs/architecture/agent-turn-lifecycle-ledger.md.
const (
	TurnOriginExecEcho  = "exec_echo"
	TurnOriginSynthetic = "synthetic"
	TurnOriginQueued    = "queued"
	TurnOriginDelegated = "delegated"
)
