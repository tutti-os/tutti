package connectormarket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

type mcpProcessStub struct{ connection *mcpConnectionStub }

func (stub *mcpProcessStub) Start(context.Context, agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	return stub.connection, nil
}

type mcpConnectionStub struct {
	frames    chan agentruntime.ProcessFrame
	closeOnce sync.Once
}

func newMCPConnectionStub() *mcpConnectionStub {
	return &mcpConnectionStub{frames: make(chan agentruntime.ProcessFrame, 16)}
}

func (connection *mcpConnectionStub) Send(data []byte) error {
	var request struct {
		ID     int64          `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(data, &request); err != nil || request.ID == 0 {
		return nil
	}
	result := map[string]any{}
	switch request.Method {
	case "initialize":
		result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}}
	case "tools/list":
		if request.Params["cursor"] == "page-2" {
			result = map[string]any{"tools": []any{
				map[string]any{"name": "second", "inputSchema": map[string]any{"type": "object"}},
			}}
		} else {
			result = map[string]any{"tools": []any{map[string]any{"name": "status", "inputSchema": map[string]any{"type": "object"}}}, "nextCursor": "page-2"}
		}
	}
	encoded, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	connection.frames <- agentruntime.ProcessFrame{Stdout: append(encoded, '\n')}
	return nil
}
func (connection *mcpConnectionStub) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-connection.frames
	if !ok {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	return frame, nil
}
func (connection *mcpConnectionStub) Close() error {
	connection.closeOnce.Do(func() { close(connection.frames) })
	return nil
}
func (connection *mcpConnectionStub) exit() {
	exitCode := 1
	connection.frames <- agentruntime.ProcessFrame{ExitCode: &exitCode}
}

type preparedResolverStub struct {
	receipt market.PreparedArtifactReceipt
}

type blockingStartProcessStub struct{ started chan struct{} }

func (stub *blockingStartProcessStub) Start(ctx context.Context, _ agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	select {
	case <-stub.started:
	default:
		close(stub.started)
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

type retryCloseProcessStub struct{ connection *retryCloseConnection }

func (stub *retryCloseProcessStub) Start(context.Context, agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	return stub.connection, nil
}

type retryCloseConnection struct {
	mu         sync.Mutex
	closeCalls int
	closed     chan struct{}
	closeOnce  sync.Once
}

func (*retryCloseConnection) Send([]byte) error { return nil }
func (connection *retryCloseConnection) Recv() (agentruntime.ProcessFrame, error) {
	<-connection.closed
	return agentruntime.ProcessFrame{}, io.EOF
}
func (connection *retryCloseConnection) Close() error {
	connection.mu.Lock()
	connection.closeCalls++
	call := connection.closeCalls
	connection.mu.Unlock()
	if call == 1 {
		return errors.New("simulated kill acknowledgement failure")
	}
	connection.closeOnce.Do(func() { close(connection.closed) })
	return nil
}

func testCLIHost(t *testing.T, processes agentruntime.ProcessTransport) (*ImplementationHost, *ConnectorCommandRegistry, market.Connector, market.HostGeneration) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "connector.js"), []byte("// connector"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtimePath := filepath.Join(root, "node")
	if err := os.WriteFile(runtimePath, []byte("runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	inventory, err := executionInventoryDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	commands := NewConnectorCommandRegistry()
	host, err := NewImplementationHost(ImplementationHostConfig{Artifacts: preparedResolverStub{receipt: market.PreparedArtifactReceipt{PreparedPath: root, InventoryDigest: inventory}},
		Runtimes: connectorRuntimeStub{executable: managedruntime.ConnectorExecutable{Path: runtimePath,
			SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SizeBytes: 7}},
		Processes: processes, Commands: commands, StateRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close() })
	connector := market.Connector{Key: "github", Installation: market.Installation{State: market.InstallationStateInstalled,
		InstalledReleaseDigest: "release-digest"}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = market.Release{ConnectorKey: "github", ReleaseDigest: "release-digest", Manifest: market.Manifest{AuthorizationKind: "none", IconURL: "data:image/png;base64,iVBORw0KGgo=",
		Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio, ManagedStdio: &market.ManagedStdioImplementation{
			Runtime: market.RuntimeRequirement{Language: "node", Profile: managedruntime.ConnectorNodeProfile, ABI: "node20-" + runtime.GOOS + "-" + runtime.GOARCH},
			CLI: &market.ManagedCLIInterface{Entrypoint: "connector.js", Commands: []market.CLICommand{{Name: "status",
				InputSchema: map[string]any{"type": "object"}, TimeoutMS: 120_000}}},
		}}}}
	return host, commands, connector, market.HostGeneration{BootEpoch: "boot-1", Generation: 2}
}

func (stub preparedResolverStub) ResolvePrepared(context.Context, market.Release) (market.PreparedArtifactReceipt, error) {
	return stub.receipt, nil
}

type connectorRuntimeStub struct {
	executable managedruntime.ConnectorExecutable
}

func (stub connectorRuntimeStub) ResolveProfile(context.Context, string) (managedruntime.ResolvedConnectorRuntime, error) {
	return managedruntime.ResolvedConnectorRuntime{Root: filepath.Dir(stub.executable.Path), Profile: managedruntime.ConnectorNodeProfile,
		ABI: "node20-" + runtime.GOOS + "-" + runtime.GOARCH, Node: &stub.executable}, nil
}
func (stub connectorRuntimeStub) VerifyLaunch(string, string) (managedruntime.ConnectorExecutable, error) {
	return stub.executable, nil
}

type connectorProcessStub struct{ starts int }

func (stub *connectorProcessStub) Start(context.Context, agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	stub.starts++
	exit := 0
	return &connectorConnectionStub{frames: []agentruntime.ProcessFrame{{Stdout: []byte(`{"ok":true}`)}, {ExitCode: &exit}}}, nil
}

type recordingConnectorProcessStub struct {
	connectorProcessStub
	spec agentruntime.ProcessSpec
}

func (stub *recordingConnectorProcessStub) Start(ctx context.Context, spec agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	stub.spec = spec
	return stub.connectorProcessStub.Start(ctx, spec)
}

type connectorConnectionStub struct{ frames []agentruntime.ProcessFrame }

func (*connectorConnectionStub) Send([]byte) error { return nil }
func (*connectorConnectionStub) Close() error      { return nil }
func (*connectorConnectionStub) CloseInput() error { return nil }
func (*connectorConnectionStub) Terminate() error  { return nil }
func (*connectorConnectionStub) Kill() error       { return nil }
func (stub *connectorConnectionStub) Recv() (agentruntime.ProcessFrame, error) {
	if len(stub.frames) == 0 {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	frame := stub.frames[0]
	stub.frames = stub.frames[1:]
	return frame, nil
}

func TestGenericCLIArgumentsRejectsNonInteractiveOverrides(t *testing.T) {
	arguments, err := genericCLIArguments([]any{"doc", "list", "--page-size", "20"})
	if err != nil || len(arguments) != 4 {
		t.Fatalf("genericCLIArguments() = %#v, %v", arguments, err)
	}
	for _, forbidden := range []string{"--yes", "--force", "--force=true"} {
		if _, err := genericCLIArguments([]any{"doc", "delete", forbidden}); err == nil {
			t.Fatalf("genericCLIArguments() accepted %q", forbidden)
		}
	}
}

func TestContainsPermissionScopeAcceptsScopedPermission(t *testing.T) {
	if !containsPermissionScope([]string{"network:larksuite.com"}, "network") {
		t.Fatal("scoped network permission did not enable connector network access")
	}
	if containsPermissionScope([]string{"filesystem:workspace"}, "network") {
		t.Fatal("unrelated scoped permission enabled connector network access")
	}
}

func TestImplementationHostRegistersWorkspaceFencedCLIAndDeactivatesIt(t *testing.T) {
	root := t.TempDir()
	entrypoint := filepath.Join(root, "connector.js")
	if err := os.WriteFile(entrypoint, []byte("// connector"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtimePath := filepath.Join(root, "node")
	if err := os.WriteFile(runtimePath, []byte("runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	inventory, err := executionInventoryDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	commands := NewConnectorCommandRegistry()
	processes := &connectorProcessStub{}
	host, err := NewImplementationHost(ImplementationHostConfig{
		Artifacts: preparedResolverStub{receipt: market.PreparedArtifactReceipt{PreparedPath: root, InventoryDigest: inventory}},
		Runtimes: connectorRuntimeStub{executable: managedruntime.ConnectorExecutable{Path: runtimePath,
			SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SizeBytes: 7}},
		Processes: processes, Commands: commands, StateRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := market.Connector{Key: "github", Installation: market.Installation{State: market.InstallationStateInstalled,
		InstalledReleaseDigest: "release-digest"}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = market.Release{ConnectorKey: "github", ReleaseDigest: "release-digest", Manifest: market.Manifest{AuthorizationKind: "none", IconURL: "data:image/png;base64,iVBORw0KGgo=",
		Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio, ManagedStdio: &market.ManagedStdioImplementation{
			Runtime: market.RuntimeRequirement{Language: "node", Profile: managedruntime.ConnectorNodeProfile, ABI: "node20-" + runtime.GOOS + "-" + runtime.GOARCH},
			CLI: &market.ManagedCLIInterface{Entrypoint: "connector.js", Commands: []market.CLICommand{{Name: "status",
				InputSchema: map[string]any{"type": "object"}, TimeoutMS: 1_000}}},
		}}}}
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 2}
	receipt, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation})
	if err != nil {
		t.Fatal(err)
	}
	if len(receipt.RouteIDs) != 1 {
		t.Fatalf("route ids = %#v", receipt.RouteIDs)
	}
	capabilities := commands.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"})
	if len(capabilities) != 1 || capabilities[0].ID != "connector.github.cli.status" {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	if capabilities := commands.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-2"}); len(capabilities) != 1 {
		t.Fatalf("global connector capabilities = %#v", capabilities)
	}
	output, err := commands.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: receipt.RouteIDs[0], Input: map[string]any{},
		Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"}})
	if err != nil || output.Value["ok"] != true || processes.starts != 1 {
		t.Fatalf("invoke = %#v, %v starts=%d", output, err, processes.starts)
	}
	if err := host.DeactivateRuntime(context.Background(), market.RuntimeDeactivationRequest{ConnectionID: "workspace-1", ConnectorKey: "github",
		ReleaseDigest: "release-digest", Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 3}}); err != nil {
		t.Fatal(err)
	}
	if _, err := commands.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: receipt.RouteIDs[0], Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"}}); err == nil {
		t.Fatal("deactivated connector CLI command remained routable")
	}
}

func TestImplementationHostExecutesFromVerifiedSnapshotAfterPreparedTreeReplacement(t *testing.T) {
	processes := &recordingConnectorProcessStub{}
	host, commands, connector, generation := testCLIHost(t, processes)
	receipt, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation})
	if err != nil {
		t.Fatal(err)
	}
	preparedRoot := host.artifacts.(preparedResolverStub).receipt.PreparedPath
	if err := os.Remove(filepath.Join(preparedRoot, "connector.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(preparedRoot, "connector.js"), []byte("// replaced after validation"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := commands.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: receipt.RouteIDs[0], Input: map[string]any{},
		Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"}}); err != nil {
		t.Fatal(err)
	}
	if processes.spec.CWD == preparedRoot || len(processes.spec.Command) < 2 || !strings.HasPrefix(processes.spec.Command[1], processes.spec.CWD+string(filepath.Separator)) {
		t.Fatalf("process spec re-opened prepared tree: %#v", processes.spec)
	}
	contents, err := os.ReadFile(processes.spec.Command[1])
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "// connector" {
		t.Fatalf("executed snapshot contents = %q", contents)
	}
	if processes.spec.ConnectorSandbox == nil || len(processes.spec.ConnectorSandbox.ReadOnlyTreeIdentities) != 1 ||
		processes.spec.ConnectorSandbox.ReadOnlyTreeIdentities[0].Root != processes.spec.CWD {
		t.Fatalf("snapshot sandbox identity = %#v", processes.spec.ConnectorSandbox)
	}
}

func TestImplementationHostPublishesStagedRoutesAtomically(t *testing.T) {
	host, commands, connector, generation := testCLIHost(t, &connectorProcessStub{})
	host.SetCapabilityPublication(false)
	receipt, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation})
	if err != nil {
		t.Fatal(err)
	}
	if capabilities := commands.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"}); len(capabilities) != 0 {
		t.Fatalf("staged capabilities leaked before commit: %#v", capabilities)
	}
	if _, err := commands.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: receipt.RouteIDs[0],
		Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"}}); !errors.Is(err, cliservice.ErrServiceUnavailable) {
		t.Fatalf("staged Invoke() error = %v", err)
	}
	if err := host.FenceAll(context.Background(), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	host.SetCapabilityPublication(true)
	if capabilities := commands.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"}); len(capabilities) != 0 {
		t.Fatalf("failed bootstrap routes became visible: %#v", capabilities)
	}
}

func TestImplementationHostDeactivationCancelsBlockingStartWithoutWaitingForCLICommandTimeout(t *testing.T) {
	processes := &blockingStartProcessStub{started: make(chan struct{})}
	host, commands, connector, generation := testCLIHost(t, processes)
	receipt, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation})
	if err != nil {
		t.Fatal(err)
	}
	invokeDone := make(chan error, 1)
	go func() {
		_, invokeErr := commands.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: receipt.RouteIDs[0], Input: map[string]any{},
			Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"}})
		invokeDone <- invokeErr
	}()
	select {
	case <-processes.started:
	case <-time.After(time.Second):
		t.Fatal("CLI process start did not block")
	}
	deadline := time.Now().Add(100 * time.Millisecond)
	if err := host.DeactivateRuntime(context.Background(), market.RuntimeDeactivationRequest{ConnectionID: "workspace-1", ConnectorKey: "github",
		ReleaseDigest: "release-digest", Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 3}, Deadline: deadline}); err != nil {
		t.Fatal(err)
	}
	if time.Now().After(deadline) {
		t.Fatal("deactivation waited past its deadline for blocking Start")
	}
	select {
	case <-invokeDone:
	case <-time.After(time.Second):
		t.Fatal("blocking Start was not canceled")
	}
}

func TestImplementationHostRetainsFencedRouteUntilCloseCanBeRetried(t *testing.T) {
	connection := &retryCloseConnection{closed: make(chan struct{})}
	host, commands, connector, generation := testCLIHost(t, &retryCloseProcessStub{connection: connection})
	receipt, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation})
	if err != nil {
		t.Fatal(err)
	}
	invokeDone := make(chan error, 1)
	go func() {
		_, invokeErr := commands.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: receipt.RouteIDs[0], Input: map[string]any{},
			Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"}})
		invokeDone <- invokeErr
	}()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		// Start has committed once the route owns the connection; Close below is
		// the first observable operation, so a short yield is sufficient here.
		host.mu.Lock()
		route := host.routes[connectorRouteKey("workspace-1", "github")]
		host.mu.Unlock()
		hasProcess := false
		if route != nil {
			route.processMu.Lock()
			hasProcess = len(route.processes) == 1
			route.processMu.Unlock()
		}
		if hasProcess {
			break
		}
		time.Sleep(time.Millisecond)
	}
	deactivation := market.RuntimeDeactivationRequest{ConnectionID: "workspace-1", ConnectorKey: "github", ReleaseDigest: "release-digest",
		Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 3}, Deadline: time.Now().Add(time.Second)}
	if err := host.DeactivateRuntime(context.Background(), deactivation); err == nil {
		t.Fatal("first deactivation unexpectedly hid close failure")
	}
	if capabilities := commands.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"}); len(capabilities) != 0 {
		t.Fatalf("fenced capabilities remained visible: %#v", capabilities)
	}
	deactivation.Deadline = time.Now().Add(time.Second)
	if err := host.DeactivateRuntime(context.Background(), deactivation); err != nil {
		t.Fatalf("retry deactivation failed: %v", err)
	}
	connection.mu.Lock()
	closeCalls := connection.closeCalls
	connection.mu.Unlock()
	if closeCalls != 2 {
		t.Fatalf("close calls = %d, want 2", closeCalls)
	}
	select {
	case <-invokeDone:
	case <-time.After(time.Second):
		t.Fatal("retried close did not release invocation")
	}
}

func TestImplementationHostPaginatesMCPToolsSeparatesCLIPathAndRemovesDeadMCPRoute(t *testing.T) {
	connection := newMCPConnectionStub()
	host, commands, connector, generation := testCLIHost(t, &mcpProcessStub{connection: connection})
	managed := connector.Release.Manifest.Implementation.ManagedStdio
	managed.MCP = &market.ManagedMCPInterface{Entrypoint: "connector.js"}
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation}); err != nil {
		t.Fatal(err)
	}
	capabilities := commands.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"})
	if len(capabilities) != 3 {
		t.Fatalf("paginated MCP/CLI capabilities = %#v", capabilities)
	}
	paths := make(map[string]bool, len(capabilities))
	for _, capability := range capabilities {
		paths[fmt.Sprint(capability.Path)] = true
	}
	if !paths["[connector github mcp status]"] || !paths["[connector github cli status]"] || !paths["[connector github mcp second]"] {
		t.Fatalf("capability paths = %#v", paths)
	}
	connection.exit()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(commands.Capabilities(context.Background(), cliservice.InvokeContext{WorkspaceID: "workspace-1"})) == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("dead MCP route remained advertised")
}

func TestImplementationHostBoundsMCPProcessStart(t *testing.T) {
	processes := &blockingStartProcessStub{started: make(chan struct{})}
	host, _, connector, generation := testCLIHost(t, processes)
	connector.Release.Manifest.Implementation.ManagedStdio.CLI = nil
	connector.Release.Manifest.Implementation.ManagedStdio.MCP = &market.ManagedMCPInterface{Entrypoint: "connector.js"}
	host.mcpStartupTimeout = 20 * time.Millisecond
	startedAt := time.Now()
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Reconcile() error = %v, want deadline", err)
	}
	if time.Since(startedAt) > time.Second {
		t.Fatal("MCP process Start was not bounded")
	}
}
