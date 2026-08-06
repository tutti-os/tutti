package agent

import (
	"context"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
)

type installedConnectorSnapshotStub struct {
	snapshot market.Snapshot
}

func (stub installedConnectorSnapshotStub) Snapshot(context.Context) (market.Snapshot, error) {
	return stub.snapshot, nil
}

func TestInstalledConnectorCapabilityOptionsUsesOnlyInstalledLocalRecords(t *testing.T) {
	options, err := installedConnectorCapabilityOptions(context.Background(), installedConnectorSnapshotStub{
		snapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture("github", market.InstallationStateInstalled, market.AuthorizationStateConnected, market.CompatibilityStateSupported),
			localConnectorFixture("notion", market.InstallationStateInstalled, market.AuthorizationStateDisconnected, market.CompatibilityStateSupported),
			localConnectorFixture("legacy", market.InstallationStateInstalled, market.AuthorizationStateConnected, market.CompatibilityStateUnsupportedVersion),
			localConnectorFixture("slack", market.InstallationStateNotInstalled, market.AuthorizationStateConnected, market.CompatibilityStateSupported),
		}},
	})
	if err != nil {
		t.Fatalf("installedConnectorCapabilityOptions() error = %v", err)
	}
	if len(options) != 3 {
		t.Fatalf("options = %#v, want three installed DB connectors", options)
	}
	if got := options[0]; got.ID != "connector:github" || got.Label != "GitHub" || got.Status != "available" || got.Trigger != "/github" || got.Invocation != "textTrigger" || got.Source != "local-db" {
		t.Fatalf("github option = %#v", got)
	}
	if got := options[1]; got.ID != "connector:notion" || got.Status != "authRequired" {
		t.Fatalf("notion option = %#v", got)
	}
	if got := options[2]; got.ID != "connector:legacy" || got.Status != "unsupported" {
		t.Fatalf("legacy option = %#v", got)
	}
}

func TestReplaceComposerConnectorCapabilitiesDropsProviderConnectors(t *testing.T) {
	result := replaceComposerConnectorCapabilities(
		[]ComposerCapabilityOption{
			{ID: "skill:review", Kind: "skill"},
			{ID: "connector:remote", Kind: "connector"},
		},
		[]ComposerCapabilityOption{{ID: "connector:local", Kind: "connector", Source: "local-db"}},
	)
	if len(result) != 2 || result[0].ID != "skill:review" || result[1].ID != "connector:local" {
		t.Fatalf("result = %#v, want non-connector capabilities plus local connector", result)
	}
}

func localConnectorFixture(
	key string,
	installation market.InstallationState,
	authorization market.AuthorizationState,
	compatibility market.CompatibilityState,
) market.Connector {
	label := key
	if key == "github" {
		label = "GitHub"
	}
	return market.Connector{
		Key: key,
		Release: market.Release{Manifest: market.Manifest{
			DisplayName: label,
			Description: key + " connector",
		}},
		Installation:  market.Installation{State: installation},
		Authorization: market.Authorization{State: authorization},
		Compatibility: market.Compatibility{State: compatibility},
	}
}
