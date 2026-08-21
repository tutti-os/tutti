package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/composercatalog"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func (s *Service) connectorCatalogVisible(ctx context.Context) (bool, error) {
	if s == nil || s.DesktopPreferencesReader == nil {
		return false, nil
	}
	preferences, err := s.DesktopPreferencesReader.Get(ctx)
	if err != nil {
		return false, err
	}
	return preferencesbiz.IsLabFlagEnabled(
		preferences.FeatureFlags,
		preferencesbiz.LabFlagConnectors,
	), nil
}

func (s *Service) validatePromptConnectors(ctx context.Context, content []PromptContentBlock) error {
	requested := make(map[string]struct{})
	for _, block := range content {
		if block.Type == "connector" {
			requested[strings.TrimSpace(block.ConnectorKey)] = struct{}{}
		}
	}
	if len(requested) == 0 {
		return nil
	}
	if s == nil || s.ConnectorMarketSnapshots == nil {
		return fmt.Errorf("%w: local connector state is unavailable", ErrInvalidArgument)
	}
	snapshot, err := connectorMarketSnapshot(ctx, s.ConnectorMarketSnapshots, s.ConnectorMarketCurrentScope)
	if err != nil {
		return fmt.Errorf("read local connector state: %w", err)
	}
	for _, connector := range snapshot.Connectors {
		key := strings.TrimSpace(connector.Key)
		if _, ok := requested[key]; !ok {
			continue
		}
		if composercatalog.ConnectorStatus(connector) != composercatalog.CapabilityStatusAvailable {
			return fmt.Errorf("%w: local connector %q is not ready", ErrInvalidArgument, key)
		}
		delete(requested, key)
	}
	for key := range requested {
		return fmt.Errorf("%w: local connector %q is not installed", ErrInvalidArgument, key)
	}
	return nil
}

func localConnectorCapabilityOptions(
	ctx context.Context,
	source market.SnapshotReader,
	currentScope func() market.OperationScope,
) ([]ComposerCapabilityOption, error) {
	snapshot, err := connectorMarketSnapshot(ctx, source, currentScope)
	if err != nil {
		return nil, err
	}
	return composercatalog.ProjectConnectorOptions(snapshot), nil
}

func connectorMarketSnapshot(
	ctx context.Context,
	source market.SnapshotReader,
	currentScope func() market.OperationScope,
) (market.Snapshot, error) {
	if scoped, ok := source.(market.ScopedSnapshotReader); ok && currentScope != nil {
		return scoped.SnapshotForScope(ctx, currentScope())
	}
	return source.Snapshot(ctx)
}

func replaceComposerConnectorCapabilities(
	options []ComposerCapabilityOption,
	connectors []ComposerCapabilityOption,
) []ComposerCapabilityOption {
	result := make([]ComposerCapabilityOption, 0, len(options)+len(connectors))
	for _, option := range options {
		if option.Kind != "connector" {
			result = append(result, option)
		}
	}
	return mergeComposerCapabilityOptions(result, connectors)
}
