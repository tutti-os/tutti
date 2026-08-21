package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type AgentSidePublisher struct {
	Service *Service
}

type agentSideUpdatedPayload struct {
	WorkspaceID          string          `json:"workspaceId"`
	SideAgentSessionID   string          `json:"sideAgentSessionId"`
	SourceAgentSessionID string          `json:"sourceAgentSessionId"`
	Sequence             int64           `json:"sequence"`
	EventType            string          `json:"eventType"`
	Data                 json.RawMessage `json:"data"`
}

func validateAgentSideUpdatedPayload(payload []byte) error {
	var decoded agentSideUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return err
	}
	if strings.TrimSpace(decoded.WorkspaceID) == "" ||
		strings.TrimSpace(decoded.SideAgentSessionID) == "" ||
		strings.TrimSpace(decoded.SourceAgentSessionID) == "" ||
		decoded.Sequence < 1 || len(decoded.Data) == 0 {
		return fmt.Errorf("agent side updated payload is incomplete")
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(decoded.Data, &data); err != nil || data == nil {
		return fmt.Errorf("agent side updated data must be an object")
	}
	requiredString := func(field string) error {
		var value string
		if raw := data[field]; len(raw) == 0 ||
			json.Unmarshal(raw, &value) != nil ||
			strings.TrimSpace(value) == "" {
			return fmt.Errorf(
				"agent side %s data.%s is required",
				decoded.EventType,
				field,
			)
		}
		return nil
	}
	switch strings.TrimSpace(decoded.EventType) {
	case "message_delta":
		for _, field := range []string{"messageId", "turnId", "role"} {
			if err := requiredString(field); err != nil {
				return err
			}
		}
		if raw := data["content"]; len(raw) > 0 {
			var content struct {
				Operation string `json:"operation"`
			}
			if err := json.Unmarshal(raw, &content); err != nil {
				return fmt.Errorf("agent side message_delta data.content must be an object")
			}
			switch content.Operation {
			case "append_text", "set":
			default:
				return fmt.Errorf("agent side message_delta content operation is unsupported")
			}
		}
		if raw := data["toolOutput"]; len(raw) > 0 {
			var toolOutput struct {
				Operation string  `json:"operation"`
				Text      *string `json:"text"`
			}
			if err := json.Unmarshal(raw, &toolOutput); err != nil ||
				strings.TrimSpace(toolOutput.Operation) == "" ||
				toolOutput.Text == nil {
				return fmt.Errorf("agent side message_delta data.toolOutput is invalid")
			}
		}
		return nil
	case "message_update":
		for _, field := range []string{"messageId", "role"} {
			if err := requiredString(field); err != nil {
				return err
			}
		}
		return nil
	case "state_patch":
		if raw := data["interactionTransition"]; len(raw) > 0 {
			var interaction struct {
				RequestID string `json:"requestId"`
				TurnID    string `json:"turnId"`
				Kind      string `json:"kind"`
				Status    string `json:"status"`
			}
			if err := json.Unmarshal(raw, &interaction); err != nil ||
				strings.TrimSpace(interaction.RequestID) == "" ||
				strings.TrimSpace(interaction.TurnID) == "" ||
				strings.TrimSpace(interaction.Status) == "" {
				return fmt.Errorf("agent side state_patch interactionTransition is invalid")
			}
			switch interaction.Kind {
			case "approval", "question", "plan":
			default:
				return fmt.Errorf("agent side state_patch interaction kind is unsupported")
			}
		}
		return nil
	case "available_commands_update", "config_options_update", "session_audit":
		return nil
	default:
		return fmt.Errorf("unsupported agent side event type %q", decoded.EventType)
	}
}

func (p AgentSidePublisher) PublishAgentSideUpdated(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
	sourceAgentSessionID string,
	sequence int64,
	eventType string,
	data any,
) error {
	if p.Service == nil {
		return nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sideAgentSessionID = strings.TrimSpace(sideAgentSessionID)
	sourceAgentSessionID = strings.TrimSpace(sourceAgentSessionID)
	eventType = strings.TrimSpace(eventType)
	if workspaceID == "" || sideAgentSessionID == "" ||
		sourceAgentSessionID == "" || sequence < 1 || eventType == "" {
		return nil
	}
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal agent side event data: %w", err)
	}
	payload, err := json.Marshal(agentSideUpdatedPayload{
		WorkspaceID: workspaceID, SideAgentSessionID: sideAgentSessionID,
		SourceAgentSessionID: sourceAgentSessionID, Sequence: sequence,
		EventType: eventType, Data: dataJSON,
	})
	if err != nil {
		return fmt.Errorf("marshal agent side updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(
		ctx,
		TopicAgentSideUpdated,
		payload,
		EventScope{WorkspaceID: workspaceID},
	)
}
