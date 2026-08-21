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
	RuntimeContext          map[string]any
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
	Session                                  *SessionSeed
	LiveOnlySession                          *SessionSeed
	AdditionalSessions                       []SessionSeed
	Turn                                     *TurnSeed
	AdditionalTurns                          []TurnSeed
	Interaction                              *InteractionSeed
	AdditionalInteractions                   []InteractionSeed
	PreparedSubmitID                         string
	RecoverInteractive                       bool
	RecoverInteractiveFollowUpPrompt         string
	RecoverInteractiveFollowUpClientSubmitID string
	RecoverInteractiveFollowUpDisposition    agenthost.RuntimeInteractiveDisposition
	DisableGoalInbox                         bool
	AcceptGoalControlsOnly                   bool
	CompleteGoalOnSet                        bool
	EmptyPauseResumeGoal                     bool
	// RaceRuntimeStartReport makes the test Runtime attempt its ordinary
	// session-start activity report before CreateSession initializes canonical
	// state. A conforming Host must keep that report behind the canonical
	// initialization barrier.
	RaceRuntimeStartReport bool
	// FailSessionInitialization fails the canonical initialize half after the
	// Runtime has started, before its report/event barrier may be released.
	FailSessionInitialization bool
	// DisconnectGoalFenceDelivery drops the live Runtime Session during the
	// first fence delivery, modeling a Host restart with accepted durable intent
	// but no in-memory provider Session.
	DisconnectGoalFenceDelivery bool
	FailCommitObserver          bool
	RejectInitialExec           bool
	RailProjectPaths            []string
	// GuidanceTargetMismatch makes the test runtime reject guidance whose
	// explicit TurnID is not the Session.ActiveTurnID. It models the runtime
	// target race without exposing a runtime/provider API to scenarios.
	GuidanceTargetMismatch bool
	// CancelDeliveryUnconfirmed makes the test runtime acknowledge the exact
	// cancel delivery without being able to confirm that it stopped that turn.
	// The Host must retain the durable operation instead of inventing a
	// terminal outcome.
	CancelDeliveryUnconfirmed bool
	DeleteAdmissionErr        error
	DeleteSessionPlans        [][]string
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
	ExecutionPending   bool
}

type CancelObservation struct {
	Session  SessionObservation
	TurnID   string
	Canceled bool
	Pending  bool
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
	StartCalls    int
	ResumeCalls   int
	ExecCalls     int
	LastStartEnv  []string
	LastResumeEnv []string
	// GuidanceProviderCalls counts guidance dispatches that passed the
	// runtime's exact-target gate. ExecCalls includes the rejected gate check.
	GuidanceProviderCalls              int
	CancelCalls                        int
	InteractiveCalls                   int
	UpdateSettingsCalls                int
	CloseCalls                         int
	GoalControlCalls                   int
	GoalReconcileCalls                 int
	RuntimeSessionPublishCalls         int
	RuntimeStartReportWrites           int
	RuntimeOperationCommits            int
	GoalOperationCommits               int
	RootTurnSettlements                int
	LastCancelTargets                  []agenthost.RuntimeCancelTarget
	LastInteractiveTurnID              string
	LastInteractiveRequestID           string
	LastExecClientSubmitID             string
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

// WorkspaceRuntimeDisconnectDriver is a narrow opt-in lifecycle contract so a
// new Host capability does not source-break existing external conformance
// drivers that implement the stable Driver interface.
type WorkspaceRuntimeDisconnectDriver interface {
	Driver
	DisconnectWorkspaceRuntime(context.Context, string) (agenthost.DisconnectWorkspaceRuntimeResult, error)
}

type WorkspaceRuntimeDisconnectScenario struct {
	Name string
	run  func(context.Context, WorkspaceRuntimeDisconnectDriver) error
}

// WorkspaceRuntimeAdmissionDriver exposes only the Host-owned coordination
// seam needed to verify admission and durable disconnect fencing.
type WorkspaceRuntimeAdmissionDriver interface {
	WithWorkspaceRuntimeOperation(context.Context, string, func(context.Context) error) error
	AcquireWorkspaceRuntimeDisconnectFence(context.Context, string) (WorkspaceRuntimeDisconnectFenceDriver, error)
}

type WorkspaceRuntimeDisconnectFenceDriver interface {
	Wait(context.Context) (context.Context, error)
	Release()
}

type WorkspaceRuntimeAdmissionScenario struct {
	Name string
	run  func(context.Context, WorkspaceRuntimeAdmissionDriver) error
}

func RunWorkspaceRuntimeAdmission(
	ctx context.Context,
	driver WorkspaceRuntimeAdmissionDriver,
	scenario WorkspaceRuntimeAdmissionScenario,
) error {
	if driver == nil {
		return fmt.Errorf("workspace runtime admission conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("workspace runtime admission scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

func RunWorkspaceRuntimeDisconnect(
	ctx context.Context,
	driver WorkspaceRuntimeDisconnectDriver,
	scenario WorkspaceRuntimeDisconnectScenario,
) error {
	if driver == nil {
		return fmt.Errorf("workspace runtime disconnect conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("workspace runtime disconnect scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

// ProviderlessTerminalDriver is the narrow fault-injection capability for a
// Runtime that durably fails the exact canonical Turn before it acquires a
// provider identity. It stays separate from Fixture so downstream conformance
// drivers can adopt this lifecycle scenario before upgrading their pinned
// Tutti dependency; an extra test-driver method is source-compatible with the
// previous conformance contract.
type ProviderlessTerminalDriver interface {
	ResetProviderlessTerminalExec(context.Context, *SessionSeed) error
}

type Scenario struct {
	Name string
	run  func(context.Context, Driver) error
}

// RailPlacementRecoveryDriver is separate from Driver so Host consumers adopt
// the immutable rail recovery proof explicitly instead of reimplementing rail
// normalization in an application adapter.
type RailPlacementRecoveryDriver interface {
	Reset(context.Context, Fixture) error
	Create(context.Context, string, agenthost.CreateSessionInput) (SessionObservation, string, error)
	GetSessionWithRailPlacement(context.Context, agenthost.SessionRef, *agenthost.RailPlacement) (SessionObservation, error)
}

type RailPlacementRecoveryScenario struct {
	Name string
	run  func(context.Context, RailPlacementRecoveryDriver) error
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

type SideConversationMetrics struct {
	ParentActive    bool
	CanonicalWrites int
	TransientEvents int
	SideLive        bool
}

// SideConversationDriver is optional because a provider may omit the native
// Side adapter entirely. Implementations exercise the common Host lifecycle;
// provider-specific protocol details belong in adapter tests.
type SideConversationDriver interface {
	ResetSideConversation(context.Context) error
	SettleSideParent(context.Context) error
	OpenSideConversation(context.Context, agenthost.OpenSideConversationInput) (agenthost.OpenSideConversationResult, error)
	SendSideConversation(context.Context, agenthost.RuntimeExecInput) (agenthost.RuntimeExecResult, error)
	CloseSideConversation(context.Context, string, string) error
	SideConversationMetrics() SideConversationMetrics
}

type SideConversationScenario struct {
	Name string
	run  func(context.Context, SideConversationDriver) error
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

func RunRailPlacementRecovery(
	ctx context.Context,
	driver RailPlacementRecoveryDriver,
	scenario RailPlacementRecoveryScenario,
) error {
	if driver == nil {
		return fmt.Errorf("agent host rail placement recovery conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host rail placement recovery conformance scenario %q has no runner", scenario.Name)
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

func RunSideConversation(
	ctx context.Context,
	driver SideConversationDriver,
	scenario SideConversationScenario,
) error {
	if driver == nil {
		return fmt.Errorf("agent host side conversation conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf(
			"agent host side conversation conformance scenario %q has no runner",
			scenario.Name,
		)
	}
	return scenario.run(ctx, driver)
}
