package agentruntime

import (
	"context"
	"fmt"
	"strings"
)

// ForkCapabilities resolves capability from the exact adapter/runtime attached
// to source. A provider-wide declaration is intentionally insufficient.
func (c *Controller) ForkCapabilities(
	ctx context.Context,
	source Session,
) (SessionForkCapabilities, error) {
	source, adapter, err := c.sessionForkSource(ctx, source)
	if err != nil {
		return SessionForkCapabilities{}, err
	}
	forkAdapter, ok := adapter.(SessionForkAdapter)
	if !ok {
		return SessionForkCapabilities{}, nil
	}
	capabilities, err := forkAdapter.ForkCapabilities(ctx, source)
	if err != nil {
		return SessionForkCapabilities{}, err
	}
	return capabilities, nil
}

// Fork creates only the provider-native child context. The host remains
// responsible for allocating/copying the canonical AgentSession and attaching
// it after the canonical commit.
func (c *Controller) Fork(
	ctx context.Context,
	input SessionForkInput,
) (SessionForkResult, error) {
	source := input.Source
	releaseLifecycle, err := c.acquireLifecycleLockContext(
		ctx,
		source.RoomID,
		source.AgentSessionID,
	)
	if err != nil {
		return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}, err
	}
	defer releaseLifecycle()

	source, adapter, err := c.sessionForkSource(ctx, source)
	if err != nil {
		return SessionForkResult{
			DeliveryDisposition: SessionForkDeliveryNotStarted,
		}, err
	}
	key := sessionKey(source.RoomID, source.AgentSessionID)
	c.mu.Lock()
	_, active := c.turns[key]
	c.mu.Unlock()
	if active {
		return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}, ErrSessionActiveTurn
	}

	forkAdapter, ok := adapter.(SessionForkAdapter)
	if !ok {
		return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}, ErrSessionForkUnsupported
	}
	capabilities, err := forkAdapter.ForkCapabilities(ctx, source)
	if err != nil {
		return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}, err
	}
	providerTurnID := strings.TrimSpace(input.ProviderTurnID)
	if providerTurnID != "" && !capabilities.ThroughTurn {
		return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}, ErrSessionForkUnsupported
	}
	if providerTurnID == "" && !capabilities.FullSession {
		return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}, ErrSessionForkUnsupported
	}
	input.Source = source
	input.ProviderTurnID = providerTurnID
	return forkAdapter.Fork(ctx, input)
}

func (c *Controller) sessionForkSource(
	ctx context.Context,
	requested Session,
) (Session, Adapter, error) {
	roomID := strings.TrimSpace(requested.RoomID)
	agentSessionID := strings.TrimSpace(requested.AgentSessionID)
	if roomID == "" {
		return Session{}, nil, fmt.Errorf("room id is required")
	}
	if agentSessionID == "" {
		return Session{}, nil, fmt.Errorf("agent session id is required")
	}
	source, ok := c.get(roomID, agentSessionID)
	if !ok {
		// Historical canonical sessions need not be live in the daemon.
		// Session Fork uses a provider-native short connection and must not
		// manufacture a Turn merely to rediscover adapter capability.
		source = requested
		source.RoomID = roomID
		source.AgentSessionID = agentSessionID
	}
	source.Provider = strings.TrimSpace(source.Provider)
	source.ProviderSessionID = strings.TrimSpace(source.ProviderSessionID)
	if source.Provider == "" {
		return Session{}, nil, fmt.Errorf("source provider is required")
	}
	if source.ProviderSessionID == "" {
		return Session{}, nil, fmt.Errorf("source provider session id is required")
	}
	adapter, err := c.resolveAdapter(ctx, AdapterResolveInput{
		Provider:          source.Provider,
		AgentTargetID:     source.AgentTargetID,
		CWD:               source.CWD,
		ProviderTargetRef: clonePayload(source.ProviderTargetRef),
	})
	if err != nil {
		return Session{}, nil, err
	}
	if adapter == nil {
		return Session{}, nil, fmt.Errorf(
			"unsupported agent session provider %q",
			source.Provider,
		)
	}
	return source, adapter, nil
}
