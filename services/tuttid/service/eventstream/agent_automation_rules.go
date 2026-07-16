package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	eventsgenerated "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
)

const TopicAgentAutomationRulesChanged = "agent.automation.rules.changed"

func validateAgentAutomationRulesChangedPayload(payload []byte) error {
	var decoded eventsgenerated.AgentAutomationRulesChangedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	var requiredFields struct {
		OccurredAtUnixMs *int `json:"occurredAtUnixMs"`
	}
	if err := json.Unmarshal(payload, &requiredFields); err != nil {
		return fmt.Errorf("decode required fields: %w", err)
	}
	if requiredFields.OccurredAtUnixMs == nil {
		return fmt.Errorf("occurredAtUnixMs is required")
	}
	if strings.TrimSpace(decoded.WorkspaceId) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if decoded.OccurredAtUnixMs < 0 {
		return fmt.Errorf("occurredAtUnixMs must not be negative")
	}
	return nil
}

// AgentAutomationRulesPublisher broadcasts automation-rule CRUD changes so
// workspace subscribers can refresh their rule list without polling. Its
// signature matches automationrule.Service's best-effort Publisher contract.
type AgentAutomationRulesPublisher struct {
	Service *Service
	Now     func() time.Time
}

func (p AgentAutomationRulesPublisher) PublishAutomationRulesChanged(workspaceID string) {
	if p.Service == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return
	}
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	payload, err := json.Marshal(eventsgenerated.AgentAutomationRulesChangedPayload{
		WorkspaceId:      workspaceID,
		OccurredAtUnixMs: int(now.UnixMilli()),
	})
	if err != nil {
		slog.Warn("agent automation rules changed payload marshal failed",
			"event", "agent.automation.rules.changed_publish_failed",
			"workspaceId", workspaceID,
			"error", err,
		)
		return
	}
	if err := p.Service.PublishFromServerScoped(
		context.Background(),
		TopicAgentAutomationRulesChanged,
		payload,
		EventScope{WorkspaceID: workspaceID},
	); err != nil {
		slog.Warn("agent automation rules changed publish failed",
			"event", "agent.automation.rules.changed_publish_failed",
			"workspaceId", workspaceID,
			"error", err,
		)
	}
}
