package events

import "strings"

// TurnLifecycleSnapshot is the authoritative, idempotent statement of a
// session's turn lifecycle, published by the turn owner (the provider
// adapter's turn machine, or the controller for the submit moment and its
// settle fallback) and stamped onto the turn.* activity event emitted at the
// transition. Consumers copy the snapshot verbatim — they never merge it with
// previous state or recompute lifecycle from discrete events (ADR 0008).
type TurnLifecycleSnapshot struct {
	Version int `json:"v"`
	// Origin is TurnLifecycleOriginAdapter or TurnLifecycleOriginController.
	// Only adapter-origin snapshots switch a session into snapshot-authority
	// mode; controller-origin snapshots (submit, settle fallback) apply to
	// every provider without flipping legacy sessions off their folding path.
	Origin string `json:"origin"`
	// Seq is monotonically increasing per agent session. Snapshots reach the
	// controller over two channels (the Exec emit closure and the session
	// event sink); a consumer must drop a snapshot whose seq is lower than
	// the last one it applied.
	Seq uint64 `json:"seq"`
	// ActiveTurnID is empty once the turn settled.
	ActiveTurnID string `json:"activeTurnId,omitempty"`
	// Phase is one of TurnPhaseSubmitted/Running/WaitingApproval/WaitingInput
	// while live, or TurnPhaseSettled.
	Phase string `json:"phase"`
	// Outcome is set only when Phase is settled: completed/failed/interrupted.
	Outcome string `json:"outcome,omitempty"`
	// Settling marks a live turn that is being wound down (interrupting).
	Settling bool `json:"settling,omitempty"`
}

// TurnLifecycleSnapshotMetadataKey is the event metadata key carrying the
// snapshot. turn.* events already project to state patches only (never to
// message updates), so stamped events cannot leak into the message timeline.
const TurnLifecycleSnapshotMetadataKey = "turnLifecycle"

const (
	TurnLifecycleOriginAdapter    = "adapter"
	TurnLifecycleOriginController = "controller"

	TurnLifecycleSnapshotVersion = 1
)

// LiveTurnLifecyclePhases is the canonical set of phases that mean "a turn is
// running right now". This list is the single source of truth; the TypeScript
// mirror lives in packages/agent/activity-core/src/selectors.ts
// (LIVE_TURN_LIFECYCLE_PHASES) and must be kept identical.
var LiveTurnLifecyclePhases = []string{
	string(TurnPhaseSubmitted),
	string(TurnPhaseRunning),
	string(TurnPhaseWaitingApproval),
	string(TurnPhaseWaitingInput),
}

// TurnLifecyclePhaseIsLive reports whether a lifecycle phase means a turn is
// currently running. Besides the canonical LiveTurnLifecyclePhases it accepts
// the legacy tokens older writers persisted (working/streaming/waiting/
// awaiting_approval) so stored records from before the snapshot contract keep
// reading correctly.
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

// TurnLifecyclePhaseIsWaiting reports whether the phase is a waiting variant
// (approval or user input), including the legacy collapsed "waiting" token.
func TurnLifecyclePhaseIsWaiting(phase string) bool {
	switch strings.TrimSpace(phase) {
	case string(TurnPhaseWaitingApproval),
		string(TurnPhaseWaitingInput),
		string(TurnPhaseWaiting),
		"awaiting_approval":
		return true
	default:
		return false
	}
}

// StampTurnLifecycleSnapshot attaches the snapshot to the event's metadata.
func StampTurnLifecycleSnapshot(event *Event, snapshot TurnLifecycleSnapshot) {
	if event == nil {
		return
	}
	if snapshot.Version == 0 {
		snapshot.Version = TurnLifecycleSnapshotVersion
	}
	if event.Payload.Metadata == nil {
		event.Payload.Metadata = map[string]any{}
	}
	event.Payload.Metadata[TurnLifecycleSnapshotMetadataKey] = map[string]any{
		"v":            snapshot.Version,
		"origin":       snapshot.Origin,
		"seq":          snapshot.Seq,
		"activeTurnId": snapshot.ActiveTurnID,
		"phase":        snapshot.Phase,
		"outcome":      snapshot.Outcome,
		"settling":     snapshot.Settling,
	}
}

// TurnLifecycleSnapshotFromEvent extracts a stamped snapshot, tolerating the
// numeric widening a JSON round trip introduces.
func TurnLifecycleSnapshotFromEvent(event Event) (TurnLifecycleSnapshot, bool) {
	raw, ok := event.Payload.Metadata[TurnLifecycleSnapshotMetadataKey]
	if !ok {
		return TurnLifecycleSnapshot{}, false
	}
	payload, ok := raw.(map[string]any)
	if !ok {
		return TurnLifecycleSnapshot{}, false
	}
	snapshot := TurnLifecycleSnapshot{
		Version:      intFromAny(payload["v"]),
		Origin:       stringFromAny(payload["origin"]),
		Seq:          uint64(intFromAny(payload["seq"])),
		ActiveTurnID: stringFromAny(payload["activeTurnId"]),
		Phase:        stringFromAny(payload["phase"]),
		Outcome:      stringFromAny(payload["outcome"]),
		Settling:     boolFromAny(payload["settling"]),
	}
	if snapshot.Phase == "" {
		return TurnLifecycleSnapshot{}, false
	}
	return snapshot, true
}

func stringFromAny(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func intFromAny(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case uint64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func boolFromAny(value any) bool {
	typed, _ := value.(bool)
	return typed
}
