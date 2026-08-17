package implementationhost

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

func TestDeactivateRuntimeAllConnectionsRemovesRotatedConnectorRoutes(t *testing.T) {
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 7}
	host := &Host{
		routes:                connectorruntime.NewRouteTable(),
		authorizationRoutes:   make(map[string]*connectorRoute),
		authorizationProvider: newManagedCredentialAuthorizationProvider(nil),
		registry:              NewRouteRegistry(),
		mcpRegistry:           NewMCPRegistry(),
	}
	host.authorizationProvider.host = host
	shimPath := filepath.Join(t.TempDir(), "tutti-connector-github")
	routes := []*connectorRoute{
		testUninstallRoute("connection-before-rotation", "github", "superseded-release", generation),
		testUninstallRoute("connection-after-rotation", "github", "release-1", generation),
	}
	routes[0].cliShimPath = shimPath
	routes[0].cliShimContent = []byte("shim")
	if err := os.WriteFile(shimPath, routes[0].cliShimContent, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		if err := host.routes.Commit(route); err != nil {
			t.Fatal(err)
		}
	}
	unrelated := testUninstallRoute("connection-other", "notion", "release-2", generation)
	if err := host.routes.Commit(unrelated); err != nil {
		t.Fatal(err)
	}

	if err := host.DeactivateRuntime(context.Background(), market.RuntimeDeactivationRequest{
		ConnectionID: "connection-after-rotation", ConnectorKey: "github", ReleaseDigest: "release-1",
		AllConnections: true, Generation: generation, Deadline: time.Now().Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		if host.routes.Route(route.id) != nil || !route.processes.IsFenced() {
			t.Fatalf("route %q survived all-connection deactivation", route.id)
		}
	}
	if host.routes.Route(unrelated.id) != unrelated {
		t.Fatal("unrelated connector route was removed")
	}
	if _, err := os.Stat(shimPath); !os.IsNotExist(err) {
		t.Fatalf("CLI shim still exists: %v", err)
	}
}

func TestDisabledReconcileRemovesRotatedConnectorRoutes(t *testing.T) {
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 7}
	host := &Host{
		routes:                connectorruntime.NewRouteTable(),
		authorizationRoutes:   make(map[string]*connectorRoute),
		authorizationProvider: newManagedCredentialAuthorizationProvider(nil),
		registry:              NewRouteRegistry(),
		mcpRegistry:           NewMCPRegistry(),
	}
	host.authorizationProvider.host = host
	routes := []*connectorRoute{
		testUninstallRoute("connection-before-rotation", "github", "superseded-release", generation),
		testUninstallRoute("connection-after-rotation", "github", "release-1", generation),
	}
	for _, route := range routes {
		if err := host.routes.Commit(route); err != nil {
			t.Fatal(err)
		}
	}
	receipt, err := host.Reconcile(context.Background(), ReconcileRequest{Runtime: market.RuntimeReconcileRequest{
		OperationID: "disable-github", ConnectionID: "connection-after-rotation",
		Connector: market.Connector{Key: "github", Installation: market.Installation{
			InstalledReleaseDigest: "release-1",
		}},
		Enabled: false, Generation: generation,
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		if host.routes.Route(route.id) != nil || !route.processes.IsFenced() {
			t.Fatalf("route %q survived disabled convergence", route.id)
		}
	}
	if receipt.Readiness.State != market.RuntimeReadinessBlocked ||
		receipt.Readiness.ReasonCode != market.RuntimeReadinessReasonRuntimeDisabled {
		t.Fatalf("disabled receipt = %#v", receipt)
	}
}

func TestDisabledCandidateReconcileReturnsRequestedReleaseDigest(t *testing.T) {
	host := &Host{
		routes:                connectorruntime.NewRouteTable(),
		authorizationRoutes:   make(map[string]*connectorRoute),
		authorizationProvider: newManagedCredentialAuthorizationProvider(nil),
		registry:              NewRouteRegistry(),
		mcpRegistry:           NewMCPRegistry(),
	}
	host.authorizationProvider.host = host
	const releaseDigest = "candidate-release"
	receipt, err := host.Reconcile(context.Background(), ReconcileRequest{Runtime: market.RuntimeReconcileRequest{
		OperationID: "disable-unauthed-linear", ConnectionID: "account-linear",
		Connector: market.Connector{
			Key:     "linear",
			Release: market.Release{ReleaseDigest: releaseDigest},
			Installation: market.Installation{
				State:                  market.InstallationStateInstalling,
				CandidateReleaseDigest: releaseDigest,
			},
		},
		Enabled: false, Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 8},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ReleaseDigest != releaseDigest {
		t.Fatalf("receipt release digest = %q, want %q", receipt.ReleaseDigest, releaseDigest)
	}
	if receipt.Readiness.State != market.RuntimeReadinessBlocked ||
		receipt.Readiness.ReasonCode != market.RuntimeReadinessReasonRuntimeDisabled {
		t.Fatalf("disabled candidate receipt = %#v", receipt)
	}
}

func TestDeactivateRuntimeAllConnectionsCancelsPendingAuthorizationRoute(t *testing.T) {
	host := &Host{
		routes:                connectorruntime.NewRouteTable(),
		authorizationRoutes:   make(map[string]*connectorRoute),
		authorizationProvider: newManagedCredentialAuthorizationProvider(nil),
		registry:              NewRouteRegistry(),
		mcpRegistry:           NewMCPRegistry(),
	}
	host.authorizationProvider.host = host
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 3}
	route := testUninstallRoute("account-pending", "github", "superseded-release", market.HostGeneration{BootEpoch: "authorization", Generation: 2})
	host.authorizationRoutes[route.id] = route
	canceled := make(chan struct{})
	const operationID = "authorization-pending"
	host.authorizationProvider.sessions[operationID] = &credentialBrokerSession{
		operationID: operationID, route: route,
		cancel: func() { close(canceled) }, changed: make(chan struct{}), state: market.AuthorizationStatePending,
	}
	host.authorizationProvider.activeByRoute[route.id] = operationID

	if err := host.DeactivateRuntime(context.Background(), market.RuntimeDeactivationRequest{
		ConnectionID: "current-connection", ConnectorKey: "github", ReleaseDigest: "release-1",
		AllConnections: true, Generation: generation, Deadline: time.Now().Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-canceled:
	default:
		t.Fatal("pending credential broker session was not canceled")
	}
	if host.authorizationRoutes[route.id] != nil || host.authorizationProvider.sessions[operationID] != nil || !route.processes.IsFenced() {
		t.Fatal("pending authorization route survived uninstall")
	}
}

func TestDeactivateRuntimeAllConnectionsRemovesOrphanedManagedCLIShim(t *testing.T) {
	binDir := t.TempDir()
	host := &Host{
		binDir:                binDir,
		routes:                connectorruntime.NewRouteTable(),
		authorizationRoutes:   make(map[string]*connectorRoute),
		authorizationProvider: newManagedCredentialAuthorizationProvider(nil),
		registry:              NewRouteRegistry(),
		mcpRegistry:           NewMCPRegistry(),
	}
	host.authorizationProvider.host = host
	command := "tutti-connector-github"
	content := "#!/bin/sh\nexport TUTTI_CONNECTOR_KEY='github'\n"
	if runtime.GOOS == "windows" {
		command += ".cmd"
		content = "@echo off\r\nset \"TUTTI_CONNECTOR_KEY=github\"\r\n"
	}
	shimPath := filepath.Join(binDir, command)
	if err := os.WriteFile(shimPath, []byte(content), 0o700); err != nil {
		t.Fatal(err)
	}

	if err := host.DeactivateRuntime(context.Background(), market.RuntimeDeactivationRequest{
		ConnectionID: "missing", ConnectorKey: "github", ReleaseDigest: "release-1", AllConnections: true,
		Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 1}, Deadline: time.Now().Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(shimPath); !os.IsNotExist(err) {
		t.Fatalf("orphaned CLI shim still exists: %v", err)
	}
}

func testUninstallRoute(connectionID, connectorKey, releaseDigest string, generation market.HostGeneration) *connectorRoute {
	return &connectorRoute{
		id: connectorRouteKey(connectionID, connectorKey), connectionID: connectionID,
		connectorKey: connectorKey, releaseDigest: releaseDigest, generation: generation,
		mcpTools: make(map[string]registeredMCPTool), processes: connectorruntime.NewProcessGroup(),
	}
}
