package connectormarket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const implementationHostTestReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

func completeImplementationHostTestRelease(release market.Release) market.Release {
	release.SchemaVersion = "1"
	release.ReleaseID = "github@1.0.0"
	release.ConnectorKey = "github"
	release.Version = "1.0.0"
	release.ReleaseDigest = implementationHostTestReleaseDigest
	release.ManifestDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	release.Manifest.SchemaVersion = "1"
	release.Manifest.DisplayName = "GitHub"
	if managed := release.Manifest.Implementation.ManagedStdio; managed != nil && managed.CLI != nil {
		managed.Runtime.VersionRange = ">=20.0.0 <21.0.0"
	}
	release.Artifact = market.Artifact{Key: "connectors/github/1.0.0.zip",
		SHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", SizeBytes: 1024, MediaType: "application/vnd.tutti.connector+zip"}
	release.PublishedAt = time.Unix(1, 0).UTC()
	release.Status = market.ReleaseStatusAvailable
	return release
}

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

type retryCloseProcessStub struct {
	connection *retryCloseConnection
	started    chan struct{}
}

func (stub *retryCloseProcessStub) Start(context.Context, agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	select {
	case <-stub.started:
	default:
		close(stub.started)
	}
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
	inventory, err := connectorruntime.ExecutionInventoryDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	commands := NewConnectorCommandRegistry()
	host, err := NewImplementationHost(ImplementationHostConfig{Artifacts: preparedResolverStub{receipt: market.PreparedArtifactReceipt{PreparedPath: root, InventoryDigest: inventory}},
		Runtimes: connectorRuntimeStub{executable: connectorruntime.ConnectorExecutable{Path: runtimePath,
			SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SizeBytes: 7}},
		Processes: processes, Commands: commands, StateRoot: t.TempDir(), MCPStartupTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close() })
	connector := market.Connector{Key: "github", Installation: market.Installation{State: market.InstallationStateInstalled,
		InstalledReleaseDigest: implementationHostTestReleaseDigest}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = completeImplementationHostTestRelease(market.Release{Manifest: market.Manifest{AuthorizationKind: "none", IconURL: "data:image/png;base64,iVBORw0KGgo=",
		Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio, ManagedStdio: &market.ManagedStdioImplementation{
			Runtime: market.RuntimeRequirement{Language: "node", Profile: connectorruntime.ConnectorNodeProfile, ABI: "node20-" + runtime.GOOS + "-" + runtime.GOARCH},
			CLI: &market.ManagedCLIInterface{Entrypoint: "connector.js", Commands: []market.CLICommand{{Name: "status",
				InputSchema: map[string]any{"type": "object"}, TimeoutMS: 120_000}}},
		}}}})
	return host, commands, connector, market.HostGeneration{BootEpoch: "boot-1", Generation: 2}
}

func (stub preparedResolverStub) ResolvePrepared(context.Context, market.Release) (market.PreparedArtifactReceipt, error) {
	return stub.receipt, nil
}

type connectorRuntimeStub struct {
	executable connectorruntime.ConnectorExecutable
}

func (stub connectorRuntimeStub) ResolveProfile(context.Context, string) (connectorruntime.ResolvedConnectorRuntime, error) {
	return connectorruntime.ResolvedConnectorRuntime{Root: filepath.Dir(stub.executable.Path), Profile: connectorruntime.ConnectorNodeProfile,
		ABI: "node20-" + runtime.GOOS + "-" + runtime.GOARCH, Node: &stub.executable, Components: map[string]string{"node": "20.0.0"}}, nil
}
func (stub connectorRuntimeStub) VerifyLaunch(string, string) (connectorruntime.ConnectorExecutable, error) {
	return stub.executable, nil
}

type connectorProcessStub struct {
	starts   int
	exitCode int
}

func (stub *connectorProcessStub) Start(context.Context, agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	stub.starts++
	exit := stub.exitCode
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
	if !connectorruntime.ContainsPermissionScope([]string{"network:larksuite.com"}, "network") {
		t.Fatal("scoped network permission did not enable connector network access")
	}
	if connectorruntime.ContainsPermissionScope([]string{"filesystem:workspace"}, "network") {
		t.Fatal("unrelated scoped permission enabled connector network access")
	}
}

func TestImplementationHostChecksCLIInstallationWithDeclaredProbeArguments(t *testing.T) {
	processes := &recordingConnectorProcessStub{}
	host, _, connector, generation := testCLIHost(t, processes)
	cli := connector.Release.Manifest.Implementation.ManagedStdio.CLI
	cli.Arguments = []string{"--non-interactive"}
	cli.InstallationProbe = &market.InstallationProbe{Arguments: []string{"doctor", "--quiet"}, TimeoutMS: 1_000}
	request := market.InstallationCheckRequest{OperationID: "probe-1", ConnectionID: "workspace-1",
		Connector: connector, Generation: generation}

	observation, err := host.CheckInstallation(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if observation.State != market.InstallationObservationPresent || observation.ConnectorKey != connector.Key ||
		observation.ReleaseDigest != implementationHostTestReleaseDigest {
		t.Fatalf("observation = %#v", observation)
	}
	entrypoint := filepath.Join(processes.spec.CWD, "connector.js")
	wantSuffix := []string{entrypoint, "--non-interactive", "doctor", "--quiet"}
	if len(processes.spec.Command) < len(wantSuffix)+1 ||
		!slices.Equal(processes.spec.Command[len(processes.spec.Command)-len(wantSuffix):], wantSuffix) {
		t.Fatalf("probe command = %#v, want suffix %#v", processes.spec.Command, wantSuffix)
	}

	processes.exitCode = 1
	observation, err = host.CheckInstallation(context.Background(), request)
	if err != nil || observation.State != market.InstallationObservationAbsent {
		t.Fatalf("absent observation = %#v, error = %v", observation, err)
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
	inventory, err := connectorruntime.ExecutionInventoryDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	commands := NewConnectorCommandRegistry()
	processes := &connectorProcessStub{}
	host, err := NewImplementationHost(ImplementationHostConfig{
		Artifacts: preparedResolverStub{receipt: market.PreparedArtifactReceipt{PreparedPath: root, InventoryDigest: inventory}},
		Runtimes: connectorRuntimeStub{executable: connectorruntime.ConnectorExecutable{Path: runtimePath,
			SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SizeBytes: 7}},
		Processes: processes, Commands: commands, StateRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := market.Connector{Key: "github", Installation: market.Installation{State: market.InstallationStateInstalled,
		InstalledReleaseDigest: implementationHostTestReleaseDigest}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = completeImplementationHostTestRelease(market.Release{Manifest: market.Manifest{AuthorizationKind: "none", IconURL: "data:image/png;base64,iVBORw0KGgo=",
		Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio, ManagedStdio: &market.ManagedStdioImplementation{
			Runtime: market.RuntimeRequirement{Language: "node", Profile: connectorruntime.ConnectorNodeProfile, ABI: "node20-" + runtime.GOOS + "-" + runtime.GOARCH},
			CLI: &market.ManagedCLIInterface{Entrypoint: "connector.js", Commands: []market.CLICommand{{Name: "status",
				InputSchema: map[string]any{"type": "object"}, TimeoutMS: 1_000}}},
		}}}})
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
		ReleaseDigest: implementationHostTestReleaseDigest, Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 3}}); err != nil {
		t.Fatal(err)
	}
	if _, err := commands.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: receipt.RouteIDs[0], Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"}}); err == nil {
		t.Fatal("deactivated connector CLI command remained routable")
	}
}

func TestImplementationHostDiscoversAndInvokesRemoteStreamableHTTPMCP(t *testing.T) {
	var calls []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cookie") != "session_id=user-session" {
			t.Errorf("Cookie = %q", request.Header.Get("Cookie"))
		}
		if request.Header.Get("Tutti-Connector-Version") != "1.0.0" {
			t.Errorf("Tutti-Connector-Version = %q", request.Header.Get("Tutti-Connector-Version"))
		}
		if request.Method == http.MethodDelete {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil {
			t.Error(err)
			return
		}
		if len(message.ID) == 0 {
			response.WriteHeader(http.StatusAccepted)
			return
		}
		calls = append(calls, message.Method)
		result := map[string]any{}
		switch message.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "2025-06-18"}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{
				"name": "status", "description": "Read status",
				"inputSchema": map[string]any{"type": "object"},
			}}}
		case "tools/call":
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "ready"}}}
		}
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Mcp-Session-Id", "mcp-session")
		_ = json.NewEncoder(response).Encode(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": result})
	}))
	defer server.Close()

	root := t.TempDir()
	runtimePath := filepath.Join(root, "node")
	if err := os.WriteFile(runtimePath, []byte("runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	commands := NewConnectorCommandRegistry()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	host, err := NewImplementationHost(ImplementationHostConfig{
		Artifacts: preparedResolverStub{}, Runtimes: connectorRuntimeStub{executable: connectorruntime.ConnectorExecutable{
			Path: runtimePath, SHA256: strings.Repeat("a", 64), SizeBytes: 7,
		}}, Processes: &connectorProcessStub{}, Commands: commands, StateRoot: t.TempDir(),
		RemoteHTTPClient: &http.Client{Transport: transport}, AuthorizeRemoteRequest: func(request *http.Request) error {
			request.Header.Set("Cookie", "session_id=user-session")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close() })
	endpoint := strings.Replace(server.URL, "127.0.0.1", "example.com", 1)
	connector := market.Connector{Key: "github", Installation: market.Installation{
		State: market.InstallationStateInstalled, InstalledReleaseDigest: implementationHostTestReleaseDigest,
	}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = completeImplementationHostTestRelease(market.Release{Manifest: market.Manifest{
		AuthorizationKind: "none", IconURL: "data:image/png;base64,iVBORw0KGgo=",
		Implementation: market.Implementation{Kind: market.ImplementationKindRemoteStreamableHTTP,
			RemoteStreamableHTTP: &market.RemoteStreamableHTTPImplementation{
				Endpoint: endpoint, AllowedHosts: []string{"example.com"},
				Authentication: market.RemoteTransportAuthentication{Type: "host_session"},
				Limits:         market.RemoteTransportLimits{TimeoutMS: 10_000, MaxResponseBytes: 4096},
			}},
	}})
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 2}
	receipt, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{
		OperationID: "op-remote", ConnectionID: "default", Connector: connector, Enabled: true, Generation: generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(receipt.RouteIDs) != 1 || receipt.RouteIDs[0] != "connector.github.mcp.status" {
		t.Fatalf("routes = %#v", receipt.RouteIDs)
	}
	output, err := commands.Invoke(context.Background(), cliservice.InvokeRequest{
		CommandID: receipt.RouteIDs[0], Input: map[string]any{}, Context: cliservice.InvokeContext{WorkspaceID: "workspace-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if output.Value == nil {
		t.Fatalf("output = %#v", output)
	}
	if len(calls) != 3 || calls[0] != "initialize" || calls[1] != "tools/list" || calls[2] != "tools/call" {
		t.Fatalf("calls = %#v", calls)
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
	if len(processes.spec.ArtifactTrees) != 1 || processes.spec.ArtifactTrees[0].Root != processes.spec.CWD {
		t.Fatalf("snapshot artifact identity = %#v", processes.spec.ArtifactTrees)
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
		ReleaseDigest: implementationHostTestReleaseDigest, Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 3}, Deadline: deadline}); err != nil {
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
	started := make(chan struct{})
	host, commands, connector, generation := testCLIHost(t, &retryCloseProcessStub{connection: connection, started: started})
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
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("CLI process did not start")
	}
	deactivation := market.RuntimeDeactivationRequest{ConnectionID: "workspace-1", ConnectorKey: "github", ReleaseDigest: implementationHostTestReleaseDigest,
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
	startedAt := time.Now()
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Reconcile() error = %v, want deadline", err)
	}
	if time.Since(startedAt) > time.Second {
		t.Fatal("MCP process Start was not bounded")
	}
}
