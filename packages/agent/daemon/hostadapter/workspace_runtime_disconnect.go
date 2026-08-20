package hostadapter

import (
	"context"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

type runtimeWorkspaceDisconnectBackend interface {
	RuntimeSessions(context.Context, string) ([]agentruntime.Session, error)
	DisconnectRuntimeSession(context.Context, string, string) (agentruntime.DisconnectRuntimeSessionResult, error)
}

type runtimeWorkspaceDisconnectTargetBackend interface {
	SnapshotRuntimeDisconnectTargets(string) []agentruntime.RuntimeDisconnectTarget
	DisconnectRuntimeSessionTarget(context.Context, agentruntime.RuntimeDisconnectTarget) (agentruntime.DisconnectRuntimeSessionResult, error)
}

func (a *RuntimeController) WorkspaceRuntimeSessions(ctx context.Context, workspaceID string) ([]host.ProviderRuntimeSession, error) {
	if a == nil || a.Backend == nil {
		return nil, host.ErrWorkspaceDisconnectUnavailable
	}
	backend, ok := a.Backend.(runtimeWorkspaceDisconnectBackend)
	if !ok {
		return nil, host.ErrWorkspaceDisconnectUnavailable
	}
	sessions, err := backend.RuntimeSessions(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, mapRuntimeError(err)
	}
	result := make([]host.ProviderRuntimeSession, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, a.sessionWithState(session))
	}
	return result, nil
}

func (a *RuntimeController) DisconnectRuntimeSession(
	ctx context.Context,
	ref host.SessionRef,
) (bool, error) {
	if err := a.requireBackend(); err != nil {
		return false, err
	}
	backend, ok := a.Backend.(runtimeWorkspaceDisconnectBackend)
	if !ok {
		return false, host.ErrWorkspaceDisconnectUnavailable
	}
	result, err := backend.DisconnectRuntimeSession(
		ctx,
		strings.TrimSpace(ref.WorkspaceID),
		strings.TrimSpace(ref.AgentSessionID),
	)
	return result.Disconnected, mapRuntimeError(err)
}

func (a *RuntimeController) SnapshotWorkspaceRuntimeDisconnectTargets(workspaceID string) []host.RuntimeDisconnectTarget {
	if a == nil || a.Backend == nil {
		return nil
	}
	backend, ok := a.Backend.(runtimeWorkspaceDisconnectTargetBackend)
	if !ok {
		return nil
	}
	targets := backend.SnapshotRuntimeDisconnectTargets(strings.TrimSpace(workspaceID))
	result := make([]host.RuntimeDisconnectTarget, 0, len(targets))
	for _, target := range targets {
		result = append(result, host.RuntimeDisconnectTarget{
			WorkspaceID: target.RoomID, AgentSessionID: target.AgentSessionID,
			ConnectionGeneration: target.ConnectionGeneration,
		})
	}
	return result
}

func (a *RuntimeController) DisconnectRuntimeSessionTarget(
	ctx context.Context,
	target host.RuntimeDisconnectTarget,
) (bool, error) {
	if a == nil || a.Backend == nil {
		return false, host.ErrWorkspaceDisconnectUnavailable
	}
	backend, ok := a.Backend.(runtimeWorkspaceDisconnectTargetBackend)
	if !ok {
		return false, host.ErrWorkspaceDisconnectUnavailable
	}
	result, err := backend.DisconnectRuntimeSessionTarget(ctx, agentruntime.RuntimeDisconnectTarget{
		RoomID: target.WorkspaceID, AgentSessionID: target.AgentSessionID,
		ConnectionGeneration: target.ConnectionGeneration,
	})
	return result.Disconnected, mapRuntimeError(err)
}
