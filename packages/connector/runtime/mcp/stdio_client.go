// Package mcp contains daemon-shared MCP protocol building blocks. It does not
// own connector lifecycle, workspace routing, or authorization.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

const defaultMaxMessageBytes = 4 * 1024 * 1024
const defaultMaxStderrBytes = 64 * 1024
const callbackQueueDepth = 64

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (err *RPCError) Error() string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("mcp error %d: %s", err.Code, err.Message)
}

type ServerRequest struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
}

type Notification struct {
	Method string
	Params json.RawMessage
}

// ServerRequestHandler runs synchronously on the protocol reader so its reply
// is ordered before subsequent messages. It must not call back into the same
// StdioClient.
type ServerRequestHandler func(ServerRequest) (any, *RPCError)

// NotificationHandler runs on a serialized bounded worker and may call the
// StdioClient without deadlocking the protocol reader.
type NotificationHandler func(Notification)

type StdioClientConfig struct {
	Connection           agentruntime.ProcessConnection
	ProcessName          string
	MaxMessageBytes      int
	MaxStderrBytes       int
	ServerRequestHandler ServerRequestHandler
	NotificationHandler  NotificationHandler
}

// StdioClient is a concurrent newline-delimited JSON-RPC 2.0 MCP client. It
// owns the protocol reader, but the caller remains responsible for closing the
// underlying process connection.
type StdioClient struct {
	connection agentruntime.ProcessConnection
	writer     agentruntime.ProcessNDJSONWriter
	name       string
	maxMessage int
	maxStderr  int
	onRequest  ServerRequestHandler
	onNotify   NotificationHandler
	notifies   chan Notification
	closedCh   chan struct{}

	mu       sync.Mutex
	nextID   int64
	pending  map[int64]chan rpcIncoming
	closed   bool
	closeErr error
	stderr   []byte
}

type rpcIncoming struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

func NewStdioClient(config StdioClientConfig) (*StdioClient, error) {
	if config.Connection == nil {
		return nil, errors.New("MCP stdio connection is required")
	}
	if config.MaxMessageBytes <= 0 {
		config.MaxMessageBytes = defaultMaxMessageBytes
	}
	if config.MaxStderrBytes <= 0 {
		config.MaxStderrBytes = defaultMaxStderrBytes
	}
	name := strings.TrimSpace(config.ProcessName)
	if name == "" {
		name = "MCP"
	}
	client := &StdioClient{
		connection: config.Connection,
		writer:     agentruntime.NewProcessNDJSONWriter(config.Connection),
		name:       name,
		maxMessage: config.MaxMessageBytes,
		maxStderr:  config.MaxStderrBytes,
		onRequest:  config.ServerRequestHandler,
		onNotify:   config.NotificationHandler,
		pending:    make(map[int64]chan rpcIncoming),
		closedCh:   make(chan struct{}),
	}
	if client.onNotify != nil {
		client.notifies = make(chan Notification, callbackQueueDepth)
		go client.notificationLoop()
	}
	go client.readLoop()
	return client, nil
}

func (client *StdioClient) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	client.mu.Lock()
	if client.closed {
		err := client.closedErrorLocked()
		client.mu.Unlock()
		return nil, err
	}
	client.nextID++
	id := client.nextID
	response := make(chan rpcIncoming, 1)
	client.pending[id] = response
	client.mu.Unlock()

	if err := client.writer.SendJSON(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		client.mu.Lock()
		delete(client.pending, id)
		client.mu.Unlock()
		return nil, err
	}
	select {
	case <-ctx.Done():
		client.mu.Lock()
		delete(client.pending, id)
		client.mu.Unlock()
		return nil, ctx.Err()
	case message, ok := <-response:
		if !ok {
			client.mu.Lock()
			err := client.closedErrorLocked()
			client.mu.Unlock()
			return nil, err
		}
		if message.Error != nil {
			return nil, message.Error
		}
		return message.Result, nil
	}
}

func (client *StdioClient) Notify(method string, params any) error {
	client.mu.Lock()
	if client.closed {
		err := client.closedErrorLocked()
		client.mu.Unlock()
		return err
	}
	client.mu.Unlock()
	return client.writer.SendJSON(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (client *StdioClient) IsClosed() bool {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.closed
}

// Done is closed when the protocol reader observes process exit, malformed
// protocol output, or another terminal transport error.
func (client *StdioClient) Done() <-chan struct{} {
	if client == nil {
		closed := make(chan struct{})
		close(closed)
		return closed
	}
	return client.closedCh
}

func (client *StdioClient) ClosedError() error {
	client.mu.Lock()
	defer client.mu.Unlock()
	if !client.closed {
		return nil
	}
	return client.closedErrorLocked()
}

func (client *StdioClient) readLoop() {
	var buffer bytes.Buffer
	for {
		frame, err := client.connection.Recv()
		if err != nil {
			client.fail(err)
			return
		}
		if len(frame.Stderr) != 0 {
			client.appendStderr(frame.Stderr)
		}
		if frame.ExitCode != nil {
			client.fail(fmt.Errorf("%s process exited (code %d)%s", client.name, *frame.ExitCode, client.stderrTail()))
			return
		}
		if len(frame.Stdout) == 0 {
			continue
		}
		buffer.Write(frame.Stdout)
		if buffer.Len() > client.maxMessage && !bytes.Contains(buffer.Bytes(), []byte("\n")) {
			client.fail(fmt.Errorf("%s message exceeds limit %d", client.name, client.maxMessage))
			return
		}
		for {
			line, rest, found := bytes.Cut(buffer.Bytes(), []byte("\n"))
			if !found {
				break
			}
			if len(line) > client.maxMessage {
				client.fail(fmt.Errorf("%s message exceeds limit %d", client.name, client.maxMessage))
				return
			}
			if err := client.dispatch(append([]byte(nil), line...)); err != nil {
				client.fail(err)
				return
			}
			next := append([]byte(nil), rest...)
			buffer.Reset()
			buffer.Write(next)
		}
	}
}

func (client *StdioClient) dispatch(line []byte) error {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return nil
	}
	var message rpcIncoming
	if err := json.Unmarshal(line, &message); err != nil {
		return fmt.Errorf("decode %s JSON-RPC message: %w", client.name, err)
	}
	if message.JSONRPC != "2.0" {
		return fmt.Errorf("decode %s JSON-RPC message: unsupported version %q", client.name, message.JSONRPC)
	}
	hasID := len(message.ID) != 0 && string(message.ID) != "null"
	if message.Method != "" && hasID {
		return client.handleServerRequest(message)
	}
	if message.Method != "" {
		if client.onNotify != nil {
			select {
			case client.notifies <- Notification{Method: message.Method, Params: message.Params}:
			case <-client.closedCh:
				return client.closedError()
			default:
				return fmt.Errorf("%s notification callback queue is full", client.name)
			}
		}
		return nil
	}
	if !hasID {
		return errors.New("MCP JSON-RPC response has no id")
	}
	var id int64
	if err := json.Unmarshal(message.ID, &id); err != nil {
		return fmt.Errorf("MCP JSON-RPC response id is unsupported: %w", err)
	}
	client.mu.Lock()
	waiter := client.pending[id]
	delete(client.pending, id)
	client.mu.Unlock()
	if waiter != nil {
		waiter <- message
	}
	return nil
}

func (client *StdioClient) handleServerRequest(message rpcIncoming) error {
	request := ServerRequest{ID: append(json.RawMessage(nil), message.ID...), Method: message.Method, Params: message.Params}
	if client.onRequest == nil {
		return client.respondServerRequest(request, nil, &RPCError{Code: -32601, Message: "method not supported"})
	}
	result, rpcErr, err := client.deliverServerRequest(request)
	if err != nil {
		return err
	}
	return client.respondServerRequest(request, result, rpcErr)
}

func (client *StdioClient) respondServerRequest(request ServerRequest, result any, rpcErr *RPCError) error {
	payload := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(request.ID)}
	if rpcErr != nil {
		payload["error"] = rpcErr
	} else {
		payload["result"] = result
	}
	if err := client.writer.SendJSON(payload); err != nil {
		return fmt.Errorf("send %s server-request response: %w", client.name, err)
	}
	return nil
}

func (client *StdioClient) notificationLoop() {
	for {
		select {
		case <-client.closedCh:
			return
		case notification := <-client.notifies:
			if client.IsClosed() {
				return
			}
			if err := client.deliverNotification(notification); err != nil {
				client.fail(err)
				return
			}
		}
	}
}

func (client *StdioClient) deliverNotification(notification Notification) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%s notification handler panicked: %v", client.name, recovered)
		}
	}()
	client.onNotify(notification)
	return nil
}

func (client *StdioClient) deliverServerRequest(request ServerRequest) (result any, rpcErr *RPCError, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = nil
			rpcErr = nil
			err = fmt.Errorf("%s server-request handler panicked: %v", client.name, recovered)
		}
	}()
	result, rpcErr = client.onRequest(request)
	return result, rpcErr, nil
}

func (client *StdioClient) appendStderr(data []byte) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.stderr = append(client.stderr, data...)
	if len(client.stderr) > client.maxStderr {
		client.stderr = append([]byte(nil), client.stderr[len(client.stderr)-client.maxStderr:]...)
	}
}

func (client *StdioClient) stderrTail() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	text := strings.TrimSpace(string(client.stderr))
	if text == "" {
		return ""
	}
	return ": " + text
}

func (client *StdioClient) fail(err error) {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return
	}
	client.closed = true
	client.closeErr = err
	close(client.closedCh)
	pending := client.pending
	client.pending = make(map[int64]chan rpcIncoming)
	client.mu.Unlock()
	for _, waiter := range pending {
		close(waiter)
	}
}

func (client *StdioClient) closedError() error {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.closedErrorLocked()
}

func (client *StdioClient) closedErrorLocked() error {
	if client.closeErr != nil {
		return client.closeErr
	}
	return errors.New("MCP stdio client is closed")
}
