package agent

import (
	"context"
	"errors"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (p *ActivityProjection) SessionDeleted(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	if p == nil || p.repo == nil {
		return false, nil
	}
	return p.repo.SessionDeleted(ctx, workspaceID, agentSessionID)
}

func (p *ActivityProjection) AgentSessionIDExists(
	ctx context.Context,
	agentSessionID string,
) (bool, error) {
	if p == nil || p.repo == nil {
		return false, ErrInvalidArgument
	}
	reader, ok := p.repo.(GlobalAgentSessionIdentityReader)
	if !ok {
		return false, errors.New("global agent session identity reader is unavailable")
	}
	return reader.AgentSessionIDExists(ctx, strings.TrimSpace(agentSessionID))
}

func (p *ActivityProjection) OtherWorkspaceLiveAgentSessionIDExists(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	if p == nil || p.repo == nil {
		return false, ErrInvalidArgument
	}
	reader, ok := p.repo.(GlobalAgentSessionIdentityReader)
	if !ok {
		return false, errors.New("global agent session identity reader is unavailable")
	}
	return reader.OtherWorkspaceLiveAgentSessionIDExists(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(agentSessionID),
	)
}

func (p *ActivityProjection) ListDeletedSessions(
	ctx context.Context,
	input agentactivitybiz.ListDeletedSessionsInput,
) (agentactivitybiz.DeletedSessionPage, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.DeletedSessionPage{}, ErrInvalidArgument
	}
	return p.repo.ListDeletedSessions(ctx, input)
}

func (p *ActivityProjection) RestoreDeletedSession(
	ctx context.Context,
	input agentactivitybiz.RestoreDeletedSessionInput,
) (agentactivitybiz.RestoreDeletedSessionResult, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.RestoreDeletedSessionResult{}, ErrInvalidArgument
	}
	result, err := p.repo.RestoreDeletedSession(ctx, input)
	if err != nil {
		return agentactivitybiz.RestoreDeletedSessionResult{}, err
	}
	agenthost.NotifyCommitted(ctx, p, agenthost.CanonicalDelta(result.CommitDelta))
	return result, nil
}

func (p *ActivityProjection) PurgeDeletedSessionTrees(
	ctx context.Context,
	input agentactivitybiz.PurgeDeletedSessionTreesInput,
) (agentactivitybiz.PurgeDeletedSessionTreesResult, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.PurgeDeletedSessionTreesResult{}, ErrInvalidArgument
	}
	return p.repo.PurgeDeletedSessionTrees(ctx, input)
}

func (p *ActivityProjection) ListRecoverableDeletedSessionResources(
	ctx context.Context,
) ([]agentactivitybiz.DeletedSessionResource, error) {
	if p == nil || p.repo == nil {
		return []agentactivitybiz.DeletedSessionResource{}, nil
	}
	return p.repo.ListRecoverableDeletedSessionResources(ctx)
}
