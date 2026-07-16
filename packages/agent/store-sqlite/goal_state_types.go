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
)

var (
	ErrGoalOperationConflict = errors.New("goal control operation identity conflicts with existing state")
	ErrGoalStateAbsent       = errors.New("agent session has no goal to update")
	ErrGoalReconcileConflict = errors.New("goal observation reconcile fence conflicted with current state")
)

type SessionGoalState struct {
	WorkspaceID        string
	AgentSessionID     string
	Desired            map[string]any
	Observed           map[string]any
	Revision           int64
	Tombstoned         bool
	SyncStatus         string
	PendingOperationID string
	LastEvidence       map[string]any
	LastError          string
	ObservedAtUnixMS   int64
	CreatedAtUnixMS    int64
	UpdatedAtUnixMS    int64
}

type GoalControlOperation struct {
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
	OperationID      string
	WorkspaceID      string
	AgentSessionID   string
	Action           string
	Objective        string
	ClientSubmitID   string
	OccurredAtUnixMS int64
}

type GoalControlOperationComplete struct {
	OperationID      string
	WorkspaceID      string
	Observed         map[string]any
	Evidence         map[string]any
	LastError        string
	Succeeded        bool
	OccurredAtUnixMS int64
	RepairEpoch      int64
}

type GoalControlOperationAcknowledge struct {
	OperationID      string
	WorkspaceID      string
	Evidence         map[string]any
	OccurredAtUnixMS int64
	RepairEpoch      int64
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
