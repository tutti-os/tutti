package agent

import (
	"context"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
)

// InstalledConnectorSnapshotReader is the narrow, read-only boundary used by
// composer options. Production wires the local connector-market SQLite store
// directly, so Provider-owned connector catalogs cannot become slash entries.
type InstalledConnectorSnapshotReader interface {
	Snapshot(context.Context) (market.Snapshot, error)
}

func installedConnectorCapabilityOptions(
	ctx context.Context,
	source InstalledConnectorSnapshotReader,
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
		if connector.Installation.State != market.InstallationStateInstalled {
			continue
		}
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
			Description: strings.TrimSpace(connector.Release.Manifest.Description),
			Status:      installedConnectorCapabilityStatus(connector),
			Source:      "local-db",
			Trigger:     "/" + key,
			Invocation:  "textTrigger",
		})
	}
	return options, nil
}

func installedConnectorCapabilityStatus(connector market.Connector) string {
	if connector.Compatibility.State != "" &&
		connector.Compatibility.State != market.CompatibilityStateSupported {
		return "unsupported"
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
