package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func (a *CodexAppServerAdapter) ReadEffectiveHistory(
	ctx context.Context,
	session Session,
) (EffectiveHistorySnapshot, error) {
	appSession, threadID, release, err := a.prepareEffectiveHistoryCommand(session)
	if err != nil {
		return EffectiveHistorySnapshot{}, err
	}
	defer release()
	raw, err := appSession.client.ThreadReadNoHandler(ctx, acpStartCallTimeout, map[string]any{
		"threadId":     threadID,
		"includeTurns": true,
	})
	if err != nil {
		return EffectiveHistorySnapshot{}, mapEffectiveHistoryUnsupported(err)
	}
	return decodeCodexEffectiveHistory(raw, threadID)
}

func (a *CodexAppServerAdapter) RollbackLatestTurn(
	ctx context.Context,
	session Session,
) (HistoryMutationResult, error) {
	appSession, threadID, release, err := a.prepareEffectiveHistoryCommand(session)
	if err != nil {
		return HistoryMutationResult{
			Disposition: DispatchDispositionNotDispatched,
		}, err
	}
	defer release()
	raw, err := appSession.client.ThreadRollbackNoHandler(ctx, acpStartCallTimeout, map[string]any{
		"threadId": threadID,
		"numTurns": 1,
	})
	if err != nil {
		disposition := DispatchDispositionOutcomeUnknown
		var callErr *acpCallError
		if errors.As(err, &callErr) {
			disposition = DispatchDispositionRejected
		}
		return HistoryMutationResult{Disposition: disposition}, mapEffectiveHistoryUnsupported(err)
	}
	snapshot, err := decodeCodexEffectiveHistory(raw, threadID)
	if err != nil {
		return HistoryMutationResult{
			Disposition: DispatchDispositionApplied,
		}, err
	}
	return HistoryMutationResult{
		Disposition: DispatchDispositionApplied,
		Snapshot:    &snapshot,
	}, nil
}

func (a *CodexAppServerAdapter) prepareEffectiveHistoryCommand(
	session Session,
) (*codexAppServerSession, string, func(), error) {
	if a == nil {
		return nil, "", nil, ErrSessionDisconnected
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if agentSessionID == "" {
		return nil, "", nil, ErrSessionNotFound
	}
	release := a.lockSessionLifecycle(agentSessionID)
	fail := func(err error) (*codexAppServerSession, string, func(), error) {
		release()
		return nil, "", nil, err
	}
	if a.hasLiveSessionWork(agentSessionID) {
		return fail(ErrSessionActiveTurn)
	}
	appSession := a.getSession(agentSessionID)
	if appSession == nil || appSession.client == nil {
		return fail(ErrSessionDisconnected)
	}
	threadID := strings.TrimSpace(appSession.threadID)
	if threadID == "" || threadID != strings.TrimSpace(session.ProviderSessionID) {
		return fail(errors.New("app-server thread identity does not match the canonical session"))
	}
	return appSession, threadID, release, nil
}

func mapEffectiveHistoryUnsupported(err error) error {
	var callErr *acpCallError
	if errors.As(err, &callErr) && callErr.Err.Code == -32601 {
		return ErrEffectiveHistoryUnsupported
	}
	return err
}

func decodeCodexEffectiveHistory(
	raw json.RawMessage,
	expectedThreadID string,
) (EffectiveHistorySnapshot, error) {
	var response struct {
		Thread struct {
			ID    string `json:"id"`
			Turns []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Items  []struct {
					Type     string  `json:"type"`
					ClientID *string `json:"clientId"`
				} `json:"items"`
			} `json:"turns"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return EffectiveHistorySnapshot{}, fmt.Errorf("decode app-server effective history: %w", err)
	}
	threadID := strings.TrimSpace(response.Thread.ID)
	if threadID == "" || threadID != strings.TrimSpace(expectedThreadID) {
		return EffectiveHistorySnapshot{}, errors.New("app-server effective history returned an unexpected thread")
	}
	turns := make([]EffectiveHistoryTurn, 0, len(response.Thread.Turns))
	seen := make(map[string]struct{}, len(response.Thread.Turns))
	for _, rawTurn := range response.Thread.Turns {
		turnID := strings.TrimSpace(rawTurn.ID)
		if turnID == "" {
			return EffectiveHistorySnapshot{}, errors.New("app-server effective history returned a turn without an id")
		}
		if _, exists := seen[turnID]; exists {
			return EffectiveHistorySnapshot{}, errors.New("app-server effective history returned duplicate turn ids")
		}
		seen[turnID] = struct{}{}
		clientUserMessageID := ""
		for _, item := range rawTurn.Items {
			if strings.TrimSpace(item.Type) != "userMessage" || item.ClientID == nil {
				continue
			}
			nextClientID := strings.TrimSpace(*item.ClientID)
			if nextClientID == "" {
				continue
			}
			if clientUserMessageID != "" && clientUserMessageID != nextClientID {
				return EffectiveHistorySnapshot{}, errors.New(
					"app-server effective history returned conflicting user message client ids",
				)
			}
			clientUserMessageID = nextClientID
		}
		turns = append(turns, EffectiveHistoryTurn{
			ID:                  turnID,
			Status:              strings.TrimSpace(rawTurn.Status),
			ClientUserMessageID: clientUserMessageID,
		})
	}
	return EffectiveHistorySnapshot{
		ProviderSessionID: threadID,
		Turns:             turns,
	}, nil
}

var _ EffectiveHistoryAdapter = (*CodexAppServerAdapter)(nil)
