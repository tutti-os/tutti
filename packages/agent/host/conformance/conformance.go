// Package conformance provides lifecycle scenarios shared by the legacy
// tuttid Service, the Agent Host implementation, and downstream host adapters.
package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type SessionSeed struct {
	WorkspaceID             string
	AgentSessionID          string
	Provider                string
	ProviderSessionID       string
	Cwd                     string
	Title                   string
	ActiveTurnID            string
	InitialTitleEstablished bool
	Live                    bool
	Kind                    string
	Origin                  string
	ParentAgentSessionID    string
	Deleted                 bool
	DeletedAtUnixMS         int64
	ExternalResumeSupported *bool
	Settings                agenthost.ComposerSettings
	Pinned                  bool
}

type TurnSeed struct {
	TurnID  string
	Phase   string
	Outcome string
}

type InteractionSeed struct {
	RequestID string
	TurnID    string
	Kind      string
	Status    string
}

// MessageSeed seeds a stored message for a turn so that RetryTurn can
// resolve the original user input through the canonical store.
type MessageSeed struct {
	MessageID string
	TurnID    string
	Role      string
	Kind      string
	Text      string
}

type Fixture struct {
	Session                *SessionSeed
	LiveOnlySession        *SessionSeed
	AdditionalSessions     []SessionSeed
	Turn                   *TurnSeed
	AdditionalTurns        []TurnSeed
	Interaction            *InteractionSeed
	AdditionalInteractions []InteractionSeed
	Messages               []MessageSeed
	PreparedSubmitID       string
	RecoverInteractive     bool
	DisableGoalInbox       bool
	AcceptGoalControlsOnly bool
	FailCommitObserver     bool
	WorktreeGCSweepErr     error
}

type SessionObservation struct {
	SessionID         string
	ProviderSessionID string
	Title             string
	ActiveTurnID      string
	Resumable         bool
	Settings          agenthost.ComposerSettings
	Pinned            bool
	Live              bool
}

type SendObservation struct {
	Session  SessionObservation
	TurnID   string
	Kind     string
	Goal     map[string]any
	Revision int64
}

type GoalObservation struct {
	Goal               map[string]any
	Revision           int64
	PendingOperationID string
	SyncStatus         string
}

type CancelObservation struct {
	Session  SessionObservation
	TurnID   string
	Canceled bool
	Reason   string
}

type OperationObservation struct {
	OperationID string
	Status      string
	Result      string
}

type InteractiveObservation struct {
	Session     SessionObservation
	OperationID string
	TurnID      string
	RequestID   string
	Disposition agenthost.RuntimeInteractiveDisposition
}

// TurnObservation is the canonical read model for a single turn, including
// lineage metadata. Conformance scenarios use it to verify that RetryTurn
// persists parent_turn_id and relation.
type TurnObservation struct {
	TurnID       string
	Phase        string
	Outcome      string
	ParentTurnID string
	Relation     string
}

type Metrics struct {
	StartCalls               int
	ResumeCalls              int
	ExecCalls                int
	CancelCalls              int
	InteractiveCalls         int
	UpdateSettingsCalls      int
	CloseCalls               int
	GoalControlCalls         int
	GoalReconcileCalls       int
	RuntimeOperationCommits  int
	GoalOperationCommits     int
	RootTurnSettlements      int
	LastCancelTargets        []agenthost.RuntimeCancelTarget
	LastInteractiveTurnID    string
	LastInteractiveRequestID string
	LastInitialTitle         string
	// LastExecText is the concatenated text content from the most recent
	// Runtime.Exec prompt. RetryTurn scenarios use it to prove the Host
	// re-sent the selected parent turn's user input, not an earlier turn's.
	LastExecText       string
	LastResumeRecreate bool
	RecoverySteps      []string
}

// Driver adapts one host implementation to the shared lifecycle scenarios.
// Reset is test-only canonical/runtime seeding; command methods mirror the
// provider-neutral Host application surface rather than any transport API.
type Driver interface {
	Reset(context.Context, Fixture) error
	Create(context.Context, string, agenthost.CreateSessionInput) (SessionObservation, string, error)
	EnsureSession(context.Context, agenthost.SessionRef) (SessionObservation, error)
	SendInput(context.Context, agenthost.SessionRef, agenthost.SendInput) (SendObservation, error)
	CancelTurn(context.Context, agenthost.CancelTurnInput) (CancelObservation, error)
	SubmitInteractive(context.Context, agenthost.InteractionRef, agenthost.SubmitInteractiveInput) (InteractiveObservation, error)
	GetInteractionStatus(context.Context, agenthost.InteractionRef) (string, bool, error)
	SubmitPlanDecision(context.Context, agenthost.SessionRef, string, string, agenthost.SubmitPlanDecisionInput) (OperationObservation, error)
	UpdateTitle(context.Context, agenthost.UpdateTitleInput) (SessionObservation, error)
	GetSession(context.Context, agenthost.SessionRef) (SessionObservation, error)
	GetCanonicalSession(context.Context, agenthost.SessionRef) (SessionObservation, error)
	UpdateSettings(context.Context, agenthost.UpdateSettingsInput) (SessionObservation, error)
	UpdatePin(context.Context, agenthost.UpdatePinInput) (SessionObservation, error)
	DeleteSession(context.Context, agenthost.SessionRef) (agenthost.DeleteSessionResult, error)
	PurgeDeletedSessions(context.Context, agenthost.PurgeDeletedSessionsInput) (agenthost.PurgeDeletedSessionsResult, error)
	GoalControl(context.Context, agenthost.GoalControlInput) (GoalObservation, error)
	GetGoalState(context.Context, agenthost.SessionRef) (GoalObservation, error)
	ReconcileGoal(context.Context, agenthost.SessionRef) (GoalObservation, error)
	StepGoalOperations(context.Context, int64) error
	Recover(context.Context) error
	Metrics() Metrics
	// RetryTurn exercises the Host.RetryTurn lifecycle contract: it creates a
	// new turn in the same session with parent_turn_id lineage metadata.
	RetryTurn(context.Context, agenthost.SessionRef, string) (SendObservation, error)
	// GetTurn reads a canonical turn including lineage fields. Used by
	// conformance scenarios to verify parent_turn_id and relation.
	GetTurn(context.Context, agenthost.SessionRef, string) (TurnObservation, bool, error)
}

type Scenario struct {
	Name string
	run  func(context.Context, Driver) error
}

func Run(ctx context.Context, driver Driver, scenario Scenario) error {
	if driver == nil {
		return fmt.Errorf("agent host conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host conformance scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}
