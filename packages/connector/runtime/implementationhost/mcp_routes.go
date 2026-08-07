package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	"github.com/tutti-os/tutti/packages/connector/runtime/command"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

func (host *Host) buildRemoteRoute(ctx context.Context, request market.RuntimeReconcileRequest) (*connectorRoute, error) {
	remote := request.Connector.Release.Manifest.Implementation.RemoteStreamableHTTP
	if remote == nil {
		return nil, errors.New("remote_streamable_http connector config is unavailable")
	}
	var authorizer mcp.RequestAuthorizer
	switch remote.Authentication.Type {
	case "none":
	case "host_session":
		if host.authorizeRemoteRequest == nil {
			return nil, errors.New("remote MCP host-session authentication is unavailable")
		}
		connectorVersion := strings.TrimSpace(request.Connector.Release.Version)
		authorizer = func(httpRequest *http.Request) error {
			httpRequest.Header.Set("Tutti-Connector-Version", connectorVersion)
			return host.authorizeRemoteRequest(httpRequest)
		}
	default:
		return nil, errors.New("remote MCP authentication type is unsupported")
	}
	client, err := mcp.NewStreamableHTTPClient(mcp.StreamableHTTPClientConfig{
		Endpoint: remote.Endpoint, AllowedHosts: remote.AllowedHosts, HTTPClient: host.remoteHTTPClient,
		AuthorizeRequest: authorizer, Timeout: time.Duration(remote.Limits.TimeoutMS) * time.Millisecond,
		MaxResponseBytes: remote.Limits.MaxResponseBytes,
	})
	if err != nil {
		return nil, err
	}
	closeClient := func() { _ = client.Close(context.Background()) }
	if _, err := client.Call(ctx, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "tutti-connector-host", "version": "1"}}); err != nil {
		closeClient()
		return nil, fmt.Errorf("initialize remote connector MCP: %w", err)
	}
	if err := client.Notify(ctx, "notifications/initialized", map[string]any{}); err != nil {
		closeClient()
		return nil, err
	}
	tools, err := listMCPTools(ctx, client)
	if err != nil {
		closeClient()
		return nil, err
	}
	route := newConnectorRoute(request)
	if err := host.registerMCPTools(route, client, tools); err != nil {
		closeClient()
		return nil, err
	}
	route.remoteMCP = client
	return route, nil
}

type mcpCaller interface {
	Call(context.Context, string, any) (json.RawMessage, error)
}

func (host *Host) registerMCPTools(route *connectorRoute, client mcpCaller, tools []mcpTool) error {
	if len(tools) == 0 {
		return errors.New("connector MCP tools/list response is invalid")
	}
	for _, tool := range tools {
		tool := tool
		commandID, err := capabilityID(route.connectorKey, "mcp", tool.Name)
		if err != nil || tool.InputSchema == nil || tool.InputSchema["type"] != "object" || command.ValidateInputSchema(tool.InputSchema) != nil {
			return errors.New("connector MCP tool contract is invalid")
		}
		if _, duplicate := route.capabilities[commandID]; duplicate {
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
	return nil
}

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func listMCPTools(ctx context.Context, client mcpCaller) ([]mcpTool, error) {
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
