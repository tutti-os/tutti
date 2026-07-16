package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// stampAdapterTurnLifecycleEvents stamps an adapter-origin TurnLifecycle
// snapshot onto every turn.* event in the batch (ADR 0008). Every such event
// is emitted by the owning adapter at one of its own turn transition points,
// so the snapshot is that transition serialized exactly once; events that
// already carry a snapshot (controller-stamped submit events) are left
// untouched. nextSeq must return a per-session monotonic sequence number.
func stampAdapterTurnLifecycleEvents(events []activityshared.Event, nextSeq func() uint64) []activityshared.Event {
	for index := range events {
		snapshot, ok := adapterSnapshotForTurnEvent(events[index])
		if !ok {
			continue
		}
		if _, stamped := activityshared.TurnLifecycleSnapshotFromEvent(events[index]); stamped {
			continue
		}
		snapshot.Origin = activityshared.TurnLifecycleOriginAdapter
		snapshot.Seq = nextSeq()
		activityshared.StampTurnLifecycleSnapshot(&events[index], snapshot)
	}
	return events
}

// adapterSnapshotForTurnEvent translates the turn transition an event states
// into the full lifecycle snapshot for that moment.
func adapterSnapshotForTurnEvent(event activityshared.Event) (activityshared.TurnLifecycleSnapshot, bool) {
	turnID := strings.TrimSpace(event.Payload.TurnID)
	switch event.Type {
	case activityshared.EventTurnStarted, activityshared.EventRootProviderTurnStarted:
		return activityshared.TurnLifecycleSnapshot{
			ActiveTurnID: turnID,
			Phase:        string(activityshared.TurnPhaseRunning),
		}, true
	case activityshared.EventTurnUpdated:
		switch strings.TrimSpace(event.Payload.TurnPhase) {
		case string(activityshared.TurnPhaseSubmitted):
			return activityshared.TurnLifecycleSnapshot{ActiveTurnID: turnID, Phase: string(activityshared.TurnPhaseSubmitted)}, true
		case string(activityshared.TurnPhaseWorking), string(activityshared.TurnPhaseRunning), "streaming":
			return activityshared.TurnLifecycleSnapshot{ActiveTurnID: turnID, Phase: string(activityshared.TurnPhaseRunning)}, true
		case string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaiting):
			return activityshared.TurnLifecycleSnapshot{ActiveTurnID: turnID, Phase: string(activityshared.TurnPhaseWaitingApproval)}, true
		case string(activityshared.TurnPhaseWaitingInput):
			return activityshared.TurnLifecycleSnapshot{ActiveTurnID: turnID, Phase: string(activityshared.TurnPhaseWaitingInput)}, true
		default:
			return activityshared.TurnLifecycleSnapshot{}, false
		}
	case activityshared.EventTurnCompleted:
		outcome := strings.TrimSpace(event.Payload.TurnOutcome)
		if outcome == "" {
			outcome = string(activityshared.TurnOutcomeCompleted)
		}
		return activityshared.TurnLifecycleSnapshot{
			Phase:   string(activityshared.TurnPhaseSettled),
			Outcome: outcome,
		}, true
	case activityshared.EventTurnFailed:
		return activityshared.TurnLifecycleSnapshot{
			Phase:   string(activityshared.TurnPhaseSettled),
			Outcome: string(activityshared.TurnOutcomeFailed),
		}, true
	default:
		return activityshared.TurnLifecycleSnapshot{}, false
	}
}
