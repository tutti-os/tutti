package agent

import (
	"context"
	"fmt"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/host"
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
	snapshot, err := s.ConnectorMarketSnapshots.Snapshot(ctx)
	if err != nil {
		return fmt.Errorf("read local connector state: %w", err)
	}
	for _, connector := range snapshot.Connectors {
		key := strings.TrimSpace(connector.Key)
		if _, ok := requested[key]; !ok {
			continue
		}
		if localConnectorCapabilityStatus(connector) != "available" {
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
) ([]ComposerCapabilityOption, error) {
	if source == nil {
		return nil, nil
	}
	snapshot, err := source.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	options := make([]ComposerCapabilityOption, 0, len(snapshot.Connectors))
	for _, connector := range snapshot.Connectors {
		key := strings.TrimSpace(connector.Key)
		if key == "" {
			continue
		}
		label := strings.TrimSpace(connector.Release.Manifest.DisplayName)
		if label == "" {
			label = key
		}
		options = append(options, ComposerCapabilityOption{
			ID:          "connector:" + key,
			Kind:        "connector",
			Name:        key,
			Label:       label,
			IconURL:     strings.TrimSpace(connector.Release.Manifest.IconURL),
			Description: strings.TrimSpace(connector.Release.Manifest.Description),
			Status:      localConnectorCapabilityStatus(connector),
			Source:      "local-db",
			Trigger:     "/" + key,
			Invocation:  "textTrigger",
		})
	}
	return options, nil
}

func localConnectorCapabilityStatus(connector market.Connector) string {
	if connector.Compatibility.State != "" &&
		connector.Compatibility.State != market.CompatibilityStateSupported {
		return "unsupported"
	}
	if connector.Installation.State != market.InstallationStateInstalled {
		return "setupRequired"
	}
	switch connector.Authorization.State {
	case market.AuthorizationStateNotRequired, market.AuthorizationStateConnected:
		return "available"
	default:
		return "authRequired"
	}
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
