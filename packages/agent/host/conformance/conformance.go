// Package conformance provides lifecycle scenarios shared by the legacy
// tuttid Service, the Agent Host implementation, and downstream host adapters.
package conformance

import (
	"context"
	"encoding/json"
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
	RootProviderTurnID      string
	ProviderTurnBindingJSON json.RawMessage
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
	CompleteGoalOnSet      bool
	EmptyPauseResumeGoal   bool
	// DisconnectGoalFenceDelivery drops the live Runtime Session during the
	// first fence delivery, modeling a Host restart with accepted durable intent
	// but no in-memory provider Session.
	DisconnectGoalFenceDelivery bool
	FailCommitObserver          bool
	RejectInitialExec           bool
	// GuidanceTargetMismatch makes the test runtime reject guidance whose
	// explicit TurnID is not the Session.ActiveTurnID. It models the runtime
	// target race without exposing a runtime/provider API to scenarios.
	GuidanceTargetMismatch bool
	WorktreeGCSweepErr     error
	DeleteAdmissionErr     error
	DeleteSessionPlans     [][]string
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
	IntentAccepted     bool
	OperationID        string
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
	OperationID          string
	Status               string
	Result               string
	ConfirmedTurnID      string
	IdentityAnchorTurnID string
}

type InteractiveObservation struct {
	Session     SessionObservation
	OperationID string
	TurnID      string
	RequestID   string
	Disposition agenthost.RuntimeInteractiveDisposition
}

type Metrics struct {
	StartCalls  int
	ResumeCalls int
	ExecCalls   int
	// GuidanceProviderCalls counts guidance dispatches that passed the
	// runtime's exact-target gate. ExecCalls includes the rejected gate check.
	GuidanceProviderCalls              int
	CancelCalls                        int
	InteractiveCalls                   int
	UpdateSettingsCalls                int
	CloseCalls                         int
	GoalControlCalls                   int
	GoalReconcileCalls                 int
	RuntimeOperationCommits            int
	GoalOperationCommits               int
	RootTurnSettlements                int
	LastCancelTargets                  []agenthost.RuntimeCancelTarget
	LastInteractiveTurnID              string
	LastInteractiveRequestID           string
	LastInitialTitle                   string
	LastExecRequiresProviderAcceptance bool
	LastClosePreservedCanonicalState   bool
	LastResumeRecreate                 bool
	LastResumeGoalGenerationFences     []agenthost.RuntimeGoalGenerationFenceInput
	RecoverySteps                      []string
	DeleteAdmissionPlans               []agenthost.DeleteSessionsPlan
	DeleteReports                      []agenthost.DeleteSessionsReport
	CanonicalDeleteCalls               int
	DeletionEvents                     []string
}

// Driver adapts one host implementation to the shared lifecycle scenarios.
// Reset is test-only canonical/runtime seeding; command methods mirror the
// provider-neutral Host application surface rather than any transport API.
type Driver interface {
	Reset(context.Context, Fixture) error
	DisconnectRuntimeSession(context.Context, agenthost.SessionRef) error
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
	DeleteSessions(context.Context, agenthost.DeleteSessionsInput) (agenthost.DeleteSessionsResult, error)
	PurgeDeletedSessions(context.Context, agenthost.PurgeDeletedSessionsInput) (agenthost.PurgeDeletedSessionsResult, error)
	GoalControl(context.Context, agenthost.GoalControlInput) (GoalObservation, error)
	AdoptProviderGoal(context.Context, agenthost.ProviderGoalAdoptionInput) (GoalObservation, error)
	FenceGoalGeneration(context.Context, agenthost.FenceGoalGenerationInput) (agenthost.FenceGoalGenerationResult, error)
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

// DeletedSessionLifecycleDriver is separate from Driver so adapters adopt the
// lossless tombstone contract explicitly while rolling out its new canonical
// storage capability.
type DeletedSessionLifecycleDriver interface {
	Reset(context.Context, Fixture) error
	DeleteSession(context.Context, agenthost.SessionRef) (agenthost.DeleteSessionResult, error)
	ListDeletedSessions(context.Context, agenthost.ListDeletedSessionsInput) (agenthost.DeletedSessionPage, error)
	RestoreDeletedSession(context.Context, agenthost.RestoreDeletedSessionInput) (agenthost.RestoreDeletedSessionResult, error)
	GetCanonicalSession(context.Context, agenthost.SessionRef) (SessionObservation, error)
	Metrics() Metrics
}

type DeletedSessionLifecycleScenario struct {
	Name string
	run  func(context.Context, DeletedSessionLifecycleDriver) error
}

// SessionForkFixture describes fault and recovery states at the public Host
// boundary. Implementations may seed those states using their own test-only
// canonical/runtime adapters.
type SessionForkFixture struct {
	FailFirstLocalCommit    bool
	RecoverProviderAccepted bool
	KeepSourceActive        bool
}

type SessionForkMetrics struct {
	ProviderForkCalls int
}

// SessionForkDriver is separate from Driver so existing Host consumers can
// adopt the new lifecycle capability explicitly rather than gaining fake
// support through the base session contract.
type SessionForkDriver interface {
	ResetSessionFork(context.Context, SessionForkFixture) error
	ForkSession(context.Context, agenthost.ForkSessionInput) (agenthost.ForkSessionResult, error)
	GetSessionForkOperation(context.Context, string, string) (agenthost.ForkSessionResult, bool, error)
	RecoverSessionForks(context.Context) error
	SessionForkMetrics() SessionForkMetrics
}

type SessionForkScenario struct {
	Name string
	run  func(context.Context, SessionForkDriver) error
}

// InteractionTreeDriver is separate from the lifecycle Driver because tree
// snapshots are a read capability that consumers can adopt independently.
type InteractionTreeDriver interface {
	ResetInteractionTree(context.Context) error
	GetSessionInteractionTreeSnapshot(context.Context, agenthost.SessionRef, agenthost.SessionInteractionTreeQuery) (agenthost.SessionInteractionTreeSnapshot, error)
}

type InteractionTreeScenario struct {
	Name string
	run  func(context.Context, InteractionTreeDriver) error
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

func RunSessionFork(
	ctx context.Context,
	driver SessionForkDriver,
	scenario SessionForkScenario,
) error {
	if driver == nil {
		return fmt.Errorf("agent host session fork conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host session fork conformance scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

func RunDeletedSessionLifecycle(
	ctx context.Context,
	driver DeletedSessionLifecycleDriver,
	scenario DeletedSessionLifecycleScenario,
) error {
	if driver == nil {
		return fmt.Errorf("agent host deleted session lifecycle conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host deleted session lifecycle conformance scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

func RunInteractionTree(
	ctx context.Context,
	driver InteractionTreeDriver,
	scenario InteractionTreeScenario,
) error {
	if driver == nil {
		return fmt.Errorf("agent host interaction tree conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host interaction tree conformance scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}
