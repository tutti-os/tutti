package canonical

import (
	"encoding/json"
	"strconv"
	"strings"
)

// The report types are pure canonical commit-observer contracts. HTTP client
// configuration and transport behavior remain in daemon/activity.
type ReportSessionStateInput struct {
	WorkspaceID    string
	AgentSessionID string
	AgentTargetID  string
	DeviceID       string
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
		Accepted               bool          `json:"accepted"`
		StateApplied           *bool         `json:"stateApplied"`
		StateAppliedSnake      *bool         `json:"state_applied"`
		LastEventAtUnixMS      flexibleInt64 `json:"lastEventAtUnixMs"`
		LastEventAtUnixMSSnake flexibleInt64 `json:"last_event_at_unix_ms"`
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
		Accepted: raw.Accepted, StateApplied: stateApplied,
		LastEventAtUnixMS: int64(firstNonZeroFlexibleInt64(raw.LastEventAtUnixMS, raw.LastEventAtUnixMSSnake)),
	}
	return nil
}

type WorkspaceAgentSessionStateUpdate struct {
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
	StartedAtUnixMS       int64                                     `json:"startedAtUnixMs,omitempty"`
	EndedAtUnixMS         int64                                     `json:"endedAtUnixMs,omitempty"`
	Turn                  *WorkspaceAgentTurnStateUpdate            `json:"turn,omitempty"`
	RootProviderTurn      *WorkspaceAgentRootProviderTurnTransition `json:"rootProviderTurn,omitempty"`
}

type WorkspaceAgentRootProviderTurnTransition struct {
	RootTurnID       string                          `json:"rootTurnId"`
	ProviderTurnID   string                          `json:"providerTurnId"`
	Phase            string                          `json:"phase"`
	Outcome          string                          `json:"outcome,omitempty"`
	CompletedCommand *WorkspaceAgentCompletedCommand `json:"completedCommand,omitempty"`
	ErrorMessage     string                          `json:"errorMessage,omitempty"`
	ErrorCode        string                          `json:"errorCode,omitempty"`
}

type WorkspaceAgentTurnStateUpdate struct {
	TurnID                  string                            `json:"turnId"`
	Origin                  string                            `json:"origin,omitempty"`
	SourceGoalOperationID   string                            `json:"sourceGoalOperationId,omitempty"`
	SourceGoalRevision      int64                             `json:"sourceGoalRevision,omitempty"`
	SourceGoalRepairEpoch   int64                             `json:"sourceGoalRepairEpoch,omitempty"`
	ActiveTurnID            *string                           `json:"activeTurnId,omitempty"`
	Phase                   string                            `json:"phase,omitempty"`
	Outcome                 string                            `json:"outcome,omitempty"`
	Settling                bool                              `json:"settling,omitempty"`
	CompletedCommand        *WorkspaceAgentCompletedCommand   `json:"completedCommand,omitempty"`
	SubmitAvailability      *WorkspaceAgentSubmitAvailability `json:"submitAvailability,omitempty"`
	FileChanges             map[string]any                    `json:"fileChanges,omitempty"`
	StartedAtUnixMS         int64                             `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS       int64                             `json:"completedAtUnixMs,omitempty"`
	FinalAssistantMessageID string                            `json:"finalAssistantMessageId,omitempty"`
	ParentTurnID            string                            `json:"parentTurnId,omitempty"`
	Relation                string                            `json:"relation,omitempty"`
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

type WorkspaceAgentInteractionTransition struct {
	RequestID string         `json:"requestId"`
	TurnID    string         `json:"turnId"`
	Kind      string         `json:"kind"`
	Status    string         `json:"status"`
	ToolName  string         `json:"toolName,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type ReportSessionMessagesInput struct {
	WorkspaceID    string
	AgentSessionID string
	AgentTargetID  string
	DeviceID       string
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
		AcceptedCount      int            `json:"acceptedCount"`
		AcceptedCountSnake int            `json:"accepted_count"`
		LatestVersion      flexibleUint64 `json:"latestVersion"`
		LatestVersionSnake flexibleUint64 `json:"latest_version"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*r = ReportSessionMessagesReply{
		AcceptedCount: firstNonZeroInt(raw.AcceptedCount, raw.AcceptedCountSnake),
		LatestVersion: uint64(firstNonZeroFlexibleUint64(raw.LatestVersion, raw.LatestVersionSnake)),
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

type WorkspaceAgentMessageSemantics struct {
	UserVisibleAssistantResponse bool   `json:"userVisibleAssistantResponse,omitempty"`
	TurnSettling                 bool   `json:"turnSettling,omitempty"`
	NoticeCommand                string `json:"noticeCommand,omitempty"`
	NoticeCommandStatus          string `json:"noticeCommandStatus,omitempty"`
}

type ConnectorInfo struct {
	ID      string `json:"id,omitempty"`
	Version string `json:"version,omitempty"`
}

type EventSource struct {
	Provider               string `json:"provider,omitempty"`
	ProviderSessionID      string `json:"providerSessionId,omitempty"`
	SessionCreatedAtUnixMS int64  `json:"sessionCreatedAtUnixMs,omitempty"`
	AgentID                string `json:"agentId,omitempty"`
	AgentTargetID          string `json:"agentTargetId,omitempty"`
	DeviceID               string `json:"deviceId,omitempty"`
	CWD                    string `json:"cwd,omitempty"`
	SessionOrigin          string `json:"sessionOrigin,omitempty"`
	UserID                 string `json:"-"`
}

type flexibleUint64 uint64
type flexibleInt64 int64

func (v *flexibleUint64) UnmarshalJSON(data []byte) error {
	parsed, err := parseFlexibleUint64(data)
	if err != nil {
		return err
	}
	*v = flexibleUint64(parsed)
	return nil
}

func (v *flexibleInt64) UnmarshalJSON(data []byte) error {
	parsed, err := parseFlexibleInt64(data)
	if err != nil {
		return err
	}
	*v = flexibleInt64(parsed)
	return nil
}

func parseFlexibleUint64(data []byte) (uint64, error) {
	text := strings.TrimSpace(string(data))
	if text == "" || text == "null" {
		return 0, nil
	}
	if strings.HasPrefix(text, `"`) {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return 0, err
		}
		text = strings.TrimSpace(value)
	}
	if text == "" {
		return 0, nil
	}
	return strconv.ParseUint(text, 10, 64)
}

func parseFlexibleInt64(data []byte) (int64, error) {
	text := strings.TrimSpace(string(data))
	if text == "" || text == "null" {
		return 0, nil
	}
	if strings.HasPrefix(text, `"`) {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return 0, err
		}
		text = strings.TrimSpace(value)
	}
	if text == "" {
		return 0, nil
	}
	return strconv.ParseInt(text, 10, 64)
}

func firstNonZeroFlexibleUint64(values ...flexibleUint64) flexibleUint64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonZeroFlexibleInt64(values ...flexibleInt64) flexibleInt64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonZeroInt(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}
