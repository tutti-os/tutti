// Package composercatalog projects provider-neutral capability data for Agent
// composer surfaces shared by daemon hosts.
package composercatalog

import (
	"context"
	"strings"

	connectorhost "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const (
	CapabilityKindConnector         = "connector"
	CapabilityInvocationTextTrigger = "textTrigger"
	CapabilitySourceLocalDB         = "local-db"

	CapabilityStatusAuthRequired  = "authRequired"
	CapabilityStatusAvailable     = "available"
	CapabilityStatusDisabled      = "disabled"
	CapabilityStatusSetupRequired = "setupRequired"
	CapabilityStatusUnsupported   = "unsupported"
)

// Option is the host-neutral capability entry consumed by Agent composer
// projections. Provider-specific discovery may populate the optional identity
// fields while connector projection uses ConnectorKey-compatible Name values.
type Option struct {
	ID          string
	Kind        string
	Name        string
	Label       string
	IconURL     string
	Description string
	Status      string
	Source      string
	PluginName  string
	ServerName  string
	ToolName    string
	Trigger     string
	Path        string
	Invocation  string
}

// ConnectorOptions reads one authoritative Connector Market snapshot and
// projects every catalog connector into the shared Agent composer contract.
func ConnectorOptions(ctx context.Context, source connectorhost.SnapshotReader) ([]Option, error) {
	if source == nil {
		return nil, nil
	}
	snapshot, err := source.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	return ProjectConnectorOptions(snapshot), nil
}

// ProjectConnectorOptions is the pure form of ConnectorOptions for hosts that
// already own an authoritative snapshot read.
func ProjectConnectorOptions(snapshot connectorhost.Snapshot) []Option {
	options := make([]Option, 0, len(snapshot.Connectors))
	for _, connector := range snapshot.Connectors {
		key := strings.TrimSpace(connector.Key)
		if key == "" {
			continue
		}
		label := strings.TrimSpace(connector.Release.Manifest.DisplayName)
		if label == "" {
			label = key
		}
		options = append(options, Option{
			ID:          "connector:" + key,
			Kind:        CapabilityKindConnector,
			Name:        key,
			Label:       label,
			IconURL:     strings.TrimSpace(connector.Release.Manifest.IconURL),
			Description: strings.TrimSpace(connector.Release.Manifest.Description),
			Status:      ConnectorStatus(connector),
			Source:      CapabilitySourceLocalDB,
			Trigger:     "/" + key,
			Invocation:  CapabilityInvocationTextTrigger,
		})
	}
	return options
}

// ConnectorStatus maps Connector Market lifecycle state to the closed Agent
// composer readiness vocabulary.
func ConnectorStatus(connector connectorhost.Connector) string {
	if connector.Compatibility.State != "" &&
		connector.Compatibility.State != connectorhost.CompatibilityStateSupported {
		return CapabilityStatusUnsupported
	}
	if connector.Installation.State != connectorhost.InstallationStateInstalled {
		return CapabilityStatusSetupRequired
	}
	switch connector.Authorization.State {
	case connectorhost.AuthorizationStateNotRequired, connectorhost.AuthorizationStateConnected:
		if connector.Runtime != nil && connector.Runtime.State != connectorhost.ConnectorRuntimeStateStarted {
			return CapabilityStatusDisabled
		}
		return CapabilityStatusAvailable
	default:
		return CapabilityStatusAuthRequired
	}
}
