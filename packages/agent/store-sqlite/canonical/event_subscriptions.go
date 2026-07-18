package canonical

const EventSourceKindAgentTurn = "agent_turn"

const (
	EventTypeAgentTurnCompleted   = "agent.turn.completed"
	EventTypeAgentTurnFailed      = "agent.turn.failed"
	EventTypeAgentTurnCanceled    = "agent.turn.canceled"
	EventTypeAgentTurnInterrupted = "agent.turn.interrupted"
)

type TerminalTurnEventDefinition struct {
	Type       string
	Version    int
	SourceKind string
	Outcome    string
	OneShot    bool
}

// TerminalTurnEventDefinitions is the single closed mapping between canonical
// turn outcomes and versioned orchestration events. Callers receive a fresh
// slice so the catalog cannot be mutated globally.
func TerminalTurnEventDefinitions() []TerminalTurnEventDefinition {
	return []TerminalTurnEventDefinition{
		{Type: EventTypeAgentTurnCompleted, Version: 1, SourceKind: EventSourceKindAgentTurn, Outcome: TurnOutcomeCompleted, OneShot: true},
		{Type: EventTypeAgentTurnFailed, Version: 1, SourceKind: EventSourceKindAgentTurn, Outcome: TurnOutcomeFailed, OneShot: true},
		{Type: EventTypeAgentTurnCanceled, Version: 1, SourceKind: EventSourceKindAgentTurn, Outcome: TurnOutcomeCanceled, OneShot: true},
		{Type: EventTypeAgentTurnInterrupted, Version: 1, SourceKind: EventSourceKindAgentTurn, Outcome: TurnOutcomeInterrupted, OneShot: true},
	}
}
