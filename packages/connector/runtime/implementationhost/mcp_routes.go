package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/host"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

func (host *Host) buildRemoteRoute(ctx context.Context, request market.RuntimeReconcileRequest) (*connectorRoute, error) {
	remote := request.Connector.Release.Manifest.Implementation.RemoteStreamableHTTP
	if remote == nil {
		return nil, errors.New("remote_streamable_http connector config is unavailable")
	}
	if host.authorizeRemoteRequest == nil {
		return nil, errors.New("remote MCP host-session authentication is unavailable")
	}
	base, err := url.Parse(host.remoteMCPBaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, errors.New("remote MCP Gateway base URL is unavailable")
	}
	endpoint, err := url.JoinPath(base.String(), "mcp", "connectors", request.Connector.Key)
	if err != nil {
		return nil, errors.New("build remote MCP Gateway endpoint")
	}
	connectorVersion := strings.TrimSpace(request.Connector.Release.Version)
	client, err := mcp.NewModernStreamableHTTPClient(mcp.ModernStreamableHTTPClientConfig{
		Endpoint: endpoint, AllowedHosts: []string{base.Hostname()}, ConnectorVersion: connectorVersion,
		HTTPClient: host.remoteHTTPClient, AuthorizeRequest: host.authorizeRemoteRequest,
		Timeout: host.remoteMCPTimeout, MaxResponseBytes: host.remoteMCPMaxResponse,
	})
	if err != nil {
		return nil, err
	}
	closeClient := func() { _ = client.Close(context.Background()) }
	if _, err := client.Call(ctx, "server/discover", map[string]any{}); err != nil {
		closeClient()
		return nil, fmt.Errorf("discover remote connector MCP: %w", err)
	}
	tools, err := listModernMCPTools(ctx, client)
	if err != nil {
		closeClient()
		return nil, err
	}
	for _, tool := range tools {
		if err := client.RegisterTool(tool.Name, tool.InputSchema); err != nil {
			closeClient()
			return nil, fmt.Errorf("register remote connector MCP Tool %q: %w", tool.Name, err)
		}
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

func (*Host) registerMCPTools(route *connectorRoute, client mcpCaller, tools []mcpTool) error {
	if len(tools) == 0 {
		return errors.New("connector MCP tools/list response is invalid")
	}
	for _, tool := range tools {
		localName := route.connectorKey + "_" + tool.Name
		// Keep the upstream JSON Schema intact. MCP schemas are not constrained
		// by Tutti's legacy command-input schema subset.
		if tool.InputSchema == nil || len(localName) > 255 || !mcpLocalToolNamePattern.MatchString(localName) {
			return errors.New("connector MCP tool contract is invalid")
		}
		if _, duplicate := route.mcpTools[localName]; duplicate {
			return errors.New("connector MCP tool capability id is duplicated")
		}
		routeID := "connector." + route.connectorKey + ".mcp." + tool.Name
		route.mcpTools[localName] = registeredMCPTool{routeID: routeID, localName: localName,
			upstreamName: tool.Name, description: tool.Description, inputSchema: cloneJSONMap(tool.InputSchema), client: client}
	}
	return nil
}

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func listMCPTools(ctx context.Context, client mcpCaller) ([]mcpTool, error) {
	return listMCPToolsWithProtocol(ctx, client, false)
}

func listModernMCPTools(ctx context.Context, client mcpCaller) ([]mcpTool, error) {
	return listMCPToolsWithProtocol(ctx, client, true)
}

func listMCPToolsWithProtocol(ctx context.Context, client mcpCaller, requireComplete bool) ([]mcpTool, error) {
	const maxPages = 64
	const maxTools = 512
	result := make([]mcpTool, 0)
	var cursor *string
	seen := map[string]struct{}{}
	for page := 0; page < maxPages; page++ {
		params := map[string]any{}
		if cursor != nil {
			params["cursor"] = *cursor
		}
		raw, err := client.Call(ctx, "tools/list", params)
		if err != nil {
			return nil, fmt.Errorf("list connector MCP tools: %w", err)
		}
		var listing struct {
			ResultType string    `json:"resultType"`
			Tools      []mcpTool `json:"tools"`
			NextCursor *string   `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &listing); err != nil || (requireComplete && listing.ResultType != "complete") {
			return nil, errors.New("connector MCP tools/list response is invalid")
		}
		result = append(result, listing.Tools...)
		if len(result) > maxTools {
			return nil, errors.New("connector MCP tools/list exceeds tool limit")
		}
		if listing.NextCursor == nil {
			return result, nil
		}
		next := *listing.NextCursor
		if _, duplicate := seen[next]; duplicate {
			return nil, errors.New("connector MCP tools/list cursor repeated")
		}
		seen[next] = struct{}{}
		cursor = &next
	}
	return nil, errors.New("connector MCP tools/list exceeds page limit")
}
