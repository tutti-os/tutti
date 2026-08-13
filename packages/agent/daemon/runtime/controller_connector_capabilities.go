package agentruntime

import (
	"context"
	"strings"
)

type ConnectorCapabilityInput struct {
	RoomID            string
	AgentSessionID    string
	AgentTargetID     string
	Provider          string
	CWD               string
	Env               []string
	ProviderTargetRef map[string]any
	PermissionModeID  string
	Settings          *SessionSettings
}

// ConnectorCapabilities resolves the exact adapter that will own the session
// and asks it for explicit Connector transport support. Unknown and future
// adapters fail closed to an ordinary, Connector-free session.
func (c *Controller) ConnectorCapabilities(
	ctx context.Context,
	input ConnectorCapabilityInput,
) (ConnectorCapabilities, error) {
	provider := strings.TrimSpace(input.Provider)
	adapter, err := c.resolveAdapter(ctx, AdapterResolveInput{
		Provider:          provider,
		AgentTargetID:     strings.TrimSpace(input.AgentTargetID),
		CWD:               strings.TrimSpace(input.CWD),
		ProviderTargetRef: clonePayload(input.ProviderTargetRef),
	})
	if err != nil {
		return ConnectorCapabilities{}, err
	}
	capabilityAdapter, ok := adapter.(ConnectorCapabilityAdapter)
	if !ok {
		return ConnectorCapabilities{}, nil
	}
	return capabilityAdapter.ConnectorCapabilities(ctx, Session{
		RoomID:             strings.TrimSpace(input.RoomID),
		AgentSessionID:     strings.TrimSpace(input.AgentSessionID),
		RootAgentSessionID: strings.TrimSpace(input.AgentSessionID),
		AgentTargetID:      strings.TrimSpace(input.AgentTargetID),
		Provider:           provider,
		CWD:                strings.TrimSpace(input.CWD),
		Env:                append([]string(nil), input.Env...),
		ProviderTargetRef:  clonePayload(input.ProviderTargetRef),
		PermissionModeID:   strings.TrimSpace(input.PermissionModeID),
		Settings:           cloneOptionalSessionSettings(input.Settings),
	})
}
