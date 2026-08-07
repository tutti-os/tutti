package agentruntime

import (
	"context"
	"errors"
	"strings"
)

func (a *ClaudeCodeSDKAdapter) RecoverProviderTurnBinding(
	ctx context.Context,
	input ProviderTurnBindingRecoveryInput,
) (ProviderTurnBindingRecoveryResult, error) {
	expectedSessionID := strings.TrimSpace(input.Source.ProviderSessionID)
	if a == nil || a.transport == nil || expectedSessionID == "" {
		return ProviderTurnBindingRecoveryResult{},
			errors.New("claude provider turn recovery source is unavailable")
	}
	if strings.TrimSpace(input.RecoveryToken) == "" &&
		(strings.TrimSpace(input.LegacyTextHMACKey) == "" ||
			strings.TrimSpace(input.LegacyTextHMACDigest) == "") {
		return ProviderTurnBindingRecoveryResult{},
			errors.New("claude provider turn recovery proof is unavailable")
	}
	event, _, err := a.statelessClaudeSDKForkRequest(
		ctx,
		input.Source,
		claudeSDKSidecarRequest{
			ID:   newID(),
			Type: "recover_turn_binding",
			Payload: map[string]any{
				"providerSessionId":    expectedSessionID,
				"recoveryToken":        strings.TrimSpace(input.RecoveryToken),
				"legacyTextHmacKey":    strings.TrimSpace(input.LegacyTextHMACKey),
				"legacyTextHmacDigest": strings.TrimSpace(input.LegacyTextHMACDigest),
				"cwd":                  strings.TrimSpace(input.Source.CWD),
			},
		},
	)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, err
	}
	result := ProviderTurnBindingRecoveryResult{
		ProviderSessionID: strings.TrimSpace(
			payloadString(event.Payload, "providerSessionId"),
		),
		ProviderTurnID: strings.TrimSpace(
			payloadString(event.Payload, "providerTurnId"),
		),
	}
	checkpointMessageID := strings.TrimSpace(
		payloadString(event.Payload, "providerCheckpointMessageId"),
	)
	if result.ProviderSessionID != expectedSessionID ||
		result.ProviderTurnID == "" ||
		checkpointMessageID == "" {
		return ProviderTurnBindingRecoveryResult{},
			errors.New("claude provider turn recovery returned incomplete identity")
	}
	result.ProviderTurnBindingJSON, err = a.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteRecovered,
			ProviderTurnID: result.ProviderTurnID,
			Payload: map[string]any{
				"checkpointMessageId": checkpointMessageID,
			},
		},
	)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, err
	}
	return result, nil
}

var _ ProviderTurnBindingRecoveryAdapter = (*ClaudeCodeSDKAdapter)(nil)
