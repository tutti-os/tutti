package agentsessionstore

import (
	"encoding/json"
	"net/http"
	"time"

	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const (
	remoteAPIPrefix                       = "/api/desktop/v1"
	localAPIPrefix                        = "/v1"
	defaultTimeout                        = 30 * time.Second
	maxUpstreamToolPayloadStringBytes     = 16 * 1024
	maxUpstreamSessionMessagePayloadBytes = 240 * 1024
	maxUpstreamReportRequestBytes         = 900 * 1024

	WorkspaceAgentSessionOriginRuntime = "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
)

type Config struct {
	BaseURL       string
	UserID        string
	Token         string
	PPELane       string
	SessionCookie string
	HTTPClient    *http.Client
}

type Client struct {
	cfg        Config
	httpClient *http.Client
}

type ReportActivityInput struct {
	WorkspaceID           string
	Connector             *ConnectorInfo
	Source                EventSource
	TimelineItems         []WorkspaceAgentTimelineItem
	StatePatches          []WorkspaceAgentStatePatch
	MessageUpdates        []WorkspaceAgentMessageUpdate
	SessionAudits         []WorkspaceAgentSessionAuditUpdate
	GoalReconcileRequests []WorkspaceAgentGoalReconcileRequest
}

type ReportActivityReply struct {
	AcceptedTimelineItemCount         int `json:"acceptedTimelineItemCount"`
	AcceptedStatePatchCount           int `json:"acceptedStatePatchCount"`
	AcceptedMessageUpdateCount        int `json:"acceptedMessageUpdateCount"`
	AcceptedSessionAuditCount         int `json:"acceptedSessionAuditCount"`
	AcceptedGoalReconcileRequestCount int `json:"acceptedGoalReconcileRequestCount"`
	RequestBodyBytes                  int `json:"-"`
}

type WorkspaceAgentGoalReconcileRequest struct {
	RequestID           string `json:"requestId"`
	Phase               string `json:"phase"`
	AgentSessionID      string `json:"agentSessionId"`
	ProviderTurnID      string `json:"providerTurnId,omitempty"`
	Reason              string `json:"reason,omitempty"`
	FenceMode           string `json:"fenceMode"`
	ExpectedOperationID string `json:"expectedOperationId,omitempty"`
	ExpectedRevision    int64  `json:"expectedRevision,omitempty"`
	ExpectedRepairEpoch int64  `json:"expectedRepairEpoch,omitempty"`
	QuiesceSucceeded    bool   `json:"quiesceSucceeded"`
	QuiesceError        string `json:"quiesceError,omitempty"`
}

// Deprecated: use canonical.ReportSessionStateInput.
type ReportSessionStateInput = canonical.ReportSessionStateInput

// Deprecated: use canonical.ReportSessionStateReply.
type ReportSessionStateReply = canonical.ReportSessionStateReply

type ReportGoalReconcileRequiredInput struct {
	WorkspaceID string
	Request     WorkspaceAgentGoalReconcileRequest
}

type ReportGoalReconcileRequiredReply struct {
	Accepted bool
}

// GoalProvenanceBinding is the durable exact-key answer used by provider
// adapters to attribute provider-authored Goal generations without relying on
// a transient Turn id. Ambiguous is a permanent fail-closed tombstone.
type GoalProvenanceBinding struct {
	WorkspaceID            string `json:"workspaceId"`
	AgentSessionID         string `json:"agentSessionId"`
	SessionCreatedAtUnixMS int64  `json:"sessionCreatedAtUnixMs"`
	ProviderSessionID      string `json:"providerSessionId"`
	Fingerprint            string `json:"fingerprint"`
	OperationID            string `json:"operationId,omitempty"`
	Revision               int64  `json:"revision,omitempty"`
	RepairEpoch            int64  `json:"repairEpoch,omitempty"`
	Ambiguous              bool   `json:"ambiguous"`
	CreatedAtUnixMS        int64  `json:"createdAtUnixMs"`
	UpdatedAtUnixMS        int64  `json:"updatedAtUnixMs"`
}

type BindGoalProvenanceInput struct {
	WorkspaceID            string `json:"workspaceId"`
	AgentSessionID         string `json:"agentSessionId"`
	SessionCreatedAtUnixMS int64  `json:"sessionCreatedAtUnixMs"`
	ProviderSessionID      string `json:"providerSessionId"`
	Fingerprint            string `json:"fingerprint"`
	OperationID            string `json:"operationId"`
	Revision               int64  `json:"revision"`
	RepairEpoch            int64  `json:"repairEpoch"`
	OccurredAtUnixMS       int64  `json:"occurredAtUnixMs,omitempty"`
}

type LookupGoalProvenanceInput struct {
	WorkspaceID            string `json:"workspaceId"`
	AgentSessionID         string `json:"agentSessionId"`
	SessionCreatedAtUnixMS int64  `json:"sessionCreatedAtUnixMs"`
	ProviderSessionID      string `json:"providerSessionId"`
	Fingerprint            string `json:"fingerprint"`
}

type LookupGoalProvenanceReply struct {
	Binding GoalProvenanceBinding `json:"binding"`
	Found   bool                  `json:"found"`
}

// Deprecated: use canonical.WorkspaceAgentSessionStateUpdate.
type WorkspaceAgentSessionStateUpdate = canonical.WorkspaceAgentSessionStateUpdate

// Deprecated: use canonical.WorkspaceAgentRootProviderTurnTransition.
type WorkspaceAgentRootProviderTurnTransition = canonical.WorkspaceAgentRootProviderTurnTransition

// Deprecated: use canonical.WorkspaceAgentTurnStateUpdate.
type WorkspaceAgentTurnStateUpdate = canonical.WorkspaceAgentTurnStateUpdate

// Deprecated: use canonical.WorkspaceAgentCompletedCommand.
type WorkspaceAgentCompletedCommand = canonical.WorkspaceAgentCompletedCommand

// Deprecated: use canonical.WorkspaceAgentSubmitAvailability.
type WorkspaceAgentSubmitAvailability = canonical.WorkspaceAgentSubmitAvailability

// Deprecated: use canonical.WorkspaceAgentTurnLifecycle.
type WorkspaceAgentTurnLifecycle = canonical.WorkspaceAgentTurnLifecycle

// Deprecated: use canonical.WorkspaceAgentInteractionTransition.
type WorkspaceAgentInteractionTransition = canonical.WorkspaceAgentInteractionTransition

const (
	RootProviderTurnPhaseRunning   = canonical.RootProviderTurnPhaseRunning
	RootProviderTurnPhaseCompleted = canonical.RootProviderTurnPhaseCompleted
)

// Deprecated: use canonical.ReportSessionMessagesInput.
type ReportSessionMessagesInput = canonical.ReportSessionMessagesInput

// Deprecated: use canonical.ReportSessionMessagesReply.
type ReportSessionMessagesReply = canonical.ReportSessionMessagesReply

// Deprecated: use canonical.WorkspaceAgentSessionMessageUpdate.
type WorkspaceAgentSessionMessageUpdate = canonical.WorkspaceAgentSessionMessageUpdate

// WorkspaceAgentSessionAuditUpdate is a first-class session-level activity.
// Compatibility transport may encode it in the session-message endpoint as
// kind=session_audit, but it never owns or references a Turn.
type WorkspaceAgentSessionAuditUpdate struct {
	AuditID          string         `json:"auditId"`
	Role             string         `json:"role"`
	Content          string         `json:"content,omitempty"`
	Payload          map[string]any `json:"payload,omitempty"`
	OccurredAtUnixMS int64          `json:"occurredAtUnixMs,omitempty"`
}

type ListSessionMessagesInput struct {
	WorkspaceID    string
	AgentSessionID string
	// DeviceID optionally scopes the query to sessions reported by a device.
	// Empty means no device filter (historical behavior).
	DeviceID      string
	AfterVersion  uint64
	Limit         int
	SessionOrigin string
}

type ListSessionMessagesReply struct {
	Messages      []WorkspaceAgentSessionMessage `json:"messages"`
	LatestVersion uint64                         `json:"latestVersion"`
	HasMore       bool                           `json:"hasMore"`
}

func (r *ListSessionMessagesReply) UnmarshalJSON(data []byte) error {
	var raw struct {
		Messages           []WorkspaceAgentSessionMessage `json:"messages"`
		LatestVersion      flexibleUint64                 `json:"latestVersion"`
		LatestVersionSnake flexibleUint64                 `json:"latest_version"`
		HasMore            bool                           `json:"hasMore"`
		HasMoreSnake       bool                           `json:"has_more"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*r = ListSessionMessagesReply{
		Messages: raw.Messages,
		LatestVersion: uint64(firstNonZeroFlexibleUint64(
			raw.LatestVersion,
			raw.LatestVersionSnake,
		)),
		HasMore: raw.HasMore || raw.HasMoreSnake,
	}
	return nil
}

type WorkspaceAgentSessionMessage struct {
	ID                uint64                          `json:"id"`
	AgentSessionID    string                          `json:"agentSessionId"`
	MessageID         string                          `json:"messageId"`
	TurnID            string                          `json:"turnId,omitempty"`
	Role              string                          `json:"role"`
	Kind              string                          `json:"kind"`
	Status            string                          `json:"status,omitempty"`
	Semantics         *WorkspaceAgentMessageSemantics `json:"semantics,omitempty"`
	Payload           map[string]any                  `json:"payload,omitempty"`
	OccurredAtUnixMS  int64                           `json:"occurredAtUnixMs,omitempty"`
	StartedAtUnixMS   int64                           `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS int64                           `json:"completedAtUnixMs,omitempty"`
	CreatedAtUnixMS   int64                           `json:"createdAtUnixMs,omitempty"`
	UpdatedAtUnixMS   int64                           `json:"updatedAtUnixMs,omitempty"`
	Version           uint64                          `json:"version"`
}

func (m *WorkspaceAgentSessionMessage) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID                     flexibleUint64                  `json:"id"`
		Sequence               flexibleUint64                  `json:"sequence"`
		AgentSessionID         string                          `json:"agentSessionId"`
		AgentSessionIDSnake    string                          `json:"agent_session_id"`
		MessageID              string                          `json:"messageId"`
		MessageIDSnake         string                          `json:"message_id"`
		TurnID                 string                          `json:"turnId"`
		TurnIDSnake            string                          `json:"turn_id"`
		Role                   string                          `json:"role"`
		Kind                   string                          `json:"kind"`
		Status                 string                          `json:"status"`
		Semantics              *WorkspaceAgentMessageSemantics `json:"semantics"`
		Payload                map[string]any                  `json:"payload"`
		OccurredAtUnixMS       flexibleInt64                   `json:"occurredAtUnixMs"`
		OccurredAtUnixMSSnake  flexibleInt64                   `json:"occurred_at_unix_ms"`
		StartedAtUnixMS        flexibleInt64                   `json:"startedAtUnixMs"`
		StartedAtUnixMSSnake   flexibleInt64                   `json:"started_at_unix_ms"`
		CompletedAtUnixMS      flexibleInt64                   `json:"completedAtUnixMs"`
		CompletedAtUnixMSSnake flexibleInt64                   `json:"completed_at_unix_ms"`
		CreatedAtUnixMS        flexibleInt64                   `json:"createdAtUnixMs"`
		CreatedAtUnixMSSnake   flexibleInt64                   `json:"created_at_unix_ms"`
		UpdatedAtUnixMS        flexibleInt64                   `json:"updatedAtUnixMs"`
		UpdatedAtUnixMSSnake   flexibleInt64                   `json:"updated_at_unix_ms"`
		Version                flexibleUint64                  `json:"version"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*m = WorkspaceAgentSessionMessage{
		ID:             uint64(firstNonZeroFlexibleUint64(raw.Sequence, raw.ID)),
		AgentSessionID: firstNonEmptyString(raw.AgentSessionID, raw.AgentSessionIDSnake),
		MessageID:      firstNonEmptyString(raw.MessageID, raw.MessageIDSnake),
		TurnID:         firstNonEmptyString(raw.TurnID, raw.TurnIDSnake),
		Role:           raw.Role,
		Kind:           raw.Kind,
		Status:         raw.Status,
		Semantics:      raw.Semantics,
		Payload:        raw.Payload,
		OccurredAtUnixMS: int64(firstNonZeroFlexibleInt64(
			raw.OccurredAtUnixMS,
			raw.OccurredAtUnixMSSnake,
		)),
		StartedAtUnixMS: int64(firstNonZeroFlexibleInt64(
			raw.StartedAtUnixMS,
			raw.StartedAtUnixMSSnake,
		)),
		CompletedAtUnixMS: int64(firstNonZeroFlexibleInt64(
			raw.CompletedAtUnixMS,
			raw.CompletedAtUnixMSSnake,
		)),
		CreatedAtUnixMS: int64(firstNonZeroFlexibleInt64(
			raw.CreatedAtUnixMS,
			raw.CreatedAtUnixMSSnake,
		)),
		UpdatedAtUnixMS: int64(firstNonZeroFlexibleInt64(
			raw.UpdatedAtUnixMS,
			raw.UpdatedAtUnixMSSnake,
		)),
		Version: uint64(raw.Version),
	}
	return nil
}

// Deprecated: use canonical.ConnectorInfo.
type ConnectorInfo = canonical.ConnectorInfo

// Deprecated: use canonical.EventSource.
type EventSource = canonical.EventSource

type WorkspaceAgentStatePatch struct {
	AgentSessionID        string                                    `json:"agentSessionId"`
	Kind                  string                                    `json:"kind,omitempty"`
	RootAgentSessionID    string                                    `json:"rootAgentSessionId,omitempty"`
	RootTurnID            string                                    `json:"rootTurnId,omitempty"`
	ParentAgentSessionID  string                                    `json:"parentAgentSessionId,omitempty"`
	ParentTurnID          string                                    `json:"parentTurnId,omitempty"`
	ParentToolCallID      string                                    `json:"parentToolCallId,omitempty"`
	AgentTargetID         string                                    `json:"agentTargetId,omitempty"`
	DeviceID              string                                    `json:"deviceId,omitempty"`
	Provider              string                                    `json:"provider,omitempty"`
	ProviderSessionID     string                                    `json:"providerSessionId,omitempty"`
	Model                 string                                    `json:"model,omitempty"`
	PermissionModeID      string                                    `json:"permissionModeId,omitempty"`
	Settings              map[string]any                            `json:"settings,omitempty"`
	RuntimeContext        map[string]any                            `json:"runtimeContext,omitempty"`
	TurnLifecycle         *WorkspaceAgentTurnLifecycle              `json:"turnLifecycle,omitempty"`
	SubmitAvailability    *WorkspaceAgentSubmitAvailability         `json:"submitAvailability,omitempty"`
	InteractionTransition *WorkspaceAgentInteractionTransition      `json:"interactionTransition,omitempty"`
	CWD                   string                                    `json:"cwd,omitempty"`
	Title                 string                                    `json:"title,omitempty"`
	LifecycleStatus       string                                    `json:"lifecycleStatus,omitempty"`
	CurrentPhase          string                                    `json:"currentPhase,omitempty"`
	LastError             string                                    `json:"lastError,omitempty"`
	OccurredAtUnixMS      int64                                     `json:"occurredAtUnixMs,omitempty"`
	Turn                  *WorkspaceAgentTurnPatch                  `json:"turn,omitempty"`
	RootProviderTurn      *WorkspaceAgentRootProviderTurnTransition `json:"rootProviderTurn,omitempty"`
	Entities              []WorkspaceAgentEntityPatch               `json:"entities,omitempty"`
}

type WorkspaceAgentTurnPatch struct {
	TurnID                  string                              `json:"turnId"`
	CapabilityRefs          []WorkspaceAgentCapabilityReference `json:"capabilityRefs,omitempty"`
	Origin                  string                              `json:"origin,omitempty"`
	SourceGoalOperationID   string                              `json:"sourceGoalOperationId,omitempty"`
	SourceGoalRevision      int64                               `json:"sourceGoalRevision,omitempty"`
	SourceGoalRepairEpoch   int64                               `json:"sourceGoalRepairEpoch,omitempty"`
	ActiveTurnID            *string                             `json:"activeTurnId,omitempty"`
	Phase                   string                              `json:"phase,omitempty"`
	Outcome                 string                              `json:"outcome,omitempty"`
	Settling                bool                                `json:"settling,omitempty"`
	CompletedCommand        *WorkspaceAgentCompletedCommand     `json:"completedCommand,omitempty"`
	SubmitAvailability      *WorkspaceAgentSubmitAvailability   `json:"submitAvailability,omitempty"`
	FileChanges             map[string]any                      `json:"fileChanges,omitempty"`
	StartedAtUnixMS         int64                               `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS       int64                               `json:"completedAtUnixMs,omitempty"`
	FinalAssistantMessageID string                              `json:"finalAssistantMessageId,omitempty"`
	ParentTurnID            string                              `json:"parentTurnId,omitempty"`
	Relation                string                              `json:"relation,omitempty"`
}

type WorkspaceAgentEntityPatch struct {
	CallID            string         `json:"callId"`
	TurnID            string         `json:"turnId,omitempty"`
	CallType          string         `json:"callType,omitempty"`
	Name              string         `json:"name,omitempty"`
	Status            string         `json:"status,omitempty"`
	Input             map[string]any `json:"input,omitempty"`
	Output            map[string]any `json:"output,omitempty"`
	Error             map[string]any `json:"error,omitempty"`
	StartedAtUnixMS   int64          `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS int64          `json:"completedAtUnixMs,omitempty"`
}

type WorkspaceAgentMessageUpdate struct {
	AgentSessionID    string                          `json:"agentSessionId"`
	MessageID         string                          `json:"messageId"`
	Seq               uint64                          `json:"seq"`
	TurnID            string                          `json:"turnId,omitempty"`
	Role              string                          `json:"role"`
	Kind              string                          `json:"kind"`
	Status            string                          `json:"status,omitempty"`
	Semantics         *WorkspaceAgentMessageSemantics `json:"semantics,omitempty"`
	CallID            string                          `json:"callId,omitempty"`
	ParentCallID      string                          `json:"parentCallId,omitempty"`
	RootCallID        string                          `json:"rootCallId,omitempty"`
	Title             string                          `json:"title,omitempty"`
	Payload           map[string]any                  `json:"payload"`
	OccurredAtUnixMS  int64                           `json:"occurredAtUnixMs,omitempty"`
	StartedAtUnixMS   int64                           `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS int64                           `json:"completedAtUnixMs,omitempty"`
}

// Deprecated: use canonical.WorkspaceAgentMessageSemantics.
type WorkspaceAgentMessageSemantics = canonical.WorkspaceAgentMessageSemantics

func (u *WorkspaceAgentMessageUpdate) UnmarshalJSON(data []byte) error {
	var raw struct {
		AgentSessionID    string                          `json:"agentSessionId"`
		MessageID         string                          `json:"messageId"`
		Seq               flexibleUint64                  `json:"seq"`
		TurnID            string                          `json:"turnId"`
		Role              string                          `json:"role"`
		Kind              string                          `json:"kind"`
		Status            string                          `json:"status"`
		Semantics         *WorkspaceAgentMessageSemantics `json:"semantics"`
		CallID            string                          `json:"callId"`
		ParentCallID      string                          `json:"parentCallId"`
		RootCallID        string                          `json:"rootCallId"`
		Title             string                          `json:"title"`
		Payload           map[string]any                  `json:"payload"`
		OccurredAtUnixMS  flexibleInt64                   `json:"occurredAtUnixMs"`
		StartedAtUnixMS   flexibleInt64                   `json:"startedAtUnixMs"`
		CompletedAtUnixMS flexibleInt64                   `json:"completedAtUnixMs"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*u = WorkspaceAgentMessageUpdate{
		AgentSessionID:    raw.AgentSessionID,
		MessageID:         raw.MessageID,
		Seq:               uint64(raw.Seq),
		TurnID:            raw.TurnID,
		Role:              raw.Role,
		Kind:              raw.Kind,
		Status:            raw.Status,
		Semantics:         raw.Semantics,
		CallID:            raw.CallID,
		ParentCallID:      raw.ParentCallID,
		RootCallID:        raw.RootCallID,
		Title:             raw.Title,
		Payload:           raw.Payload,
		OccurredAtUnixMS:  int64(raw.OccurredAtUnixMS),
		StartedAtUnixMS:   int64(raw.StartedAtUnixMS),
		CompletedAtUnixMS: int64(raw.CompletedAtUnixMS),
	}
	return nil
}

type ListAgentsInput struct {
	WorkspaceID   string
	SessionOrigin string
	UserID        string
	// DeviceID optionally scopes the query to sessions reported by a device.
	// Empty means no device filter (historical behavior).
	DeviceID string
}

type WorkspaceAgentSnapshot struct {
	Presences           []WorkspaceAgentPresence                  `json:"presences"`
	Sessions            []ProviderActivitySessionProjection       `json:"sessions"`
	SessionTimelineByID map[string][]WorkspaceAgentTimelineItem   `json:"sessionTimelineById,omitempty"`
	SessionMessagesByID map[string][]WorkspaceAgentSessionMessage `json:"sessionMessagesById,omitempty"`
}

type WorkspaceAgentPresence struct {
	ID                  uint64 `json:"id"`
	WorkspaceID         string `json:"roomId"`
	UserID              string `json:"userId"`
	Provider            string `json:"provider"`
	Status              string `json:"status"`
	LastHeartbeatUnixMS int64  `json:"lastHeartbeatUnixMs"`
	LeaseExpiresUnixMS  int64  `json:"leaseExpiresUnixMs"`
	CreatedAtUnixMS     int64  `json:"createdAtUnixMs"`
	UpdatedAtUnixMS     int64  `json:"updatedAtUnixMs"`
}

// ProviderActivitySessionProjection is the legacy provider-event projection
// used inside the runtime/activity bridge. It is not the durable protocol-v2
// Session entity; its lifecycle fields must not escape this boundary.
type ProviderActivitySessionProjection struct {
	ID                 uint64                            `json:"id"`
	AgentSessionID     string                            `json:"agentSessionId"`
	AgentTargetID      string                            `json:"agentTargetId,omitempty"`
	DeviceID           string                            `json:"deviceId,omitempty"`
	PresenceID         uint64                            `json:"presenceId"`
	UserID             string                            `json:"userId"`
	Provider           string                            `json:"provider"`
	ProviderSessionID  string                            `json:"providerSessionId"`
	SessionOrigin      string                            `json:"sessionOrigin,omitempty"`
	CWD                string                            `json:"cwd"`
	Status             string                            `json:"status"`
	TurnLifecycle      *WorkspaceAgentTurnLifecycle      `json:"turnLifecycle,omitempty"`
	SubmitAvailability *WorkspaceAgentSubmitAvailability `json:"submitAvailability,omitempty"`
	LifecycleStatus    string                            `json:"lifecycleStatus"`
	TurnPhase          string                            `json:"turnPhase"`
	StartedAtUnixMS    int64                             `json:"startedAtUnixMs"`
	EndedAtUnixMS      int64                             `json:"endedAtUnixMs"`
	CreatedAtUnixMS    int64                             `json:"createdAtUnixMs"`
	UpdatedAtUnixMS    int64                             `json:"updatedAtUnixMs"`
	EffectiveStatus    string                            `json:"effectiveStatus"`
	Title              string                            `json:"title,omitempty"`
	SyncState          *WorkspaceAgentSyncState          `json:"syncState,omitempty"`
}

func (s ProviderActivitySessionProjection) MarshalJSON() ([]byte, error) {
	type output struct {
		ID                 uint64                            `json:"id"`
		AgentSessionID     string                            `json:"agentSessionId"`
		AgentTargetID      string                            `json:"agentTargetId,omitempty"`
		DeviceID           string                            `json:"deviceId,omitempty"`
		PresenceID         uint64                            `json:"presenceId"`
		UserID             string                            `json:"userId"`
		Provider           string                            `json:"provider"`
		ProviderSessionID  string                            `json:"providerSessionId"`
		SessionOrigin      string                            `json:"sessionOrigin,omitempty"`
		CWD                string                            `json:"cwd"`
		Status             string                            `json:"status"`
		TurnLifecycle      *WorkspaceAgentTurnLifecycle      `json:"turnLifecycle,omitempty"`
		SubmitAvailability *WorkspaceAgentSubmitAvailability `json:"submitAvailability,omitempty"`
		LifecycleStatus    string                            `json:"lifecycleStatus,omitempty"`
		TurnPhase          string                            `json:"turnPhase,omitempty"`
		EffectiveStatus    string                            `json:"effectiveStatus,omitempty"`
		StartedAtUnixMS    int64                             `json:"startedAtUnixMs"`
		EndedAtUnixMS      int64                             `json:"endedAtUnixMs"`
		CreatedAtUnixMS    int64                             `json:"createdAtUnixMs"`
		UpdatedAtUnixMS    int64                             `json:"updatedAtUnixMs"`
		Title              string                            `json:"title,omitempty"`
		SyncState          *WorkspaceAgentSyncState          `json:"syncState,omitempty"`
	}
	return json.Marshal(output{
		ID:                 s.ID,
		AgentSessionID:     s.AgentSessionID,
		AgentTargetID:      s.AgentTargetID,
		DeviceID:           s.DeviceID,
		PresenceID:         s.PresenceID,
		UserID:             s.UserID,
		Provider:           s.Provider,
		ProviderSessionID:  s.ProviderSessionID,
		SessionOrigin:      s.SessionOrigin,
		CWD:                s.CWD,
		Status:             s.Status,
		TurnLifecycle:      s.TurnLifecycle,
		SubmitAvailability: s.SubmitAvailability,
		LifecycleStatus:    s.LifecycleStatus,
		TurnPhase:          s.TurnPhase,
		EffectiveStatus:    s.EffectiveStatus,
		StartedAtUnixMS:    s.StartedAtUnixMS,
		EndedAtUnixMS:      s.EndedAtUnixMS,
		CreatedAtUnixMS:    s.CreatedAtUnixMS,
		UpdatedAtUnixMS:    s.UpdatedAtUnixMS,
		Title:              s.Title,
		SyncState:          cloneSyncState(s.SyncState),
	})
}

type WorkspaceAgentSyncState struct {
	AgentSessionID            string `json:"agentSessionId,omitempty"`
	Status                    string `json:"status"`
	PendingTimelineItemCount  int    `json:"pendingTimelineItemCount,omitempty"`
	PendingStatePatchCount    int    `json:"pendingStatePatchCount,omitempty"`
	PendingMessageUpdateCount int    `json:"pendingMessageUpdateCount,omitempty"`
	AttemptCount              int    `json:"attemptCount,omitempty"`
	FailedReportCount         int    `json:"failedReportCount,omitempty"`
	LastError                 string `json:"lastError,omitempty"`
	LastAttemptAtUnixMS       int64  `json:"lastAttemptAtUnixMs,omitempty"`
	LastSyncedAtUnixMS        int64  `json:"lastSyncedAtUnixMs,omitempty"`
	UpdatedAtUnixMS           int64  `json:"updatedAtUnixMs,omitempty"`
}

type WorkspaceAgentTimelineItem struct {
	ID               uint64         `json:"id"`
	RoomID           string         `json:"roomId"`
	AgentSessionID   string         `json:"agentSessionId"`
	TurnID           string         `json:"turnId,omitempty"`
	EventSource      string         `json:"eventSource"`
	EventID          string         `json:"eventId"`
	ActorType        string         `json:"actorType"`
	ActorID          string         `json:"actorId"`
	ItemType         string         `json:"itemType"`
	Role             string         `json:"role,omitempty"`
	CallType         string         `json:"callType,omitempty"`
	CallID           string         `json:"callId,omitempty"`
	Name             string         `json:"name,omitempty"`
	Status           string         `json:"status,omitempty"`
	Payload          map[string]any `json:"payload,omitempty"`
	OccurredAtUnixMS int64          `json:"occurredAtUnixMs"`
	CreatedAtUnixMS  int64          `json:"createdAtUnixMs"`
}

func (p *WorkspaceAgentPresence) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID                  flexibleUint64 `json:"id"`
		RoomID              string         `json:"roomId"`
		WorkspaceID         string         `json:"workspaceId"`
		UserID              string         `json:"userId"`
		Provider            string         `json:"provider"`
		Status              string         `json:"status"`
		LastHeartbeatUnixMS flexibleInt64  `json:"lastHeartbeatUnixMs"`
		LeaseExpiresUnixMS  flexibleInt64  `json:"leaseExpiresUnixMs"`
		CreatedAtUnixMS     flexibleInt64  `json:"createdAtUnixMs"`
		UpdatedAtUnixMS     flexibleInt64  `json:"updatedAtUnixMs"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*p = WorkspaceAgentPresence{
		ID:                  uint64(raw.ID),
		WorkspaceID:         firstNonEmptyString(raw.RoomID, raw.WorkspaceID),
		UserID:              raw.UserID,
		Provider:            raw.Provider,
		Status:              raw.Status,
		LastHeartbeatUnixMS: int64(raw.LastHeartbeatUnixMS),
		LeaseExpiresUnixMS:  int64(raw.LeaseExpiresUnixMS),
		CreatedAtUnixMS:     int64(raw.CreatedAtUnixMS),
		UpdatedAtUnixMS:     int64(raw.UpdatedAtUnixMS),
	}
	return nil
}

func (s *ProviderActivitySessionProjection) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID                     flexibleUint64           `json:"id"`
		AgentSessionID         string                   `json:"agentSessionId"`
		AgentSessionIDSnake    string                   `json:"agent_session_id"`
		AgentTargetID          string                   `json:"agentTargetId"`
		AgentTargetIDSnake     string                   `json:"agent_target_id"`
		DeviceID               string                   `json:"deviceId"`
		DeviceIDSnake          string                   `json:"device_id"`
		AgentID                string                   `json:"agentId"`
		AgentIDSnake           string                   `json:"agent_id"`
		PresenceID             flexibleUint64           `json:"presenceId"`
		PresenceIDSnake        flexibleUint64           `json:"presence_id"`
		UserID                 string                   `json:"userId"`
		UserIDSnake            string                   `json:"user_id"`
		Provider               string                   `json:"provider"`
		ProviderSessionID      string                   `json:"providerSessionId"`
		ProviderSessionIDSnake string                   `json:"provider_session_id"`
		SessionOrigin          string                   `json:"sessionOrigin"`
		SessionOriginSnake     string                   `json:"session_origin"`
		CWD                    string                   `json:"cwd"`
		LifecycleStatus        string                   `json:"lifecycleStatus"`
		LifecycleStatusSnake   string                   `json:"lifecycle_status"`
		TurnPhase              string                   `json:"turnPhase"`
		TurnPhaseSnake         string                   `json:"turn_phase"`
		StartedAtUnixMS        flexibleInt64            `json:"startedAtUnixMs"`
		StartedAtUnixMSSnake   flexibleInt64            `json:"started_at_unix_ms"`
		EndedAtUnixMS          flexibleInt64            `json:"endedAtUnixMs"`
		EndedAtUnixMSSnake     flexibleInt64            `json:"ended_at_unix_ms"`
		CreatedAtUnixMS        flexibleInt64            `json:"createdAtUnixMs"`
		CreatedAtUnixMSSnake   flexibleInt64            `json:"created_at_unix_ms"`
		UpdatedAtUnixMS        flexibleInt64            `json:"updatedAtUnixMs"`
		UpdatedAtUnixMSSnake   flexibleInt64            `json:"updated_at_unix_ms"`
		EffectiveStatus        string                   `json:"effectiveStatus"`
		EffectiveStatusSnake   string                   `json:"effective_status"`
		Status                 string                   `json:"status"`
		Title                  string                   `json:"title,omitempty"`
		SyncState              *WorkspaceAgentSyncState `json:"syncState,omitempty"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*s = ProviderActivitySessionProjection{
		ID: uint64(raw.ID),
		AgentSessionID: firstNonEmptyString(
			raw.AgentSessionID,
			raw.AgentSessionIDSnake,
			raw.AgentID,
			raw.AgentIDSnake,
		),
		AgentTargetID: firstNonEmptyString(raw.AgentTargetID, raw.AgentTargetIDSnake),
		DeviceID:      firstNonEmptyString(raw.DeviceID, raw.DeviceIDSnake),
		PresenceID:    uint64(firstNonZeroFlexibleUint64(raw.PresenceID, raw.PresenceIDSnake)),
		UserID:        firstNonEmptyString(raw.UserID, raw.UserIDSnake),
		Provider:      raw.Provider,
		ProviderSessionID: firstNonEmptyString(
			raw.ProviderSessionID,
			raw.ProviderSessionIDSnake,
		),
		SessionOrigin: firstNonEmptyString(raw.SessionOrigin, raw.SessionOriginSnake),
		CWD:           raw.CWD,
		LifecycleStatus: firstNonEmptyString(
			raw.LifecycleStatus,
			raw.LifecycleStatusSnake,
		),
		TurnPhase: firstNonEmptyString(
			raw.TurnPhase,
			raw.TurnPhaseSnake,
		),
		StartedAtUnixMS: int64(firstNonZeroFlexibleInt64(raw.StartedAtUnixMS, raw.StartedAtUnixMSSnake)),
		EndedAtUnixMS:   int64(firstNonZeroFlexibleInt64(raw.EndedAtUnixMS, raw.EndedAtUnixMSSnake)),
		CreatedAtUnixMS: int64(firstNonZeroFlexibleInt64(raw.CreatedAtUnixMS, raw.CreatedAtUnixMSSnake)),
		UpdatedAtUnixMS: int64(firstNonZeroFlexibleInt64(raw.UpdatedAtUnixMS, raw.UpdatedAtUnixMSSnake)),
		EffectiveStatus: firstNonEmptyString(raw.EffectiveStatus, raw.EffectiveStatusSnake, raw.Status),
		Status:          raw.Status,
		Title:           raw.Title,
		SyncState:       cloneSyncState(raw.SyncState),
	}
	return nil
}
