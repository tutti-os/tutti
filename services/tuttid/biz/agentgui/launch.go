package agentgui

import "strings"

type LaunchRequest struct {
	WorkspaceID    string
	AgentSessionID string
	AgentTargetID  string
	Provider       string
	Source         string
	Reason         string
	RequestID      string
}

func NormalizeLaunchRequest(input LaunchRequest) LaunchRequest {
	source := strings.TrimSpace(input.Source)
	if source == "" {
		source = "cli"
	}
	return LaunchRequest{
		WorkspaceID:    strings.TrimSpace(input.WorkspaceID),
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
		AgentTargetID:  strings.TrimSpace(input.AgentTargetID),
		Provider:       strings.TrimSpace(input.Provider),
		Source:         source,
		Reason:         strings.TrimSpace(input.Reason),
		RequestID:      strings.TrimSpace(input.RequestID),
	}
}
