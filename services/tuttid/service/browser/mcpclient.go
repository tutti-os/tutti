// Package browser hosts a daemon-owned browser session driven by
// chrome-devtools-mcp. The daemon is the MCP client (so it answers any MCP
// elicitation itself) and exposes browser actions to agents through the
// `tutti browser` CLI — replacing per-provider MCP injection.
package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	agentruntime "github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime"
)

// mcpClient is a minimal newline-delimited JSON-RPC 2.0 client for an MCP
// server spoken over a process stdio connection. It correlates responses by id
// and answers server-initiated requests (notably MCP elicitation) itself.
//
// The framing/dispatch pattern mirrors the ACP client
// (packages/agent/daemon/runtime/acp_client.go) but speaks MCP tools/call
// rather than ACP, so it is kept as a small dedicated client.
type mcpClient struct {
	conn   agentruntime.ProcessConnection
	writer agentruntime.ProcessNDJSONWriter

	mu       sync.Mutex
	nextID   int
	pending  map[int]chan rpcIncoming
	closed   bool
	closeErr error

	stderr bytes.Buffer
}

type rpcIncoming struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("mcp error %d: %s", e.Code, e.Message) }

func newMCPClient(conn agentruntime.ProcessConnection) *mcpClient {
	c := &mcpClient{
		conn:    conn,
		writer:  agentruntime.NewProcessNDJSONWriter(conn),
		pending: make(map[int]chan rpcIncoming),
	}
	go c.readLoop()
	return c
}

// readLoop assembles stdout chunks into newline-delimited JSON messages and
// dispatches them. It runs until the connection closes or the process exits.
func (c *mcpClient) readLoop() {
	var buf bytes.Buffer
	for {
		frame, err := c.conn.Recv()
		if err != nil {
			c.fail(err)
			return
		}
		if len(frame.Stderr) > 0 {
			c.mu.Lock()
			c.stderr.Write(frame.Stderr)
			c.mu.Unlock()
		}
		if frame.ExitCode != nil {
			c.fail(fmt.Errorf("browser MCP process exited (code %d)%s", *frame.ExitCode, c.stderrTail()))
			return
		}
		if len(frame.Stdout) == 0 {
			continue
		}
		buf.Write(frame.Stdout)
		for {
			line, rest, found := bytes.Cut(buf.Bytes(), []byte("\n"))
			if !found {
				break
			}
			c.dispatch(append([]byte(nil), line...))
			next := append([]byte(nil), rest...)
			buf.Reset()
			buf.Write(next)
		}
	}
}

func (c *mcpClient) dispatch(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	var msg rpcIncoming
	if err := json.Unmarshal(line, &msg); err != nil {
		return
	}
	hasID := len(msg.ID) > 0 && string(msg.ID) != "null"
	// Server-initiated request (has method + id): answer it ourselves.
	if msg.Method != "" && hasID {
		c.handleServerRequest(msg)
		return
	}
	// Notification (method, no id): ignore.
	if msg.Method != "" {
		return
	}
	// Response (id, no method): deliver to the waiter.
	if !hasID {
		return
	}
	var id int
	if err := json.Unmarshal(msg.ID, &id); err != nil {
		return
	}
	c.mu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ch != nil {
		ch <- msg
	}
}

// handleServerRequest answers MCP server→client requests. MCP elicitation is
// auto-accepted (we never declare the elicitation capability, so a compliant
// server shouldn't send it, but we answer defensively rather than letting the
// tool call hang). Anything else is declined with method-not-supported.
func (c *mcpClient) handleServerRequest(msg rpcIncoming) {
	if msg.Method == "elicitation/create" {
		c.respond(msg.ID, map[string]any{"action": "accept", "content": map[string]any{}}, nil)
		return
	}
	c.respond(msg.ID, nil, &rpcError{Code: -32601, Message: "method not supported"})
}

func (c *mcpClient) respond(id json.RawMessage, result any, rpcErr *rpcError) {
	payload := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id)}
	if rpcErr != nil {
		payload["error"] = rpcErr
	} else {
		payload["result"] = result
	}
	if err := c.send(payload); err != nil {
		c.fail(fmt.Errorf("send browser MCP response: %w", err))
	}
}

func (c *mcpClient) send(payload any) error {
	return c.writer.SendJSON(payload)
}

// call issues a request and waits for the response or ctx cancellation.
func (c *mcpClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed {
		err := c.closeErr
		c.mu.Unlock()
		if err == nil {
			err = errors.New("browser MCP client closed")
		}
		return nil, err
	}
	c.nextID++
	id := c.nextID
	ch := make(chan rpcIncoming, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}

	select {
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	case msg, ok := <-ch:
		if !ok {
			c.mu.Lock()
			err := c.closeErr
			c.mu.Unlock()
			if err == nil {
				err = errors.New("browser MCP client closed")
			}
			return nil, err
		}
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	}
}

func (c *mcpClient) notify(method string, params any) error {
	return c.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *mcpClient) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *mcpClient) fail(err error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.closeErr = err
	pending := c.pending
	c.pending = make(map[int]chan rpcIncoming)
	c.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
}

func (c *mcpClient) stderrTail() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := strings.TrimSpace(c.stderr.String())
	if s == "" {
		return ""
	}
	if len(s) > 400 {
		s = s[len(s)-400:]
	}
	return ": " + s
}
