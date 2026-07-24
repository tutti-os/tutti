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
	TurnID                  string
	Phase                   string
	Outcome                 string
	FinalAssistantMessageID string
	StartedAtUnixMS         int64
	SettledAtUnixMS         int64
	Origin                  string
}

type InteractionSeed struct {
	RequestID string
	TurnID    string
	Kind      string
	Status    string
}

type Fixture struct {
	Session                *SessionSeed
	LiveOnlySession        *SessionSeed
	AdditionalSessions     []SessionSeed
	Turn                   *TurnSeed
	AdditionalTurns        []TurnSeed
	Interaction            *InteractionSeed
	AdditionalInteractions []InteractionSeed
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
	RailSectionKey    string
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
	LastResumeRecreate       bool
	RecoverySteps            []string
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
	ListSessionTurns(context.Context, agenthost.SessionRef, agenthost.SessionTurnQuery) (agenthost.SessionTurnSummaryPage, error)
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
