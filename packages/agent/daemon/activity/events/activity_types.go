package events

import (
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

type Provider string

const (
	ProviderCodex      Provider = providerregistry.CodexProviderID
	ProviderTuttiAgent Provider = "tutti-agent"
	ProviderCursor     Provider = "cursor"
	ProviderNexight    Provider = "nexight"
	ProviderClaudeCode Provider = providerregistry.ClaudeCodeProviderID
	ProviderOpenClaw   Provider = "openclaw"
	ProviderOpenCode   Provider = providerregistry.OpenCodeProviderID
)

type EventType string

const (
	EventPresenceHeartbeat         EventType = "presence.heartbeat"
	EventSessionStarted            EventType = "session.started"
	EventSessionUpdated            EventType = "session.updated"
	EventSessionCompleted          EventType = "session.completed"
	EventSessionFailed             EventType = "session.failed"
	EventSessionAudit              EventType = "session.audit"
	EventGoalReconcileRequired     EventType = "goal.reconcile_required"
	EventTurnStarted               EventType = "turn.started"
	EventTurnUpdated               EventType = "turn.updated"
	EventTurnCompleted             EventType = "turn.completed"
	EventTurnFailed                EventType = "turn.failed"
	EventTurnCanceled              EventType = "turn.canceled"
	EventRootProviderTurnStarted   EventType = "root_provider_turn.started"
	EventRootProviderTurnCompleted EventType = "root_provider_turn.completed"
	EventMessageAppended           EventType = "message.appended"
	EventMessageCreated            EventType = "message.created"
	EventActivityStarted           EventType = "activity.started"
	EventActivityUpdated           EventType = "activity.updated"
	EventActivityCompleted         EventType = "activity.completed"
	EventActivityFailed            EventType = "activity.failed"
	EventCallStarted               EventType = "call.started"
	EventCallCompleted             EventType = "call.completed"
	EventCallFailed                EventType = "call.failed"
	EventInteractionRequested      EventType = "interaction.requested"
	EventInteractionSuperseded     EventType = "interaction.superseded"
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
	TurnOutcomeCanceled    TurnOutcome = "canceled"
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
	EventID              string
	Type                 EventType
	Provider             Provider
	ProviderSessionID    string
	AgentSessionID       string
	SessionKind          string
	RootAgentSessionID   string
	RootTurnID           string
	ParentAgentSessionID string
	ParentTurnID         string
	ParentToolCallID     string
	OccurredAtUnixMS     int64
	Payload              EventPayload
}

// InteractionTransition is the provider-independent runtime statement for an
// actionable interaction. Runtime reporters may create pending interactions
// or supersede them; answered is owned exclusively by the durable response
// operation.
type InteractionTransition struct {
	RequestID string
	TurnID    string
	Kind      string
	Status    string
	ToolName  string
	Input     map[string]any
	Metadata  map[string]any
}

type EventPayload struct {
	PresenceStatus  string
	LifecycleStatus string
	EffectiveStatus string
	TurnID          string
	TurnPhase       string
	TurnOutcome     string
	ProviderTurnID  string
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
	Interaction     *InteractionTransition
}

type EventContext struct {
	EventID              string
	Provider             Provider
	ProviderSessionID    string
	AgentSessionID       string
	SessionKind          string
	RootAgentSessionID   string
	RootTurnID           string
	ParentAgentSessionID string
	ParentTurnID         string
	ParentToolCallID     string
	TurnID               string
	CWD                  string
	Title                string
	OccurredAtUnixMS     int64
}

func NormalizeProvider(value string) (Provider, bool) {
	if resolved, ok := providerregistry.ResolveEventProvider(value); ok {
		return Provider(resolved.ProviderID), true
	}
	// A registered alias excluded from the event projection must stay
	// excluded. Only genuinely external identities may use the open path.
	if _, registered := providerregistry.ResolveProviderID(value); registered {
		return "", false
	}
	if providerID, ok := providerregistry.NormalizeOpenProviderID(value); ok {
		return Provider(providerID), true
	}
	return "", false
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

// NewChildSessionStarted records the child session and its first submitted
// turn in one durable state transition. Provider aliases may be attached now
// or by later events, but the creator relationship is complete and immutable.
func NewChildSessionStarted(ctx EventContext, childTurnID string) Event {
	return eventFromContext(ctx, EventSessionStarted, EventPayload{
		LifecycleStatus: string(SessionLifecycleStatusActive),
		EffectiveStatus: string(SessionStatusWorking),
		TurnID:          strings.TrimSpace(childTurnID),
		TurnPhase:       string(TurnPhaseSubmitted),
		CWD:             strings.TrimSpace(ctx.CWD),
		Title:           strings.TrimSpace(ctx.Title),
	})
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

// NewSessionAudit records a session-scoped user/control action. It is not a
// message on a Turn: TurnID is always empty, and downstream projections must
// keep it out of Turn lifecycle state.
func NewSessionAudit(ctx EventContext, role MessageRole, content string, metadata map[string]any) Event {
	event := eventFromContext(ctx, EventSessionAudit, EventPayload{
		Role:     role,
		Content:  content,
		Metadata: cloneMap(metadata),
	})
	event.Payload.TurnID = ""
	return event
}

// NewGoalReconcileRequired carries internal, session-scoped evidence from a
// provider adapter to the durable Host goal mutation lane. It is neither transcript content
// nor a Turn lifecycle event.
func NewGoalReconcileRequired(ctx EventContext, metadata map[string]any) Event {
	event := eventFromContext(ctx, EventGoalReconcileRequired, EventPayload{Metadata: cloneMap(metadata)})
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

func NewTurnCanceled(ctx EventContext, turnID string) Event {
	return eventFromContext(ctx, EventTurnCanceled, EventPayload{
		TurnID:      strings.TrimSpace(turnID),
		TurnPhase:   string(TurnPhaseSettled),
		TurnOutcome: string(TurnOutcomeCanceled),
		CWD:         strings.TrimSpace(ctx.CWD),
	})
}

func NewRootProviderTurnStarted(ctx EventContext, rootTurnID string, providerTurnID string) Event {
	return eventFromContext(ctx, EventRootProviderTurnStarted, EventPayload{
		TurnID:         strings.TrimSpace(rootTurnID),
		ProviderTurnID: strings.TrimSpace(providerTurnID),
		TurnPhase:      string(TurnPhaseRunning),
		CWD:            strings.TrimSpace(ctx.CWD),
	})
}

func NewRootProviderTurnCompleted(ctx EventContext, rootTurnID string, providerTurnID string, outcome TurnOutcome) Event {
	return eventFromContext(ctx, EventRootProviderTurnCompleted, EventPayload{
		TurnID:         strings.TrimSpace(rootTurnID),
		ProviderTurnID: strings.TrimSpace(providerTurnID),
		TurnPhase:      string(TurnPhaseSettled),
		TurnOutcome:    string(outcome),
		CWD:            strings.TrimSpace(ctx.CWD),
	})
}

func NewInteractionRequested(ctx EventContext, transition InteractionTransition) Event {
	transition.Status = "pending"
	return newInteractionTransitionEvent(ctx, EventInteractionRequested, transition)
}

func NewInteractionSuperseded(ctx EventContext, transition InteractionTransition) Event {
	transition.Status = "superseded"
	return newInteractionTransitionEvent(ctx, EventInteractionSuperseded, transition)
}

func newInteractionTransitionEvent(ctx EventContext, eventType EventType, transition InteractionTransition) Event {
	transition.RequestID = strings.TrimSpace(transition.RequestID)
	transition.TurnID = strings.TrimSpace(transition.TurnID)
	transition.Kind = strings.TrimSpace(transition.Kind)
	transition.Status = strings.TrimSpace(transition.Status)
	transition.ToolName = strings.TrimSpace(transition.ToolName)
	transition.Input = cloneMap(transition.Input)
	transition.Metadata = cloneMap(transition.Metadata)
	event := eventFromContext(ctx, eventType, EventPayload{
		TurnID:      transition.TurnID,
		Interaction: &transition,
	})
	return event
}

func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	cloned := make(map[string]any, len(value))
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
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
		EventID:              strings.TrimSpace(ctx.EventID),
		Type:                 eventType,
		Provider:             ctx.Provider,
		ProviderSessionID:    strings.TrimSpace(ctx.ProviderSessionID),
		AgentSessionID:       strings.TrimSpace(ctx.AgentSessionID),
		SessionKind:          strings.TrimSpace(ctx.SessionKind),
		RootAgentSessionID:   strings.TrimSpace(ctx.RootAgentSessionID),
		RootTurnID:           strings.TrimSpace(ctx.RootTurnID),
		ParentAgentSessionID: strings.TrimSpace(ctx.ParentAgentSessionID),
		ParentTurnID:         strings.TrimSpace(ctx.ParentTurnID),
		ParentToolCallID:     strings.TrimSpace(ctx.ParentToolCallID),
		OccurredAtUnixMS:     ctx.OccurredAtUnixMS,
		Payload:              payload,
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
