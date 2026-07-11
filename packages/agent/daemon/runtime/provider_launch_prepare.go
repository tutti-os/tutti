package agentruntime

import (
	"context"
	"log/slog"
	"sync"
)

type ProviderLaunchPrepareInput struct {
	Provider    string
	Session     Session
	Command     []string
	Env         []string
	CWD         string
	DirectStart bool
}

type ProviderLaunchPrepareResult struct {
	Command []string
	Env     []string
	CWD     string
	Cleanup func(context.Context) error
}

type ProviderLaunchPreparer func(context.Context, ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error)

type ProviderLaunchPreparerAdapter interface {
	SetProviderLaunchPreparer(ProviderLaunchPreparer)
}

func setProviderLaunchPreparer(adapters []Adapter, preparer ProviderLaunchPreparer) {
	ApplyProviderLaunchPreparer(adapters, preparer)
}

func ApplyProviderLaunchPreparer(adapters []Adapter, preparer ProviderLaunchPreparer) {
	if preparer == nil {
		return
	}
	for _, adapter := range adapters {
		if setter, ok := adapter.(ProviderLaunchPreparerAdapter); ok {
			setter.SetProviderLaunchPreparer(preparer)
		}
	}
}

func prepareProviderLaunch(
	ctx context.Context,
	preparer ProviderLaunchPreparer,
	session Session,
	spec ProcessSpec,
) (ProcessSpec, func(context.Context), error) {
	spec.Command = append([]string(nil), spec.Command...)
	spec.Env = append([]string(nil), spec.Env...)
	if preparer == nil {
		return spec, nil, nil
	}
	result, err := preparer(ctx, ProviderLaunchPrepareInput{
		Provider:    spec.Provider,
		Session:     cloneProviderLaunchSession(session),
		Command:     append([]string(nil), spec.Command...),
		Env:         append([]string(nil), spec.Env...),
		CWD:         spec.CWD,
		DirectStart: spec.DirectStart,
	})
	if err != nil {
		return ProcessSpec{}, nil, err
	}
	spec.Command = append([]string(nil), result.Command...)
	spec.Env = append([]string(nil), result.Env...)
	spec.CWD = result.CWD
	return spec, providerLaunchCleanup(spec, result.Cleanup), nil
}

func cloneProviderLaunchSession(session Session) Session {
	session.Env = append([]string(nil), session.Env...)
	session.RuntimeContext = clonePayload(session.RuntimeContext)
	session.ProviderTargetRef = clonePayload(session.ProviderTargetRef)
	if session.Settings != nil {
		session.Settings = cloneSessionSettings(*session.Settings)
	}
	return session
}

func providerLaunchCleanup(spec ProcessSpec, cleanup func(context.Context) error) func(context.Context) {
	if cleanup == nil {
		return nil
	}
	var once sync.Once
	return func(ctx context.Context) {
		once.Do(func() {
			if ctx == nil {
				ctx = context.Background()
			}
			if err := cleanup(ctx); err != nil {
				slog.Warn("agent session provider launch cleanup failed",
					"event", "agent_session.provider_launch.cleanup_failed",
					"provider", spec.Provider,
					"room_id", spec.RoomID,
					"agent_session_id", spec.AgentSessionID,
					"error", err.Error(),
				)
			}
		})
	}
}

func cleanupPreparedLaunch(cleanup func(context.Context)) {
	if cleanup != nil {
		cleanup(context.Background())
	}
}

func wrapProviderLaunchCleanup(conn ProcessConnection, cleanup func(context.Context)) ProcessConnection {
	if conn == nil || cleanup == nil {
		return conn
	}
	wrapped := &providerLaunchCleanupConnection{
		ProcessConnection: conn,
		cleanup:           cleanup,
	}
	if graceful, ok := conn.(GracefulProcessConnection); ok {
		return &providerLaunchCleanupGracefulConnection{
			providerLaunchCleanupConnection: wrapped,
			graceful:                        graceful,
		}
	}
	return wrapped
}

type providerLaunchCleanupConnection struct {
	ProcessConnection
	cleanup func(context.Context)
}

func (c *providerLaunchCleanupConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	if contextual, ok := c.ProcessConnection.(ContextProcessConnection); ok {
		return contextual.RecvContext(ctx)
	}
	return c.Recv()
}

func (c *providerLaunchCleanupConnection) Close() error {
	if c == nil {
		return nil
	}
	err := c.ProcessConnection.Close()
	c.cleanup(context.Background())
	return err
}

type providerLaunchCleanupGracefulConnection struct {
	*providerLaunchCleanupConnection
	graceful GracefulProcessConnection
}

func (c *providerLaunchCleanupGracefulConnection) CloseInput() error {
	return c.graceful.CloseInput()
}

func (c *providerLaunchCleanupGracefulConnection) Terminate() error {
	return c.graceful.Terminate()
}

func (c *providerLaunchCleanupGracefulConnection) Kill() error {
	return c.graceful.Kill()
}
