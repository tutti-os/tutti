package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

const (
	providerTurnBindingSchemaVersion       = 1
	claudeProviderTurnBindingSchemaVersion = 2
)

type claudeProviderTurnBinding struct {
	SchemaVersion             int    `json:"schemaVersion"`
	ProviderSessionID         string `json:"providerSessionId,omitempty"`
	ContextRecoveryGeneration int64  `json:"contextRecoveryGeneration,omitempty"`
	CheckpointMessageID       string `json:"checkpointMessageId,omitempty"`
}

func (*ClaudeCodeSDKAdapter) WriteProviderTurnBinding(
	input ProviderTurnBindingWriteInput,
) (json.RawMessage, error) {
	if strings.TrimSpace(input.ProviderTurnID) == "" {
		return nil, errors.New("claude provider turn id is required")
	}
	binding := claudeProviderTurnBinding{
		SchemaVersion:             claudeProviderTurnBindingSchemaVersion,
		ProviderSessionID:         strings.TrimSpace(input.Source.ProviderSessionID),
		ContextRecoveryGeneration: claudeSDKContextRecoveryFromRuntimeContext(input.Source.RuntimeContext).Generation,
	}
	if binding.ProviderSessionID == "" {
		return nil, errors.New("claude provider session id is required")
	}
	if input.Payload != nil {
		binding.CheckpointMessageID = strings.TrimSpace(
			stringValue(input.Payload["checkpointMessageId"]),
		)
	}
	return json.Marshal(binding)
}

func (*ClaudeCodeSDKAdapter) CanForkProviderTurn(
	_ context.Context,
	input ProviderTurnForkabilityInput,
) (bool, error) {
	if strings.TrimSpace(input.ProviderTurnID) == "" {
		return false, nil
	}
	var binding claudeProviderTurnBinding
	if err := json.Unmarshal(input.ProviderTurnBindingJSON, &binding); err != nil {
		return false, nil
	}
	if strings.TrimSpace(binding.CheckpointMessageID) == "" {
		return false, nil
	}
	return claudeProviderTurnBindingMatchesSource(binding, input.Source), nil
}

func claudeProviderTurnBindingMatchesSource(
	binding claudeProviderTurnBinding,
	source Session,
) bool {
	generation := claudeSDKContextRecoveryFromRuntimeContext(
		source.RuntimeContext,
	).Generation
	switch binding.SchemaVersion {
	case providerTurnBindingSchemaVersion:
		// Historical v1 bindings predate provider-session identity. They remain
		// usable only before the first rollover; afterwards they fail closed.
		return generation == 0
	case claudeProviderTurnBindingSchemaVersion:
		return strings.TrimSpace(binding.ProviderSessionID) != "" &&
			binding.ProviderSessionID == strings.TrimSpace(source.ProviderSessionID) &&
			binding.ContextRecoveryGeneration == generation
	default:
		return false
	}
}

type appServerProviderTurnBinding struct {
	SchemaVersion int `json:"schemaVersion"`
}

func (*CodexAppServerAdapter) WriteProviderTurnBinding(
	input ProviderTurnBindingWriteInput,
) (json.RawMessage, error) {
	if strings.TrimSpace(input.ProviderTurnID) == "" {
		return nil, errors.New("app-server provider turn id is required")
	}
	return json.Marshal(appServerProviderTurnBinding{
		SchemaVersion: providerTurnBindingSchemaVersion,
	})
}

func (*CodexAppServerAdapter) CanForkProviderTurn(
	_ context.Context,
	input ProviderTurnForkabilityInput,
) (bool, error) {
	if strings.TrimSpace(input.ProviderTurnID) == "" {
		return false, nil
	}
	var binding appServerProviderTurnBinding
	if err := json.Unmarshal(input.ProviderTurnBindingJSON, &binding); err != nil {
		return false, nil
	}
	return binding.SchemaVersion == providerTurnBindingSchemaVersion, nil
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

var (
	_ ProviderTurnBindingAdapter = (*ClaudeCodeSDKAdapter)(nil)
	_ ProviderTurnBindingAdapter = (*CodexAppServerAdapter)(nil)
)

func (c *Controller) providerTurnBindingJSON(
	ctx context.Context,
	session Session,
	input ProviderTurnBindingWriteInput,
) json.RawMessage {
	if c == nil {
		return nil
	}
	adapter, err := c.resolveAdapter(ctx, AdapterResolveInput{
		Provider:          strings.TrimSpace(session.Provider),
		AgentTargetID:     session.AgentTargetID,
		CWD:               session.CWD,
		ProviderTargetRef: clonePayload(session.ProviderTargetRef),
	})
	if err != nil {
		return nil
	}
	writer, ok := adapter.(ProviderTurnBindingAdapter)
	if !ok {
		return nil
	}
	input.Source = session
	binding, err := writer.WriteProviderTurnBinding(input)
	if err != nil {
		return nil
	}
	return binding
}
