package computer

import (
	"context"
	"encoding/json"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	mcpservice "github.com/tutti-os/tutti/services/tuttid/service/mcp"
)

// mcpClient preserves the computer session's private adapter while sharing the
// protocol implementation with browser and connector hosts.
type mcpClient struct{ shared *mcpservice.StdioClient }

func newMCPClient(connection agentruntime.ProcessConnection) *mcpClient {
	shared, err := mcpservice.NewStdioClient(mcpservice.StdioClientConfig{
		Connection:  connection,
		ProcessName: "computer MCP",
		// Preserve the existing computer behavior. Connector clients omit this
		// handler and therefore fail closed with method-not-supported.
		ServerRequestHandler: func(request mcpservice.ServerRequest) (any, *mcpservice.RPCError) {
			if request.Method == "elicitation/create" {
				return map[string]any{"action": "accept", "content": map[string]any{}}, nil
			}
			return nil, &mcpservice.RPCError{Code: -32601, Message: "method not supported"}
		},
	})
	if err != nil {
		panic(err)
	}
	return &mcpClient{shared: shared}
}

func (client *mcpClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return client.shared.Call(ctx, method, params)
}

func (client *mcpClient) notify(method string, params any) error {
	return client.shared.Notify(method, params)
}

func (client *mcpClient) isClosed() bool { return client == nil || client.shared.IsClosed() }
