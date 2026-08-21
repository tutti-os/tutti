package agent

import (
	"context"
	"errors"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestValidatePromptConnectorsRequiresInstalledAuthorizedConnector(t *testing.T) {
	service := &Service{ConnectorMarketSnapshots: connectorMarketSnapshotStub{
		snapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture("lark-cli", market.InstallationStateInstalled, market.AuthorizationStateConnected, market.CompatibilityStateSupported),
			localConnectorFixture("notion", market.InstallationStateInstalled, market.AuthorizationStateDisconnected, market.CompatibilityStateSupported),
		}},
	}}
	if err := service.validatePromptConnectors(context.Background(), []PromptContentBlock{{
		Type: "connector", ConnectorKey: "lark-cli",
	}}); err != nil {
		t.Fatalf("validatePromptConnectors(lark-cli) error = %v", err)
	}
	if err := service.validatePromptConnectors(context.Background(), []PromptContentBlock{{
		Type: "connector", ConnectorKey: "notion",
	}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("validatePromptConnectors(notion) error = %v, want ErrInvalidArgument", err)
	}
	if err := service.validatePromptConnectors(context.Background(), []PromptContentBlock{{
		Type: "connector", ConnectorKey: "missing",
	}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("validatePromptConnectors(missing) error = %v, want ErrInvalidArgument", err)
	}
}

func TestValidatePromptConnectorsUsesCurrentAccountAuthorization(t *testing.T) {
	snapshots := &scopedConnectorMarketSnapshotStub{
		snapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture("github", market.InstallationStateInstalled, market.AuthorizationStateDisconnected, market.CompatibilityStateSupported),
		}},
		scopedSnapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture("github", market.InstallationStateInstalled, market.AuthorizationStateConnected, market.CompatibilityStateSupported),
		}},
	}
	service := &Service{
		ConnectorMarketSnapshots: snapshots,
		ConnectorMarketCurrentScope: func() market.OperationScope {
			return market.OperationScope{AccountID: "account-1"}
		},
	}

	err := service.validatePromptConnectors(context.Background(), []PromptContentBlock{{
		Type: "connector", ConnectorKey: "github",
	}})
	if err != nil {
		t.Fatalf("validatePromptConnectors(github) error = %v", err)
	}
	if snapshots.requestedScope.AccountID != "account-1" {
		t.Fatalf("connector snapshot scope = %#v, want current account", snapshots.requestedScope)
	}
}

type connectorMarketSnapshotStub struct {
	snapshot market.Snapshot
}

func (stub connectorMarketSnapshotStub) Snapshot(context.Context) (market.Snapshot, error) {
	return stub.snapshot, nil
}

type scopedConnectorMarketSnapshotStub struct {
	snapshot       market.Snapshot
	scopedSnapshot market.Snapshot
	requestedScope market.OperationScope
}

func (stub *scopedConnectorMarketSnapshotStub) Snapshot(context.Context) (market.Snapshot, error) {
	return stub.snapshot, nil
}

func (stub *scopedConnectorMarketSnapshotStub) SnapshotForScope(_ context.Context, scope market.OperationScope) (market.Snapshot, error) {
	stub.requestedScope = scope
	return stub.scopedSnapshot, nil
}

func TestLocalConnectorCapabilityOptionsProjectsCatalogWithSetupState(t *testing.T) {
	options, err := localConnectorCapabilityOptions(context.Background(), connectorMarketSnapshotStub{
		snapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture("github", market.InstallationStateInstalled, market.AuthorizationStateConnected, market.CompatibilityStateSupported),
			localConnectorFixture("notion", market.InstallationStateInstalled, market.AuthorizationStateDisconnected, market.CompatibilityStateSupported),
			localConnectorFixture("legacy", market.InstallationStateInstalled, market.AuthorizationStateConnected, market.CompatibilityStateUnsupportedVersion),
			localConnectorFixture("slack", market.InstallationStateNotInstalled, market.AuthorizationStateConnected, market.CompatibilityStateSupported),
			localConnectorFixture("lark-cli", market.InstallationStateFailed, market.AuthorizationStateDisconnected, market.CompatibilityStateSupported),
		}},
	}, nil)
	if err != nil {
		t.Fatalf("localConnectorCapabilityOptions() error = %v", err)
	}
	if len(options) != 5 {
		t.Fatalf("options = %#v, want all local catalog connectors", options)
	}
	if got := options[0]; got.ID != "connector:github" || got.Label != "GitHub" || got.IconURL != "data:image/png;base64,aWNvbg==" || got.Status != "available" || got.Trigger != "/github" || got.Invocation != "textTrigger" || got.Source != "local-db" {
		t.Fatalf("github option = %#v", got)
	}
	if got := options[1]; got.ID != "connector:notion" || got.Status != "authRequired" {
		t.Fatalf("notion option = %#v", got)
	}
	if got := options[2]; got.ID != "connector:legacy" || got.Status != "unsupported" {
		t.Fatalf("legacy option = %#v", got)
	}
	if got := options[3]; got.ID != "connector:slack" || got.Status != "setupRequired" {
		t.Fatalf("slack option = %#v", got)
	}
	if got := options[4]; got.ID != "connector:lark-cli" || got.Status != "setupRequired" {
		t.Fatalf("lark-cli option = %#v", got)
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
			IconURL:     "data:image/png;base64,aWNvbg==",
			Description: key + " connector",
		}},
		Installation:  market.Installation{State: installation},
		Authorization: market.Authorization{State: authorization},
		Compatibility: market.Compatibility{State: compatibility},
	}
}
