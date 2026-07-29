package agentruntime

import (
	"context"
	"errors"
	"strings"
)

var ErrEffectiveHistoryUnsupported = errors.New("agent provider does not support effective history mutation")

type EffectiveHistoryInput struct {
	RoomID         string
	AgentSessionID string
	Provider       string
}

func (c *Controller) SupportsEffectiveHistory(
	_ context.Context,
	input EffectiveHistoryInput,
) (bool, error) {
	if c == nil {
		return false, nil
	}
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		if session, found := c.get(
			strings.TrimSpace(input.RoomID),
			strings.TrimSpace(input.AgentSessionID),
		); found {
			provider = strings.TrimSpace(session.Provider)
		}
	}
	if provider == "" {
		return false, nil
	}
	_, supported := c.adapter(provider).(EffectiveHistoryAdapter)
	return supported, nil
}

func (c *Controller) ReadEffectiveHistory(
	ctx context.Context,
	input EffectiveHistoryInput,
) (EffectiveHistorySnapshot, error) {
	session, adapter, release, err := c.prepareEffectiveHistoryCommand(ctx, input)
	if err != nil {
		return EffectiveHistorySnapshot{}, err
	}
	defer release()
	return adapter.ReadEffectiveHistory(ctx, session)
}

func (c *Controller) RollbackLatestTurn(
	ctx context.Context,
	input EffectiveHistoryInput,
) (HistoryMutationResult, error) {
	session, adapter, release, err := c.prepareEffectiveHistoryCommand(ctx, input)
	if err != nil {
		return HistoryMutationResult{
			Disposition: DispatchDispositionNotDispatched,
		}, err
	}
	defer release()
	return adapter.RollbackLatestTurn(ctx, session)
}

func (c *Controller) prepareEffectiveHistoryCommand(
	ctx context.Context,
	input EffectiveHistoryInput,
) (Session, EffectiveHistoryAdapter, func(), error) {
	input.RoomID = strings.TrimSpace(input.RoomID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	if c == nil || input.RoomID == "" || input.AgentSessionID == "" {
		return Session{}, nil, nil, ErrSessionNotFound
	}
	release, err := c.acquireLifecycleLockContext(ctx, input.RoomID, input.AgentSessionID)
	if err != nil {
		return Session{}, nil, nil, err
	}
	fail := func(err error) (Session, EffectiveHistoryAdapter, func(), error) {
		release()
		return Session{}, nil, nil, err
	}
	if c.HasActiveTurn(input.RoomID, input.AgentSessionID) {
		return fail(ErrSessionActiveTurn)
	}
	session, rawAdapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return fail(err)
	}
	if input.Provider != "" && strings.TrimSpace(session.Provider) != strings.TrimSpace(input.Provider) {
		return fail(errors.New("provider changed while preparing effective history command"))
	}
	adapter, ok := rawAdapter.(EffectiveHistoryAdapter)
	if !ok {
		return fail(ErrEffectiveHistoryUnsupported)
	}
	if err := c.ensureLiveAdapterSession(ctx, session, rawAdapter); err != nil {
		return fail(err)
	}
	if refreshed, found := c.get(input.RoomID, input.AgentSessionID); found {
		session = refreshed
	}
	return session, adapter, release, nil
}
