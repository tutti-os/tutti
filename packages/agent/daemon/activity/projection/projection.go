package projection

import "strings"

type SessionSnapshot struct {
	WorkspaceID       string
	AgentSessionID    string
	Origin            string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	Model             string
	Settings          map[string]any
	RuntimeContext    map[string]any
	CWD               string
	Title             string
	Status            string
	CurrentPhase      string
	LastError         string
	MessageVersion    uint64
	LastEventUnixMS   int64
	StartedAtUnixMS   int64
	EndedAtUnixMS     int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
	DeletedAtUnixMS   int64
}

type SessionStateReport struct {
	WorkspaceID       string
	AgentSessionID    string
	Origin            string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	Model             string
	Settings          map[string]any
	RuntimeContext    map[string]any
	CWD               string
	Title             string
	Status            string
	CurrentPhase      string
	LastError         string
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	EndedAtUnixMS     int64
}

type SessionProjection struct {
	Accepted        bool
	LastEventUnixMS int64
	Session         SessionSnapshot
}

func ProjectSessionState(
	existing SessionSnapshot,
	hasExisting bool,
	report SessionStateReport,
	nowUnixMS int64,
) SessionProjection {
	lastEvent := report.OccurredAtUnixMS
	if lastEvent <= 0 {
		lastEvent = nowUnixMS
	}
	if hasExisting && existing.DeletedAtUnixMS > 0 {
		return SessionProjection{
			Accepted:        false,
			LastEventUnixMS: lastEvent,
			Session:         existing,
		}
	}
	session := SessionSnapshot{
		WorkspaceID:       strings.TrimSpace(report.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(report.AgentSessionID),
		Origin:            strings.TrimSpace(report.Origin),
		AgentTargetID:     strings.TrimSpace(report.AgentTargetID),
		Provider:          strings.TrimSpace(report.Provider),
		ProviderSessionID: strings.TrimSpace(report.ProviderSessionID),
		Model:             strings.TrimSpace(report.Model),
		Settings:          cloneJSONMap(report.Settings),
		RuntimeContext:    cloneJSONMap(report.RuntimeContext),
		CWD:               strings.TrimSpace(report.CWD),
		Title:             strings.TrimSpace(report.Title),
		Status:            strings.TrimSpace(report.Status),
		CurrentPhase:      strings.TrimSpace(report.CurrentPhase),
		LastError:         strings.TrimSpace(report.LastError),
		LastEventUnixMS:   lastEvent,
		StartedAtUnixMS:   report.StartedAtUnixMS,
		EndedAtUnixMS:     report.EndedAtUnixMS,
		CreatedAtUnixMS:   nowUnixMS,
		UpdatedAtUnixMS:   nowUnixMS,
	}
	if hasExisting {
		session.CreatedAtUnixMS = existing.CreatedAtUnixMS
		session.MessageVersion = existing.MessageVersion
		if session.LastError == "" {
			session.LastError = strings.TrimSpace(existing.LastError)
		}
		if session.Origin == "" {
			session.Origin = existing.Origin
		}
		if session.AgentTargetID == "" {
			session.AgentTargetID = existing.AgentTargetID
		}
		if session.Provider == "" {
			session.Provider = existing.Provider
		}
		if session.ProviderSessionID == "" {
			session.ProviderSessionID = existing.ProviderSessionID
		}
		if session.Model == "" {
			session.Model = existing.Model
		}
		if len(session.Settings) == 0 {
			session.Settings = cloneJSONMap(existing.Settings)
		}
		if len(session.RuntimeContext) == 0 {
			session.RuntimeContext = cloneJSONMap(existing.RuntimeContext)
		}
		if session.CWD == "" {
			session.CWD = existing.CWD
		}
		if session.Title == "" {
			session.Title = existing.Title
		}
		if session.Status == "" {
			session.Status = existing.Status
		}
		if session.CurrentPhase == "" {
			session.CurrentPhase = existing.CurrentPhase
		}
		session.Status, session.CurrentPhase = mergeSessionRuntimeState(
			existing.Status,
			existing.CurrentPhase,
			session.Status,
			session.CurrentPhase,
			lastEvent,
			existing.LastEventUnixMS,
		)
		if existing.LastEventUnixMS > session.LastEventUnixMS {
			session.LastEventUnixMS = existing.LastEventUnixMS
		}
		if session.StartedAtUnixMS <= 0 {
			session.StartedAtUnixMS = existing.StartedAtUnixMS
		} else if existing.StartedAtUnixMS > 0 && existing.StartedAtUnixMS < session.StartedAtUnixMS {
			session.StartedAtUnixMS = existing.StartedAtUnixMS
		}
		if existing.EndedAtUnixMS > session.EndedAtUnixMS {
			session.EndedAtUnixMS = existing.EndedAtUnixMS
		}
	}
	return SessionProjection{
		Accepted:        session.WorkspaceID != "" && session.AgentSessionID != "",
		LastEventUnixMS: session.LastEventUnixMS,
		Session:         session,
	}
}

type MessageSnapshot struct {
	ID                uint64
	AgentSessionID    string
	MessageID         string
	Version           uint64
	TurnID            string
	Role              string
	Kind              string
	Status            string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type MessageUpdate struct {
	MessageID         string
	TurnID            string
	Role              string
	Kind              string
	Status            string
	ContentDelta      string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
}

func ProjectMessageUpdate(
	existing MessageSnapshot,
	hasExisting bool,
	update MessageUpdate,
	version uint64,
	nowUnixMS int64,
) (MessageSnapshot, bool) {
	messageID := strings.TrimSpace(update.MessageID)
	if messageID == "" {
		return MessageSnapshot{}, false
	}
	message := MessageSnapshot{
		MessageID:         messageID,
		Version:           version,
		TurnID:            strings.TrimSpace(update.TurnID),
		Role:              strings.TrimSpace(update.Role),
		Kind:              strings.TrimSpace(update.Kind),
		Status:            strings.TrimSpace(update.Status),
		Payload:           cloneJSONMap(update.Payload),
		OccurredAtUnixMS:  update.OccurredAtUnixMS,
		StartedAtUnixMS:   update.StartedAtUnixMS,
		CompletedAtUnixMS: update.CompletedAtUnixMS,
		CreatedAtUnixMS:   nowUnixMS,
		UpdatedAtUnixMS:   nowUnixMS,
	}
	if hasExisting {
		message.ID = existing.ID
		message.AgentSessionID = strings.TrimSpace(existing.AgentSessionID)
		message.CreatedAtUnixMS = existing.CreatedAtUnixMS
		if message.TurnID == "" {
			message.TurnID = existing.TurnID
		} else if existingTurnID := strings.TrimSpace(existing.TurnID); existingTurnID != "" && message.TurnID != existingTurnID {
			return MessageSnapshot{}, false
		}
		if message.Role == "" {
			message.Role = existing.Role
		}
		if message.Kind == "" {
			message.Kind = existing.Kind
		}
		message.Status = MergeMessageStatus(existing.Status, message.Status)
		message.Payload = mergeJSONMap(existing.Payload, message.Payload)
		if message.OccurredAtUnixMS <= 0 {
			message.OccurredAtUnixMS = existing.OccurredAtUnixMS
		} else if existing.OccurredAtUnixMS > 0 && existing.OccurredAtUnixMS > message.OccurredAtUnixMS {
			message.OccurredAtUnixMS = existing.OccurredAtUnixMS
		}
		if message.StartedAtUnixMS <= 0 {
			message.StartedAtUnixMS = existing.StartedAtUnixMS
		} else if existing.StartedAtUnixMS > 0 && existing.StartedAtUnixMS < message.StartedAtUnixMS {
			message.StartedAtUnixMS = existing.StartedAtUnixMS
		}
		if message.CompletedAtUnixMS <= 0 {
			message.CompletedAtUnixMS = existing.CompletedAtUnixMS
		} else if existing.CompletedAtUnixMS > 0 && existing.CompletedAtUnixMS > message.CompletedAtUnixMS {
			message.CompletedAtUnixMS = existing.CompletedAtUnixMS
		}
	}
	if message.TurnID == "" {
		return MessageSnapshot{}, false
	}
	if message.OccurredAtUnixMS <= 0 {
		message.OccurredAtUnixMS = firstNonZeroInt64(message.StartedAtUnixMS, message.CompletedAtUnixMS, nowUnixMS)
	}
	if strings.TrimSpace(update.ContentDelta) != "" {
		if message.Payload == nil {
			message.Payload = make(map[string]any)
		}
		message.Payload["text"] = stringValue(message.Payload["text"]) + update.ContentDelta
	}
	message.Payload = clearStaleToolPayloadForStatus(message.Kind, message.Status, message.Payload)
	if message.Payload == nil {
		message.Payload = map[string]any{}
	}
	return message, true
}

func clearStaleToolPayloadForStatus(kind string, status string, payload map[string]any) map[string]any {
	if strings.TrimSpace(kind) != "tool_call" || strings.TrimSpace(status) != "completed" || len(payload) == 0 {
		return payload
	}
	delete(payload, "error")
	return payload
}

func firstNonZeroInt64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func MergeMessageStatus(existing string, incoming string) string {
	existing = strings.TrimSpace(existing)
	incoming = strings.TrimSpace(incoming)
	if incoming == "" {
		return existing
	}
	if IsTerminalMessageStatus(existing) && !IsTerminalMessageStatus(incoming) {
		return existing
	}
	return incoming
}

func mergeSessionRuntimeState(
	existingStatus string,
	existingCurrentPhase string,
	incomingStatus string,
	incomingCurrentPhase string,
	incomingEventUnixMS int64,
	existingLastEventUnixMS int64,
) (string, string) {
	existingStatus = strings.TrimSpace(existingStatus)
	existingCurrentPhase = strings.TrimSpace(existingCurrentPhase)
	incomingStatus = strings.TrimSpace(incomingStatus)
	incomingCurrentPhase = strings.TrimSpace(incomingCurrentPhase)
	if incomingStatus == "" {
		incomingStatus = existingStatus
	}
	if incomingCurrentPhase == "" {
		incomingCurrentPhase = existingCurrentPhase
	}
	if existingLastEventUnixMS > 0 &&
		incomingEventUnixMS > 0 &&
		incomingEventUnixMS < existingLastEventUnixMS {
		return existingStatus, existingCurrentPhase
	}
	existingCanonical := CanonicalSessionStatus(existingStatus, existingCurrentPhase)
	if isTerminalSessionStatus(existingCanonical) {
		return existingStatus, existingCurrentPhase
	}
	return incomingStatus, incomingCurrentPhase
}

func isTerminalSessionStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "completed", "failed", "canceled", "errored":
		return true
	default:
		return false
	}
}

func IsTerminalMessageStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "completed", "failed", "canceled", "errored":
		return true
	default:
		return false
	}
}

func CanonicalSessionStatus(lifecycleStatus string, currentPhase string) string {
	lifecycleStatus = strings.TrimSpace(lifecycleStatus)
	currentPhase = strings.TrimSpace(currentPhase)
	switch lifecycleStatus {
	case "failed":
		return "failed"
	case "completed", "ended":
		return "completed"
	case "canceled":
		return "canceled"
	}
	switch currentPhase {
	case "failed":
		return "failed"
	case "waiting", "waiting_approval", "awaiting_approval", "waiting_input":
		return "waiting"
	case "working", "running", "streaming":
		return "working"
	}
	switch lifecycleStatus {
	case "working", "running", "streaming":
		return "working"
	case "waiting", "waiting_approval", "awaiting_approval", "waiting_input":
		return "waiting"
	default:
		return lifecycleStatus
	}
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func cloneJSONMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func mergeJSONMap(existing map[string]any, incoming map[string]any) map[string]any {
	if len(existing) == 0 {
		return cloneJSONMap(incoming)
	}
	out := cloneJSONMap(existing)
	for key, value := range incoming {
		if incomingMap, ok := value.(map[string]any); ok {
			if existingMap, ok := out[key].(map[string]any); ok {
				out[key] = mergeJSONMap(existingMap, incomingMap)
				continue
			}
		}
		out[key] = value
	}
	return out
}
