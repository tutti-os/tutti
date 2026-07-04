package eventstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

const (
	TopicAnalyticsDebugReported                = "analytics.debug.reported"
	TopicAgentActivityUpdated                  = "agent.activity.updated"
	TopicPreferencesDesktopUpdateRequested     = "preferences.desktop.update.requested"
	TopicPreferencesDesktopUpdated             = "preferences.desktop.updated"
	TopicWorkspaceIssueUpdated                 = "workspace.issue.updated"
	TopicWorkspaceAppFactoryJobUpdated         = "workspace.appfactory.job.updated"
	TopicWorkspaceAppUpdated                   = "workspace.app.updated"
	TopicWorkspaceWorkbenchNodeLaunchRequested = "workspace.workbench.node.launch.requested"
)

// Direction, ValidationCode and ValidationError now live in stream-go and are
// re-exported as aliases from service.go; PayloadValidator stays catalog-local.
type PayloadValidator func([]byte) error

type TopicDefinition struct {
	Name               string
	ClientCanPublish   bool
	ClientCanSubscribe bool
	Version            int
	directions         []Direction
	validators         map[Direction]PayloadValidator
}

func (d TopicDefinition) Directions() []Direction {
	result := make([]Direction, len(d.directions))
	copy(result, d.directions)
	return result
}

func (d TopicDefinition) allowsDirection(direction Direction) bool {
	for _, candidate := range d.directions {
		if candidate == direction {
			return true
		}
	}
	return false
}

func (d TopicDefinition) validatePayload(direction Direction, payload []byte) error {
	validator, ok := d.validators[direction]
	if !ok || validator == nil {
		return nil
	}
	return validator(payload)
}

type Catalog interface {
	Topic(topic string) (TopicDefinition, bool)
	Topics() []TopicDefinition
	TopicVersion(topic string) (int, bool)
	ValidatePublish(topic string, direction Direction, payload []byte) error
	ValidateSubscription(topic string) error
}

type StaticCatalog struct {
	topics map[string]TopicDefinition
}

func NewStaticCatalog(definitions []TopicDefinition) StaticCatalog {
	topics := make(map[string]TopicDefinition, len(definitions))
	for _, definition := range definitions {
		copyDefinition := definition
		topics[definition.Name] = copyDefinition
	}
	return StaticCatalog{topics: topics}
}

func DefaultCatalog() StaticCatalog {
	return NewStaticCatalog([]TopicDefinition{
		{
			Name:               TopicAnalyticsDebugReported,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAnalyticsDebugReportedPayload,
			},
		},
		{
			Name:               TopicAgentActivityUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentActivityUpdatedPayload,
			},
		},
		{
			Name:               TopicPreferencesDesktopUpdateRequested,
			ClientCanPublish:   true,
			ClientCanSubscribe: false,
			Version:            1,
			directions:         []Direction{DirectionClientToServer},
			validators: map[Direction]PayloadValidator{
				DirectionClientToServer: validateDesktopPreferencesUpdateRequestedPayload,
			},
		},
		{
			Name:               TopicPreferencesDesktopUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateDesktopPreferencesUpdatedPayload,
			},
		},
		{
			Name:               TopicWorkspaceIssueUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateWorkspaceIssueUpdatedPayload,
			},
		},
		{
			Name:               TopicWorkspaceAppUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateWorkspaceAppUpdatedPayload,
			},
		},
		{
			Name:               TopicWorkspaceAppFactoryJobUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateWorkspaceAppFactoryJobUpdatedPayload,
			},
		},
		{
			Name:               TopicWorkspaceWorkbenchNodeLaunchRequested,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateWorkspaceWorkbenchNodeLaunchRequestedPayload,
			},
		},
	})
}

func (c StaticCatalog) Topic(topic string) (TopicDefinition, bool) {
	definition, ok := c.topics[strings.TrimSpace(topic)]
	return definition, ok
}

func (c StaticCatalog) TopicVersion(topic string) (int, bool) {
	definition, ok := c.Topic(topic)
	if !ok {
		return 0, false
	}
	return definition.Version, true
}

func (c StaticCatalog) Topics() []TopicDefinition {
	topics := make([]TopicDefinition, 0, len(c.topics))
	for _, definition := range c.topics {
		topics = append(topics, definition)
	}
	sort.Slice(topics, func(i, j int) bool {
		return topics[i].Name < topics[j].Name
	})
	return topics
}

func (c StaticCatalog) ValidatePublish(topic string, direction Direction, payload []byte) error {
	definition, ok := c.Topic(topic)
	if !ok {
		return &ValidationError{
			Code:      ValidationCodeInvalidTopic,
			Message:   fmt.Sprintf("unknown topic %q", strings.TrimSpace(topic)),
			Topic:     strings.TrimSpace(topic),
			Direction: direction,
		}
	}
	if !definition.allowsDirection(direction) {
		return &ValidationError{
			Code:      ValidationCodeInvalidDirection,
			Message:   fmt.Sprintf("topic %q does not allow %s", definition.Name, direction),
			Topic:     definition.Name,
			Direction: direction,
		}
	}
	if err := definition.validatePayload(direction, payload); err != nil {
		return &ValidationError{
			Code:      ValidationCodeInvalidPayload,
			Message:   err.Error(),
			Topic:     definition.Name,
			Direction: direction,
		}
	}
	return nil
}

func (c StaticCatalog) ValidateSubscription(topic string) error {
	definition, ok := c.Topic(topic)
	if !ok {
		return &ValidationError{
			Code:    ValidationCodeInvalidTopic,
			Message: fmt.Sprintf("unknown topic %q", strings.TrimSpace(topic)),
			Topic:   strings.TrimSpace(topic),
		}
	}
	if !definition.ClientCanSubscribe {
		return &ValidationError{
			Code:    ValidationCodeInvalidDirection,
			Message: fmt.Sprintf("topic %q is not subscribable", definition.Name),
			Topic:   definition.Name,
		}
	}
	return nil
}

type analyticsDebugReportedPayload struct {
	Events []analyticsDebugReportedEventPayload `json:"events"`
}

type analyticsDebugReportedEventPayload struct {
	Name     string         `json:"name"`
	ClientTS int64          `json:"clientTs"`
	Params   map[string]any `json:"params"`
}

type agentActivityUpdatedPayload struct {
	WorkspaceID    string          `json:"workspaceId"`
	AgentSessionID string          `json:"agentSessionId"`
	AgentTargetID  string          `json:"agentTargetId,omitempty"`
	EventType      string          `json:"eventType"`
	Data           json.RawMessage `json:"data"`
}

type agentActivityUpdatedDataHeader struct {
	WorkspaceID    string `json:"workspaceId"`
	AgentSessionID string `json:"agentSessionId"`
	EventType      string `json:"eventType"`
}

type agentActivitySessionUpdateData struct {
	agentActivityUpdatedDataHeader
	AgentTargetID   string `json:"agentTargetId,omitempty"`
	LastEventUnixMS *int64 `json:"lastEventUnixMs"`
}

type agentActivitySessionDeletedData struct {
	agentActivityUpdatedDataHeader
	DeletedAtUnixMS *int64 `json:"deletedAtUnixMs"`
}

type agentActivityMessageUpdateData struct {
	agentActivityUpdatedDataHeader
	LatestVersion *uint64                    `json:"latestVersion"`
	AcceptedCount *int                       `json:"acceptedCount"`
	Messages      []agentActivityMessageData `json:"messages"`
}

type agentActivityMessageData struct {
	AgentSessionID string         `json:"agentSessionId"`
	ID             *uint64        `json:"id"`
	Kind           string         `json:"kind"`
	MessageID      string         `json:"messageId"`
	Payload        map[string]any `json:"payload"`
	Role           string         `json:"role"`
	Version        *uint64        `json:"version"`
	TurnID         string         `json:"turnId"`
	Status         string         `json:"status,omitempty"`
	OccurredAtMS   *int64         `json:"occurredAtUnixMs"`
	StartedAtMS    *int64         `json:"startedAtUnixMs,omitempty"`
	CompletedAtMS  *int64         `json:"completedAtUnixMs,omitempty"`
	CreatedAtMS    *int64         `json:"createdAtUnixMs,omitempty"`
	UpdatedAtMS    *int64         `json:"updatedAtUnixMs,omitempty"`
}

type agentActivityStatePatchData struct {
	agentActivityUpdatedDataHeader
	LastEventUnixMS  *int64                      `json:"lastEventUnixMs"`
	OccurredAtUnixMS *int64                      `json:"occurredAtUnixMs,omitempty"`
	Provider         string                      `json:"provider,omitempty"`
	AgentTargetID    string                      `json:"agentTargetId,omitempty"`
	ProviderSession  string                      `json:"providerSessionId,omitempty"`
	Model            string                      `json:"model,omitempty"`
	CWD              string                      `json:"cwd,omitempty"`
	Title            string                      `json:"title,omitempty"`
	LifecycleStatus  string                      `json:"lifecycleStatus,omitempty"`
	CurrentPhase     string                      `json:"currentPhase,omitempty"`
	LastError        string                      `json:"lastError,omitempty"`
	StartedAtUnixMS  *int64                      `json:"startedAtUnixMs,omitempty"`
	EndedAtUnixMS    *int64                      `json:"endedAtUnixMs,omitempty"`
	Turn             *agentActivityStateTurnData `json:"turn,omitempty"`
}

type agentActivityStateTurnData struct {
	TurnID            string `json:"turnId"`
	Phase             string `json:"phase,omitempty"`
	Outcome           string `json:"outcome,omitempty"`
	FileChanges       any    `json:"fileChanges,omitempty"`
	StartedAtUnixMS   *int64 `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS *int64 `json:"completedAtUnixMs,omitempty"`
}

type workbenchNodeLaunchRequestedPayload struct {
	WorkspaceID  string          `json:"workspaceId"`
	TypeID       string          `json:"typeId"`
	Source       string          `json:"source"`
	LaunchSource string          `json:"launchSource,omitempty"`
	DockEntryID  string          `json:"dockEntryId,omitempty"`
	RequestID    string          `json:"requestId,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
}

type workspaceIssueUpdatedPayload struct {
	WorkspaceID string `json:"workspaceId"`
	IssueID     string `json:"issueId"`
	TaskID      string `json:"taskId,omitempty"`
	RunID       string `json:"runId,omitempty"`
	ChangeKind  string `json:"changeKind"`
}

func validateAnalyticsDebugReportedPayload(payload []byte) error {
	var decoded analyticsDebugReportedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if len(decoded.Events) == 0 {
		return fmt.Errorf("events is required")
	}
	if len(decoded.Events) > 100 {
		return fmt.Errorf("events must not contain more than 100 items")
	}
	for index, event := range decoded.Events {
		if strings.TrimSpace(event.Name) == "" {
			return fmt.Errorf("events[%d].name is required", index)
		}
		if event.ClientTS <= 0 {
			return fmt.Errorf("events[%d].clientTs must be positive", index)
		}
		if event.Params == nil {
			return fmt.Errorf("events[%d].params is required", index)
		}
	}
	return nil
}

func validateDesktopPreferencesUpdateRequestedPayload(payload []byte) error {
	decoded, err := decodeDesktopPreferencesMutationPayload(payload)
	if err != nil {
		return err
	}
	if decoded.DockPlacement == "" {
		return fmt.Errorf("preferences.dockPlacement is required")
	}
	if !preferencesbiz.IsDesktopDockPlacement(decoded.DockPlacement) {
		return fmt.Errorf("preferences.dockPlacement is unsupported")
	}
	if strings.TrimSpace(decoded.AgentDockLayout) == "" {
		return fmt.Errorf("preferences.agentDockLayout is required")
	}
	if !preferencesbiz.IsDesktopAgentDockLayout(strings.TrimSpace(decoded.AgentDockLayout)) {
		return fmt.Errorf("preferences.agentDockLayout is unsupported")
	}
	if decoded.AppCatalogChannel == "" {
		return fmt.Errorf("preferences.appCatalogChannel is required")
	}
	if !preferencesbiz.IsDesktopAppCatalogChannel(decoded.AppCatalogChannel) {
		return fmt.Errorf("preferences.appCatalogChannel is unsupported")
	}
	if decoded.BrowserUseConnectionMode != "" &&
		!preferencesbiz.IsDesktopBrowserUseConnectionMode(decoded.BrowserUseConnectionMode) {
		return fmt.Errorf("preferences.browserUseConnectionMode is unsupported")
	}
	if decoded.DefaultAgentProvider == "" {
		return fmt.Errorf("preferences.defaultAgentProvider is required")
	}
	if !agentproviderbiz.IsSupported(decoded.DefaultAgentProvider) {
		return fmt.Errorf("preferences.defaultAgentProvider is unsupported")
	}
	if decoded.DockIconStyle == "" {
		return fmt.Errorf("preferences.dockIconStyle is required")
	}
	if !preferencesbiz.IsDesktopDockIconStyle(decoded.DockIconStyle) {
		return fmt.Errorf("preferences.dockIconStyle is unsupported")
	}
	if decoded.Locale == "" {
		return fmt.Errorf("preferences.locale is required")
	}
	if !preferencesbiz.IsDesktopLocale(decoded.Locale) {
		return fmt.Errorf("preferences.locale is unsupported")
	}
	if decoded.MinimizeAnimation == "" {
		return fmt.Errorf("preferences.minimizeAnimation is required")
	}
	if !preferencesbiz.IsDesktopMinimizeAnimation(decoded.MinimizeAnimation) {
		return fmt.Errorf("preferences.minimizeAnimation is unsupported")
	}
	if decoded.SleepPreventionMode == "" {
		return fmt.Errorf("preferences.sleepPreventionMode is required")
	}
	if !preferencesbiz.IsDesktopSleepPreventionMode(decoded.SleepPreventionMode) {
		return fmt.Errorf("preferences.sleepPreventionMode is unsupported")
	}
	if decoded.ThemeSource == "" {
		return fmt.Errorf("preferences.themeSource is required")
	}
	if !preferencesbiz.IsDesktopThemeSource(decoded.ThemeSource) {
		return fmt.Errorf("preferences.themeSource is unsupported")
	}
	if decoded.UpdateChannel == "" {
		return fmt.Errorf("preferences.updateChannel is required")
	}
	if !preferencesbiz.IsDesktopUpdateChannel(decoded.UpdateChannel) {
		return fmt.Errorf("preferences.updateChannel is unsupported")
	}
	if decoded.UpdatePolicy == "" {
		return fmt.Errorf("preferences.updatePolicy is required")
	}
	if !preferencesbiz.IsDesktopUpdatePolicy(decoded.UpdatePolicy) {
		return fmt.Errorf("preferences.updatePolicy is unsupported")
	}
	for extension, opener := range decoded.FileDefaultOpenersByExtension {
		if preferencesbiz.NormalizeDesktopFileExtension(extension) == "" {
			return fmt.Errorf("preferences.fileDefaultOpenersByExtension has unsupported extension")
		}
		if !preferencesbiz.IsDesktopFileDefaultOpener(opener) {
			return fmt.Errorf("preferences.fileDefaultOpenersByExtension has unsupported opener")
		}
	}
	return nil
}

func validateDesktopPreferencesUpdatedPayload(payload []byte) error {
	var decoded desktopPreferencesUpdatedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if decoded.Preferences.DockPlacement == "" {
		return fmt.Errorf("preferences.dockPlacement is required")
	}
	if !preferencesbiz.IsDesktopDockPlacement(decoded.Preferences.DockPlacement) {
		return fmt.Errorf("preferences.dockPlacement is unsupported")
	}
	if decoded.Preferences.AgentConversationDetailMode == "" {
		return fmt.Errorf("preferences.agentConversationDetailMode is required")
	}
	if !preferencesbiz.IsDesktopAgentConversationDetailMode(decoded.Preferences.AgentConversationDetailMode) {
		return fmt.Errorf("preferences.agentConversationDetailMode is unsupported")
	}
	if strings.TrimSpace(decoded.Preferences.AgentDockLayout) == "" {
		return fmt.Errorf("preferences.agentDockLayout is required")
	}
	if !preferencesbiz.IsDesktopAgentDockLayout(strings.TrimSpace(decoded.Preferences.AgentDockLayout)) {
		return fmt.Errorf("preferences.agentDockLayout is unsupported")
	}
	if decoded.Preferences.AppCatalogChannel == "" {
		return fmt.Errorf("preferences.appCatalogChannel is required")
	}
	if !preferencesbiz.IsDesktopAppCatalogChannel(decoded.Preferences.AppCatalogChannel) {
		return fmt.Errorf("preferences.appCatalogChannel is unsupported")
	}
	if decoded.Preferences.BrowserUseConnectionMode != "" &&
		!preferencesbiz.IsDesktopBrowserUseConnectionMode(decoded.Preferences.BrowserUseConnectionMode) {
		return fmt.Errorf("preferences.browserUseConnectionMode is unsupported")
	}
	if decoded.Preferences.DefaultAgentProvider == "" {
		return fmt.Errorf("preferences.defaultAgentProvider is required")
	}
	if !agentproviderbiz.IsSupported(decoded.Preferences.DefaultAgentProvider) {
		return fmt.Errorf("preferences.defaultAgentProvider is unsupported")
	}
	if decoded.Preferences.DockIconStyle == "" {
		return fmt.Errorf("preferences.dockIconStyle is required")
	}
	if !preferencesbiz.IsDesktopDockIconStyle(decoded.Preferences.DockIconStyle) {
		return fmt.Errorf("preferences.dockIconStyle is unsupported")
	}
	if decoded.Preferences.Locale == "" {
		return fmt.Errorf("preferences.locale is required")
	}
	if !preferencesbiz.IsDesktopLocale(decoded.Preferences.Locale) {
		return fmt.Errorf("preferences.locale is unsupported")
	}
	if decoded.Preferences.MinimizeAnimation == "" {
		return fmt.Errorf("preferences.minimizeAnimation is required")
	}
	if !preferencesbiz.IsDesktopMinimizeAnimation(decoded.Preferences.MinimizeAnimation) {
		return fmt.Errorf("preferences.minimizeAnimation is unsupported")
	}
	if decoded.Preferences.SleepPreventionMode == "" {
		return fmt.Errorf("preferences.sleepPreventionMode is required")
	}
	if !preferencesbiz.IsDesktopSleepPreventionMode(decoded.Preferences.SleepPreventionMode) {
		return fmt.Errorf("preferences.sleepPreventionMode is unsupported")
	}
	if decoded.Preferences.ThemeSource == "" {
		return fmt.Errorf("preferences.themeSource is required")
	}
	if !preferencesbiz.IsDesktopThemeSource(decoded.Preferences.ThemeSource) {
		return fmt.Errorf("preferences.themeSource is unsupported")
	}
	if decoded.Preferences.UpdateChannel == "" {
		return fmt.Errorf("preferences.updateChannel is required")
	}
	if !preferencesbiz.IsDesktopUpdateChannel(decoded.Preferences.UpdateChannel) {
		return fmt.Errorf("preferences.updateChannel is unsupported")
	}
	if decoded.Preferences.UpdatePolicy == "" {
		return fmt.Errorf("preferences.updatePolicy is required")
	}
	if !preferencesbiz.IsDesktopUpdatePolicy(decoded.Preferences.UpdatePolicy) {
		return fmt.Errorf("preferences.updatePolicy is unsupported")
	}
	for extension, opener := range decoded.Preferences.FileDefaultOpenersByExtension {
		if preferencesbiz.NormalizeDesktopFileExtension(extension) == "" {
			return fmt.Errorf("preferences.fileDefaultOpenersByExtension has unsupported extension")
		}
		if !preferencesbiz.IsDesktopFileDefaultOpener(opener) {
			return fmt.Errorf("preferences.fileDefaultOpenersByExtension has unsupported opener")
		}
	}
	return nil
}

func validateAgentActivityUpdatedPayload(payload []byte) error {
	var decoded agentActivityUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.WorkspaceID) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.AgentSessionID) == "" {
		return fmt.Errorf("agentSessionId is required")
	}
	switch strings.TrimSpace(decoded.EventType) {
	case "session_update", "session_deleted", "message_update", "state_patch":
	default:
		return fmt.Errorf("eventType is unsupported")
	}
	if len(decoded.Data) == 0 || string(decoded.Data) == "null" {
		return fmt.Errorf("data is required")
	}
	return validateAgentActivityUpdatedData(decoded)
}

func decodeJSONStrict(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func validateAgentActivityUpdatedData(decoded agentActivityUpdatedPayload) error {
	var header agentActivityUpdatedDataHeader
	if err := json.Unmarshal(decoded.Data, &header); err != nil {
		return fmt.Errorf("decode data: %w", err)
	}
	workspaceID := strings.TrimSpace(decoded.WorkspaceID)
	agentSessionID := strings.TrimSpace(decoded.AgentSessionID)
	eventType := strings.TrimSpace(decoded.EventType)
	if strings.TrimSpace(header.WorkspaceID) != workspaceID {
		return fmt.Errorf("data.workspaceId must match workspaceId")
	}
	if strings.TrimSpace(header.AgentSessionID) != agentSessionID {
		return fmt.Errorf("data.agentSessionId must match agentSessionId")
	}
	if strings.TrimSpace(header.EventType) != eventType {
		return fmt.Errorf("data.eventType must match eventType")
	}
	switch eventType {
	case "session_update":
		var data agentActivitySessionUpdateData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode session_update data: %w", err)
		}
		if data.LastEventUnixMS == nil {
			return fmt.Errorf("data.lastEventUnixMs is required")
		}
	case "session_deleted":
		var data agentActivitySessionDeletedData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode session_deleted data: %w", err)
		}
		if data.DeletedAtUnixMS == nil {
			return fmt.Errorf("data.deletedAtUnixMs is required")
		}
	case "message_update":
		var data agentActivityMessageUpdateData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode message_update data: %w", err)
		}
		if data.LatestVersion == nil {
			return fmt.Errorf("data.latestVersion is required")
		}
		if data.AcceptedCount == nil {
			return fmt.Errorf("data.acceptedCount is required")
		}
		if data.Messages == nil {
			return fmt.Errorf("data.messages is required")
		}
		if *data.AcceptedCount < 0 {
			return fmt.Errorf("data.acceptedCount is invalid")
		}
		for index, message := range data.Messages {
			if strings.TrimSpace(message.AgentSessionID) != agentSessionID {
				return fmt.Errorf("data.messages[%d].agentSessionId must match agentSessionId", index)
			}
			if message.ID == nil {
				return fmt.Errorf("data.messages[%d].id is required", index)
			}
			if strings.TrimSpace(message.Kind) == "" {
				return fmt.Errorf("data.messages[%d].kind is required", index)
			}
			if strings.TrimSpace(message.MessageID) == "" {
				return fmt.Errorf("data.messages[%d].messageId is required", index)
			}
			if message.Payload == nil {
				return fmt.Errorf("data.messages[%d].payload is required", index)
			}
			if strings.TrimSpace(message.Role) == "" {
				return fmt.Errorf("data.messages[%d].role is required", index)
			}
			if message.Version == nil || *message.Version == 0 {
				return fmt.Errorf("data.messages[%d].version is required", index)
			}
			if strings.TrimSpace(message.TurnID) == "" {
				return fmt.Errorf("data.messages[%d].turnId is required", index)
			}
			if message.OccurredAtMS == nil || *message.OccurredAtMS <= 0 {
				return fmt.Errorf("data.messages[%d].occurredAtUnixMs is required", index)
			}
		}
	case "state_patch":
		var data agentActivityStatePatchData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode state_patch data: %w", err)
		}
		if data.LastEventUnixMS == nil {
			return fmt.Errorf("data.lastEventUnixMs is required")
		}
		if data.Turn != nil && strings.TrimSpace(data.Turn.TurnID) == "" {
			return fmt.Errorf("data.turn.turnId is required")
		}
	}
	return nil
}

func validateWorkspaceWorkbenchNodeLaunchRequestedPayload(payload []byte) error {
	var decoded workbenchNodeLaunchRequestedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.WorkspaceID) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.TypeID) == "" {
		return fmt.Errorf("typeId is required")
	}
	if strings.TrimSpace(decoded.Source) == "" {
		return fmt.Errorf("source is required")
	}
	if decoded.LaunchSource != "" && strings.TrimSpace(decoded.LaunchSource) == "" {
		return fmt.Errorf("launchSource must not be blank")
	}
	if decoded.DockEntryID != "" && strings.TrimSpace(decoded.DockEntryID) == "" {
		return fmt.Errorf("dockEntryId must not be blank")
	}
	if decoded.RequestID != "" && strings.TrimSpace(decoded.RequestID) == "" {
		return fmt.Errorf("requestId must not be blank")
	}
	return nil
}

func validateWorkspaceIssueUpdatedPayload(payload []byte) error {
	var decoded workspaceIssueUpdatedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.WorkspaceID) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.IssueID) == "" {
		return fmt.Errorf("issueId is required")
	}
	if decoded.TaskID != "" && strings.TrimSpace(decoded.TaskID) == "" {
		return fmt.Errorf("taskId must not be blank")
	}
	if decoded.RunID != "" && strings.TrimSpace(decoded.RunID) == "" {
		return fmt.Errorf("runId must not be blank")
	}
	switch strings.TrimSpace(decoded.ChangeKind) {
	case "issue_created",
		"issue_updated",
		"issue_deleted",
		"issue_context_refs_updated",
		"task_created",
		"task_updated",
		"task_deleted",
		"task_context_refs_updated",
		"run_created",
		"run_completed":
	default:
		return fmt.Errorf("changeKind is unsupported")
	}
	return nil
}

func validateWorkspaceAppUpdatedPayload(payload []byte) error {
	var raw struct {
		App map[string]json.RawMessage `json:"app"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	referencesRaw, ok := raw.App["references"]
	if !ok {
		return fmt.Errorf("app.references is required")
	}
	var references struct {
		ListSupported *bool `json:"listSupported"`
	}
	if err := json.Unmarshal(referencesRaw, &references); err != nil {
		return fmt.Errorf("decode app.references: %w", err)
	}
	if references.ListSupported == nil {
		return fmt.Errorf("app.references.listSupported is required")
	}

	var decoded eventprotocol.WorkspaceAppUpdatedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	app := decoded.App
	if strings.TrimSpace(app.AppId) == "" {
		return fmt.Errorf("app.appId is required")
	}
	if strings.TrimSpace(app.DisplayName) == "" {
		return fmt.Errorf("app.displayName is required")
	}
	if strings.TrimSpace(app.Version) == "" {
		return fmt.Errorf("app.version is required")
	}
	if app.StateRevision < 0 {
		return fmt.Errorf("app.stateRevision must not be negative")
	}
	switch app.Status {
	case "idle", "preparing", "starting", "running", "installed_pending_restart", "failed", "stopping":
	default:
		return fmt.Errorf("app.status is unsupported")
	}
	switch app.MinimizeBehavior {
	case "hibernate", "keep-mounted":
	default:
		return fmt.Errorf("app.minimizeBehavior is unsupported")
	}
	if app.WindowMinWidth != nil && (*app.WindowMinWidth < workspacebiz.MinAppWindowWidth || *app.WindowMinWidth > workspacebiz.MaxAppWindowWidth) {
		return fmt.Errorf("app.windowMinWidth is unsupported")
	}
	if app.WindowMinHeight != nil && (*app.WindowMinHeight < workspacebiz.MinAppWindowHeight || *app.WindowMinHeight > workspacebiz.MaxAppWindowHeight) {
		return fmt.Errorf("app.windowMinHeight is unsupported")
	}
	return nil
}

func validateWorkspaceAppFactoryJobUpdatedPayload(payload []byte) error {
	var decoded eventprotocol.WorkspaceAppfactoryJobUpdatedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	job := decoded.Job
	if strings.TrimSpace(job.JobId) == "" {
		return fmt.Errorf("job.jobId is required")
	}
	if strings.TrimSpace(job.WorkspaceId) == "" {
		return fmt.Errorf("job.workspaceId is required")
	}
	switch job.Status {
	case "queued", "generating", "preparing", "validating", "ready", "published", "failed", "canceled":
		return nil
	default:
		return fmt.Errorf("job.status is unsupported")
	}
}
