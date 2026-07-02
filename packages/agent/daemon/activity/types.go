package agentsessionstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
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
	WorkspaceID    string
	Connector      *ConnectorInfo
	Source         EventSource
	TimelineItems  []WorkspaceAgentTimelineItem
	StatePatches   []WorkspaceAgentStatePatch
	MessageUpdates []WorkspaceAgentMessageUpdate
}

type ReportActivityReply struct {
	AcceptedTimelineItemCount  int `json:"acceptedTimelineItemCount"`
	AcceptedStatePatchCount    int `json:"acceptedStatePatchCount"`
	AcceptedMessageUpdateCount int `json:"acceptedMessageUpdateCount"`
	RequestBodyBytes           int `json:"-"`
}

type ReportSessionStateInput struct {
	WorkspaceID    string
	AgentSessionID string
	SessionOrigin  string
	Connector      *ConnectorInfo
	Source         EventSource
	State          WorkspaceAgentSessionStateUpdate
}

type ReportSessionStateReply struct {
	Accepted          bool  `json:"accepted"`
	StateApplied      bool  `json:"stateApplied"`
	LastEventAtUnixMS int64 `json:"lastEventAtUnixMs"`
	RequestBodyBytes  int   `json:"-"`
}

func (r *ReportSessionStateReply) UnmarshalJSON(data []byte) error {
	var raw struct {
		Accepted                 bool          `json:"accepted"`
		StateApplied             *bool         `json:"stateApplied"`
		StateAppliedSnake        *bool         `json:"state_applied"`
		LastEventAtUnixMS        flexibleInt64 `json:"lastEventAtUnixMs"`
		LastEventAtUnixMSSnake   flexibleInt64 `json:"last_event_at_unix_ms"`
		RequestBodyBytesIgnored  int           `json:"requestBodyBytes"`
		RequestBodyBytesIgnored2 int           `json:"request_body_bytes"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	stateApplied := raw.Accepted
	if raw.StateApplied != nil {
		stateApplied = *raw.StateApplied
	} else if raw.StateAppliedSnake != nil {
		stateApplied = *raw.StateAppliedSnake
	}
	*r = ReportSessionStateReply{
		Accepted:          raw.Accepted,
		StateApplied:      stateApplied,
		LastEventAtUnixMS: int64(firstNonZeroFlexibleInt64(raw.LastEventAtUnixMS, raw.LastEventAtUnixMSSnake)),
	}
	return nil
}

type WorkspaceAgentSessionStateUpdate struct {
	AgentTargetID      string                            `json:"agentTargetId,omitempty"`
	Provider           string                            `json:"provider,omitempty"`
	ProviderSessionID  string                            `json:"providerSessionId,omitempty"`
	Model              string                            `json:"model,omitempty"`
	Settings           map[string]any                    `json:"settings,omitempty"`
	RuntimeContext     map[string]any                    `json:"runtimeContext,omitempty"`
	TurnLifecycle      *WorkspaceAgentTurnLifecycle      `json:"turnLifecycle,omitempty"`
	SubmitAvailability *WorkspaceAgentSubmitAvailability `json:"submitAvailability,omitempty"`
	PendingInteractive *WorkspaceAgentInteractivePrompt  `json:"pendingInteractive,omitempty"`
	CWD                string                            `json:"cwd,omitempty"`
	Title              string                            `json:"title,omitempty"`
	LifecycleStatus    string                            `json:"lifecycleStatus,omitempty"`
	CurrentPhase       string                            `json:"currentPhase,omitempty"`
	LastError          string                            `json:"lastError,omitempty"`
	OccurredAtUnixMS   int64                             `json:"occurredAtUnixMs,omitempty"`
	StartedAtUnixMS    int64                             `json:"startedAtUnixMs,omitempty"`
	EndedAtUnixMS      int64                             `json:"endedAtUnixMs,omitempty"`
	Turn               *WorkspaceAgentTurnStateUpdate    `json:"turn,omitempty"`
}

type WorkspaceAgentTurnStateUpdate struct {
	TurnID             string                            `json:"turnId"`
	ActiveTurnID       *string                           `json:"activeTurnId,omitempty"`
	Phase              string                            `json:"phase,omitempty"`
	Outcome            string                            `json:"outcome,omitempty"`
	Settling           bool                              `json:"settling,omitempty"`
	CompletedCommand   *WorkspaceAgentCompletedCommand   `json:"completedCommand,omitempty"`
	SubmitAvailability *WorkspaceAgentSubmitAvailability `json:"submitAvailability,omitempty"`
	FileChanges        map[string]any                    `json:"fileChanges,omitempty"`
	StartedAtUnixMS    int64                             `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS  int64                             `json:"completedAtUnixMs,omitempty"`
}

type WorkspaceAgentCompletedCommand struct {
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

type WorkspaceAgentSubmitAvailability struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type WorkspaceAgentTurnLifecycle struct {
	ActiveTurnID     *string                         `json:"activeTurnId"`
	Phase            string                          `json:"phase"`
	Settling         bool                            `json:"settling,omitempty"`
	Outcome          *string                         `json:"outcome,omitempty"`
	CompletedCommand *WorkspaceAgentCompletedCommand `json:"completedCommand,omitempty"`
}

type WorkspaceAgentInteractivePrompt struct {
	Kind      string         `json:"kind"`
	RequestID string         `json:"requestId,omitempty"`
	ToolName  string         `json:"toolName,omitempty"`
	Status    string         `json:"status,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Output    map[string]any `json:"output,omitempty"`
	Error     map[string]any `json:"error,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type ReportSessionMessagesInput struct {
	WorkspaceID    string
	AgentSessionID string
	SessionOrigin  string
	Connector      *ConnectorInfo
	Source         EventSource
	Updates        []WorkspaceAgentSessionMessageUpdate
}

type ReportSessionMessagesReply struct {
	AcceptedCount    int    `json:"acceptedCount"`
	LatestVersion    uint64 `json:"latestVersion"`
	RequestBodyBytes int    `json:"-"`
}

func (r *ReportSessionMessagesReply) UnmarshalJSON(data []byte) error {
	var raw struct {
		AcceptedCount           int            `json:"acceptedCount"`
		AcceptedCountSnake      int            `json:"accepted_count"`
		LatestVersion           flexibleUint64 `json:"latestVersion"`
		LatestVersionSnake      flexibleUint64 `json:"latest_version"`
		RequestBodyBytesIgnored int            `json:"requestBodyBytes"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*r = ReportSessionMessagesReply{
		AcceptedCount: firstNonZeroInt(raw.AcceptedCount, raw.AcceptedCountSnake),
		LatestVersion: uint64(firstNonZeroFlexibleUint64(
			raw.LatestVersion,
			raw.LatestVersionSnake,
		)),
	}
	return nil
}

type WorkspaceAgentSessionMessageUpdate struct {
	MessageID         string                          `json:"messageId"`
	TurnID            string                          `json:"turnId,omitempty"`
	Role              string                          `json:"role"`
	Kind              string                          `json:"kind"`
	Status            string                          `json:"status,omitempty"`
	Semantics         *WorkspaceAgentMessageSemantics `json:"semantics,omitempty"`
	ContentDelta      string                          `json:"contentDelta,omitempty"`
	Payload           map[string]any                  `json:"payload,omitempty"`
	OccurredAtUnixMS  int64                           `json:"occurredAtUnixMs,omitempty"`
	StartedAtUnixMS   int64                           `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS int64                           `json:"completedAtUnixMs,omitempty"`
}

type ListSessionMessagesInput struct {
	WorkspaceID    string
	AgentSessionID string
	AfterVersion   uint64
	Limit          int
	SessionOrigin  string
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
		ID:             uint64(raw.ID),
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

type ConnectorInfo struct {
	ID      string `json:"id,omitempty"`
	Version string `json:"version,omitempty"`
}

type EventSource struct {
	Provider          string `json:"provider,omitempty"`
	ProviderSessionID string `json:"providerSessionId,omitempty"`
	AgentID           string `json:"agentId,omitempty"`
	AgentTargetID     string `json:"agentTargetId,omitempty"`
	CWD               string `json:"cwd,omitempty"`
	SessionOrigin     string `json:"sessionOrigin,omitempty"`
	UserID            string `json:"-"`
}

type WorkspaceAgentStatePatch struct {
	AgentSessionID            string                            `json:"agentSessionId"`
	AgentTargetID             string                            `json:"agentTargetId,omitempty"`
	Provider                  string                            `json:"provider,omitempty"`
	ProviderSessionID         string                            `json:"providerSessionId,omitempty"`
	Model                     string                            `json:"model,omitempty"`
	PermissionModeID          string                            `json:"permissionModeId,omitempty"`
	Settings                  map[string]any                    `json:"settings,omitempty"`
	RuntimeContext            map[string]any                    `json:"runtimeContext,omitempty"`
	TurnLifecycle             *WorkspaceAgentTurnLifecycle      `json:"turnLifecycle,omitempty"`
	SubmitAvailability        *WorkspaceAgentSubmitAvailability `json:"submitAvailability,omitempty"`
	PendingInteractive        *WorkspaceAgentInteractivePrompt  `json:"pendingInteractive,omitempty"`
	PendingInteractivePresent bool                              `json:"-"`
	CWD                       string                            `json:"cwd,omitempty"`
	Title                     string                            `json:"title,omitempty"`
	LifecycleStatus           string                            `json:"lifecycleStatus,omitempty"`
	CurrentPhase              string                            `json:"currentPhase,omitempty"`
	LastError                 string                            `json:"lastError,omitempty"`
	OccurredAtUnixMS          int64                             `json:"occurredAtUnixMs,omitempty"`
	Turn                      *WorkspaceAgentTurnPatch          `json:"turn,omitempty"`
	Entities                  []WorkspaceAgentEntityPatch       `json:"entities,omitempty"`
}

func (p WorkspaceAgentStatePatch) MarshalJSON() ([]byte, error) {
	type alias WorkspaceAgentStatePatch
	data, err := json.Marshal(alias(p))
	if err != nil || !p.PendingInteractivePresent {
		return data, err
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, err
	}
	if p.PendingInteractive == nil {
		object["pendingInteractive"] = nil
	} else {
		object["pendingInteractive"] = p.PendingInteractive
	}
	return json.Marshal(object)
}

type WorkspaceAgentTurnPatch struct {
	TurnID             string                            `json:"turnId"`
	ActiveTurnID       *string                           `json:"activeTurnId,omitempty"`
	Phase              string                            `json:"phase,omitempty"`
	Outcome            string                            `json:"outcome,omitempty"`
	Settling           bool                              `json:"settling,omitempty"`
	CompletedCommand   *WorkspaceAgentCompletedCommand   `json:"completedCommand,omitempty"`
	SubmitAvailability *WorkspaceAgentSubmitAvailability `json:"submitAvailability,omitempty"`
	FileChanges        map[string]any                    `json:"fileChanges,omitempty"`
	StartedAtUnixMS    int64                             `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS  int64                             `json:"completedAtUnixMs,omitempty"`
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

type WorkspaceAgentMessageSemantics struct {
	UserVisibleAssistantResponse bool   `json:"userVisibleAssistantResponse,omitempty"`
	TurnSettling                 bool   `json:"turnSettling,omitempty"`
	NoticeCommand                string `json:"noticeCommand,omitempty"`
	NoticeCommandStatus          string `json:"noticeCommandStatus,omitempty"`
}

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
}

type WorkspaceAgentSnapshot struct {
	Presences           []WorkspaceAgentPresence                  `json:"presences"`
	Sessions            []WorkspaceAgentSession                   `json:"sessions"`
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

type WorkspaceAgentSession struct {
	ID                 uint64                            `json:"id"`
	AgentSessionID     string                            `json:"agentSessionId"`
	AgentTargetID      string                            `json:"agentTargetId,omitempty"`
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

func (s WorkspaceAgentSession) MarshalJSON() ([]byte, error) {
	type output struct {
		ID                 uint64                            `json:"id"`
		AgentSessionID     string                            `json:"agentSessionId"`
		AgentTargetID      string                            `json:"agentTargetId,omitempty"`
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

func (s *WorkspaceAgentSession) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID                     flexibleUint64           `json:"id"`
		AgentSessionID         string                   `json:"agentSessionId"`
		AgentSessionIDSnake    string                   `json:"agent_session_id"`
		AgentTargetID          string                   `json:"agentTargetId"`
		AgentTargetIDSnake     string                   `json:"agent_target_id"`
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
	*s = WorkspaceAgentSession{
		ID: uint64(raw.ID),
		AgentSessionID: firstNonEmptyString(
			raw.AgentSessionID,
			raw.AgentSessionIDSnake,
			raw.AgentID,
			raw.AgentIDSnake,
		),
		AgentTargetID: firstNonEmptyString(raw.AgentTargetID, raw.AgentTargetIDSnake),
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

func firstNonZeroFlexibleInt64(values ...flexibleInt64) flexibleInt64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonZeroFlexibleUint64(values ...flexibleUint64) flexibleUint64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func (i *WorkspaceAgentTimelineItem) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID               flexibleUint64 `json:"id"`
		RoomID           string         `json:"roomId"`
		AgentSessionID   string         `json:"agentSessionId"`
		TurnID           string         `json:"turnId"`
		EventSource      string         `json:"eventSource"`
		EventID          string         `json:"eventId"`
		ActorType        string         `json:"actorType"`
		ActorID          string         `json:"actorId"`
		ItemType         string         `json:"itemType"`
		Role             string         `json:"role"`
		CallType         string         `json:"callType"`
		CallID           string         `json:"callId"`
		Name             string         `json:"name"`
		Status           string         `json:"status"`
		Payload          map[string]any `json:"payload,omitempty"`
		OccurredAtUnixMS flexibleInt64  `json:"occurredAtUnixMs"`
		CreatedAtUnixMS  flexibleInt64  `json:"createdAtUnixMs"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*i = WorkspaceAgentTimelineItem{
		ID:               uint64(raw.ID),
		RoomID:           raw.RoomID,
		AgentSessionID:   raw.AgentSessionID,
		TurnID:           raw.TurnID,
		EventSource:      raw.EventSource,
		EventID:          raw.EventID,
		ActorType:        raw.ActorType,
		ActorID:          raw.ActorID,
		ItemType:         raw.ItemType,
		Role:             raw.Role,
		CallType:         raw.CallType,
		CallID:           raw.CallID,
		Name:             raw.Name,
		Status:           raw.Status,
		Payload:          raw.Payload,
		OccurredAtUnixMS: int64(raw.OccurredAtUnixMS),
		CreatedAtUnixMS:  int64(raw.CreatedAtUnixMS),
	}
	return nil
}

type HTTPError struct {
	StatusCode int
	Body       string
	Header     http.Header
}

func (e HTTPError) Error() string {
	if strings.TrimSpace(e.Body) == "" {
		return fmt.Sprintf("agent activity request failed (%d)", e.StatusCode)
	}
	return fmt.Sprintf("agent activity request failed (%d): %s", e.StatusCode, e.Body)
}

type requestBodySizedError struct {
	err              error
	requestBodyBytes int
}

func (e requestBodySizedError) Error() string {
	return e.err.Error()
}

func (e requestBodySizedError) Unwrap() error {
	return e.err
}

func (e requestBodySizedError) RequestBodyBytes() int {
	return e.requestBodyBytes
}

func WithRequestBodyBytes(err error, requestBodyBytes int) error {
	if err == nil || requestBodyBytes <= 0 {
		return err
	}
	var sized interface{ RequestBodyBytes() int }
	if errors.As(err, &sized) && sized.RequestBodyBytes() > 0 {
		return err
	}
	return requestBodySizedError{
		err:              err,
		requestBodyBytes: requestBodyBytes,
	}
}

func RequestBodyBytesFromError(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	var sized interface{ RequestBodyBytes() int }
	if !errors.As(err, &sized) {
		return 0, false
	}
	requestBodyBytes := sized.RequestBodyBytes()
	if requestBodyBytes <= 0 {
		return 0, false
	}
	return requestBodyBytes, true
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstNonZeroInt(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}
