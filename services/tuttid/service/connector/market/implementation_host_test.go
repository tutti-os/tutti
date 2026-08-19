package connectormarket

import (
	"context"
	"encoding/json"
	"errors"
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
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
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
	mu        sync.Mutex
	closed    bool
}

func newMCPConnectionStub() *mcpConnectionStub {
	return &mcpConnectionStub{frames: make(chan agentruntime.ProcessFrame, 16)}
}

func (connection *mcpConnectionStub) Send(data []byte) error {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.closed {
		return io.ErrClosedPipe
	}
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
	connection.closeOnce.Do(func() {
		connection.mu.Lock()
		connection.closed = true
		close(connection.frames)
		connection.mu.Unlock()
	})
	return nil
}
func (connection *mcpConnectionStub) exit() {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.closed {
		return
	}
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

func testCLIHost(t *testing.T, processes agentruntime.ProcessTransport) (*ImplementationHost, *ConnectorRuntimeRegistry, market.Connector, market.HostGeneration) {
	return testCLIHostWithSetup(t, processes, nil)
}

func testCLIHostWithSetup(t *testing.T, processes agentruntime.ProcessTransport, setup func(string)) (*ImplementationHost, *ConnectorRuntimeRegistry, market.Connector, market.HostGeneration) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "connector.js"), []byte("// connector"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtimePath := filepath.Join(root, "node")
	if err := os.WriteFile(runtimePath, []byte("runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if setup != nil {
		setup(root)
	}
	inventory, err := connectorruntime.ExecutionInventoryDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	commands := NewConnectorRuntimeRegistry()
	host, err := NewImplementationHost(ImplementationHostConfig{Artifacts: preparedResolverStub{receipt: market.PreparedArtifactReceipt{PreparedPath: root, InventoryDigest: inventory}},
		Runtimes: connectorRuntimeStub{executable: connectorruntime.ConnectorExecutable{Path: runtimePath,
			SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SizeBytes: 7}},
		Processes: processes, Registry: commands, StateRoot: t.TempDir(), MCPStartupTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close() })
	connector := market.Connector{Key: "github", Installation: market.Installation{State: market.InstallationStateInstalled,
		InstalledReleaseDigest: implementationHostTestReleaseDigest}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = completeImplementationHostTestRelease(market.Release{Manifest: market.Manifest{AuthorizationKind: "none", IconURL: "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg",
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

func TestContainsPermissionScopeAcceptsScopedPermission(t *testing.T) {
	if !connectorruntime.ContainsPermissionScope([]string{"network:larksuite.com"}, "network") {
		t.Fatal("scoped network permission did not enable connector network access")
	}
	if connectorruntime.ContainsPermissionScope([]string{"filesystem:workspace"}, "network") {
		t.Fatal("unrelated scoped permission enabled connector network access")
	}
}

func TestImplementationHostChecksCLIReadinessWithDeclaredArguments(t *testing.T) {
	processes := &recordingConnectorProcessStub{}
	host, _, connector, generation := testCLIHost(t, processes)
	cli := connector.Release.Manifest.Implementation.ManagedStdio.CLI
	cli.Arguments = []string{"--non-interactive"}
	cli.ReadinessProbe = &market.CLIReadinessProbe{Arguments: []string{"doctor", "--quiet"}, TimeoutMS: 1_000}
	request := market.RuntimeReconcileRequest{OperationID: "reconcile-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation}

	receipt, err := host.Reconcile(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Readiness.State != market.RuntimeReadinessReady || len(receipt.Readiness.Interfaces) != 1 ||
		receipt.Readiness.Interfaces[0].Kind != "cli" {
		t.Fatalf("readiness = %#v", receipt.Readiness)
	}
	entrypoint := filepath.Join(processes.spec.CWD, "connector.js")
	wantSuffix := []string{entrypoint, "--non-interactive", "doctor", "--quiet"}
	if len(processes.spec.Command) < len(wantSuffix)+1 ||
		!slices.Equal(processes.spec.Command[len(processes.spec.Command)-len(wantSuffix):], wantSuffix) {
		t.Fatalf("readiness command = %#v, want suffix %#v", processes.spec.Command, wantSuffix)
	}

	processes.exitCode = 1
	request.Generation.Generation++
	if _, err = host.Reconcile(context.Background(), request); err == nil || !strings.Contains(err.Error(), "CLI readiness") {
		t.Fatalf("failed readiness error = %v", err)
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
	commands := NewConnectorRuntimeRegistry()
	stateRoot := t.TempDir()
	host, err := NewImplementationHost(ImplementationHostConfig{
		Artifacts: preparedResolverStub{receipt: market.PreparedArtifactReceipt{PreparedPath: root, InventoryDigest: inventory}},
		Runtimes: connectorRuntimeStub{executable: connectorruntime.ConnectorExecutable{Path: runtimePath,
			SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SizeBytes: 7}},
		Processes: &connectorProcessStub{}, Registry: commands, StateRoot: stateRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := market.Connector{Key: "github", Installation: market.Installation{State: market.InstallationStateInstalled,
		InstalledReleaseDigest: implementationHostTestReleaseDigest}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = completeImplementationHostTestRelease(market.Release{Manifest: market.Manifest{AuthorizationKind: "none", IconURL: "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg",
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
	if receipt.Readiness.State != market.RuntimeReadinessReady || len(receipt.Readiness.Interfaces) != 1 ||
		receipt.Readiness.Interfaces[0].Kind != "cli" || len(receipt.Readiness.Interfaces[0].RouteIDs) != 0 {
		t.Fatalf("readiness = %#v", receipt.Readiness)
	}
	routes := commands.runtime.Routes()
	if len(routes) != 1 || routes[0].CLICommand != "tutti-connector-github" {
		t.Fatalf("CLI routes = %#v", routes)
	}
	shimPath := filepath.Join(stateRoot, "bin", routes[0].CLICommand)
	if _, err := os.Stat(shimPath); err != nil {
		t.Fatalf("CLI shim was not published: %v", err)
	}
	if err := host.DeactivateRuntime(context.Background(), market.RuntimeDeactivationRequest{ConnectionID: "workspace-1", ConnectorKey: "github",
		ReleaseDigest: implementationHostTestReleaseDigest, Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 3}}); err != nil {
		t.Fatal(err)
	}
	if routes := commands.runtime.Routes(); len(routes) != 0 {
		t.Fatalf("deactivated connector route remained published: %#v", routes)
	}
	if _, err := os.Stat(shimPath); !os.IsNotExist(err) {
		t.Fatalf("deactivated connector CLI shim remained: %v", err)
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
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil {
			t.Error(err)
			return
		}
		if request.Header.Get("MCP-Protocol-Version") != mcp.ModernProtocolVersion || request.Header.Get("Mcp-Method") != message.Method {
			t.Errorf("modern MCP metadata = %#v", request.Header)
		}
		calls = append(calls, message.Method)
		result := map[string]any{}
		switch message.Method {
		case "server/discover":
			result = map[string]any{"resultType": "complete", "supportedVersions": []string{mcp.ModernProtocolVersion}, "capabilities": map[string]any{"tools": map[string]any{}}}
		case "tools/list":
			result = map[string]any{"resultType": "complete", "tools": []any{map[string]any{
				"name": "status", "description": "Read status",
				"inputSchema": map[string]any{"type": "object"},
			}}}
		case "tools/call":
			result = map[string]any{"resultType": "complete", "content": []any{map[string]any{"type": "text", "text": "ready"}}}
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": result})
	}))
	defer server.Close()

	root := t.TempDir()
	skillDir := filepath.Join(root, "skills", "document-search")
	if err := os.MkdirAll(skillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: document-search\ndescription: Search Tencent Docs.\n---\n\nUse the Connector MCP tools.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtimePath := filepath.Join(root, "node")
	if err := os.WriteFile(runtimePath, []byte("runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	commands := NewConnectorRuntimeRegistry()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	endpoint := strings.Replace(server.URL, "127.0.0.1", "example.com", 1)
	remoteMCPClientFactory, err := NewDirectRemoteMCPClientFactory(DirectRemoteMCPClientFactoryConfig{
		BaseURL: endpoint, HTTPClient: &http.Client{Transport: transport},
		AuthorizeAccountRequest: func(request *http.Request, accountID string) error {
			if accountID != "account-1" {
				t.Fatalf("accountID = %q", accountID)
			}
			request.Header.Set("Cookie", "session_id=user-session")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	host, err := NewImplementationHost(ImplementationHostConfig{
		Artifacts: preparedResolverStub{receipt: market.PreparedArtifactReceipt{PreparedPath: root}}, Runtimes: connectorRuntimeStub{executable: connectorruntime.ConnectorExecutable{
			Path: runtimePath, SHA256: strings.Repeat("a", 64), SizeBytes: 7,
		}}, Processes: &connectorProcessStub{}, Registry: commands, StateRoot: t.TempDir(),
		RemoteMCPClientFactory: remoteMCPClientFactory,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close() })
	connector := market.Connector{Key: "github", Installation: market.Installation{
		State: market.InstallationStateInstalled, InstalledReleaseDigest: implementationHostTestReleaseDigest,
	}, Authorization: market.Authorization{State: market.AuthorizationStateNotRequired}}
	connector.Release = completeImplementationHostTestRelease(market.Release{Manifest: market.Manifest{
		AuthorizationKind: "none", IconURL: "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg",
		RequiredCapabilities: []string{"tools"},
		Implementation: market.Implementation{Kind: market.ImplementationKindRemoteStreamableHTTP,
			RemoteStreamableHTTP: &market.RemoteStreamableHTTPImplementation{
				ProtocolVersion: mcp.ModernProtocolVersion, BindingRef: "github.primary", ContractVersion: 1,
				BindingContractHash: "sha256:" + strings.Repeat("b", 64),
			}},
	}})
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 2}
	receipt, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{
		OperationID: "op-remote", Scope: market.OperationScope{AccountID: "account-1"}, ConnectionID: "default", Connector: connector, Enabled: true, Generation: generation,
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Readiness.State != market.RuntimeReadinessReady || len(receipt.Readiness.Interfaces) != 1 ||
		len(receipt.Readiness.Interfaces[0].RouteIDs) != 1 || receipt.Readiness.Interfaces[0].RouteIDs[0] != "connector.github.mcp.status" {
		t.Fatalf("readiness = %#v", receipt.Readiness)
	}
	tools, err := commands.MCPRegistry().Tools(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Name != "github_status" {
		t.Fatalf("native MCP tools = %#v", tools)
	}
	output, err := commands.MCPRegistry().Call(context.Background(), "github_status", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if len(output) == 0 {
		t.Fatalf("output = %#v", output)
	}
	if len(calls) != 5 || calls[0] != "server/discover" || calls[1] != "tools/list" || calls[2] != "tools/list" || calls[3] != "tools/list" || calls[4] != "tools/call" {
		t.Fatalf("calls = %#v", calls)
	}
	hints := commands.RouteRegistry().RoutingHints()
	if len(hints) != 1 || hints[0].SkillRoot != filepath.Join(root, "skills") {
		t.Fatalf("remote Connector routing hints = %#v", hints)
	}
}

func TestImplementationHostPublishesStagedRoutesAtomically(t *testing.T) {
	host, commands, connector, generation := testCLIHost(t, &connectorProcessStub{})
	host.SetCapabilityPublication(false)
	_, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation})
	if err != nil {
		t.Fatal(err)
	}
	if routes := commands.runtime.Routes(); len(routes) != 0 {
		t.Fatalf("staged routes leaked before publication: %#v", routes)
	}
	if err := host.FenceAll(context.Background(), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	host.SetCapabilityPublication(true)
	if routes := commands.runtime.Routes(); len(routes) != 0 {
		t.Fatalf("failed bootstrap routes became visible: %#v", routes)
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
	routes := commands.runtime.Routes()
	if len(routes) != 1 || !routes[0].HasMCP || routes[0].CLICommand != "tutti-connector-github" {
		t.Fatalf("paginated MCP/CLI route = %#v", routes)
	}
	tools, err := commands.MCPRegistry().Tools(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 2 || tools[0].Name != "github_second" || tools[1].Name != "github_status" {
		t.Fatalf("paginated native MCP tools = %#v", tools)
	}
	connection.exit()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		tools, _ := commands.MCPRegistry().Tools(context.Background())
		if len(commands.runtime.Routes()) == 0 && len(tools) == 0 {
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
