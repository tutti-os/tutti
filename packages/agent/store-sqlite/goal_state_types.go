package storesqlite

import "errors"

const (
	GoalSyncStatusPending  = "pending"
	GoalSyncStatusApplying = "applying"
	GoalSyncStatusSynced   = "synced"
	GoalSyncStatusDiverged = "diverged"
	GoalSyncStatusUnknown  = "unknown"
	GoalSyncStatusFailed   = "failed"

	GoalOperationStatusPrepared   = "prepared"
	GoalOperationStatusDispatched = "dispatched"
	GoalOperationStatusCompleted  = "completed"
	GoalOperationStatusFailed     = "failed"
	GoalOperationStatusSuperseded = "superseded"

	GoalProviderPhasePrepared   = "prepared"
	GoalProviderPhaseDispatched = "dispatched"
	GoalProviderPhaseAccepted   = "accepted"
	GoalProviderPhaseApplied    = "applied"
	GoalProviderPhaseUnknown    = "unknown"

	GoalControlCompletionModeProvider  GoalControlCompletionMode = "provider"
	GoalControlCompletionModeLocalStop GoalControlCompletionMode = "local_stop"
)

// GoalControlCompletionMode distinguishes provider-confirmed completion from
// restart recovery that only finalizes the durable local stop. The zero value
// preserves the provider-confirmed behavior for existing callers.
type GoalControlCompletionMode string

var (
	ErrGoalOperationConflict       = errors.New("goal control operation identity conflicts with existing state")
	ErrGoalStateAbsent             = errors.New("agent session has no goal to update")
	ErrGoalReconcileConflict       = errors.New("goal observation reconcile fence conflicted with current state")
	ErrGoalGenerationFenceConflict = errors.New("goal generation fence identity conflicts with existing state")
	ErrGoalGenerationSuperseded    = errors.New("goal generation was superseded before the conditional control")
)

type SessionGoalState struct {
	// CommitTransactionID is populated only on a successful mutation return;
	// it is not persisted as goal state.
	CommitTransactionID string           `json:"-"`
	CommitDelta         TransactionDelta `json:"-"`
	WorkspaceID         string
	AgentSessionID      string
	Desired             map[string]any
	Observed            map[string]any
	Revision            int64
	Tombstoned          bool
	SyncStatus          string
	PendingOperationID  string
	// ExecutionPending is Host-owned proof that the accepted Goal command is
	// expected to begin autonomous execution but no exact Goal Turn has been
	// persisted yet. It is cleared by the first provenance-matched Turn.
	ExecutionPending bool
	LastEvidence     map[string]any
	LastError        string
	ObservedAtUnixMS int64
	CreatedAtUnixMS  int64
	UpdatedAtUnixMS  int64
}

type GoalControlOperation struct {
	// CommitTransactionID is populated only on a successful mutation return;
	// it is not persisted as operation state.
	CommitTransactionID     string           `json:"-"`
	CommitDelta             TransactionDelta `json:"-"`
	OperationID             string
	WorkspaceID             string
	AgentSessionID          string
	GoalRevision            int64
	Action                  string
	Objective               string
	Status                  string
	Evidence                map[string]any
	LastError               string
	CreatedAtUnixMS         int64
	UpdatedAtUnixMS         int64
	CompletedAtUnixMS       int64
	ProviderPhase           string
	LeaseOwner              string
	LeaseExpiresAtMS        int64
	NextAttemptAtMS         int64
	Attempt                 int
	RepairRequired          bool
	RepairEpoch             int64
	AcceptedAtUnixMS        int64
	AcceptedAttempt         int
	FirstDispatchedAtUnixMS int64
	DispatchedAttempt       int
	ClientSubmitID          string
}

type GoalControlOperationPrepare struct {
	OperationID    string
	WorkspaceID    string
	AgentSessionID string
	Action         string
	Objective      string
	ClientSubmitID string
	// ExpectedRevision makes a control conditional on the exact Goal
	// generation still being current. Zero preserves ordinary controls.
	ExpectedRevision int64
	OccurredAtUnixMS int64
}

// ProviderGoalAdoption atomically promotes one provider-authored Goal
// generation into the durable Goal operation lane after the provider has
// already applied it. OperationID and ClientSubmitID must be deterministic for
// the provider generation so notification replay is idempotent.
type ProviderGoalAdoption struct {
	OperationID      string
	WorkspaceID      string
	AgentSessionID   string
	ClientSubmitID   string
	ExpectedRevision int64
	Goal             map[string]any
	Evidence         map[string]any
	OccurredAtUnixMS int64
}

type GoalControlOperationComplete struct {
	OperationID      string
	WorkspaceID      string
	Mode             GoalControlCompletionMode
	Observed         map[string]any
	Evidence         map[string]any
	LastError        string
	Succeeded        bool
	ExecutionPending bool
	OccurredAtUnixMS int64
	RepairEpoch      int64
}

type GoalControlOperationAcknowledge struct {
	OperationID      string
	WorkspaceID      string
	Evidence         map[string]any
	OccurredAtUnixMS int64
	RepairEpoch      int64
	ExecutionPending bool
}

type GoalObservationReconcile struct {
	WorkspaceID      string
	AgentSessionID   string
	Observed         map[string]any
	Evidence         map[string]any
	LastError        string
	OccurredAtUnixMS int64
	Expected         *GoalObservationFence
	// ForceSyncUnknown records non-authoritative evidence without allowing an
	// otherwise converged desired/observed pair to claim provider convergence.
	ForceSyncUnknown bool
}

type GoalObservationFence struct {
	Exists             bool
	Revision           int64
	PendingOperationID string
	ObservedAtUnixMS   int64
}

type GoalTerminalIncidentInput struct {
	WorkspaceID      string
	AgentSessionID   string
	Revision         int64
	SourceID         string
	LastError        string
	OccurredAtUnixMS int64
	Expected         *GoalObservationFence
}

type ListClaimableGoalControlOperationsInput struct {
	NowUnixMS int64
	Limit     int
}

type ClaimGoalControlOperationInput struct {
	WorkspaceID      string
	OperationID      string
	LeaseOwner       string
	NowUnixMS        int64
	LeaseExpiresAtMS int64
}

type ReleaseGoalControlOperationInput struct {
	WorkspaceID     string
	OperationID     string
	LeaseOwner      string
	ProviderPhase   string
	Evidence        map[string]any
	LastError       string
	NowUnixMS       int64
	NextAttemptAtMS int64
	Fail            bool
	RepairEpoch     int64
}

type GoalControlOperationEvidence struct {
	WorkspaceID      string
	OperationID      string
	ProviderPhase    string
	Evidence         map[string]any
	OccurredAtUnixMS int64
}

const (
	GoalGenerationFenceStatusPending    = "pending"
	GoalGenerationFenceStatusProcessing = "processing"
	GoalGenerationFenceStatusCompleted  = "completed"
)

// GoalGenerationFence permanently revokes one exact Goal operation
// generation. Its presence is the durable admission fence; Status only tracks
// delivery of quiesce/clear work and never re-authorizes the generation.
type GoalGenerationFence struct {
	FenceID              string
	WorkspaceID          string
	AgentSessionID       string
	TargetOperationID    string
	TargetRevision       int64
	TargetRepairEpoch    int64
	ClientSubmitID       string
	Reason               string
	Status               string
	ClearOperationID     string
	LeaseOwner           string
	LeaseExpiresAtUnixMS int64
	NextAttemptAtUnixMS  int64
	Attempt              int
	LastError            string
	CreatedAtUnixMS      int64
	UpdatedAtUnixMS      int64
	CompletedAtUnixMS    int64
}

type GoalGenerationFencePrepare struct {
	FenceID           string
	WorkspaceID       string
	AgentSessionID    string
	TargetOperationID string
	ClientSubmitID    string
	Reason            string
	OccurredAtUnixMS  int64
}

type ListClaimableGoalGenerationFencesInput struct {
	NowUnixMS int64
	Limit     int
}

type ClaimGoalGenerationFenceInput struct {
	FenceID          string
	LeaseOwner       string
	NowUnixMS        int64
	LeaseExpiresAtMS int64
}

type ReleaseGoalGenerationFenceInput struct {
	FenceID          string
	LeaseOwner       string
	LastError        string
	NowUnixMS        int64
	NextAttemptAtMS  int64
	ClearOperationID string
}

type CompleteGoalGenerationFenceInput struct {
	FenceID          string
	LeaseOwner       string
	ClearOperationID string
	OccurredAtUnixMS int64
}

type WakeGoalControlOperationInput struct {
	WorkspaceID       string
	OperationID       string
	GoalRevision      int64
	SourceRevision    int64
	SourceOperationID string
	OccurredAtUnixMS  int64
}

type EnsureGoalRepairOperationInput struct {
	WorkspaceID       string
	AgentSessionID    string
	SourceOperationID string
	SourceRevision    int64
	CurrentRevision   int64
	Evidence          map[string]any
	OccurredAtUnixMS  int64
}

type GoalReconcileInboxItem struct {
	RequestID        string
	WorkspaceID      string
	AgentSessionID   string
	Payload          map[string]any
	PayloadError     string
	Status           string
	Attempt          int
	LeaseOwner       string
	LeaseExpiresAtMS int64
	NextAttemptAtMS  int64
	LastError        string
	CreatedAtUnixMS  int64
	UpdatedAtUnixMS  int64
}

type ClaimGoalReconcileInboxInput struct {
	RequestID        string
	LeaseOwner       string
	NowUnixMS        int64
	LeaseExpiresAtMS int64
}

type ReleaseGoalReconcileInboxInput struct {
	RequestID       string
	LeaseOwner      string
	NowUnixMS       int64
	NextAttemptAtMS int64
	LastError       string
	Fail            bool
}

// GoalProvenanceBinding is an exact, durable association between a
// provider-authored Goal generation fingerprint and the business operation
// that created it. Ambiguous is a permanent tombstone: callers must not use
// the identity fields when it is true.
type GoalProvenanceBinding struct {
	WorkspaceID            string
	AgentSessionID         string
	SessionCreatedAtUnixMS int64
	ProviderSessionID      string
	Fingerprint            string
	OperationID            string
	Revision               int64
	RepairEpoch            int64
	Ambiguous              bool
	CreatedAtUnixMS        int64
	UpdatedAtUnixMS        int64
}

type BindGoalProvenanceInput struct {
	WorkspaceID            string
	AgentSessionID         string
	SessionCreatedAtUnixMS int64
	ProviderSessionID      string
	Fingerprint            string
	OperationID            string
	Revision               int64
	RepairEpoch            int64
	OccurredAtUnixMS       int64
}

type LookupGoalProvenanceInput struct {
	WorkspaceID            string
	AgentSessionID         string
	SessionCreatedAtUnixMS int64
	ProviderSessionID      string
	Fingerprint            string
}
