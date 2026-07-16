package agentruntime

import (
	"context"
	"errors"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

var ErrLiveSessionBusy = errors.New("agent live session is busy")

type ProcessSpec struct {
	Provider       string
	AgentSessionID string
	RoomID         string
	CWD            string
	Command        []string
	Env            []string
	DirectStart    bool
}

type ProcessFrame struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode *int
	Message  string
}

type ProcessConnection interface {
	Send([]byte) error
	Recv() (ProcessFrame, error)
	Close() error
}

// ContextProcessConnection lets protocol readers stop waiting for output
// without terminating the provider process. Long-lived provider startups use
// this to detach a UI request timeout from the process lifecycle.
type ContextProcessConnection interface {
	ProcessConnection
	RecvContext(context.Context) (ProcessFrame, error)
}

type GracefulProcessConnection interface {
	ProcessConnection
	CloseInput() error
	Terminate() error
	Kill() error
}

type ProcessTransport interface {
	Start(context.Context, ProcessSpec) (ProcessConnection, error)
}

type EventSink func([]activityshared.Event)
type SessionEventSink func(string, []activityshared.Event)
type CommandSnapshotSink func(AgentSessionCommandSnapshot)
type ConfigOptionsUpdateSink func(AgentSessionConfigOptionsUpdate)

type Adapter interface {
	Provider() string
	Start(context.Context, Session) ([]activityshared.Event, error)
	Resume(context.Context, Session) error
	Close(context.Context, Session) error
	Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error)
	Cancel(context.Context, Session, string) ([]activityshared.Event, error)
}

// TargetedCancelAdapter maps canonical root/child targets onto provider-native
// handles. The controller supplies the root live session and never asks the
// adapter to discover the durable child tree itself.
type TargetedCancelAdapter interface {
	CancelTargets(context.Context, Session, []CancelTarget, string) (TargetedCancelResult, error)
}

// TargetedCancelResult separates provider-confirmed cancellation from the
// normalized UI events produced while issuing the command. A missing target
// is not confirmation: services/tuttid will settle an unconfirmed child turn
// as interrupted after this bounded provider call returns.
type TargetedCancelResult struct {
	Events           []activityshared.Event
	ConfirmedTargets []CancelTarget
}

type AsyncExecAdapter interface {
	ExecAsync(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) error
}

// RootProviderTurnLifecycleAdapter reports provider-turn lifecycle facts
// without claiming the canonical root WorkspaceAgentTurn is terminal. The
// durable daemon settles that root turn after checking every child turn.
type RootProviderTurnLifecycleAdapter interface {
	UsesRootProviderTurnLifecycle() bool
}

type ActiveTurnGuidanceAdapter interface {
	// GuideActiveTurn appends guidance to the exact controller turn identified
	// by turnID. The guidance submit does not own a separate turn lifecycle.
	GuideActiveTurn(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error)
}

type ResumeProbeAdapter interface {
	CanResume(Session) bool
}

type LiveSessionProbeAdapter interface {
	HasLiveSession(Session) bool
}

type LiveSessionReleaseAdapter interface {
	ReleaseLiveSession(context.Context, Session) error
}

type StateAdapter interface {
	SessionState(Session) SessionStateSnapshot
}

type CommandSnapshotAdapter interface {
	SessionCommandSnapshot(Session) (AgentSessionCommandSnapshot, bool)
}

type CommandSnapshotSinkAdapter interface {
	SetCommandSnapshotSink(CommandSnapshotSink)
}

type SessionEventSinkAdapter interface {
	SetSessionEventSink(SessionEventSink)
}

type GoalReconcileDurableRequest struct {
	RequestID           string
	Phase               string
	ProviderTurnID      string
	Reason              string
	FenceMode           string
	ExpectedOperationID string
	ExpectedRevision    int64
	ExpectedRepairEpoch int64
	QuiesceSucceeded    bool
	QuiesceError        string
}

type GoalReconcileDurableSink func(context.Context, Session, GoalReconcileDurableRequest) error

type GoalReconcileDurableSinkAdapter interface {
	SetGoalReconcileDurableSink(GoalReconcileDurableSink)
}

// GoalProvenanceBinding is the exact durable association between a
// provider-authored Goal generation and the business operation that created
// it. Ambiguous is a permanent tombstone: a reused fingerprint must never be
// rebound to either operation.
type GoalProvenanceBinding struct {
	OperationID string
	Revision    int64
	RepairEpoch int64
	Ambiguous   bool
}

type GoalProvenanceDurableSink interface {
	BindGoalProvenance(context.Context, Session, string, GoalProvenanceBinding) (GoalProvenanceBinding, error)
	LookupGoalProvenance(context.Context, Session, string) (GoalProvenanceBinding, bool, error)
}

type GoalProvenanceDurableSinkAdapter interface {
	SetGoalProvenanceDurableSink(GoalProvenanceDurableSink)
}

type ConfigOptionsUpdateSinkAdapter interface {
	SetConfigOptionsUpdateSink(ConfigOptionsUpdateSink)
}

type InteractiveAdapter interface {
	SubmitInteractive(context.Context, Session, SubmitInteractiveInput) (SubmitInteractiveResult, error)
}

type InteractiveDispositionAdapter interface {
	InteractiveDisposition(Session, string, string) InteractiveDisposition
}

type TargetedInteractiveDispositionAdapter interface {
	InteractiveDispositionForTarget(Session, string, string, string) InteractiveDisposition
}

type InteractiveDispositionSink func(string, string, string, InteractiveDisposition)

type InteractiveDispositionSinkAdapter interface {
	SetInteractiveDispositionSink(InteractiveDispositionSink)
}

// InteractiveSelectionState is the provider adapter's narrow projection of a
// successful interactive choice onto generic session settings. The controller
// owns persistence/publication; adapters own protocol vocabulary.
type InteractiveSelectionState struct {
	PlanMode       bool
	PermissionMode string
}

type InteractiveSelectionStateAdapter interface {
	StateAfterInteractiveSelection(Session, string) (InteractiveSelectionState, bool)
}

type InteractiveDenyFollowUpPolicyAdapter interface {
	ControllerSendsInteractiveDenyFollowUp() bool
}

type PromptContentAdapter interface {
	ValidatePromptContent(Session, []PromptContentBlock) error
}

// GoalControlAction is a direct goal operation invoked from the GUI (banner
// buttons) without going through the prompt pipeline.
type GoalControlAction string

const (
	GoalControlPause  GoalControlAction = "pause"
	GoalControlResume GoalControlAction = "resume"
	GoalControlClear  GoalControlAction = "clear"
	GoalControlSet    GoalControlAction = "set"
)

type GoalAdapterCapabilities struct {
	QuerySupported        bool
	ClearSupported        bool
	PauseSupported        bool
	QuiesceGoalTurns      bool
	ReplaySetAfterRestart bool
}

type GoalAdapterResult struct {
	Events      []activityshared.Event
	Observation map[string]any
	Evidence    map[string]any
	// ProviderPhase separates transport acceptance from evidence that the
	// provider actually consumed/applied the command.
	ProviderPhase string
}

// GoalApplyInput carries the durable control identity allocated above the
// provider boundary. It is not a Turn identity: providers copy it onto any
// Turn they later create so activity can be traced back to the goal revision.
type GoalApplyInput struct {
	Action      GoalControlAction
	Objective   string
	OperationID string
	Revision    int64
	RepairEpoch int64
	// SubmissionMetadata links a composer-originated control to its turnless
	// audit message. It is intentionally independent of Turn identity.
	SubmissionMetadata map[string]any
}

// GoalAdapter is the semantic provider boundary for goal state. Providers
// return observations and evidence; only the upper persistence layer decides
// desired/observed convergence and writes durable state.
type GoalAdapter interface {
	GoalCapabilities() GoalAdapterCapabilities
	ApplyGoal(ctx context.Context, session Session, input GoalApplyInput) (GoalAdapterResult, error)
	ReconcileGoal(ctx context.Context, session Session) (GoalAdapterResult, error)
	NormalizeGoalObservation(raw map[string]any) map[string]any
	// ExecGoalControl handles a typed "/goal …" prompt as a session-level
	// operation. The controller calls it before allocating a turn identity;
	// audit messages emitted by the adapter therefore remain turnless.
	ExecGoalControl(ctx context.Context, session Session, content []PromptContentBlock, displayPrompt string) (events []activityshared.Event, handled bool, err error)
}

type PermissionModeAdapter interface {
	ApplyPermissionMode(context.Context, Session) error
}

type LiveSettingsAdapter interface {
	ApplySessionSettings(context.Context, Session, SessionSettingsPatch) error
}

type NewSessionSettingsAdapter interface {
	RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool
}
