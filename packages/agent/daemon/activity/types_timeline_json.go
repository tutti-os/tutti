package agentsessionstore

import "encoding/json"

func (i *WorkspaceAgentTimelineItem) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID               flexibleUint64 `json:"id"`
		RoomID           string         `json:"roomId"`
		AgentSessionID   string         `json:"agentSessionId"`
		TurnID           string         `json:"turnId"`
		EventSource      string         `json:"eventSource"`
		EventID          string         `json:"eventId"`
		ActorType        string         `json:"actorType"`
		ActorID          string         `json:"actorId"`
		ItemType         string         `json:"itemType"`
		Role             string         `json:"role"`
		CallType         string         `json:"callType"`
		CallID           string         `json:"callId"`
		Name             string         `json:"name"`
		Status           string         `json:"status"`
		Payload          map[string]any `json:"payload,omitempty"`
		OccurredAtUnixMS flexibleInt64  `json:"occurredAtUnixMs"`
		CreatedAtUnixMS  flexibleInt64  `json:"createdAtUnixMs"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*i = WorkspaceAgentTimelineItem{
		ID:               uint64(raw.ID),
		RoomID:           raw.RoomID,
		AgentSessionID:   raw.AgentSessionID,
		TurnID:           raw.TurnID,
		EventSource:      raw.EventSource,
		EventID:          raw.EventID,
		ActorType:        raw.ActorType,
		ActorID:          raw.ActorID,
		ItemType:         raw.ItemType,
		Role:             raw.Role,
		CallType:         raw.CallType,
		CallID:           raw.CallID,
		Name:             raw.Name,
		Status:           raw.Status,
		Payload:          raw.Payload,
		OccurredAtUnixMS: int64(raw.OccurredAtUnixMS),
		CreatedAtUnixMS:  int64(raw.CreatedAtUnixMS),
	}
	return nil
}
