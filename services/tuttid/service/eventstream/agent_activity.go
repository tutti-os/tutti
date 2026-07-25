package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type AgentActivityPublisher struct {
	Service *Service
}

func (p AgentActivityPublisher) PublishAgentActivityUpdated(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	eventType string,
	data map[string]any,
) error {
	if p.Service == nil {
		return nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return nil
	}
	if data == nil {
		data = map[string]any{}
	}
	if _, ok := data["workspaceId"]; !ok {
		data["workspaceId"] = workspaceID
	}
	if _, ok := data["agentSessionId"]; !ok {
		data["agentSessionId"] = agentSessionID
	}
	eventType = strings.TrimSpace(eventType)
	if _, ok := data["eventType"]; !ok {
		data["eventType"] = eventType
	}
	dataPayload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal agent activity updated data: %w", err)
	}
	return p.publishAgentActivityUpdatedJSON(
		ctx,
		workspaceID,
		agentSessionID,
		eventType,
		dataPayload,
	)
}

// PublishAgentActivityUpdatedJSON preserves an already-validated live
// projection byte-for-byte. This avoids decoding opaque payload values through
// map[string]any merely to wrap them in the public WebSocket event envelope.
func (p AgentActivityPublisher) PublishAgentActivityUpdatedJSON(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	eventType string,
	data json.RawMessage,
) error {
	if p.Service == nil {
		return nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	eventType = strings.TrimSpace(eventType)
	if workspaceID == "" || agentSessionID == "" || eventType == "" || len(data) == 0 {
		return nil
	}
	return p.publishAgentActivityUpdatedJSON(
		ctx,
		workspaceID,
		agentSessionID,
		eventType,
		append(json.RawMessage(nil), data...),
	)
}

func (p AgentActivityPublisher) publishAgentActivityUpdatedJSON(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	eventType string,
	data json.RawMessage,
) error {
	payload, err := json.Marshal(agentActivityUpdatedPayload{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		EventType:      eventType,
		Data:           data,
	})
	if err != nil {
		return fmt.Errorf("marshal agent activity updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(
		ctx,
		TopicAgentActivityUpdated,
		payload,
		EventScope{WorkspaceID: workspaceID},
	)
}
