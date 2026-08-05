//revive:disable:file-length-limit

package connectormarket

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
	mcpservice "github.com/tutti-os/tutti/services/tuttid/service/mcp"
)

type PreparedArtifactResolver interface {
	ResolvePrepared(context.Context, market.Release) (market.PreparedArtifactReceipt, error)
}

type ConnectorRuntimeResolver interface {
	ResolveProfile(context.Context, string) (managedruntime.ResolvedConnectorRuntime, error)
	VerifyLaunch(profile, runtimeName string) (managedruntime.ConnectorExecutable, error)
}

type ImplementationHostConfig struct {
	Artifacts         PreparedArtifactResolver
	Runtimes          ConnectorRuntimeResolver
	Processes         agentruntime.ProcessTransport
	Commands          *ConnectorCommandRegistry
	StateRoot         string
	MCPStartupTimeout time.Duration
}

type ImplementationHost struct {
	artifacts         PreparedArtifactResolver
	runtimes          ConnectorRuntimeResolver
	processes         agentruntime.ProcessTransport
	commands          *ConnectorCommandRegistry
	stateRoot         string
	mcpStartupTimeout time.Duration

	mu          sync.Mutex
	routes      map[string]*connectorRoute
	fences      map[string]market.HostGeneration
	transitions map[string]*sync.Mutex
	closed      bool
}

type trackedConnectorProcess struct {
	connection agentruntime.ProcessConnection
	cancel     context.CancelFunc
	closing    bool
}

type connectorRoute struct {
	id            string
	workspaceID   string
	connectorKey  string
	releaseDigest string
	generation    market.HostGeneration
	capabilities  map[string]connectorCommand
	closeMu       sync.Mutex
	processMu     sync.Mutex
	processes     map[uint64]trackedConnectorProcess
	pendingStarts map[uint64]context.CancelFunc
	nextProcessID uint64
	fenced        bool
	mcpClient     *mcpservice.StdioClient
	executionRoot string
}

type connectorCommand struct {
	capability cliservice.Capability
	invoke     func(context.Context, cliservice.InvokeRequest) (cliservice.CommandOutput, error)
}

func NewImplementationHost(config ImplementationHostConfig) (*ImplementationHost, error) {
	if config.Artifacts == nil || config.Runtimes == nil || config.Processes == nil || config.Commands == nil {
		return nil, errors.New("connector implementation host dependencies are required")
	}
	if !filepath.IsAbs(strings.TrimSpace(config.StateRoot)) {
		return nil, errors.New("connector implementation state root must be absolute")
	}
	if config.MCPStartupTimeout <= 0 {
		config.MCPStartupTimeout = 15 * time.Second
	}
	return &ImplementationHost{artifacts: config.Artifacts, runtimes: config.Runtimes, processes: config.Processes,
		commands: config.Commands, stateRoot: filepath.Clean(config.StateRoot), mcpStartupTimeout: config.MCPStartupTimeout,
		routes: make(map[string]*connectorRoute), fences: make(map[string]market.HostGeneration), transitions: make(map[string]*sync.Mutex)}, nil
}

func (host *ImplementationHost) Reconcile(ctx context.Context, request market.WorkspaceReconcileRequest) (market.WorkspaceRuntimeReceipt, error) {
	if host == nil || !hostIdentityPattern.MatchString(request.WorkspaceID) || !hostIdentityPattern.MatchString(request.Connector.Key) || request.Generation.BootEpoch == "" || request.Generation.Generation == 0 {
		return market.WorkspaceRuntimeReceipt{}, errors.New("connector workspace reconcile identity is invalid")
	}
	key := connectorRouteKey(request.WorkspaceID, request.Connector.Key)
	if !request.Enabled {
		if err := host.removeRoute(key, request.Generation, "", time.Time{}); err != nil {
			return market.WorkspaceRuntimeReceipt{}, err
		}
		return market.WorkspaceRuntimeReceipt{OperationID: request.OperationID, WorkspaceID: request.WorkspaceID,
			ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Installation.InstalledReleaseDigest, Generation: request.Generation}, nil
	}
	if request.Connector.Authorization.State != market.AuthorizationStateNotRequired || request.Connector.Release.Manifest.AuthorizationKind != "none" {
		return market.WorkspaceRuntimeReceipt{}, errors.New("connector credential broker is not available for authorized connectors")
	}
	if request.Connector.Installation.State != market.InstallationStateInstalled ||
		request.Connector.Installation.InstalledReleaseDigest != request.Connector.Release.ReleaseDigest {
		return market.WorkspaceRuntimeReceipt{}, errors.New("connector installed release is not active")
	}
	prepared, err := host.artifacts.ResolvePrepared(ctx, request.Connector.Release)
	if err != nil {
		return market.WorkspaceRuntimeReceipt{}, fmt.Errorf("resolve prepared connector artifact: %w", err)
	}
	executionRoot, err := host.createExecutionSnapshot(prepared)
	if err != nil {
		return market.WorkspaceRuntimeReceipt{}, fmt.Errorf("create connector execution snapshot: %w", err)
	}
	prepared.PreparedPath = executionRoot
	route, err := host.buildManagedRoute(ctx, request, prepared)
	if err != nil {
		_ = removeExecutionSnapshot(executionRoot)
		return market.WorkspaceRuntimeReceipt{}, err
	}
	route.executionRoot = executionRoot
	if err := host.commitRoute(key, route); err != nil {
		_ = route.close(time.Now().Add(3 * time.Second))
		return market.WorkspaceRuntimeReceipt{}, err
	}
	if route.mcpClient != nil {
		go host.monitorMCPRoute(route, route.mcpClient)
	}
	routeIDs := make([]string, 0, len(route.capabilities))
	for routeID := range route.capabilities {
		routeIDs = append(routeIDs, routeID)
	}
	sort.Strings(routeIDs)
	return market.WorkspaceRuntimeReceipt{OperationID: request.OperationID, WorkspaceID: request.WorkspaceID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: route.releaseDigest, Generation: request.Generation, RouteIDs: routeIDs}, nil
}

func (host *ImplementationHost) Close() error {
	if host == nil {
		return nil
	}
	host.mu.Lock()
	host.closed = true
	routes := make([]*connectorRoute, 0, len(host.routes))
	for _, route := range host.routes {
		host.commands.remove(route.id)
		route.fence()
		routes = append(routes, route)
	}
	host.mu.Unlock()
	var closeErrors []error
	for _, route := range routes {
		if err := route.close(time.Now().Add(3 * time.Second)); err != nil {
			closeErrors = append(closeErrors, err)
			continue
		}
		host.deleteExactRoute(route)
	}
	return errors.Join(closeErrors...)
}

// SetCapabilityPublication gates discovery and invocation without preventing
// bootstrap from staging validated MCP processes and CLI routes. Enabling is a
// single registry state transition after every durable binding reconciles.
func (host *ImplementationHost) SetCapabilityPublication(enabled bool) {
	if host != nil {
		host.commands.setPublished(enabled)
	}
}

// FenceAll deactivates every staged or published route, including a route whose
// operation failed before its durable binding was committed.
func (host *ImplementationHost) FenceAll(_ context.Context, deadline time.Time) error {
	if host == nil {
		return nil
	}
	host.mu.Lock()
	type target struct {
		key        string
		generation market.HostGeneration
		digest     string
	}
	targets := make([]target, 0, len(host.routes))
	for key, route := range host.routes {
		targets = append(targets, target{key: key, generation: route.generation, digest: route.releaseDigest})
	}
	host.mu.Unlock()
	var fenceErrors []error
	for _, target := range targets {
		fenceErrors = append(fenceErrors, host.removeRoute(target.key, target.generation, target.digest, deadline))
	}
	return errors.Join(fenceErrors...)
}

func (host *ImplementationHost) FailClosed(ctx context.Context, deadline time.Time) error {
	if host == nil {
		return nil
	}
	host.SetCapabilityPublication(false)
	return host.FenceAll(ctx, deadline)
}

func (host *ImplementationHost) DeactivateWorkspace(ctx context.Context, request market.WorkspaceDeactivationRequest) error {
	if host == nil {
		return errors.New("connector implementation host is unavailable")
	}
	if !request.Deadline.IsZero() && time.Now().After(request.Deadline) {
		return context.DeadlineExceeded
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return host.removeRoute(connectorRouteKey(request.WorkspaceID, request.ConnectorKey), request.Generation, request.ReleaseDigest, request.Deadline)
}

func (host *ImplementationHost) buildManagedRoute(ctx context.Context, request market.WorkspaceReconcileRequest, prepared market.PreparedArtifactReceipt) (*connectorRoute, error) {
	implementation := request.Connector.Release.Manifest.Implementation
	if implementation.Kind != market.ImplementationKindManagedStdio || implementation.ManagedStdio == nil {
		return nil, errors.New("only managed_stdio connector implementations are supported")
	}
	managed := implementation.ManagedStdio
	resolved, err := host.runtimes.ResolveProfile(ctx, managed.Runtime.Profile)
	if err != nil {
		return nil, fmt.Errorf("resolve connector managed runtime: %w", err)
	}
	executable, err := host.runtimes.VerifyLaunch(managed.Runtime.Profile, managed.Runtime.Language)
	if err != nil {
		return nil, fmt.Errorf("verify connector managed runtime launch: %w", err)
	}
	if err := verifyRuntimeABI(managed.Runtime, resolved); err != nil {
		return nil, err
	}
	stateDir, err := secureConnectorStateDir(host.stateRoot, request.WorkspaceID, request.Connector.Key)
	if err != nil {
		return nil, err
	}
	route := &connectorRoute{id: connectorRouteKey(request.WorkspaceID, request.Connector.Key), workspaceID: request.WorkspaceID,
		connectorKey: request.Connector.Key, releaseDigest: request.Connector.Release.ReleaseDigest,
		generation: request.Generation, capabilities: make(map[string]connectorCommand),
		processes: make(map[uint64]trackedConnectorProcess), pendingStarts: make(map[uint64]context.CancelFunc)}
	sandbox := &agentruntime.ConnectorSandboxPolicy{ReadOnlyPaths: []string{prepared.PreparedPath, resolved.Root}, WritablePaths: []string{stateDir},
		ReadOnlyTreeIdentities: []agentruntime.ReadOnlyTreeIdentity{{Root: prepared.PreparedPath, SHA256: prepared.InventoryDigest}},
		Network:                containsPermission(request.Connector.Release.Manifest.Permissions, "network")}
	if managed.MCP != nil {
		if err := host.attachMCP(ctx, route, managed, prepared, executable, sandbox); err != nil {
			_ = route.close(time.Now().Add(3 * time.Second))
			return nil, err
		}
	}
	if managed.CLI != nil {
		if err := host.attachCLI(route, managed, prepared, executable, sandbox); err != nil {
			_ = route.close(time.Now().Add(3 * time.Second))
			return nil, err
		}
	}
	if len(route.capabilities) == 0 {
		_ = route.close(time.Now().Add(3 * time.Second))
		return nil, errors.New("connector implementation exposed no MCP tools or CLI commands")
	}
	return route, nil
}

func (host *ImplementationHost) attachMCP(ctx context.Context, route *connectorRoute, managed *market.ManagedStdioImplementation, prepared market.PreparedArtifactReceipt, executable managedruntime.ConnectorExecutable, sandbox *agentruntime.ConnectorSandboxPolicy) error {
	entrypoint, err := preparedEntrypoint(prepared.PreparedPath, managed.MCP.Entrypoint)
	if err != nil {
		return err
	}
	startupContext, cancelStartup := context.WithTimeout(ctx, host.mcpStartupTimeout)
	defer cancelStartup()
	startContext, processID, accepted := route.beginProcess(context.Background())
	if !accepted {
		return errors.New("connector MCP route was fenced during startup")
	}
	connection, err := host.awaitProcessStart(startupContext, route, processID, startContext,
		connectorProcessSpec(route, managed.Runtime.Language, executable, prepared.PreparedPath,
			append([]string{entrypoint}, managed.MCP.Arguments...), sandbox))
	if err != nil {
		return fmt.Errorf("start connector MCP process: %w", err)
	}
	release := func() { route.releaseProcess(processID, connection) }
	client, err := mcpservice.NewStdioClient(mcpservice.StdioClientConfig{Connection: connection, ProcessName: route.connectorKey + " MCP"})
	if err != nil {
		release()
		return err
	}
	if _, err := client.Call(startupContext, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "tuttid-connector-host", "version": "1"}}); err != nil {
		release()
		return fmt.Errorf("initialize connector MCP process: %w", err)
	}
	if err := client.Notify("notifications/initialized", map[string]any{}); err != nil {
		release()
		return err
	}
	tools, err := listConnectorMCPTools(startupContext, client)
	if err != nil {
		release()
		return err
	}
	if len(tools) == 0 {
		release()
		return errors.New("connector MCP tools/list response is invalid")
	}
	for _, tool := range tools {
		tool := tool
		commandID, err := connectorCapabilityID(route.connectorKey, "mcp", tool.Name)
		if err != nil || tool.InputSchema == nil || tool.InputSchema["type"] != "object" || cliservice.ValidateCapabilityInputSchema(tool.InputSchema) != nil {
			release()
			return errors.New("connector MCP tool contract is invalid")
		}
		if _, duplicate := route.capabilities[commandID]; duplicate {
			release()
			return errors.New("connector MCP tool capability id is duplicated")
		}
		route.capabilities[commandID] = connectorCommand{capability: connectorCapability(commandID, route.connectorKey, tool.Name, tool.Description, tool.InputSchema),
			invoke: func(callCtx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
				if !host.routeCurrent(route) {
					return cliservice.CommandOutput{}, cliservice.ErrServiceUnavailable
				}
				result, err := client.Call(callCtx, "tools/call", map[string]any{"name": tool.Name, "arguments": request.Input})
				if err != nil {
					return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("connector MCP tool failed", err)
				}
				return jsonCommandOutput(result)
			}}
	}
	route.mcpClient = client
	return nil
}

type connectorMCPTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func listConnectorMCPTools(ctx context.Context, client *mcpservice.StdioClient) ([]connectorMCPTool, error) {
	const maxPages = 64
	const maxTools = 512
	result := make([]connectorMCPTool, 0)
	cursor := ""
	seen := map[string]struct{}{}
	for page := 0; page < maxPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := client.Call(ctx, "tools/list", params)
		if err != nil {
			return nil, fmt.Errorf("list connector MCP tools: %w", err)
		}
		var listing struct {
			Tools      []connectorMCPTool `json:"tools"`
			NextCursor string             `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &listing); err != nil {
			return nil, errors.New("connector MCP tools/list response is invalid")
		}
		result = append(result, listing.Tools...)
		if len(result) > maxTools {
			return nil, errors.New("connector MCP tools/list exceeds tool limit")
		}
		next := strings.TrimSpace(listing.NextCursor)
		if next == "" {
			return result, nil
		}
		if _, duplicate := seen[next]; duplicate {
			return nil, errors.New("connector MCP tools/list cursor repeated")
		}
		seen[next] = struct{}{}
		cursor = next
	}
	return nil, errors.New("connector MCP tools/list exceeds page limit")
}

func (host *ImplementationHost) monitorMCPRoute(route *connectorRoute, client *mcpservice.StdioClient) {
	<-client.Done()
	_ = host.retireExactRoute(route, time.Now().Add(3*time.Second))
}

func (host *ImplementationHost) attachCLI(route *connectorRoute, managed *market.ManagedStdioImplementation, prepared market.PreparedArtifactReceipt, executable managedruntime.ConnectorExecutable, sandbox *agentruntime.ConnectorSandboxPolicy) error {
	entrypoint, err := preparedEntrypoint(prepared.PreparedPath, managed.CLI.Entrypoint)
	if err != nil {
		return err
	}
	for _, manifestCommand := range managed.CLI.Commands {
		manifestCommand := manifestCommand
		commandID, err := connectorCapabilityID(route.connectorKey, "cli", manifestCommand.Name)
		if err != nil {
			return err
		}
		if _, duplicate := route.capabilities[commandID]; duplicate {
			return errors.New("connector CLI capability id is duplicated")
		}
		if err := cliservice.ValidateCapabilityInputSchema(manifestCommand.InputSchema); err != nil {
			return fmt.Errorf("connector CLI input schema is unsupported: %w", err)
		}
		route.capabilities[commandID] = connectorCommand{capability: connectorCapability(commandID, route.connectorKey, manifestCommand.Name, manifestCommand.Description, manifestCommand.InputSchema),
			invoke: func(callCtx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
				if !host.routeCurrent(route) {
					return cliservice.CommandOutput{}, cliservice.ErrServiceUnavailable
				}
				timeoutCtx, cancel := context.WithTimeout(callCtx, time.Duration(manifestCommand.TimeoutMS)*time.Millisecond)
				defer cancel()
				arguments := append([]string{entrypoint}, managed.CLI.Arguments...)
				arguments = append(arguments, manifestCommand.Arguments...)
				connection, processID, err := host.startRouteProcess(timeoutCtx, route, connectorProcessSpec(route, managed.Runtime.Language, executable, prepared.PreparedPath, arguments, sandbox))
				if err != nil {
					return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("start connector CLI command", err)
				}
				defer route.releaseProcess(processID, connection)
				input, _ := json.Marshal(request.Input)
				if err := connection.Send(append(input, '\n')); err != nil {
					return cliservice.CommandOutput{}, err
				}
				if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
					_ = graceful.CloseInput()
				}
				return collectCLIOutput(timeoutCtx, connection)
			}}
	}
	return nil
}

func connectorProcessSpec(route *connectorRoute, language string, executable managedruntime.ConnectorExecutable, cwd string, args []string, sandbox *agentruntime.ConnectorSandboxPolicy) agentruntime.ProcessSpec {
	command := append([]string{executable.Path}, args...)
	stateDir := ""
	if sandbox != nil && len(sandbox.WritablePaths) != 0 {
		stateDir = sandbox.WritablePaths[0]
	}
	return agentruntime.ProcessSpec{Provider: "connector:" + route.connectorKey, RoomID: route.workspaceID, CWD: cwd, Command: command,
		Env: []string{"TUTTI_CONNECTOR_WORKSPACE_ID=" + route.workspaceID, "TUTTI_CONNECTOR_KEY=" + route.connectorKey,
			"TUTTI_CONNECTOR_LANGUAGE=" + language, "TUTTI_CONNECTOR_STATE_DIR=" + stateDir},
		ExecutableIdentity: &agentruntime.ExecutableIdentity{SHA256: executable.SHA256, SizeBytes: executable.SizeBytes}, ConnectorSandbox: sandbox}
}

func (host *ImplementationHost) startRouteProcess(ctx context.Context, route *connectorRoute, spec agentruntime.ProcessSpec) (agentruntime.ProcessConnection, uint64, error) {
	host.mu.Lock()
	if host.closed || host.routes[route.id] != route {
		host.mu.Unlock()
		return nil, 0, cliservice.ErrServiceUnavailable
	}
	startContext, processID, accepted := route.beginProcess(ctx)
	host.mu.Unlock()
	if !accepted {
		return nil, 0, cliservice.ErrServiceUnavailable
	}
	connection, err := host.awaitProcessStart(ctx, route, processID, startContext, spec)
	if err != nil {
		return nil, 0, err
	}
	return connection, processID, nil
}

func (host *ImplementationHost) awaitProcessStart(waitCtx context.Context, route *connectorRoute, processID uint64,
	startContext context.Context, spec agentruntime.ProcessSpec) (agentruntime.ProcessConnection, error) {
	type startResult struct {
		connection agentruntime.ProcessConnection
		err        error
	}
	result := make(chan startResult, 1)
	go func() {
		connection, err := host.processes.Start(startContext, spec)
		result <- startResult{connection: connection, err: err}
	}()
	select {
	case started := <-result:
		if started.err != nil {
			route.failProcessStart(processID)
			return nil, started.err
		}
		if !route.commitProcessStart(processID, started.connection) {
			_ = started.connection.Close()
			return nil, cliservice.ErrServiceUnavailable
		}
		return started.connection, nil
	case <-waitCtx.Done():
		route.failProcessStart(processID)
		go func() {
			started := <-result
			if started.connection != nil {
				_ = started.connection.Close()
			}
		}()
		return nil, waitCtx.Err()
	}
}

func collectCLIOutput(ctx context.Context, connection agentruntime.ProcessConnection) (cliservice.CommandOutput, error) {
	const maxCLIOutputBytes = 4 << 20
	const maxCLIStderrBytes = 64 << 10
	var stdout, stderr strings.Builder
	for {
		var frame agentruntime.ProcessFrame
		var err error
		if contextual, ok := connection.(agentruntime.ContextProcessConnection); ok {
			frame, err = contextual.RecvContext(ctx)
		} else {
			frame, err = connection.Recv()
		}
		if err != nil {
			if errors.Is(err, io.EOF) && stdout.Len() != 0 {
				break
			}
			return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("read connector CLI output", err)
		}
		stdout.Write(frame.Stdout)
		stderr.Write(frame.Stderr)
		if stdout.Len() > maxCLIOutputBytes || stderr.Len() > maxCLIStderrBytes {
			if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
				_ = graceful.Kill()
			}
			return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("connector CLI output exceeded its limit", nil)
		}
		if frame.ExitCode != nil {
			if *frame.ExitCode != 0 {
				return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError(strings.TrimSpace(stderr.String()), nil)
			}
			break
		}
	}
	return jsonCommandOutput([]byte(strings.TrimSpace(stdout.String())))
}

func jsonCommandOutput(raw []byte) (cliservice.CommandOutput, error) {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("connector returned invalid JSON", nil)
	}
	if object, ok := value.(map[string]any); ok {
		return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: object}, nil
	}
	return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: map[string]any{"result": value}}, nil
}

func preparedEntrypoint(root, relative string) (string, error) {
	root = filepath.Clean(root)
	target := filepath.Join(root, filepath.FromSlash(relative))
	if target == root || !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", errors.New("connector entrypoint escapes prepared artifact")
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("connector entrypoint is not a regular prepared file")
	}
	return target, nil
}

func verifyRuntimeABI(requirement market.RuntimeRequirement, resolved managedruntime.ResolvedConnectorRuntime) error {
	if requirement.Profile != resolved.Profile || requirement.ABI != resolved.ABI {
		return errors.New("connector runtime ABI does not match the signed local runtime")
	}
	return nil
}

func connectorCapability(routeID, connectorKey, name, description string, inputSchema map[string]any) cliservice.Capability {
	if strings.TrimSpace(description) == "" {
		description = "Connector command " + name
	}
	kind := "cli"
	if strings.Contains(routeID, ".mcp.") {
		kind = "mcp"
	}
	return cliservice.Capability{ID: routeID, Path: []string{"connector", connectorKey, kind, name}, Summary: description,
		Description: description, Visibility: cliservice.CapabilityVisibilityPublic, InputSchema: inputSchema,
		Output: cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModeJSON, JSON: true},
		Source: cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceApp, AppID: "connector:" + connectorKey, AppName: connectorKey}}
}

var capabilityPartPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)
var hostIdentityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$`)

func secureConnectorStateDir(root, workspaceID, connectorKey string) (string, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(rootReal, workspaceID, connectorKey)
	if err := os.MkdirAll(target, 0o700); err != nil {
		return "", err
	}
	targetReal, err := filepath.EvalSymlinks(target)
	if err != nil || (targetReal != rootReal && !strings.HasPrefix(targetReal, rootReal+string(filepath.Separator))) {
		return "", errors.New("connector state directory escapes state root")
	}
	return targetReal, nil
}

func containsPermission(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func connectorCapabilityID(connectorKey, kind, name string) (string, error) {
	if !capabilityPartPattern.MatchString(connectorKey) || !capabilityPartPattern.MatchString(name) {
		return "", errors.New("connector capability name is invalid")
	}
	return "connector." + connectorKey + "." + kind + "." + name, nil
}

func connectorRouteKey(workspaceID, connectorKey string) string {
	return workspaceID + "\x00" + connectorKey
}

func (host *ImplementationHost) routeTransition(key string) *sync.Mutex {
	host.mu.Lock()
	defer host.mu.Unlock()
	transition := host.transitions[key]
	if transition == nil {
		transition = &sync.Mutex{}
		host.transitions[key] = transition
	}
	return transition
}

func (host *ImplementationHost) commitRoute(key string, next *connectorRoute) error {
	transition := host.routeTransition(key)
	transition.Lock()
	defer transition.Unlock()

	host.mu.Lock()
	if host.closed {
		host.mu.Unlock()
		return errors.New("connector implementation host is closed")
	}
	if fence, exists := host.fences[key]; exists && fence.BootEpoch == next.generation.BootEpoch && next.generation.Generation <= fence.Generation {
		host.mu.Unlock()
		return errors.New("connector workspace reconcile generation is fenced")
	}
	current := host.routes[key]
	if current != nil && !newerOrEqualGeneration(next.generation, current.generation) {
		host.mu.Unlock()
		return errors.New("connector workspace reconcile generation is stale")
	}
	if current != nil {
		host.commands.remove(current.id)
		current.fence()
	}
	host.mu.Unlock()

	if current != nil {
		if err := current.close(time.Now().Add(3 * time.Second)); err != nil {
			return fmt.Errorf("retire previous connector route: %w", err)
		}
	}

	host.mu.Lock()
	defer host.mu.Unlock()
	if host.closed || host.routes[key] != current {
		return errors.New("connector workspace route changed while committing")
	}
	host.routes[key] = next
	host.commands.replace(next)
	return nil
}

func (host *ImplementationHost) removeRoute(key string, generation market.HostGeneration, releaseDigest string, deadline time.Time) error {
	transition := host.routeTransition(key)
	transition.Lock()
	defer transition.Unlock()

	host.mu.Lock()
	current := host.routes[key]
	if current == nil {
		host.advanceFenceLocked(key, generation)
		host.mu.Unlock()
		return nil
	}
	if releaseDigest != "" && current.releaseDigest != releaseDigest {
		host.mu.Unlock()
		return errors.New("connector workspace deactivation release digest does not match active route")
	}
	if generation.BootEpoch != current.generation.BootEpoch {
		host.mu.Unlock()
		return errors.New("connector workspace deactivation boot epoch does not match active route")
	}
	if generation.Generation < current.generation.Generation {
		host.mu.Unlock()
		return nil
	}
	host.commands.remove(current.id)
	host.advanceFenceLocked(key, generation)
	current.fence()
	host.mu.Unlock()
	if err := current.close(deadline); err != nil {
		return err
	}
	host.mu.Lock()
	if host.routes[key] == current {
		delete(host.routes, key)
	}
	host.mu.Unlock()
	return nil
}

func (host *ImplementationHost) advanceFenceLocked(key string, generation market.HostGeneration) {
	current, exists := host.fences[key]
	if !exists || current.BootEpoch != generation.BootEpoch || generation.Generation > current.Generation {
		host.fences[key] = generation
	}
}

func (host *ImplementationHost) retireExactRoute(route *connectorRoute, deadline time.Time) error {
	transition := host.routeTransition(route.id)
	transition.Lock()
	defer transition.Unlock()
	host.mu.Lock()
	if host.routes[route.id] != route {
		host.mu.Unlock()
		return nil
	}
	host.commands.remove(route.id)
	route.fence()
	host.mu.Unlock()
	if err := route.close(deadline); err != nil {
		return err
	}
	host.deleteExactRoute(route)
	return nil
}

func (host *ImplementationHost) deleteExactRoute(route *connectorRoute) {
	host.mu.Lock()
	if host.routes[route.id] == route {
		delete(host.routes, route.id)
	}
	host.mu.Unlock()
}

func (host *ImplementationHost) routeCurrent(route *connectorRoute) bool {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.routes[route.id] != route {
		return false
	}
	return !route.isFenced()
}

func newerOrEqualGeneration(candidate, current market.HostGeneration) bool {
	return candidate.BootEpoch == current.BootEpoch && candidate.Generation >= current.Generation
}

func (route *connectorRoute) close(deadline time.Time) error {
	if route == nil {
		return nil
	}
	route.closeMu.Lock()
	defer route.closeMu.Unlock()
	route.fence()
	route.processMu.Lock()
	processes := make(map[uint64]trackedConnectorProcess, len(route.processes))
	for processID, process := range route.processes {
		process.closing = true
		route.processes[processID] = process
		processes[processID] = process
	}
	route.processMu.Unlock()

	type closeResult struct {
		processID uint64
		err       error
	}
	results := make(chan closeResult, len(processes))
	for processID, process := range processes {
		process.cancel()
		go func(processID uint64, connection agentruntime.ProcessConnection) {
			results <- closeResult{processID: processID, err: connection.Close()}
		}(processID, process.connection)
	}
	var closeErrors []error
	for range processes {
		var result closeResult
		if deadline.IsZero() {
			result = <-results
		} else {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return errors.Join(append(closeErrors, context.DeadlineExceeded)...)
			}
			timer := time.NewTimer(remaining)
			select {
			case result = <-results:
				if !timer.Stop() {
					<-timer.C
				}
			case <-timer.C:
				return errors.Join(append(closeErrors, context.DeadlineExceeded)...)
			}
		}
		if result.err != nil {
			closeErrors = append(closeErrors, result.err)
			continue
		}
		route.processMu.Lock()
		if current, exists := route.processes[result.processID]; exists && current.connection == processes[result.processID].connection {
			delete(route.processes, result.processID)
		}
		route.processMu.Unlock()
	}
	if len(closeErrors) == 0 && route.executionRoot != "" {
		if err := removeExecutionSnapshot(route.executionRoot); err != nil {
			closeErrors = append(closeErrors, err)
		} else {
			route.executionRoot = ""
		}
	}
	return errors.Join(closeErrors...)
}

const preparedReceiptFilename = ".tutti-connector-receipt.json"

func (host *ImplementationHost) createExecutionSnapshot(prepared market.PreparedArtifactReceipt) (string, error) {
	if strings.TrimSpace(prepared.InventoryDigest) == "" {
		return "", errors.New("prepared connector inventory digest is missing")
	}
	if err := os.MkdirAll(host.stateRoot, 0o700); err != nil {
		return "", err
	}
	stateRoot, err := filepath.EvalSymlinks(host.stateRoot)
	if err != nil {
		return "", err
	}
	parent := filepath.Join(stateRoot, "execution-snapshots")
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return "", err
	}
	staging, err := os.MkdirTemp(parent, ".staging-")
	if err != nil {
		return "", err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = removeExecutionSnapshot(staging)
		}
	}()
	if err := copyExecutionTree(prepared.PreparedPath, staging); err != nil {
		return "", err
	}
	digest, err := executionInventoryDigest(staging)
	if err != nil {
		return "", err
	}
	if digest != prepared.InventoryDigest {
		return "", errors.New("connector execution snapshot does not match verified inventory")
	}
	if err := makeExecutionTreeReadOnly(staging); err != nil {
		return "", err
	}
	target := staging + ".ready"
	if err := os.Rename(staging, target); err != nil {
		return "", err
	}
	cleanup = false
	return target, nil
}

func copyExecutionTree(source, destination string) error {
	return filepath.WalkDir(source, func(path string, _ os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		target := filepath.Join(destination, relative)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("prepared connector snapshot contains a symlink")
		}
		if info.IsDir() {
			return os.Mkdir(target, 0o700)
		}
		if !info.Mode().IsRegular() {
			return errors.New("prepared connector snapshot contains an unsupported file type")
		}
		sourceFile, err := os.Open(path)
		if err != nil {
			return err
		}
		openedInfo, statErr := sourceFile.Stat()
		if statErr != nil || !openedInfo.Mode().IsRegular() {
			sourceFile.Close()
			return errors.New("prepared connector file changed during snapshot")
		}
		targetFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			sourceFile.Close()
			return err
		}
		_, copyErr := io.Copy(targetFile, sourceFile)
		syncErr := targetFile.Sync()
		closeTargetErr := targetFile.Close()
		closeSourceErr := sourceFile.Close()
		return errors.Join(copyErr, syncErr, closeTargetErr, closeSourceErr)
	})
}

func executionInventoryDigest(root string) (string, error) {
	hash := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." || relative == preparedReceiptFilename {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("connector execution snapshot contains an unsupported file type")
		}
		_, _ = io.WriteString(hash, filepath.ToSlash(relative))
		_, _ = hash.Write([]byte{0})
		if entry.IsDir() {
			_, _ = hash.Write([]byte("dir\x00"))
			return nil
		}
		_, _ = io.WriteString(hash, fmt.Sprintf("file\x00%d\x00", info.Size()))
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(hash, file)
		return errors.Join(copyErr, file.Close())
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func makeExecutionTreeReadOnly(root string) error {
	var directories []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
			return nil
		}
		return os.Chmod(path, 0o400)
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := os.Chmod(directories[index], 0o500); err != nil {
			return err
		}
	}
	return nil
}

func removeExecutionSnapshot(root string) error {
	if strings.TrimSpace(root) == "" {
		return nil
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr == nil && entry.IsDir() {
			_ = os.Chmod(path, 0o700)
		}
		return nil
	})
	return os.RemoveAll(root)
}

func (route *connectorRoute) fence() {
	route.processMu.Lock()
	route.fenced = true
	for processID, cancel := range route.pendingStarts {
		cancel()
		delete(route.pendingStarts, processID)
	}
	route.processMu.Unlock()
}

func (route *connectorRoute) isFenced() bool {
	route.processMu.Lock()
	defer route.processMu.Unlock()
	return route.fenced
}

func (route *connectorRoute) beginProcess(parent context.Context) (context.Context, uint64, bool) {
	route.processMu.Lock()
	defer route.processMu.Unlock()
	if route.fenced {
		return nil, 0, false
	}
	processContext, cancel := context.WithCancel(parent)
	route.nextProcessID++
	route.pendingStarts[route.nextProcessID] = cancel
	return processContext, route.nextProcessID, true
}

func (route *connectorRoute) failProcessStart(processID uint64) {
	route.processMu.Lock()
	cancel := route.pendingStarts[processID]
	delete(route.pendingStarts, processID)
	route.processMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (route *connectorRoute) commitProcessStart(processID uint64, connection agentruntime.ProcessConnection) bool {
	route.processMu.Lock()
	defer route.processMu.Unlock()
	cancel := route.pendingStarts[processID]
	delete(route.pendingStarts, processID)
	if route.fenced || cancel == nil {
		if cancel != nil {
			cancel()
		}
		return false
	}
	route.processes[processID] = trackedConnectorProcess{connection: connection, cancel: cancel}
	return true
}

func (route *connectorRoute) releaseProcess(processID uint64, connection agentruntime.ProcessConnection) {
	route.processMu.Lock()
	current, owned := route.processes[processID]
	if owned && current.connection == connection && !current.closing {
		delete(route.processes, processID)
	} else {
		owned = false
	}
	route.processMu.Unlock()
	if owned {
		current.cancel()
		_ = connection.Close()
	}
}

type ConnectorCommandRegistry struct {
	mu        sync.RWMutex
	routes    map[string]*connectorRoute
	published bool
}

func NewConnectorCommandRegistry() *ConnectorCommandRegistry {
	return &ConnectorCommandRegistry{routes: make(map[string]*connectorRoute), published: true}
}

func (registry *ConnectorCommandRegistry) setPublished(enabled bool) {
	registry.mu.Lock()
	registry.published = enabled
	registry.mu.Unlock()
}

func (registry *ConnectorCommandRegistry) replace(route *connectorRoute) {
	registry.mu.Lock()
	registry.routes[route.id] = route
	registry.mu.Unlock()
}

func (registry *ConnectorCommandRegistry) remove(routeID string) {
	registry.mu.Lock()
	delete(registry.routes, routeID)
	registry.mu.Unlock()
}

func (registry *ConnectorCommandRegistry) Capabilities(_ context.Context, invokeContext cliservice.InvokeContext) []cliservice.Capability {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	if !registry.published {
		return nil
	}
	result := []cliservice.Capability{}
	for _, route := range registry.routes {
		if route.workspaceID != invokeContext.WorkspaceID {
			continue
		}
		for _, command := range route.capabilities {
			result = append(result, command.capability)
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ID < result[right].ID })
	return result
}

func (registry *ConnectorCommandRegistry) Invoke(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
	registry.mu.RLock()
	if !registry.published {
		registry.mu.RUnlock()
		return cliservice.CommandOutput{}, cliservice.ErrServiceUnavailable
	}
	var command *connectorCommand
	for _, route := range registry.routes {
		if route.workspaceID != request.Context.WorkspaceID {
			continue
		}
		if candidate, ok := route.capabilities[request.CommandID]; ok {
			copy := candidate
			command = &copy
			break
		}
	}
	registry.mu.RUnlock()
	if command == nil {
		return cliservice.CommandOutput{}, cliservice.ErrCommandNotFound
	}
	return command.invoke(ctx, request)
}

func ProductionPorts(host *ImplementationHost) (market.ImplementationHost, market.AuthorizationProvider, market.CompatibilityEvaluator, market.ImplementationRegistry) {
	return host, unavailableAuthorization{}, productionCompatibility{}, market.NewImplementationRegistry(map[string]market.ImplementationValidator{
		market.ImplementationKindManagedStdio: nil,
	})
}

type productionCompatibility struct{}

func (productionCompatibility) Evaluate(manifest market.Manifest) market.Compatibility {
	if manifest.Implementation.Kind != market.ImplementationKindManagedStdio || manifest.AuthorizationKind != "none" {
		return market.Compatibility{State: market.CompatibilityStateUnsupportedImplementation, Reason: "implementation or authorization broker is unavailable"}
	}
	for _, platform := range manifest.Compatibility.Platforms {
		if platform == runtime.GOOS+"-"+runtime.GOARCH {
			return market.Compatibility{State: market.CompatibilityStateSupported}
		}
	}
	if len(manifest.Compatibility.Platforms) != 0 {
		return market.Compatibility{State: market.CompatibilityStateUnsupportedPlatform, Reason: "platform is not supported"}
	}
	return market.Compatibility{State: market.CompatibilityStateSupported}
}
