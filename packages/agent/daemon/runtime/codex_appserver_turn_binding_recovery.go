package agentruntime

import (
	"context"
	"errors"
	"strings"
)

func (a *CodexAppServerAdapter) RecoverProviderTurnBinding(
	ctx context.Context,
	input ProviderTurnBindingRecoveryInput,
) (ProviderTurnBindingRecoveryResult, error) {
	token := strings.TrimSpace(input.RecoveryToken)
	source := input.Source
	expectedThreadID := strings.TrimSpace(source.ProviderSessionID)
	if a == nil || expectedThreadID == "" || token == "" {
		// Codex thread/read is authoritative for clientUserMessageId. Old
		// history without that identity has no equally authoritative text shape
		// in the stable protocol, so it must fail closed.
		return ProviderTurnBindingRecoveryResult{},
			errors.New("codex provider turn recovery token is unavailable")
	}
	trace := newCodexAppServerStartupTrace(source, a.startupSpanObserver, nil)
	client, _, err := a.startInitializedClient(ctx, source, trace)
	if err != nil {
		trace.Finish(err)
		return ProviderTurnBindingRecoveryResult{}, err
	}
	defer client.Close()
	raw, err := client.ThreadReadNoHandler(
		ctx,
		acpStartCallTimeout,
		map[string]any{
			"threadId":     expectedThreadID,
			"includeTurns": true,
		},
	)
	trace.Finish(err)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, err
	}
	history, err := decodeCodexEffectiveHistory(raw, expectedThreadID)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, err
	}
	var matched EffectiveHistoryTurn
	matchCount := 0
	for _, turn := range history.Turns {
		if strings.TrimSpace(turn.ClientUserMessageID) != token {
			continue
		}
		switch strings.TrimSpace(turn.Status) {
		case "completed", "failed", "interrupted", "canceled", "cancelled":
		default:
			return ProviderTurnBindingRecoveryResult{},
				errors.New("codex provider turn recovery matched a nonterminal turn")
		}
		matched = turn
		matchCount++
	}
	if matchCount != 1 || strings.TrimSpace(matched.ID) == "" {
		return ProviderTurnBindingRecoveryResult{},
			errors.New("codex provider turn recovery token is absent or ambiguous")
	}
	result := ProviderTurnBindingRecoveryResult{
		ProviderSessionID: expectedThreadID,
		ProviderTurnID:    strings.TrimSpace(matched.ID),
	}
	result.ProviderTurnBindingJSON, err = a.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteRecovered,
			ProviderTurnID: result.ProviderTurnID,
		},
	)
	if err != nil {
		return ProviderTurnBindingRecoveryResult{}, err
	}
	return result, nil
}

var _ ProviderTurnBindingRecoveryAdapter = (*CodexAppServerAdapter)(nil)
