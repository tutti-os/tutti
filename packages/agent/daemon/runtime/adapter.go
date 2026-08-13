package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"os"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

var ErrLiveSessionBusy = errors.New("agent live session is busy")

type ProcessSpec struct {
	Provider           string
	AgentSessionID     string
	RootAgentSessionID string
	RoomID             string
	CWD                string
	ProtocolCWD        string
	Command            []string
	Env                []string
	DirectStart        bool
	ExecutableIdentity *ExecutableIdentity
	ArtifactTrees      []ArtifactTreeIdentity
	// SensitiveInheritedFiles are opt-in descriptors whose contents must never
	// be copied into argv or the process environment. Generic process
	// transports reject this field; the connector transport maps each file to
	// fd 3+n and publishes only that descriptor number through DescriptorEnvKey.
	SensitiveInheritedFiles []SensitiveInheritedFile
}

// ArtifactTreeIdentity binds a connector artifact snapshot to the inventory
// digest verified from the signed artifact. The connector transport rechecks
// it immediately before launch, closing the receipt-to-launch pathname gap.
type ArtifactTreeIdentity struct {
	Root   string
	SHA256 string
}

// SensitiveInheritedFile describes one host-owned secret-bearing descriptor.
// DescriptorEnvKey is metadata, not a secret, and must use the reserved
// TUTTI_CONNECTOR_FD_ prefix. Ownership stays with the caller; transports dup
// the descriptor for the child and never close File.
type SensitiveInheritedFile struct {
	File             *os.File
	DescriptorEnvKey string
	Purpose          string
}

// ExecutableIdentity binds a process launch to bytes verified by an owning
// managed-runtime boundary. When present, local transport executes the opened,
// verified descriptor rather than resolving the pathname again.
type ExecutableIdentity struct {
	SHA256    string
	SizeBytes int64
}

type ProcessFrame struct {
	Stdout       []byte
	Stderr       []byte
	ExitCode     *int
	Message      string
	RecordingID  string
	ConnectionID string
	ChunkSeq     uint64
	// Synthetic marks optional-probe / startup-metadata responses invented by
	// replay. They are not cassette units and must not advance the provider
	// input barrier (ChunkSeq is unset / zero).
	Synthetic bool
}

type ProcessConnection interface {
	Send([]byte) error
	Recv() (ProcessFrame, error)
	Close() error
}

// RuntimeTransportFailure carries a bounded machine-readable failure code
// from a host-owned process transport into canonical Agent failure events.
// Implementations must not encode raw paths, request payloads, or credentials
// in the code.
type RuntimeTransportFailure interface {
	error
	RuntimeTransportFailureCode() string
}

// RuntimeTransportGRPCFailure optionally preserves the bounded gRPC status
// code for transport diagnostics without exposing the raw status message.
type RuntimeTransportGRPCFailure interface {
	RuntimeTransportFailure
	RuntimeTransportGRPCCode() string
}

// ProcessCassetteCheckpointConnection is implemented by replay connections so
// provider adapters can distinguish a cold process tape from capture attached
// to an already initialized live provider connection.
type ProcessCassetteCheckpointConnection interface {
	ProcessConnection
	ProcessCassetteCaptureOrigin() ProcessCassetteCaptureOrigin
}

func processCassetteCaptureOrigin(
	connection ProcessConnection,
) ProcessCassetteCaptureOrigin {
	checkpoint, ok := connection.(ProcessCassetteCheckpointConnection)
	if !ok {
		return ""
	}
	return checkpoint.ProcessCassetteCaptureOrigin()
}

// ContextProcessConnection lets protocol readers stop waiting for output
// without terminating the provider process. Long-lived provider startups use
// this to detach a UI request timeout from the process lifecycle.
type ContextProcessConnection interface {
	ProcessConnection
	RecvContext(context.Context) (ProcessFrame, error)
}

// ProviderInputUnitCompletion is the decoder-to-transport barrier. Recording
// uses it to anchor semantic observations to transport positions. Replay uses
// it to hold a connection after a complete input unit has been handled.
type ProviderInputUnitCompletion interface {
	CompleteProviderInputUnit(context.Context, ProviderInputUnit) error
}

// ProviderInputUnitTrackingTransport marks transports whose connections emit
// stable process positions for recording or deterministic replay.
type ProviderInputUnitTrackingTransport interface {
	TracksProviderInputUnits() bool
}

type ProviderInputUnit struct {
	RecordingID string
	Position    sessionreplay.ProviderUnitPosition
	Kind        sessionreplay.ProviderInputUnitKind
}

type providerInputUnitContextKey struct{}

func contextWithProviderInputUnit(
	ctx context.Context,
	unit ProviderInputUnit,
) context.Context {
	return context.WithValue(ctx, providerInputUnitContextKey{}, unit)
}

func ProviderInputUnitFromContext(ctx context.Context) (ProviderInputUnit, bool) {
	if ctx == nil {
		return ProviderInputUnit{}, false
	}
	unit, ok := ctx.Value(providerInputUnitContextKey{}).(ProviderInputUnit)
	return unit, ok
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
	// Resume reconnects provider context only. It must not initiate a Turn;
	// execution remains gated on a later explicit Controller operation.
	Resume(context.Context, Session) error
	Close(context.Context, Session) error
	Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error)
	Cancel(context.Context, Session, string) ([]activityshared.Event, error)
}

// ConnectorCapabilityAdapter reports whether this exact provider runtime can
// accept Tutti's session-scoped Connector binding. Implementations must return
// false unless support is explicit; a missing implementation is unsupported.
type ConnectorCapabilityAdapter interface {
	ConnectorCapabilities(context.Context, Session) (ConnectorCapabilities, error)
}

type ConnectorCapabilities struct {
	HTTPMCP bool
}

// SessionForkAdapter is an optional provider-native capability. Providers that
// cannot prove an exact fork boundary do not implement it.
type SessionForkAdapter interface {
	ForkCapabilities(context.Context, Session) (SessionForkCapabilities, error)
	Fork(context.Context, SessionForkInput) (SessionForkResult, error)
}

// ProviderTurnBindingAdapter owns the provider-specific Turn binding payload.
// The host and store persist ProviderTurnBindingJSON opaquely and never infer
// forkability from provider-specific fields.
type ProviderTurnBindingAdapter interface {
	WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput,
	) (json.RawMessage, error)
	CanForkProviderTurn(
		context.Context,
		ProviderTurnForkabilityInput,
	) (bool, error)
}

type ProviderTurnBindingRecoveryAdapter interface {
	RecoverProviderTurnBinding(
		context.Context,
		ProviderTurnBindingRecoveryInput,
	) (ProviderTurnBindingRecoveryResult, error)
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

// ResolveInputBoundAdapter lets a provider-keyed migration cache fail closed
// when a dynamic adapter was created for a different trusted Target binding.
type ResolveInputBoundAdapter interface {
	MatchesAdapterResolveInput(AdapterResolveInput) bool
}

type AsyncExecAdapter interface {
	ExecAsync(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) error
}

// ProviderAcceptanceExecAdapter exposes the provider's exact acceptance
// receipt without making canonical lifecycle depend on provider-specific
// notifications arriving later through the ordinary report queue.
type ProviderAcceptanceExecAdapter interface {
	Adapter
	ExecWithProviderAcceptance(
		context.Context,
		Session,
		[]PromptContentBlock,
		string,
		string,
		EventSink,
		CommandSnapshotSink,
		ProviderDispatchSink,
		ProviderAcceptanceBarrier,
	) ([]activityshared.Event, error)
}

type EffectiveHistoryTurn struct {
	ID                  string
	Status              string
	ClientUserMessageID string
}

// EffectiveHistorySnapshot is the provider's authoritative thread membership
// after a read or rollback. Canonical messages remain store-owned.
type EffectiveHistorySnapshot struct {
	ProviderSessionID string
	Turns             []EffectiveHistoryTurn
}

type HistoryMutationResult struct {
	Disposition DispatchDisposition
	Snapshot    *EffectiveHistorySnapshot
}

type HistoryReplacementExecInput struct {
	Content       []PromptContentBlock
	DisplayPrompt string
	TurnID        string
}

// ProviderDispatchSink reports the provider's direct operation outcome. A
// successful operation that does not create a provider Turn uses
// DispatchDispositionAppliedWithoutProviderTurn. Implementations must report
// exactly once before a typed execution method returns.
type ProviderDispatchSink func(ProviderDispatchResult)

// ProviderAcceptanceBarrier durably binds the canonical Turn to the exact
// provider session and provider Turn before the adapter exposes any event that
// depends on that identity. Implementations must call it synchronously on the
// provider event path and stop event publication when it fails.
type ProviderAcceptanceBarrier func(ProviderAcceptanceReceipt) error

// EffectiveHistoryAdapter is the complete provider capability required by
// edit-retry: authoritative history reads, rollback, and a fresh replacement
// turn start with typed acceptance evidence. Shared code fails closed unless
// the provider implements the entire seam.
type EffectiveHistoryAdapter interface {
	Adapter
	ReadEffectiveHistory(context.Context, Session) (EffectiveHistorySnapshot, error)
	RollbackLatestTurn(context.Context, Session) (HistoryMutationResult, error)
	ExecHistoryReplacement(
		context.Context,
		Session,
		HistoryReplacementExecInput,
		EventSink,
		CommandSnapshotSink,
		ProviderDispatchSink,
	) ([]activityshared.Event, error)
}

// RootProviderTurnLifecycleAdapter reports provider-turn lifecycle facts
// without claiming the canonical root WorkspaceAgentTurn is terminal. The
// durable daemon settles that root turn after checking every child turn.
type RootProviderTurnLifecycleAdapter interface {
	UsesRootProviderTurnLifecycle() bool
}

type ActiveTurnGuidanceAdapter interface {
	// GuideActiveTurn applies guidance to the exact controller turn identified
	// by turnID. It must terminate the provider's current response and close its
	// streaming projections before admitting the guided response, while keeping
	// the same canonical turn lifecycle.
	GuideActiveTurn(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error)
}

type ResumeProbeAdapter interface {
	CanResume(Session) bool
}

type LiveSessionProbeAdapter interface {
	HasLiveSession(Session) bool
}

type LiveSessionResourceCleanupResult struct {
	Attempted int
	Cleaned   int
	Failed    int
}

// LiveSessionResourceCleanupAdapter owns physical handles that can outlive a
// canonical runtime Session after a failed close. Cleanup is bounded by limit
// so one reaper or shutdown pass cannot block on every retired process.
type LiveSessionResourceCleanupAdapter interface {
	CleanupLiveSessionResources(context.Context, int) LiveSessionResourceCleanupResult
}

type LiveSessionReleaseAdapter interface {
	ReleaseLiveSession(context.Context, Session) error
}

// LiveSessionReleaseCapabilityAdapter narrows live-session release for
// adapters whose ability to resume is learned from the current provider
// handshake rather than known statically by adapter type.
type LiveSessionReleaseCapabilityAdapter interface {
	CanReleaseLiveSession(Session) bool
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

type ProviderGoalAdoptionRequest struct {
	Fingerprint      string
	ExpectedRevision int64
	Goal             map[string]any
}

type ProviderGoalAdoptionSink func(context.Context, Session, ProviderGoalAdoptionRequest) (GoalProvenanceBinding, error)

type ProviderGoalAdoptionSinkAdapter interface {
	SetProviderGoalAdoptionSink(ProviderGoalAdoptionSink)
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

type GoalGenerationFenceInput struct {
	OperationID string
	Revision    int64
	RepairEpoch int64
	Reason      string
}

// GoalGenerationFencer installs an exact, idempotent admission fence for one
// Goal generation. It must never retarget the session's current Turn.
type GoalGenerationFencer interface {
	FenceGoalGeneration(context.Context, Session, GoalGenerationFenceInput) error
}

type GoalAdapterResult struct {
	Events      []activityshared.Event
	Observation map[string]any
	Evidence    map[string]any
	// ProviderPhase separates transport acceptance from evidence that the
	// provider actually consumed/applied the command.
	ProviderPhase string
	// ExecutionPending is set only when the provider accepted a command that
	// is expected to start autonomous Goal execution.
	ExecutionPending bool
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

// SessionSettingsValidationAdapter validates a settings patch against live
// runtime facts before the controller mutates or applies any part of it.
type SessionSettingsValidationAdapter interface {
	ValidateSessionSettings(Session, SessionSettingsPatch) error
}

type NewSessionSettingsAdapter interface {
	RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool
}
