package composercatalog

import (
	"context"
	"errors"
	"testing"

	connectorhost "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestConnectorOptionsProjectsEveryCatalogState(t *testing.T) {
	source := snapshotStub{snapshot: connectorhost.Snapshot{Connectors: []connectorhost.Connector{
		connectorFixture("github", "GitHub", connectorhost.InstallationStateInstalled, connectorhost.AuthorizationStateConnected, connectorhost.CompatibilityStateSupported),
		connectorFixture("notion", "", connectorhost.InstallationStateInstalled, connectorhost.AuthorizationStateDisconnected, connectorhost.CompatibilityStateSupported),
		connectorFixture("legacy", "Legacy", connectorhost.InstallationStateInstalled, connectorhost.AuthorizationStateConnected, connectorhost.CompatibilityStateUnsupportedVersion),
		connectorFixture("slack", "Slack", connectorhost.InstallationStateNotInstalled, connectorhost.AuthorizationStateConnected, connectorhost.CompatibilityStateSupported),
	}}}

	options, err := ConnectorOptions(context.Background(), source)
	if err != nil {
		t.Fatalf("ConnectorOptions() error = %v", err)
	}
	if len(options) != 4 {
		t.Fatalf("options = %#v, want every catalog connector", options)
	}
	if got := options[0]; got.ID != "connector:github" || got.Label != "GitHub" || got.IconURL != "data:image/png;base64,aWNvbg==" || got.Status != CapabilityStatusAvailable || got.Trigger != "/github" || got.Invocation != CapabilityInvocationTextTrigger || got.Source != CapabilitySourceLocalDB {
		t.Fatalf("github option = %#v", got)
	}
	if got := options[1]; got.Label != "notion" || got.Status != CapabilityStatusAuthRequired {
		t.Fatalf("notion option = %#v", got)
	}
	if got := options[2]; got.Status != CapabilityStatusUnsupported {
		t.Fatalf("legacy option = %#v", got)
	}
	if got := options[3]; got.Status != CapabilityStatusSetupRequired {
		t.Fatalf("slack option = %#v", got)
	}
}

func TestConnectorOptionsPreservesSnapshotReadError(t *testing.T) {
	want := errors.New("snapshot unavailable")
	_, err := ConnectorOptions(context.Background(), snapshotStub{err: want})
	if !errors.Is(err, want) {
		t.Fatalf("ConnectorOptions() error = %v, want %v", err, want)
	}
}

func TestConnectorStatusRequiresStartedRuntimeWhenProjected(t *testing.T) {
	connector := connectorFixture("github", "GitHub", connectorhost.InstallationStateInstalled,
		connectorhost.AuthorizationStateConnected, connectorhost.CompatibilityStateSupported)
	connector.Runtime = &connectorhost.ConnectorRuntime{State: connectorhost.ConnectorRuntimeStateStopped}
	if got := ConnectorStatus(connector); got != CapabilityStatusDisabled {
		t.Fatalf("stopped ConnectorStatus() = %q, want %q", got, CapabilityStatusDisabled)
	}
	connector.Runtime.State = connectorhost.ConnectorRuntimeStateStarted
	if got := ConnectorStatus(connector); got != CapabilityStatusAvailable {
		t.Fatalf("started ConnectorStatus() = %q, want %q", got, CapabilityStatusAvailable)
	}
}

type snapshotStub struct {
	snapshot connectorhost.Snapshot
	err      error
}

func (stub snapshotStub) Snapshot(context.Context) (connectorhost.Snapshot, error) {
	return stub.snapshot, stub.err
}

func connectorFixture(
	key string,
	label string,
	installation connectorhost.InstallationState,
	authorization connectorhost.AuthorizationState,
	compatibility connectorhost.CompatibilityState,
) connectorhost.Connector {
	return connectorhost.Connector{
		Key: key,
		Release: connectorhost.Release{Manifest: connectorhost.Manifest{
			DisplayName: label,
			IconURL:     "data:image/png;base64,aWNvbg==",
			Description: key + " connector",
		}},
		Installation:  connectorhost.Installation{State: installation},
		Authorization: connectorhost.Authorization{State: authorization},
		Compatibility: connectorhost.Compatibility{State: compatibility},
	}
}
