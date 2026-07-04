package codexproto

import (
	"context"
	"encoding/json"
)

// JSONRPCRequest is the minimal JSON-RPC request envelope used by generated
// request builders and server-request dispatch.
type JSONRPCRequest struct {
	ID     RequestID       `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Caller is the transport seam used by generated client request helpers.
type Caller interface {
	Call(ctx context.Context, method string, params any, result any) error
}

// Client implements generated typed client request helpers over a Caller.
type Client struct {
	caller Caller
}

// NewClient returns a typed Codex app-server protocol client wrapper.
func NewClient(caller Caller) *Client {
	return &Client{caller: caller}
}

// Call forwards an untyped JSON-RPC call through the wrapped transport.
func (c *Client) Call(ctx context.Context, method string, params any, result any) error {
	return c.caller.Call(ctx, method, params, result)
}
