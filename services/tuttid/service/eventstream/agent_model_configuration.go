package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	eventsgenerated "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
)

const TopicAgentModelConfigurationChanged = "agent.model.configuration.changed"

func validateAgentModelConfigurationChangedPayload(payload []byte) error {
	var decoded eventsgenerated.AgentModelConfigurationChangedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	var requiredFields struct {
		ResetComposerModel *bool `json:"resetComposerModel"`
		OccurredAtUnixMs   *int  `json:"occurredAtUnixMs"`
	}
	if err := json.Unmarshal(payload, &requiredFields); err != nil {
		return fmt.Errorf("decode required fields: %w", err)
	}
	if requiredFields.ResetComposerModel == nil {
		return fmt.Errorf("resetComposerModel is required")
	}
	if requiredFields.OccurredAtUnixMs == nil {
		return fmt.Errorf("occurredAtUnixMs is required")
	}
	if strings.TrimSpace(decoded.WorkspaceId) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if len(decoded.AgentTargetIds) == 0 {
		return fmt.Errorf("agentTargetIds is required")
	}
	if decoded.DefaultModels == nil {
		return fmt.Errorf("defaultModels is required")
	}
	seen := make(map[string]struct{}, len(decoded.AgentTargetIds))
	for _, agentTargetID := range decoded.AgentTargetIds {
		agentTargetID = strings.TrimSpace(agentTargetID)
		if agentTargetID == "" {
			return fmt.Errorf("agentTargetIds must not contain empty entries")
		}
		if _, ok := seen[agentTargetID]; ok {
			return fmt.Errorf("agentTargetIds must not contain duplicate entries")
		}
		seen[agentTargetID] = struct{}{}
		if _, ok := decoded.DefaultModels[agentTargetID]; !ok {
			return fmt.Errorf("defaultModels must include %q", agentTargetID)
		}
	}
	for agentTargetID := range decoded.DefaultModels {
		trimmed := strings.TrimSpace(agentTargetID)
		if _, ok := seen[trimmed]; !ok || trimmed != agentTargetID {
			return fmt.Errorf("defaultModels contains unexpected agent target %q", agentTargetID)
		}
	}
	if decoded.OccurredAtUnixMs < 0 {
		return fmt.Errorf("occurredAtUnixMs must not be negative")
	}
	return nil
}

// AgentModelConfigurationPublisher broadcasts model-plan and binding changes
// to the workspace GUI. Subscribers re-fetch composer options for the affected
// agent targets and, when requested, discard a model selected from stale
// configuration.
type AgentModelConfigurationPublisher struct {
	Service *Service
	Now     func() time.Time
}

func (p AgentModelConfigurationPublisher) PublishAgentModelConfigurationChanged(
	ctx context.Context,
	workspaceID string,
	agentTargetIDs []string,
	defaultModels map[string]string,
	resetComposerModel bool,
) error {
	if p.Service == nil {
		return nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return fmt.Errorf("workspace id is required")
	}
	normalizedTargetIDs := make([]string, 0, len(agentTargetIDs))
	seen := make(map[string]struct{}, len(agentTargetIDs))
	for _, agentTargetID := range agentTargetIDs {
		agentTargetID = strings.TrimSpace(agentTargetID)
		if agentTargetID == "" {
			continue
		}
		if _, ok := seen[agentTargetID]; ok {
			continue
		}
		seen[agentTargetID] = struct{}{}
		normalizedTargetIDs = append(normalizedTargetIDs, agentTargetID)
	}
	if len(normalizedTargetIDs) == 0 {
		return nil
	}
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	payload, err := json.Marshal(eventsgenerated.AgentModelConfigurationChangedPayload{
		WorkspaceId:        workspaceID,
		AgentTargetIds:     normalizedTargetIDs,
		DefaultModels:      normalizeDefaultModels(normalizedTargetIDs, defaultModels),
		ResetComposerModel: resetComposerModel,
		OccurredAtUnixMs:   int(now.UnixMilli()),
	})
	if err != nil {
		return fmt.Errorf("marshal agent model configuration changed payload: %w", err)
	}
	if err := p.Service.PublishFromServerScoped(
		ctx,
		TopicAgentModelConfigurationChanged,
		payload,
		EventScope{WorkspaceID: workspaceID},
	); err != nil {
		return fmt.Errorf("publish %s: %w", TopicAgentModelConfigurationChanged, err)
	}
	return nil
}

func normalizeDefaultModels(agentTargetIDs []string, defaultModels map[string]string) map[string]string {
	normalized := make(map[string]string, len(agentTargetIDs))
	for _, agentTargetID := range agentTargetIDs {
		normalized[agentTargetID] = strings.TrimSpace(defaultModels[agentTargetID])
	}
	return normalized
}
