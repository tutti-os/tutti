package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func (host *Host) buildRemoteRoute(ctx context.Context, request market.RuntimeReconcileRequest) (*connectorRoute, error) {
	remote := request.Connector.Release.Manifest.Implementation.RemoteStreamableHTTP
	if remote == nil {
		return nil, errors.New("remote_streamable_http connector config is unavailable")
	}
	accountID := strings.TrimSpace(request.Scope.AccountID)
	if accountID == "" || host.remoteMCPClientFactory == nil {
		return nil, errors.New("remote MCP product client factory is unavailable")
	}
	client, err := host.remoteMCPClientFactory.NewRemoteMCPClient(ctx, RemoteMCPClientRequest{
		OperationID: request.OperationID, ConnectionID: request.ConnectionID,
		ConnectorKey: request.Connector.Key, AccountID: accountID,
		ReleaseDigest:  request.Connector.Release.ReleaseDigest,
		Version:        request.Connector.Release.Version,
		Generation:     request.Generation,
		Implementation: *remote,
	})
	if err != nil {
		return nil, fmt.Errorf("create remote connector MCP client: %w", err)
	}
	closeClient := func() { _ = client.Close(context.Background()) }
	if _, err := client.Call(ctx, "server/discover", map[string]any{}); err != nil {
		closeClient()
		return nil, wrapRemoteMCPAuthorizationError(fmt.Errorf("discover remote connector MCP: %w", err))
	}
	cacheKey := remoteMCPToolCacheKeyFrom(request)
	tools, cached := host.remoteMCPTools.lookup(cacheKey)
	if !cached {
		var err error
		tools, err = listModernMCPTools(ctx, client)
		if err != nil {
			closeClient()
			return nil, wrapRemoteMCPAuthorizationError(err)
		}
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
	if !cached {
		host.remoteMCPTools.store(cacheKey, tools)
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
	if err := validateMCPToolContracts(route.connectorKey, tools); err != nil {
		return err
	}
	for _, tool := range tools {
		localName := route.connectorKey + "_" + tool.Name
		// Keep the upstream JSON Schema intact. MCP schemas are not constrained
		// by Tutti's legacy command-input schema subset.
		routeID := "connector." + route.connectorKey + ".mcp." + tool.Name
		route.mcpTools[localName] = registeredMCPTool{routeID: routeID, localName: localName,
			upstreamName: tool.Name, description: tool.Description, inputSchema: cloneJSONMap(tool.InputSchema), client: client}
	}
	return nil
}

func validateMCPToolContracts(connectorKey string, tools []mcpTool) error {
	seen := make(map[string]struct{}, len(tools))
	for _, tool := range tools {
		localName := connectorKey + "_" + tool.Name
		if strings.TrimSpace(tool.Name) == "" || tool.InputSchema == nil || len(localName) > 255 || !mcpLocalToolNamePattern.MatchString(localName) {
			return errors.New("connector MCP tool contract is invalid")
		}
		if _, duplicate := seen[localName]; duplicate {
			return errors.New("connector MCP tool capability id is duplicated")
		}
		seen[localName] = struct{}{}
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
		if err := json.Unmarshal(raw, &listing); err != nil ||
			(requireComplete && listing.ResultType != "" && listing.ResultType != "complete") {
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
