package main

import (
	"context"
	"errors"

	"github.com/google/uuid"
	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
	replaydata "github.com/tutti-os/tutti/services/tuttid/data/agentsessionreplay"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentsessionreplay "github.com/tutti-os/tutti/services/tuttid/service/agentsessionreplay"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type agentCommitObservers []agenthost.CommitObserver

func (observers agentCommitObservers) ObserveCommitted(ctx context.Context, delta agenthost.CommittedDelta) error {
	var result error
	for _, observer := range observers {
		if observer != nil {
			result = errors.Join(result, observer.ObserveCommitted(ctx, delta))
		}
	}
	return result
}

func buildAgentSessionRecordingService(
	store workspacedata.CatalogStore,
	transport *agentdaemon.SessionRecordingProcessTransport,
	_ *agentservice.Service,
) (*agentsessionreplay.Service, error) {
	fixtures, ok := store.(agentsessionreplay.StateFixtureStore)
	if !ok {
		return nil, errors.New("agent session recording fixture store is unavailable")
	}
	metadata, ok := store.(agentsessionreplay.MetadataStore)
	if !ok {
		return nil, errors.New("agent session replay metadata store is unavailable")
	}
	artifacts := &replaydata.Store{
		StateDir: tuttitypes.DefaultStateDir(),
	}
	service := &agentsessionreplay.Service{
		Workflow: &replay.Workflow{
			Fixtures:  fixtures,
			Artifacts: artifacts,
			Transport: transport,
			Store:     metadata,
			NewID:     uuid.NewString,
		},
	}
	if err := service.Recover(context.Background()); err != nil {
		return nil, err
	}
	return service, nil
}

func configureAgentSessionRecordingObservers(
	projection *agentservice.ActivityProjection,
	sessions *agentservice.Service,
	runtime agentservice.RootTurnObserver,
	_ *agentsessionreplay.Service,
) {
	projection.SetRootTurnObserver(runtime)
	sessions.CommitObserver = agentCommitObservers{projection}
}
