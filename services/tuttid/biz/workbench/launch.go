package workbench

import (
	"encoding/json"
	"strings"
)

type NodeLaunchRequest struct {
	WorkspaceID  string
	TypeID       string
	Source       string
	LaunchSource string
	DockEntryID  string
	RequestID    string
	Payload      json.RawMessage
}

func NormalizeNodeLaunchRequest(input NodeLaunchRequest) NodeLaunchRequest {
	source := strings.TrimSpace(input.Source)
	if source == "" {
		source = "cli"
	}
	return NodeLaunchRequest{
		WorkspaceID:  strings.TrimSpace(input.WorkspaceID),
		TypeID:       strings.TrimSpace(input.TypeID),
		Source:       source,
		LaunchSource: strings.TrimSpace(input.LaunchSource),
		DockEntryID:  strings.TrimSpace(input.DockEntryID),
		RequestID:    strings.TrimSpace(input.RequestID),
		Payload:      input.Payload,
	}
}
