// Package implementationhost owns the host-neutral managed Connector runtime.
// Products provide artifact, runtime, process, and credential ports and may
// expose the registry through their own CLI or local broker transport.
package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	"github.com/tutti-os/tutti/packages/connector/runtime/command"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

type PreparedArtifactResolver interface {
	ResolvePrepared(context.Context, market.Release) (market.PreparedArtifactReceipt, error)
}

type ReconcileRequest struct {
	Runtime market.RuntimeReconcileRequest
}

type Config struct {
	Artifacts         PreparedArtifactResolver
	CLIInstallations  market.CLIInstallationManager
	Runtimes          connectorruntime.ConnectorRuntimeResolver
	Processes         agentruntime.ProcessTransport
	Routes            RouteObserver
	Commands          *CommandRegistry
	StateRoot         string
	UserHome          string
	MCPStartupTimeout time.Duration
}

type Host struct {
	artifacts             PreparedArtifactResolver
	planner               *connectorruntime.ManagedRoutePlanner
	processes             agentruntime.ProcessTransport
	routeObserver         RouteObserver
	mcpStartupTimeout     time.Duration
	routes                *connectorruntime.RouteTable
	snapshots             *connectorruntime.ExecutionSnapshotter
	authorizationProvider *managedCredentialAuthorizationProvider
}

type connectorCommand struct {
	capability command.Capability
	kind       string
	name       string
	invoke     command.Handler
}

type connectorRoute struct {
	id                     string
	connectionID           string
	connectorKey           string
	releaseDigest          string
	generation             market.HostGeneration
	capabilities           map[string]connectorCommand
	closeMu                sync.Mutex
	mcpClient              *mcp.StdioClient
	executionRoot          string
	installedRoot          string
	displayName            string
	description            string
	processes              *connectorruntime.ProcessGroup
	snapshots              *connectorruntime.ExecutionSnapshotter
	userHome               string
	cliLaunch              *managedCLILaunch
	credentialBrokerLaunch *managedCredentialBrokerLaunch
}

func New(config Config) (*Host, error) {
	if config.Artifacts == nil || config.Runtimes == nil || config.Processes == nil || config.Commands == nil {
		return nil, errors.New("connector implementation host dependencies are required")
	}
	if !filepath.IsAbs(strings.TrimSpace(config.StateRoot)) {
		return nil, errors.New("connector implementation state root must be absolute")
	}
	if !filepath.IsAbs(strings.TrimSpace(config.UserHome)) {
		return nil, errors.New("connector implementation user home must be absolute")
	}
	if config.MCPStartupTimeout <= 0 {
		config.MCPStartupTimeout = 15 * time.Second
	}
	snapshots, err := connectorruntime.NewExecutionSnapshotter(config.StateRoot)
	if err != nil {
		return nil, err
	}
	routes := connectorruntime.NewRouteTable()
	planner, err := connectorruntime.NewManagedRoutePlanner(connectorruntime.ManagedRoutePlannerConfig{
		StateRoot: config.StateRoot, UserHome: config.UserHome, Runtimes: config.Runtimes, CLIInstallations: config.CLIInstallations,
	})
	if err != nil {
		return nil, err
	}
	config.Commands.attach(routes)
	host := &Host{artifacts: config.Artifacts, planner: planner, processes: config.Processes,
		routeObserver: config.Routes, mcpStartupTimeout: config.MCPStartupTimeout, routes: routes, snapshots: snapshots}
	host.authorizationProvider = newManagedCredentialAuthorizationProvider(host)
	return host, nil
}

func (host *Host) Reconcile(ctx context.Context, request ReconcileRequest) (market.RuntimeReceipt, error) {
	runtimeRequest := request.Runtime
	if host == nil || !hostIdentityPattern.MatchString(runtimeRequest.ConnectionID) ||
		!hostIdentityPattern.MatchString(runtimeRequest.Connector.Key) || runtimeRequest.Generation.BootEpoch == "" || runtimeRequest.Generation.Generation == 0 {
		return market.RuntimeReceipt{}, errors.New("connector runtime reconcile identity is invalid")
	}
	if err := market.ValidateRuntimeReleaseShape(runtimeRequest.Connector.Release); err != nil {
		return market.RuntimeReceipt{}, err
	}
	key := connectorRouteKey(runtimeRequest.ConnectionID, runtimeRequest.Connector.Key)
	if !runtimeRequest.Enabled {
		if err := host.routes.Remove(key, runtimeRequest.Generation, "", time.Time{}); err != nil {
			return market.RuntimeReceipt{}, err
		}
		return market.RuntimeReceipt{OperationID: runtimeRequest.OperationID, ConnectionID: runtimeRequest.ConnectionID,
			ConnectorKey: runtimeRequest.Connector.Key, ReleaseDigest: runtimeRequest.Connector.Installation.InstalledReleaseDigest,
			Generation: runtimeRequest.Generation}, nil
	}
	if runtimeRequest.Connector.Installation.State != market.InstallationStateInstalled ||
		runtimeRequest.Connector.Installation.InstalledReleaseDigest != runtimeRequest.Connector.Release.ReleaseDigest {
		return market.RuntimeReceipt{}, errors.New("connector installed release is not active")
	}
	if err := host.validateAuthorization(runtimeRequest); err != nil {
		return market.RuntimeReceipt{}, err
	}
	prepared, err := host.artifacts.ResolvePrepared(ctx, runtimeRequest.Connector.Release)
	if err != nil {
		return market.RuntimeReceipt{}, fmt.Errorf("resolve prepared connector artifact: %w", err)
	}
	installedRoot := prepared.PreparedPath
	executionRoot, err := host.snapshots.Create(prepared)
	if err != nil {
		return market.RuntimeReceipt{}, fmt.Errorf("create connector execution snapshot: %w", err)
	}
	prepared.PreparedPath = executionRoot
	route, err := host.buildManagedRoute(ctx, runtimeRequest, prepared)
	if err != nil {
		_ = host.snapshots.Remove(executionRoot)
		return market.RuntimeReceipt{}, err
	}
	route.executionRoot, route.installedRoot = executionRoot, installedRoot
	route.displayName = runtimeRequest.Connector.Release.Manifest.DisplayName
	route.description = runtimeRequest.Connector.Release.Manifest.Description
	route.snapshots = host.snapshots
	if err := host.routes.Commit(route); err != nil {
		_ = route.Close(time.Now().Add(3 * time.Second))
		return market.RuntimeReceipt{}, err
	}
	if route.mcpClient != nil {
		go host.monitorMCPRoute(route, route.mcpClient)
	}
	routeIDs := make([]string, 0, len(route.capabilities))
	for routeID := range route.capabilities {
		routeIDs = append(routeIDs, routeID)
	}
	sort.Strings(routeIDs)
	return market.RuntimeReceipt{OperationID: runtimeRequest.OperationID, ConnectionID: runtimeRequest.ConnectionID,
		ConnectorKey: runtimeRequest.Connector.Key, ReleaseDigest: route.releaseDigest,
		Generation: runtimeRequest.Generation, RouteIDs: routeIDs}, nil
}

func (*Host) validateAuthorization(request market.RuntimeReconcileRequest) error {
	authKind := request.Connector.Release.Manifest.AuthorizationKind
	managed := request.Connector.Release.Manifest.Implementation.ManagedStdio
	if authKind == "none" {
		if request.Connector.Authorization.State != market.AuthorizationStateNotRequired {
			return errors.New("authorization-free connector has an invalid credential binding")
		}
		return nil
	}
	if managed == nil || managed.CredentialBroker == nil {
		return errors.New("authorized connector credential broker binding is unavailable")
	}
	switch request.Connector.Authorization.State {
	case market.AuthorizationStateDisconnected, market.AuthorizationStatePending, market.AuthorizationStateConnected,
		market.AuthorizationStateExpired, market.AuthorizationStateFailed:
	default:
		return errors.New("authorized connector has an invalid authorization state")
	}
	return nil
}

func (host *Host) Close() error {
	if host == nil {
		return nil
	}
	return host.routes.Close(time.Now().Add(3 * time.Second))
}

func (host *Host) SetCapabilityPublication(enabled bool) {
	if host != nil {
		host.routes.SetPublished(enabled)
	}
}

func (host *Host) FenceAll(_ context.Context, deadline time.Time) error {
	if host == nil {
		return nil
	}
	return host.routes.FenceAll(deadline)
}

func (host *Host) FailClosed(ctx context.Context, deadline time.Time) error {
	if host == nil {
		return nil
	}
	host.SetCapabilityPublication(false)
	return host.FenceAll(ctx, deadline)
}

func (host *Host) DeactivateRuntime(ctx context.Context, request market.RuntimeDeactivationRequest) error {
	if host == nil {
		return errors.New("connector implementation host is unavailable")
	}
	if !request.Deadline.IsZero() && time.Now().After(request.Deadline) {
		return context.DeadlineExceeded
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return host.routes.Remove(connectorRouteKey(request.ConnectionID, request.ConnectorKey), request.Generation, request.ReleaseDigest, request.Deadline)
}

func (host *Host) buildManagedRoute(ctx context.Context, request market.RuntimeReconcileRequest,
	prepared market.PreparedArtifactReceipt) (*connectorRoute, error) {
	plan, err := host.planner.Build(ctx, request, prepared)
	if err != nil {
		return nil, err
	}
	route := &connectorRoute{id: connectorRouteKey(request.ConnectionID, request.Connector.Key), connectionID: request.ConnectionID,
		connectorKey: request.Connector.Key, releaseDigest: request.Connector.Release.ReleaseDigest,
		generation: request.Generation, capabilities: make(map[string]connectorCommand), processes: connectorruntime.NewProcessGroup(),
		userHome: plan.UserHome}
	if plan.Managed.MCP != nil {
		if err := host.attachMCP(ctx, route, plan.Managed, prepared, plan.Executable, plan.StateDir, plan.UserHome, plan.ArtifactTrees); err != nil {
			_ = route.close(time.Now().Add(3 * time.Second))
			return nil, err
		}
	}
	if plan.Managed.CLI != nil {
		if err := host.attachCLI(route, plan.Managed, prepared, plan.InstalledCLI, plan.Executable, plan.StateDir, plan.UserHome, plan.ArtifactTrees); err != nil {
			_ = route.close(time.Now().Add(3 * time.Second))
			return nil, err
		}
	}
	if plan.Managed.CredentialBroker != nil {
		if err := host.attachCredentialBroker(route, plan.Managed.CredentialBroker, prepared, plan.Executable, plan.StateDir, plan.ArtifactTrees); err != nil {
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

var capabilityPartPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)
var hostIdentityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$`)

func (*Host) attachCredentialBroker(route *connectorRoute, broker *market.ManagedCredentialBroker,
	prepared market.PreparedArtifactReceipt, executable connectorruntime.ConnectorExecutable,
	stateDir string, artifactTrees []agentruntime.ArtifactTreeIdentity) error {
	if route.cliLaunch == nil {
		return errors.New("connector credential broker requires a managed CLI")
	}
	entrypoint, err := connectorruntime.PreparedEntrypoint(prepared.PreparedPath, broker.Entrypoint)
	if err != nil {
		return fmt.Errorf("resolve connector credential broker entrypoint: %w", err)
	}
	allowedHosts := make(map[string]struct{}, len(broker.AllowedHosts))
	for _, allowedHost := range broker.AllowedHosts {
		allowedHosts[strings.ToLower(strings.TrimSpace(allowedHost))] = struct{}{}
	}
	route.credentialBrokerLaunch = &managedCredentialBrokerLaunch{
		entrypoint: entrypoint, timeout: time.Duration(broker.TimeoutMS) * time.Millisecond, allowedHosts: allowedHosts,
		cliLaunch: credentialBrokerCLILaunch{Executable: route.cliLaunch.executable.Path,
			Arguments: append([]string(nil), route.cliLaunch.arguments...), CWD: route.cliLaunch.cwd},
		executable: executable, language: route.cliLaunch.language, cwd: prepared.PreparedPath, stateDir: stateDir,
		artifactTrees: append([]agentruntime.ArtifactTreeIdentity(nil), artifactTrees...),
	}
	return nil
}

func (host *Host) attachMCP(ctx context.Context, route *connectorRoute, managed *market.ManagedStdioImplementation,
	prepared market.PreparedArtifactReceipt, executable connectorruntime.ConnectorExecutable,
	stateDir, userHome string, artifactTrees []agentruntime.ArtifactTreeIdentity) error {
	entrypoint, err := connectorruntime.PreparedEntrypoint(prepared.PreparedPath, managed.MCP.Entrypoint)
	if err != nil {
		return err
	}
	startupContext, cancelStartup := context.WithTimeout(ctx, host.mcpStartupTimeout)
	defer cancelStartup()
	spec := connectorruntime.ConnectorProcessSpec(route.connectionID, route.connectorKey, managed.Runtime.Language,
		executable, prepared.PreparedPath, append([]string{entrypoint}, managed.MCP.Arguments...), stateDir, userHome, artifactTrees)
	connection, processID, err := host.startProcess(startupContext, route, spec, false)
	if err != nil {
		return fmt.Errorf("start connector MCP process: %w", err)
	}
	release := func() { route.releaseProcess(processID, connection) }
	client, err := mcp.NewStdioClient(mcp.StdioClientConfig{Connection: connection, ProcessName: route.connectorKey + " MCP"})
	if err != nil {
		release()
		return err
	}
	if _, err := client.Call(startupContext, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "tutti-connector-host", "version": "1"}}); err != nil {
		release()
		return fmt.Errorf("initialize connector MCP process: %w", err)
	}
	if err := client.Notify("notifications/initialized", map[string]any{}); err != nil {
		release()
		return err
	}
	tools, err := listMCPTools(startupContext, client)
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
		commandID, err := capabilityID(route.connectorKey, "mcp", tool.Name)
		if err != nil || tool.InputSchema == nil || tool.InputSchema["type"] != "object" || command.ValidateInputSchema(tool.InputSchema) != nil {
			release()
			return errors.New("connector MCP tool contract is invalid")
		}
		if _, duplicate := route.capabilities[commandID]; duplicate {
			release()
			return errors.New("connector MCP tool capability id is duplicated")
		}
		route.capabilities[commandID] = connectorCommand{capability: connectorCapability(commandID, route.connectorKey, "mcp", tool.Name, tool.Description, tool.InputSchema),
			kind: "mcp", name: tool.Name,
			invoke: func(callCtx context.Context, request command.InvokeRequest) (command.Output, error) {
				if !host.routeCurrent(route) {
					return command.Output{}, command.ErrServiceUnavailable
				}
				result, err := client.Call(callCtx, "tools/call", map[string]any{"name": tool.Name, "arguments": request.Input})
				if err != nil {
					return command.Output{}, command.ServiceUnavailable("connector MCP tool failed", err)
				}
				return jsonOutput(result)
			}}
	}
	route.mcpClient = client
	return nil
}

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func listMCPTools(ctx context.Context, client *mcp.StdioClient) ([]mcpTool, error) {
	const maxPages = 64
	const maxTools = 512
	result := make([]mcpTool, 0)
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
			Tools      []mcpTool `json:"tools"`
			NextCursor string    `json:"nextCursor"`
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

func (host *Host) monitorMCPRoute(route *connectorRoute, client *mcp.StdioClient) {
	<-client.Done()
	unexpected := host.routes.IsCurrent(route)
	_ = host.routes.RetireExact(route, time.Now().Add(3*time.Second))
	if unexpected && host.routeObserver != nil {
		host.routeObserver.ObserveRoute(context.Background(), RouteObservation{
			ConnectorKey: route.connectorKey, ConnectionID: route.connectionID,
			ReleaseDigest: route.releaseDigest, Generation: route.generation, ObservedAt: time.Now().UTC(),
		})
	}
}

func (host *Host) attachCLI(route *connectorRoute, managed *market.ManagedStdioImplementation,
	prepared market.PreparedArtifactReceipt, installed *market.CLIInstallationReceipt,
	executable connectorruntime.ConnectorExecutable, stateDir, userHome string, artifactTrees []agentruntime.ArtifactTreeIdentity) error {
	entrypointRoot, entrypointRelative := prepared.PreparedPath, managed.CLI.Entrypoint
	if installed != nil {
		entrypointRoot, entrypointRelative = installed.InstallRoot, installed.Entrypoint
	}
	entrypoint, err := connectorruntime.PreparedEntrypoint(entrypointRoot, entrypointRelative)
	if err != nil {
		return err
	}
	launchArguments := []string{entrypoint}
	launchExecutable := executable
	if installed != nil && installed.LaunchKind == "native" {
		launchArguments = nil
		launchExecutable = connectorruntime.ConnectorExecutable{Path: entrypoint, SHA256: installed.EntrypointSHA256,
			SizeBytes: installed.EntrypointSize}
	}
	route.cliLaunch = &managedCLILaunch{arguments: append(append([]string{}, launchArguments...), managed.CLI.Arguments...),
		artifactTrees: append([]agentruntime.ArtifactTreeIdentity(nil), artifactTrees...), cwd: prepared.PreparedPath,
		executable: launchExecutable, language: managed.Runtime.Language, stateDir: stateDir}
	if len(managed.CLI.Commands) == 0 {
		return host.attachGenericCLI(route, managed, prepared, launchArguments, launchExecutable, stateDir, userHome, artifactTrees)
	}
	for _, manifestCommand := range managed.CLI.Commands {
		manifestCommand := manifestCommand
		commandID, err := capabilityID(route.connectorKey, "cli", manifestCommand.Name)
		if err != nil {
			return err
		}
		if _, duplicate := route.capabilities[commandID]; duplicate {
			return errors.New("connector CLI capability id is duplicated")
		}
		if err := command.ValidateInputSchema(manifestCommand.InputSchema); err != nil {
			return fmt.Errorf("connector CLI input schema is unsupported: %w", err)
		}
		route.capabilities[commandID] = connectorCommand{capability: connectorCapability(commandID, route.connectorKey,
			"cli", manifestCommand.Name, manifestCommand.Description, manifestCommand.InputSchema),
			kind: "cli", name: manifestCommand.Name,
			invoke: func(callCtx context.Context, request command.InvokeRequest) (command.Output, error) {
				if !host.routeCurrent(route) {
					return command.Output{}, command.ErrServiceUnavailable
				}
				timeoutCtx, cancel := context.WithTimeout(callCtx, time.Duration(manifestCommand.TimeoutMS)*time.Millisecond)
				defer cancel()
				arguments := append([]string{}, launchArguments...)
				arguments = append(arguments, managed.CLI.Arguments...)
				arguments = append(arguments, manifestCommand.Arguments...)
				spec := connectorruntime.ConnectorProcessSpec(route.connectionID, route.connectorKey, managed.Runtime.Language,
					launchExecutable, prepared.PreparedPath, arguments, stateDir, userHome, artifactTrees)
				connection, processID, err := host.startProcess(timeoutCtx, route, spec, true)
				if err != nil {
					return command.Output{}, command.ServiceUnavailable("start connector CLI command", err)
				}
				defer route.releaseProcess(processID, connection)
				input, _ := json.Marshal(request.Input)
				if err := connection.Send(append(input, '\n')); err != nil {
					return command.Output{}, err
				}
				if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
					_ = graceful.CloseInput()
				}
				return collectCLIOutput(timeoutCtx, connection)
			}}
	}
	return nil
}

func (host *Host) attachGenericCLI(route *connectorRoute, managed *market.ManagedStdioImplementation,
	prepared market.PreparedArtifactReceipt, launchArguments []string, executable connectorruntime.ConnectorExecutable,
	stateDir, userHome string, artifactTrees []agentruntime.ArtifactTreeIdentity) error {
	commandID, err := capabilityID(route.connectorKey, "cli", "run")
	if err != nil {
		return err
	}
	inputSchema := map[string]any{"type": "object", "properties": map[string]any{
		"args": map[string]any{"type": "array", "items": map[string]any{"type": "string"},
			"description": "CLI arguments described by the installed connector skill"}},
		"required": []string{"args"}, "additionalProperties": false}
	route.capabilities[commandID] = connectorCommand{capability: connectorCapability(commandID, route.connectorKey, "cli", "run",
		"Run the installed connector CLI with skill-defined arguments", inputSchema), kind: "cli", name: "run",
		invoke: func(callCtx context.Context, request command.InvokeRequest) (command.Output, error) {
			if !host.routeCurrent(route) {
				return command.Output{}, command.ErrServiceUnavailable
			}
			arguments, err := GenericCLIArguments(request.Input["args"])
			if err != nil {
				return command.Output{}, command.InvalidInput("connector_cli_args_invalid", err.Error(), nil)
			}
			timeoutCtx, cancel := context.WithTimeout(callCtx, time.Duration(managed.CLI.TimeoutMS)*time.Millisecond)
			defer cancel()
			processArguments := append([]string{}, launchArguments...)
			processArguments = append(processArguments, managed.CLI.Arguments...)
			processArguments = append(processArguments, arguments...)
			spec := connectorruntime.ConnectorProcessSpec(route.connectionID, route.connectorKey, managed.Runtime.Language,
				executable, prepared.PreparedPath, processArguments, stateDir, userHome, artifactTrees)
			connection, processID, err := host.startProcess(timeoutCtx, route, spec, true)
			if err != nil {
				return command.Output{}, command.ServiceUnavailable("start connector CLI command", err)
			}
			defer route.releaseProcess(processID, connection)
			if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
				_ = graceful.CloseInput()
			}
			return collectCLIOutput(timeoutCtx, connection)
		}}
	return nil
}

// GenericCLIArguments validates skill-authored argv for a generic Connector
// CLI route. Destructive non-interactive overrides remain forbidden.
func GenericCLIArguments(raw any) ([]string, error) {
	var arguments []string
	switch values := raw.(type) {
	case []string:
		arguments = append(arguments, values...)
	case []any:
		for _, value := range values {
			argument, ok := value.(string)
			if !ok {
				return nil, errors.New("connector CLI args must contain only strings")
			}
			arguments = append(arguments, argument)
		}
	default:
		return nil, errors.New("connector CLI args are required")
	}
	for _, argument := range arguments {
		if strings.ContainsRune(argument, '\x00') || argument == "--yes" || argument == "--force" ||
			strings.HasPrefix(argument, "--yes=") || strings.HasPrefix(argument, "--force=") {
			return nil, errors.New("connector CLI args contain a forbidden non-interactive override")
		}
	}
	return arguments, nil
}

func (host *Host) startProcess(ctx context.Context, route *connectorRoute, spec agentruntime.ProcessSpec,
	requireCurrent bool) (agentruntime.ProcessConnection, uint64, error) {
	if requireCurrent && !host.routes.IsCurrent(route) {
		return nil, 0, command.ErrServiceUnavailable
	}
	startContext, processID, accepted := route.processes.Begin(context.Background())
	if !accepted {
		return nil, 0, command.ErrServiceUnavailable
	}
	type startResult struct {
		connection agentruntime.ProcessConnection
		err        error
	}
	result := make(chan startResult, 1)
	go func() {
		connection, startErr := host.processes.Start(startContext, spec)
		result <- startResult{connection: connection, err: startErr}
	}()
	select {
	case started := <-result:
		if started.err != nil {
			route.processes.FailStart(processID)
			return nil, 0, started.err
		}
		if !route.processes.CommitStart(processID, started.connection) {
			_ = started.connection.Close()
			return nil, 0, command.ErrServiceUnavailable
		}
		return started.connection, processID, nil
	case <-ctx.Done():
		route.processes.FailStart(processID)
		go func() {
			started := <-result
			if started.connection != nil {
				_ = started.connection.Close()
			}
		}()
		return nil, 0, ctx.Err()
	}
}

func collectCLIOutput(ctx context.Context, connection agentruntime.ProcessConnection) (command.Output, error) {
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
			return command.Output{}, command.ServiceUnavailable("read connector CLI output", err)
		}
		stdout.Write(frame.Stdout)
		stderr.Write(frame.Stderr)
		if stdout.Len() > maxCLIOutputBytes || stderr.Len() > maxCLIStderrBytes {
			if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
				_ = graceful.Kill()
			}
			return command.Output{}, command.ExecutionFailed("connector CLI output exceeded its limit", nil)
		}
		if frame.ExitCode != nil {
			if *frame.ExitCode != 0 {
				return command.Output{}, command.ExecutionFailed(strings.TrimSpace(stderr.String()), nil)
			}
			break
		}
	}
	return jsonOutput([]byte(strings.TrimSpace(stdout.String())))
}

func jsonOutput(raw []byte) (command.Output, error) {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return command.Output{}, command.ExecutionFailed("connector returned invalid JSON", nil)
	}
	if object, ok := value.(map[string]any); ok {
		return command.Output{Value: object}, nil
	}
	return command.Output{Value: map[string]any{"result": value}}, nil
}

func connectorCapability(routeID, connectorKey, kind, name, description string, inputSchema map[string]any) command.Capability {
	if strings.TrimSpace(description) == "" {
		description = "Connector command " + name
	}
	return command.Capability{ID: routeID, Path: []string{"connector", connectorKey, kind, name}, Summary: description,
		Description: description, InputSchema: inputSchema,
		Source: command.CapabilitySource{Kind: "connector", AppID: "connector:" + connectorKey, AppName: connectorKey}}
}

func capabilityID(connectorKey, kind, name string) (string, error) {
	if !capabilityPartPattern.MatchString(connectorKey) || !capabilityPartPattern.MatchString(name) {
		return "", errors.New("connector capability name is invalid")
	}
	return "connector." + connectorKey + "." + kind + "." + name, nil
}

func connectorRouteKey(connectionID, connectorKey string) string {
	return connectionID + "\x00" + connectorKey
}

func (host *Host) routeCurrent(route *connectorRoute) bool {
	return host.routes.IsCurrent(route) && !route.processes.IsFenced()
}

func (route *connectorRoute) RouteID() string                        { return route.id }
func (route *connectorRoute) RouteGeneration() market.HostGeneration { return route.generation }
func (route *connectorRoute) RouteReleaseDigest() string             { return route.releaseDigest }
func (route *connectorRoute) Fence()                                 { route.processes.Fence() }
func (route *connectorRoute) close(deadline time.Time) error         { return route.Close(deadline) }
func (route *connectorRoute) releaseProcess(id uint64, connection agentruntime.ProcessConnection) {
	if route != nil && route.processes != nil {
		route.processes.Release(id, connection)
	}
}

func (route *connectorRoute) Close(deadline time.Time) error {
	if route == nil {
		return nil
	}
	route.closeMu.Lock()
	defer route.closeMu.Unlock()
	closeErr := route.processes.Close(deadline)
	if closeErr == nil && route.executionRoot != "" {
		if err := route.snapshots.Remove(route.executionRoot); err != nil {
			closeErr = err
		} else {
			route.executionRoot = ""
		}
	}
	return closeErr
}

type CommandRegistry struct {
	mu     sync.RWMutex
	routes *connectorruntime.RouteTable
}

type RouteDescriptor struct {
	ConnectorKey  string
	DisplayName   string
	Description   string
	InstalledRoot string
}

func NewCommandRegistry() *CommandRegistry { return &CommandRegistry{} }

func (registry *CommandRegistry) attach(routes *connectorruntime.RouteTable) {
	registry.mu.Lock()
	registry.routes = routes
	registry.mu.Unlock()
}

func (registry *CommandRegistry) activeRoutes() []*connectorRoute {
	registry.mu.RLock()
	table := registry.routes
	registry.mu.RUnlock()
	if table == nil {
		return nil
	}
	portable := table.PublishedRoutes()
	routes := make([]*connectorRoute, 0, len(portable))
	for _, candidate := range portable {
		if route, ok := candidate.(*connectorRoute); ok {
			routes = append(routes, route)
		}
	}
	return routes
}

func (registry *CommandRegistry) Routes() []RouteDescriptor {
	routes := registry.activeRoutes()
	result := make([]RouteDescriptor, 0, len(routes))
	for _, route := range routes {
		result = append(result, RouteDescriptor{ConnectorKey: route.connectorKey, DisplayName: route.displayName,
			Description: route.description, InstalledRoot: route.installedRoot})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ConnectorKey < result[right].ConnectorKey })
	return result
}

func (registry *CommandRegistry) Capabilities() []command.Capability {
	result := []command.Capability{}
	for _, route := range registry.activeRoutes() {
		for _, registered := range route.capabilities {
			result = append(result, registered.capability)
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ID < result[right].ID })
	return result
}

func (registry *CommandRegistry) CapabilitiesForConnector(connectorKey string) []CapabilitySummary {
	seen := make(map[string]struct{})
	result := make([]CapabilitySummary, 0)
	for _, route := range registry.activeRoutes() {
		if route.connectorKey != connectorKey {
			continue
		}
		for _, registered := range route.capabilities {
			if _, duplicate := seen[registered.capability.ID]; duplicate {
				continue
			}
			seen[registered.capability.ID] = struct{}{}
			result = append(result, CapabilitySummary{ID: registered.capability.ID, Kind: registered.kind,
				Name: registered.name, Description: registered.capability.Description,
				InputSchema: registered.capability.InputSchema})
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ID < result[right].ID })
	return result
}

func (registry *CommandRegistry) Invoke(ctx context.Context, request command.InvokeRequest) (command.Output, error) {
	routes := registry.activeRoutes()
	if len(routes) == 0 {
		return command.Output{}, command.ErrServiceUnavailable
	}
	for _, route := range routes {
		if registered, ok := route.capabilities[request.CommandID]; ok {
			return registered.invoke(ctx, request)
		}
	}
	return command.Output{}, command.ErrNotFound
}

func (registry *CommandRegistry) InvokeConnector(ctx context.Context, connectorKey, capabilityID string,
	request command.InvokeRequest) (command.Output, error) {
	matches := make([]connectorCommand, 0, 1)
	connectorMismatch := false
	routes := registry.activeRoutes()
	if len(routes) == 0 {
		return command.Output{}, command.ErrServiceUnavailable
	}
	for _, route := range routes {
		if route.connectorKey != connectorKey {
			if _, found := route.capabilities[capabilityID]; found {
				connectorMismatch = true
			}
			continue
		}
		if registered, found := route.capabilities[capabilityID]; found {
			matches = append(matches, registered)
		}
	}
	if len(matches) == 0 {
		if connectorMismatch {
			return command.Output{}, command.InvalidInput("connector_capability_connector_mismatch",
				"Connector capability does not belong to the selected connector", nil)
		}
		return command.Output{}, command.InvalidInput("connector_capability_not_found", "Connector capability was not found", nil)
	}
	if len(matches) > 1 {
		return command.Output{}, command.InvalidInput("connector_capability_ambiguous", "Connector capability id is ambiguous", nil)
	}
	return matches[0].invoke(ctx, request)
}

var _ connectorruntime.ManagedRoute = (*connectorRoute)(nil)
