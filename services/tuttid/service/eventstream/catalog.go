package eventstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

const (
	TopicAnalyticsDebugReported                         = "analytics.debug.reported"
	TopicAgentActivityUpdated                           = "agent.activity.updated"
	TopicAgentCollaborationUpdated                      = "agent.collaboration.updated"
	TopicAgentModelCatalogInvalidated                   = "agent.model.catalog.invalidated"
	TopicAgentQuickPromptUpdated                        = "agent.quickprompt.updated"
	TopicPreferencesAgentComposerDefaultsChanged        = "preferences.agent.composer.defaults.changed"
	TopicPreferencesAgentComposerDefaultsPatchRequested = "preferences.agent.composer.defaults.patch.requested"
	TopicPreferencesDesktopUpdateRequested              = "preferences.desktop.update.requested"
	TopicPreferencesDesktopUpdated                      = "preferences.desktop.updated"
	TopicUserProjectUpdated                             = "user.project.updated"
	TopicWorkspaceIssueUpdated                          = "workspace.issue.updated"
	TopicWorkspaceWorkflowUpdated                       = "workspace.workflow.updated"
	TopicWorkspaceTuttiModeUpdated                      = "workspace.tuttimode.updated"
	TopicWorkspaceAppFactoryJobUpdated                  = "workspace.appfactory.job.updated"
	TopicWorkspaceAppUpdated                            = "workspace.app.updated"
	TopicWorkspaceWorkbenchNodeLaunchRequested          = "workspace.workbench.node.launch.requested"
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
	definitions := []TopicDefinition{
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
			Version:            2,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentActivityUpdatedPayload,
			},
		},
		{
			Name:               TopicAgentCollaborationUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentCollaborationUpdatedPayload,
			},
		},
		{
			Name:               TopicAgentModelCatalogInvalidated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentModelCatalogInvalidatedPayload,
			},
		},
		{
			Name:               TopicAgentQuickPromptUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentQuickPromptUpdatedPayload,
			},
		},
	}
	definitions = append(definitions, preferencesTopicDefinitions()...)
	definitions = append(definitions, modelGovernanceTopicDefinitions()...)
	definitions = append(definitions, collaborationTopicDefinitions()...)
	definitions = append(definitions, []TopicDefinition{
		{
			Name:               TopicUserProjectUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            2,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateUserProjectUpdatedPayload,
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
			Name:               TopicWorkspaceWorkflowUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateWorkspaceWorkflowUpdatedPayload,
			},
		},
		{
			Name:               TopicWorkspaceTuttiModeUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateWorkspaceTuttiModeUpdatedPayload,
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
	}...)
	return NewStaticCatalog(definitions)
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

type agentModelCatalogInvalidatedPayload struct {
	Providers        []string `json:"providers"`
	OccurredAtUnixMS int64    `json:"occurredAtUnixMs"`
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
	if !preferencesbiz.IsDeletedAgentConversationRetentionDays(decoded.DeletedAgentConversationRetentionDays) {
		return fmt.Errorf("preferences.deletedAgentConversationRetentionDays is unsupported")
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
	if decoded.Preferences.DeletedAgentConversationRetentionDays != 0 &&
		!preferencesbiz.IsDeletedAgentConversationRetentionDays(decoded.Preferences.DeletedAgentConversationRetentionDays) {
		return fmt.Errorf("preferences.deletedAgentConversationRetentionDays is unsupported")
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
	case "session_reconcile_required", "session_deleted", "session_audit", "message_update", "turn_update", "interaction_update":
	default:
		return fmt.Errorf("eventType is unsupported")
	}
	if len(decoded.Data) == 0 || string(decoded.Data) == "null" {
		return fmt.Errorf("data is required")
	}
	return validateAgentActivityUpdatedData(decoded)
}

func validateAgentModelCatalogInvalidatedPayload(payload []byte) error {
	var decoded agentModelCatalogInvalidatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if len(decoded.Providers) == 0 {
		return fmt.Errorf("providers is required")
	}
	for _, provider := range decoded.Providers {
		if strings.TrimSpace(provider) == "" {
			return fmt.Errorf("providers must not contain empty entries")
		}
		if !agentproviderbiz.IsSupported(provider) {
			return fmt.Errorf("providers contains unsupported provider %q", provider)
		}
	}
	if decoded.OccurredAtUnixMS <= 0 {
		return fmt.Errorf("occurredAtUnixMs is required")
	}
	return nil
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
	case "session_reconcile_required":
		var data agentActivitySessionUpdateData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode session_reconcile_required data: %w", err)
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
			if strings.TrimSpace(message.Kind) == "" {
				return fmt.Errorf("data.messages[%d].kind is required", index)
			}
			if strings.TrimSpace(message.Kind) == "session_audit" {
				return fmt.Errorf("data.messages[%d].kind must not be session_audit", index)
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
			if message.Sequence == nil || *message.Sequence == 0 {
				return fmt.Errorf("data.messages[%d].sequence is required", index)
			}
			if message.Version == nil || *message.Version == 0 {
				return fmt.Errorf("data.messages[%d].version is required", index)
			}
			if message.TurnID == nil || strings.TrimSpace(*message.TurnID) == "" {
				return fmt.Errorf("data.messages[%d].turnId is required", index)
			}
			if message.OccurredAtMS == nil || *message.OccurredAtMS <= 0 {
				return fmt.Errorf("data.messages[%d].occurredAtUnixMs is required", index)
			}
		}
	case "session_audit":
		var data agentActivitySessionAuditData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode session_audit data: %w", err)
		}
		if strings.TrimSpace(data.Audit.AuditID) == "" {
			return fmt.Errorf("data.audit.auditId is required")
		}
		if strings.TrimSpace(data.Audit.Role) == "" {
			return fmt.Errorf("data.audit.role is required")
		}
		if data.Audit.Payload == nil {
			return fmt.Errorf("data.audit.payload is required")
		}
		if data.Audit.OccurredAtUnixMS == nil || *data.Audit.OccurredAtUnixMS <= 0 {
			return fmt.Errorf("data.audit.occurredAtUnixMs is required")
		}
		if data.Audit.Version == nil || *data.Audit.Version == 0 {
			return fmt.Errorf("data.audit.version is required")
		}
	case "turn_update":
		if err := requireJSONFields(decoded.Data, "", "occurredAtUnixMs", "activeTurnId", "turn"); err != nil {
			return err
		}
		if err := requireJSONFields(decoded.Data, "turn", "turnId", "agentSessionId", "phase", "origin", "outcome", "error", "fileChanges", "completedCommand", "startedAtUnixMs", "settledAtUnixMs", "updatedAtUnixMs"); err != nil {
			return err
		}
		var data agentActivityTurnUpdateData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode turn_update data: %w", err)
		}
		if data.OccurredAtUnixMS == nil || strings.TrimSpace(data.Turn.TurnID) == "" || data.Turn.AgentSessionID != agentSessionID ||
			!isOneOf(data.Turn.Phase, "submitted", "running", "waiting", "settling", "settled") || data.Turn.StartedAtUnixMS == nil || data.Turn.UpdatedAtUnixMS == nil {
			return fmt.Errorf("data.turn is invalid")
		}
		if !isOneOf(data.Turn.Origin, "user_prompt", "goal_arm", "goal_continuation", "provider_initiated", "legacy_unknown") {
			return fmt.Errorf("data.turn.origin is invalid")
		}
		if data.Turn.SourceGoalOperationID != nil && strings.TrimSpace(*data.Turn.SourceGoalOperationID) == "" {
			return fmt.Errorf("data.turn.sourceGoalOperationId must be non-empty when present")
		}
		if data.Turn.SourceGoalRevision != nil && *data.Turn.SourceGoalRevision < 0 {
			return fmt.Errorf("data.turn.sourceGoalRevision is invalid")
		}
		if data.Turn.SourceGoalRepairEpoch != nil && *data.Turn.SourceGoalRepairEpoch < 0 {
			return fmt.Errorf("data.turn.sourceGoalRepairEpoch is invalid")
		}
		if data.Turn.Outcome != nil && !isOneOf(*data.Turn.Outcome, "completed", "failed", "canceled", "interrupted") {
			return fmt.Errorf("data.turn.outcome is invalid")
		}
		for index, reference := range data.Turn.CapabilityRefs {
			if reference.Capability != "tutti" || reference.Source != "slash_command" {
				return fmt.Errorf("data.turn.capabilityRefs[%d] is invalid", index)
			}
		}
		if data.Turn.Phase == "settled" {
			if data.ActiveTurnID != nil || data.Turn.Outcome == nil || data.Turn.SettledAtUnixMS == nil {
				return fmt.Errorf("settled turn must clear activeTurnId and include outcome/settledAtUnixMs")
			}
		} else if data.ActiveTurnID == nil || strings.TrimSpace(*data.ActiveTurnID) != data.Turn.TurnID || data.Turn.Outcome != nil || data.Turn.SettledAtUnixMS != nil {
			return fmt.Errorf("live turn must own activeTurnId and omit outcome/settledAtUnixMs")
		}
		if data.Turn.Error != nil && (data.Turn.Outcome == nil || !isOneOf(*data.Turn.Outcome, "failed", "interrupted")) {
			return fmt.Errorf("data.turn.error requires failed or interrupted outcome")
		}
	case "interaction_update":
		if err := requireJSONFields(decoded.Data, "", "occurredAtUnixMs", "interaction"); err != nil {
			return err
		}
		if err := requireJSONFields(decoded.Data, "interaction", "requestId", "agentSessionId", "turnId", "kind", "status", "toolName", "input", "output", "metadata", "createdAtUnixMs", "updatedAtUnixMs"); err != nil {
			return err
		}
		var data agentActivityInteractionUpdateData
		if err := decodeJSONStrict(decoded.Data, &data); err != nil {
			return fmt.Errorf("decode interaction_update data: %w", err)
		}
		interaction := data.Interaction
		if data.OccurredAtUnixMS == nil || interaction.AgentSessionID != agentSessionID || strings.TrimSpace(interaction.RequestID) == "" || strings.TrimSpace(interaction.TurnID) == "" ||
			!isOneOf(interaction.Kind, "approval", "question", "plan") || !isOneOf(interaction.Status, "pending", "answered", "superseded") || interaction.CreatedAtUnixMS == nil || interaction.UpdatedAtUnixMS == nil {
			return fmt.Errorf("data.interaction is invalid")
		}
		if *data.OccurredAtUnixMS < 0 || *interaction.CreatedAtUnixMS < 0 || *interaction.UpdatedAtUnixMS < *interaction.CreatedAtUnixMS {
			return fmt.Errorf("data.interaction timestamps are invalid")
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
