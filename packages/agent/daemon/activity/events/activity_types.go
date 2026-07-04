package events

import "strings"

type Provider string

const (
	ProviderCodex      Provider = "codex"
	ProviderNexight    Provider = "nexight"
	ProviderClaudeCode Provider = "claude-code"
	ProviderGemini     Provider = "gemini"
	ProviderOpenClaw   Provider = "openclaw"
	ProviderHermes     Provider = "hermes"
)

type EventType string

const (
	EventPresenceHeartbeat EventType = "presence.heartbeat"
	EventSessionStarted    EventType = "session.started"
	EventSessionUpdated    EventType = "session.updated"
	EventSessionCompleted  EventType = "session.completed"
	EventSessionFailed     EventType = "session.failed"
	EventTurnStarted       EventType = "turn.started"
	EventTurnUpdated       EventType = "turn.updated"
	EventTurnCompleted     EventType = "turn.completed"
	EventTurnFailed        EventType = "turn.failed"
	EventMessageAppended   EventType = "message.appended"
	EventMessageCreated    EventType = "message.created"
	EventActivityStarted   EventType = "activity.started"
	EventActivityUpdated   EventType = "activity.updated"
	EventActivityCompleted EventType = "activity.completed"
	EventActivityFailed    EventType = "activity.failed"
	EventCallStarted       EventType = "call.started"
	EventCallCompleted     EventType = "call.completed"
	EventCallFailed        EventType = "call.failed"
)

type PresenceStatus string

const (
	PresenceStatusWorking PresenceStatus = "working"
	PresenceStatusPaused  PresenceStatus = "paused"
)

type SessionStatus string

const (
	SessionStatusWorking   SessionStatus = "working"
	SessionStatusIdle      SessionStatus = "idle"
	SessionStatusWaiting   SessionStatus = "waiting"
	SessionStatusPaused    SessionStatus = "paused"
	SessionStatusCompleted SessionStatus = "completed"
	SessionStatusFailed    SessionStatus = "failed"
	SessionStatusCanceled  SessionStatus = "canceled"
)

type SessionLifecycleStatus string

const (
	SessionLifecycleStatusActive SessionLifecycleStatus = "active"
	SessionLifecycleStatusEnded  SessionLifecycleStatus = "ended"
	SessionLifecycleStatusFailed SessionLifecycleStatus = "failed"
)

type TurnPhase string

const (
	TurnPhaseIdle            TurnPhase = "idle"
	TurnPhaseSubmitted       TurnPhase = "submitted"
	TurnPhaseWorking         TurnPhase = "working"
	TurnPhaseRunning         TurnPhase = "running"
	TurnPhaseWaitingApproval TurnPhase = "waiting_approval"
	TurnPhaseWaitingInput    TurnPhase = "waiting_input"
	TurnPhaseWaiting         TurnPhase = "waiting"
	TurnPhaseSettled         TurnPhase = "settled"
	TurnPhaseFailed          TurnPhase = "failed"
)

type TurnOutcome string

const (
	TurnOutcomeCompleted   TurnOutcome = "completed"
	TurnOutcomeInterrupted TurnOutcome = "interrupted"
	TurnOutcomeFailed      TurnOutcome = "failed"
)

type MessageRole string

const (
	MessageRoleUser              MessageRole = "user"
	MessageRoleAssistant         MessageRole = "assistant"
	MessageRoleAssistantThinking MessageRole = "assistant_thinking"
)

type ActivityStatus string

const (
	ActivityStatusRunning   ActivityStatus = "running"
	ActivityStatusCompleted ActivityStatus = "completed"
	ActivityStatusFailed    ActivityStatus = "failed"
)

type Event struct {
	EventID           string
	Type              EventType
	Provider          Provider
	ProviderSessionID string
	AgentSessionID    string
	OwnerThreadID     string
	OwnerCallID       string
	OccurredAtUnixMS  int64
	Payload           EventPayload
}

type EventPayload struct {
	PresenceStatus  string
	LifecycleStatus string
	EffectiveStatus string
	TurnID          string
	TurnPhase       string
	TurnOutcome     string
	ActivityStatus  string
	CWD             string
	Role            MessageRole
	Content         string
	CallID          string
	CallType        string
	Name            string
	Status          string
	Input           map[string]any
	Output          map[string]any
	Error           map[string]any
	EventKey        string
	ActivityKey     string
	Metadata        map[string]any
	LeaseTTLSeconds int
	Title           string
}

type EventContext struct {
	EventID           string
	Provider          Provider
	ProviderSessionID string
	AgentSessionID    string
	OwnerThreadID     string
	OwnerCallID       string
	TurnID            string
	CWD               string
	Title             string
	OccurredAtUnixMS  int64
}

func NormalizeProvider(value string) (Provider, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case string(ProviderCodex):
		return ProviderCodex, true
	case string(ProviderNexight):
		return ProviderNexight, true
	case string(ProviderGemini), "gemini-cli", "gemini_cli":
		return ProviderGemini, true
	case "claude", string(ProviderClaudeCode), "claude_code":
		return ProviderClaudeCode, true
	case string(ProviderOpenClaw), "open_claw":
		return ProviderOpenClaw, true
	case string(ProviderHermes), "hermes-agent", "hermes_agent":
		return ProviderHermes, true
	default:
		return "", false
	}
}

func NewPresenceHeartbeat(ctx EventContext, status PresenceStatus, leaseTTLSeconds int) Event {
	return eventFromContext(ctx, EventPresenceHeartbeat, EventPayload{
		PresenceStatus:  string(status),
		LeaseTTLSeconds: leaseTTLSeconds,
	})
}

func NewSessionStarted(ctx EventContext) Event {
	event := eventFromContext(ctx, EventSessionStarted, EventPayload{
		LifecycleStatus: string(SessionLifecycleStatusActive),
		EffectiveStatus: string(SessionStatusIdle),
		CWD:             strings.TrimSpace(ctx.CWD),
		Title:           strings.TrimSpace(ctx.Title),
	})
	event.Payload.TurnID = ""
	return event
}

func NewSessionUpdated(ctx EventContext, status SessionStatus) Event {
	event := eventFromContext(ctx, EventSessionUpdated, EventPayload{
		EffectiveStatus: string(status),
		CWD:             strings.TrimSpace(ctx.CWD),
	})
	event.Payload.TurnID = ""
	return event
}

func NewSessionTitleUpdated(ctx EventContext) Event {
	return eventFromContext(ctx, EventSessionUpdated, EventPayload{
		Title: strings.TrimSpace(ctx.Title),
	})
}

func NewSessionCompleted(ctx EventContext) Event {
	event := eventFromContext(ctx, EventSessionCompleted, EventPayload{
		LifecycleStatus: string(SessionLifecycleStatusEnded),
		EffectiveStatus: string(SessionStatusCompleted),
		CWD:             strings.TrimSpace(ctx.CWD),
	})
	event.Payload.TurnID = ""
	return event
}

func NewSessionFailed(ctx EventContext) Event {
	event := eventFromContext(ctx, EventSessionFailed, EventPayload{
		LifecycleStatus: string(SessionLifecycleStatusFailed),
		EffectiveStatus: string(SessionStatusFailed),
		CWD:             strings.TrimSpace(ctx.CWD),
	})
	event.Payload.TurnID = ""
	return event
}

func NewTurnStarted(ctx EventContext, turnID string) Event {
	return eventFromContext(ctx, EventTurnStarted, EventPayload{
		TurnID:    strings.TrimSpace(turnID),
		TurnPhase: string(TurnPhaseWorking),
		CWD:       strings.TrimSpace(ctx.CWD),
	})
}

func NewTurnUpdated(ctx EventContext, turnID string, phase TurnPhase) Event {
	return eventFromContext(ctx, EventTurnUpdated, EventPayload{
		TurnID:    strings.TrimSpace(turnID),
		TurnPhase: string(phase),
		CWD:       strings.TrimSpace(ctx.CWD),
	})
}

func NewTurnCompleted(ctx EventContext, turnID string, outcome TurnOutcome) Event {
	return eventFromContext(ctx, EventTurnCompleted, EventPayload{
		TurnID:      strings.TrimSpace(turnID),
		TurnPhase:   string(TurnPhaseIdle),
		TurnOutcome: string(outcome),
		CWD:         strings.TrimSpace(ctx.CWD),
	})
}

func NewTurnFailed(ctx EventContext, turnID string) Event {
	return eventFromContext(ctx, EventTurnFailed, EventPayload{
		TurnID:      strings.TrimSpace(turnID),
		TurnPhase:   string(TurnPhaseFailed),
		TurnOutcome: string(TurnOutcomeFailed),
		CWD:         strings.TrimSpace(ctx.CWD),
	})
}

func NewMessageAppended(ctx EventContext, role MessageRole, content string) Event {
	return eventFromContext(ctx, EventMessageAppended, EventPayload{
		Role:    role,
		Content: content,
	})
}

func NewContextMessage(ctx EventContext, role MessageRole, content string) Event {
	return eventFromContext(ctx, EventMessageCreated, EventPayload{
		Role:    role,
		Content: content,
	})
}

func NewCallStarted(ctx EventContext, callID, callType, name string, input map[string]any) Event {
	return eventFromContext(ctx, EventCallStarted, EventPayload{
		CallID:   strings.TrimSpace(callID),
		CallType: strings.TrimSpace(callType),
		Name:     strings.TrimSpace(name),
		Status:   string(ActivityStatusRunning),
		Input:    cloneMetadata(input),
	})
}

func NewCallCompleted(ctx EventContext, callID, callType, name string, output map[string]any) Event {
	return eventFromContext(ctx, EventCallCompleted, EventPayload{
		CallID:   strings.TrimSpace(callID),
		CallType: strings.TrimSpace(callType),
		Name:     strings.TrimSpace(name),
		Status:   string(ActivityStatusCompleted),
		Output:   cloneMetadata(output),
	})
}

func NewCallFailed(ctx EventContext, callID, callType, name string, errPayload map[string]any) Event {
	return eventFromContext(ctx, EventCallFailed, EventPayload{
		CallID:   strings.TrimSpace(callID),
		CallType: strings.TrimSpace(callType),
		Name:     strings.TrimSpace(name),
		Status:   string(ActivityStatusFailed),
		Error:    cloneMetadata(errPayload),
	})
}

func NewActivityStarted(ctx EventContext, activityKey string, metadata map[string]any) Event {
	return eventFromContext(ctx, EventActivityStarted, EventPayload{
		EventKey:    string(EventActivityStarted),
		ActivityKey: strings.TrimSpace(activityKey),
		Metadata:    cloneMetadata(metadata),
	})
}

func NewActivityUpdated(ctx EventContext, activityKey string, metadata map[string]any) Event {
	return eventFromContext(ctx, EventActivityUpdated, EventPayload{
		EventKey:    string(EventActivityUpdated),
		ActivityKey: strings.TrimSpace(activityKey),
		Metadata:    cloneMetadata(metadata),
	})
}

func NewActivityCompleted(ctx EventContext, activityKey string, metadata map[string]any) Event {
	return eventFromContext(ctx, EventActivityCompleted, EventPayload{
		EventKey:       string(EventActivityCompleted),
		ActivityKey:    strings.TrimSpace(activityKey),
		ActivityStatus: string(ActivityStatusCompleted),
		Metadata:       cloneMetadata(metadata),
	})
}

func NewActivityFailed(ctx EventContext, activityKey string, metadata map[string]any) Event {
	return eventFromContext(ctx, EventActivityFailed, EventPayload{
		EventKey:       string(EventActivityFailed),
		ActivityKey:    strings.TrimSpace(activityKey),
		ActivityStatus: string(ActivityStatusFailed),
		Metadata:       cloneMetadata(metadata),
	})
}

func eventFromContext(ctx EventContext, eventType EventType, payload EventPayload) Event {
	if payload.TurnID == "" {
		payload.TurnID = strings.TrimSpace(ctx.TurnID)
	}
	if payload.CWD == "" {
		payload.CWD = strings.TrimSpace(ctx.CWD)
	}
	return Event{
		EventID:           strings.TrimSpace(ctx.EventID),
		Type:              eventType,
		Provider:          ctx.Provider,
		ProviderSessionID: strings.TrimSpace(ctx.ProviderSessionID),
		AgentSessionID:    strings.TrimSpace(ctx.AgentSessionID),
		OwnerThreadID:     strings.TrimSpace(ctx.OwnerThreadID),
		OwnerCallID:       strings.TrimSpace(ctx.OwnerCallID),
		OccurredAtUnixMS:  ctx.OccurredAtUnixMS,
		Payload:           payload,
	}
}

func cloneMetadata(metadata map[string]any) map[string]any {
	if len(metadata) == 0 {
		return nil
	}
	out := make(map[string]any, len(metadata))
	for key, value := range metadata {
		out[key] = value
	}
	return out
}

func BestEffortErrorMessage(payload EventPayload) string {
	if msg := errorMessageFromValue(payload.Metadata["error"]); msg != "" {
		return msg
	}
	if payload.Metadata != nil {
		if msg := firstNonEmptyErrorString(
			payload.Metadata["lastError"],
			payload.Metadata["errorMessage"],
			payload.Metadata["debugMessage"],
			payload.Metadata["message"],
		); msg != "" {
			return msg
		}
	}
	if msg := errorMessageFromMap(payload.Error); msg != "" {
		return msg
	}
	return ""
}

func firstNonEmptyErrorString(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func errorMessageFromValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		return errorMessageFromMap(typed)
	default:
		return ""
	}
}

func errorMessageFromMap(value map[string]any) string {
	if len(value) == 0 {
		return ""
	}
	return firstNonEmptyErrorString(
		value["error"],
		value["message"],
		value["detail"],
		value["debugMessage"],
		value["lastError"],
	)
}
