package events

import "strings"

// TurnLifecyclePhaseIsLive reports whether a lifecycle phase means a turn is
// currently running. Besides the canonical submitted/running/waiting_*
// phases it accepts the legacy tokens older writers persisted
// (working/streaming/waiting/awaiting_approval) so stored records from
// before this phase set was formalized keep reading correctly.
//
// Ported from main's ADR-0008 turn_lifecycle_snapshot.go: this branch does
// not carry the rest of that snapshot machinery (TurnLifecycleSnapshot,
// StampTurnLifecycleSnapshot, session.LifecycleAuthority, etc.), so only the
// phase-liveness predicate itself is included here.
func TurnLifecyclePhaseIsLive(phase string) bool {
	switch strings.TrimSpace(phase) {
	case string(TurnPhaseSubmitted),
		string(TurnPhaseRunning),
		string(TurnPhaseWaitingApproval),
		string(TurnPhaseWaitingInput),
		// Legacy persisted tokens.
		string(TurnPhaseWorking),
		"streaming",
		string(TurnPhaseWaiting),
		"awaiting_approval":
		return true
	default:
		return false
	}
}
