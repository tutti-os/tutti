package agentruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type acpClient struct {
	conn                ProcessConnection
	stderrMessageMapper acpStderrMessageMapper
	omitWireVersion     bool
	nextID              atomic.Int64
	callMu              sync.Mutex
	sendMu              sync.Mutex
	mu                  sync.Mutex
	pending             map[int64]*acpPendingCall
	active              *acpActiveHandler
	handler             acpMessageHandler
	stderrSink          func([]byte)
	done                chan struct{}
	doneErr             error
	exitCode            *int
	stderrTail          []byte
	stdoutTail          []byte
	stdoutProtocolErrs  int
	doneOnce            sync.Once
}

type acpClientDiagnostics struct {
	ExitCode   *int
	StderrTail string
	StdoutTail string
}

type acpMessage struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *acpError       `json:"error,omitempty"`
}

type acpMessageHandler func(context.Context, acpMessage) error
type acpStderrMessageMapper func([]byte) (acpMessage, bool)

type acpPendingCall struct {
	response chan acpMessage
}

type acpActiveHandler struct {
	ctx     context.Context
	handler acpMessageHandler
	errors  chan error
}

type acpError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type acpCallError struct {
	Method string
	Err    acpError
}

func (e *acpCallError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("acp %s failed: %s", e.Method, acpErrorSummary(&e.Err))
}

func (e *acpCallError) AuthRequired() bool {
	if e == nil {
		return false
	}
	haystack := strings.ToLower(e.Err.Message + " " + string(e.Err.Data))
	return strings.Contains(haystack, "auth")
}

func newACPClientWithStderrMessageMapper(conn ProcessConnection, mapper acpStderrMessageMapper) *acpClient {
	c := &acpClient{
		conn:                conn,
		stderrMessageMapper: mapper,
		pending:             make(map[int64]*acpPendingCall),
		done:                make(chan struct{}),
	}
	go c.readLoop()
	return c
}

const (
	acpClientOutputTailLimit          = 8192
	acpClientStdoutProtocolErrorLimit = 5
)

// newAppServerJSONRPCClient creates a JSON-RPC client for the codex
// app-server wire format, which omits the "jsonrpc" version header.
func newAppServerJSONRPCClient(conn ProcessConnection) *acpClient {
	c := &acpClient{
		conn:            conn,
		omitWireVersion: true,
		pending:         make(map[int64]*acpPendingCall),
		done:            make(chan struct{}),
	}
	go c.readLoop()
	return c
}

func (c *acpClient) messageEnvelope() map[string]any {
	if c != nil && c.omitWireVersion {
		return map[string]any{}
	}
	return map[string]any{"jsonrpc": "2.0"}
}

func (c *acpClient) SetMessageHandler(handler acpMessageHandler) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.handler = handler
	c.mu.Unlock()
}

func (c *acpClient) SetStderrSink(sink func([]byte)) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.stderrSink = sink
	c.mu.Unlock()
}

func (c *acpClient) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Done is closed when the process connection terminates.
func (c *acpClient) Done() <-chan struct{} {
	return c.done
}

// Err reports why the connection terminated; valid after Done is closed.
func (c *acpClient) Err() error {
	return c.finishError()
}

func (c *acpClient) Diagnostics() acpClientDiagnostics {
	if c == nil {
		return acpClientDiagnostics{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	diag := acpClientDiagnostics{
		StderrTail: strings.TrimSpace(string(c.stderrTail)),
		StdoutTail: strings.TrimSpace(string(c.stdoutTail)),
	}
	if c.exitCode != nil {
		exitCode := *c.exitCode
		diag.ExitCode = &exitCode
	}
	return diag
}

func (c *acpClient) Notify(ctx context.Context, method string, params any) error {
	if c == nil {
		return errors.New("acp client is nil")
	}
	message := c.messageEnvelope()
	message["method"] = method
	if params != nil {
		message["params"] = params
	}
	if err := c.sendJSON(ctx, message); err != nil {
		slog.Warn("agent session ACP notify failed",
			"event", "agent_session.acp.notify.failed",
			"method", method,
			"error", err.Error(),
		)
		return err
	}
	slog.Info("agent session ACP notify sent",
		"event", "agent_session.acp.notify.sent",
		"method", method,
	)
	return nil
}

func (c *acpClient) CallWithTimeout(
	ctx context.Context,
	timeout time.Duration,
	method string,
	params any,
	handler func(context.Context, acpMessage) error,
) (json.RawMessage, error) {
	if c == nil {
		return nil, errors.New("acp client is nil")
	}
	if timeout <= 0 {
		return c.Call(ctx, method, params, handler)
	}
	c.callMu.Lock()
	defer c.callMu.Unlock()

	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := c.callLocked(callCtx, method, params, handler)
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, fmt.Errorf("acp %s timed out after %s", method, timeout)
	}
	return result, err
}

func (c *acpClient) Call(
	ctx context.Context,
	method string,
	params any,
	handler func(context.Context, acpMessage) error,
) (json.RawMessage, error) {
	if c == nil {
		return nil, errors.New("acp client is nil")
	}
	c.callMu.Lock()
	defer c.callMu.Unlock()
	return c.callLocked(ctx, method, params, handler)
}

func (c *acpClient) callLocked(
	ctx context.Context,
	method string,
	params any,
	handler func(context.Context, acpMessage) error,
) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	message := c.messageEnvelope()
	message["id"] = id
	message["method"] = method
	if params != nil {
		message["params"] = params
	}
	active := &acpActiveHandler{ctx: ctx, handler: handler, errors: make(chan error, 1)}
	pending := &acpPendingCall{response: make(chan acpMessage, 1)}
	c.registerCall(id, pending, active)
	defer c.unregisterCall(id, active)

	slog.Info("agent session ACP request sent",
		"event", "agent_session.acp.request.sent",
		"method", method,
		"id", id,
	)
	if err := c.sendJSON(ctx, message); err != nil {
		return nil, err
	}

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-c.done:
			return nil, c.finishError()
		case err := <-active.errors:
			if err == nil {
				err = io.EOF
			}
			return nil, err
		case message := <-pending.response:
			if message.Error != nil {
				slog.Warn("agent session ACP request failed",
					"event", "agent_session.acp.request.failed",
					"method", method,
					"id", id,
					"error_code", message.Error.Code,
					"error_message", message.Error.Message,
					"error_data", truncateACPLogValue(string(message.Error.Data), 1200),
				)
				return nil, &acpCallError{Method: method, Err: *message.Error}
			}
			return message.Result, nil
		}
	}
}

// CallNoHandler issues a request without claiming the single active message
// handler slot and without serializing behind other calls. It is required for
// requests that must run while another call is streaming (for example codex
// app-server `turn/interrupt` and `turn/steer` while `turn/start` is pending).
func (c *acpClient) CallNoHandler(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c == nil {
		return nil, errors.New("acp client is nil")
	}
	id := c.nextID.Add(1)
	message := c.messageEnvelope()
	message["id"] = id
	message["method"] = method
	if params != nil {
		message["params"] = params
	}
	pending := &acpPendingCall{response: make(chan acpMessage, 1)}
	c.registerCall(id, pending, nil)
	defer c.unregisterCall(id, nil)

	slog.Info("agent session ACP request sent",
		"event", "agent_session.acp.request.sent",
		"method", method,
		"id", id,
	)
	if err := c.sendJSON(ctx, message); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, c.finishError()
	case response := <-pending.response:
		if response.Error != nil {
			return nil, &acpCallError{Method: method, Err: *response.Error}
		}
		return response.Result, nil
	}
}

func (c *acpClient) CallNoHandlerWithTimeout(
	ctx context.Context,
	timeout time.Duration,
	method string,
	params any,
) (json.RawMessage, error) {
	if c == nil {
		return nil, errors.New("acp client is nil")
	}
	if timeout <= 0 {
		return c.CallNoHandler(ctx, method, params)
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := c.CallNoHandler(callCtx, method, params)
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, fmt.Errorf("acp %s timed out after %s", method, timeout)
	}
	return result, err
}

func (c *acpClient) registerCall(id int64, pending *acpPendingCall, active *acpActiveHandler) {
	c.mu.Lock()
	if c.pending == nil {
		c.pending = make(map[int64]*acpPendingCall)
	}
	c.pending[id] = pending
	if active != nil && active.handler != nil {
		c.active = active
	}
	c.mu.Unlock()
}

func (c *acpClient) unregisterCall(id int64, active *acpActiveHandler) {
	c.mu.Lock()
	delete(c.pending, id)
	if active != nil && c.active == active {
		c.active = nil
	}
	c.mu.Unlock()
}

func (c *acpClient) Respond(ctx context.Context, id json.RawMessage, result any, responseErr *acpError) error {
	if len(bytes.TrimSpace(id)) == 0 {
		return nil
	}
	message := c.messageEnvelope()
	message["id"] = json.RawMessage(id)
	if responseErr != nil {
		message["error"] = responseErr
	} else {
		message["result"] = result
	}
	return c.sendJSON(ctx, message)
}

func (c *acpClient) sendJSON(ctx context.Context, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return c.conn.Send(raw)
	}
}

func (c *acpClient) readLoop() {
	var pending []byte
	var stderrTail []byte
	var stdoutTail []byte
	for {
		frame, err := c.conn.Recv()
		if err != nil {
			c.finish(err)
			return
		}
		if len(frame.Stderr) > 0 {
			stderrTail = append(stderrTail, frame.Stderr...)
			if len(stderrTail) > acpClientOutputTailLimit {
				stderrTail = stderrTail[len(stderrTail)-acpClientOutputTailLimit:]
			}
			c.setStderrTail(stderrTail)
			c.mu.Lock()
			stderrSink := c.stderrSink
			c.mu.Unlock()
			if stderrSink != nil {
				stderrSink(frame.Stderr)
			}
			if c.stderrMessageMapper != nil {
				if message, ok := c.stderrMessageMapper(frame.Stderr); ok {
					c.dispatchMessage(message)
				}
			}
			slog.Warn("agent session ACP stderr",
				"event", "agent_session.acp.stderr",
				"message", truncateACPLogValue(string(frame.Stderr), 1200),
			)
			continue
		}
		if frame.ExitCode != nil {
			c.setExitCode(*frame.ExitCode)
			message := strings.TrimSpace(frame.Message)
			if stderr := strings.TrimSpace(string(stderrTail)); stderr != "" {
				message = firstNonEmpty(message, "process exited") + ": " + stderr
			}
			c.finish(fmt.Errorf("acp process exited with code %d: %s", *frame.ExitCode, message))
			return
		}
		if len(frame.Stdout) == 0 {
			continue
		}
		stdoutTail = append(stdoutTail, frame.Stdout...)
		if len(stdoutTail) > acpClientOutputTailLimit {
			stdoutTail = stdoutTail[len(stdoutTail)-acpClientOutputTailLimit:]
		}
		c.setStdoutTail(stdoutTail)
		pending = append(pending, frame.Stdout...)
		for {
			line, rest, ok := bytes.Cut(pending, []byte("\n"))
			if !ok {
				break
			}
			pending = rest
			c.dispatchLine(line)
		}
	}
}

func (c *acpClient) setStderrTail(tail []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stderrTail = append(c.stderrTail[:0], tail...)
}

func (c *acpClient) setStdoutTail(tail []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stdoutTail = append(c.stdoutTail[:0], tail...)
}

func (c *acpClient) setExitCode(exitCode int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.exitCode = &exitCode
}

func (c *acpClient) dispatchLine(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	if !bytes.HasPrefix(line, []byte("{")) {
		if json.Valid(line) {
			c.recordStdoutProtocolError("non_object_json", line, nil)
			return
		}
		if benignACPStdoutLine(line) {
			c.resetStdoutProtocolErrors()
			slog.Warn("agent session ACP stdout ignored provider log line",
				"event", "agent_session.acp.stdout.provider_log",
				"message", truncateACPLogValue(string(line), 1200),
			)
			return
		}
		c.recordStdoutProtocolError("invalid_json", line, nil)
		return
	}
	var message acpMessage
	if err := json.Unmarshal(line, &message); err != nil {
		c.recordStdoutProtocolError("invalid_json", line, err)
		return
	}
	c.resetStdoutProtocolErrors()
	slog.Info("agent session ACP stdout",
		"event", "agent_session.acp.stdout",
		"method", message.Method,
		"id", strings.TrimSpace(string(message.ID)),
		"has_result", len(message.Result) > 0,
		"has_error", message.Error != nil,
		"error_code", acpErrorCode(message.Error),
		"error_message", acpErrorMessage(message.Error),
		"error_data", acpErrorData(message.Error),
	)
	c.dispatchMessage(message)
}

func (c *acpClient) resetStdoutProtocolErrors() {
	c.mu.Lock()
	c.stdoutProtocolErrs = 0
	c.mu.Unlock()
}

func (c *acpClient) recordStdoutProtocolError(kind string, line []byte, cause error) {
	c.mu.Lock()
	c.stdoutProtocolErrs++
	count := c.stdoutProtocolErrs
	stdoutTail := strings.TrimSpace(string(c.stdoutTail))
	stderrTail := strings.TrimSpace(string(c.stderrTail))
	c.mu.Unlock()

	message := truncateACPLogValue(string(line), 1200)
	if count < acpClientStdoutProtocolErrorLimit {
		slog.Warn("agent session ACP stdout ignored malformed protocol line",
			"event", "agent_session.acp.stdout.protocol_line_ignored",
			"kind", kind,
			"consecutive_count", count,
			"limit", acpClientStdoutProtocolErrorLimit,
			"message", message,
			"error", acpProtocolErrorMessage(cause),
		)
		return
	}

	errText := fmt.Sprintf("invalid acp stdout protocol after %d consecutive malformed lines: %s", count, kind)
	if cause != nil {
		errText += ": " + cause.Error()
	}
	errText += ": " + message
	if stdoutTail != "" {
		errText += "; stdout tail: " + truncateACPLogValue(stdoutTail, 1200)
	}
	if stderrTail != "" {
		errText += "; stderr tail: " + truncateACPLogValue(stderrTail, 1200)
	}
	c.finish(errors.New(errText))
}

func acpProtocolErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func benignACPStdoutLine(line []byte) bool {
	text := strings.TrimSpace(string(line))
	if text == "" {
		return true
	}
	lower := strings.ToLower(text)
	prefixes := []string{
		"warn ",
		"warn:",
		"warning ",
		"warning:",
		"[warn]",
		"[warning]",
		"npm warn",
		"info ",
		"info:",
		"[info]",
		"debug ",
		"debug:",
		"[debug]",
		"trace ",
		"trace:",
		"[trace]",
		"(node:",
		"experimentalwarning:",
		"codex ",
		"codex-",
		"claude ",
	}
	for _, prefix := range prefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return strings.Contains(lower, "deprecated")
}

func (c *acpClient) dispatchMessage(message acpMessage) {
	slog.Info("agent session ACP message received",
		"event", "agent_session.acp.message.received",
		"method", message.Method,
		"id", strings.TrimSpace(string(message.ID)),
		"has_error", message.Error != nil,
	)
	if len(message.ID) > 0 && message.Method == "" {
		id, ok := acpIDInt64(message.ID)
		if !ok {
			slog.Warn("agent session ACP response ignored because id is unsupported",
				"event", "agent_session.acp.response.unsupported_id",
				"id", strings.TrimSpace(string(message.ID)),
			)
			return
		}
		pending := c.pendingCall(id)
		if pending == nil {
			slog.Warn("agent session ACP response ignored because no call is pending",
				"event", "agent_session.acp.response.unmatched",
				"id", id,
			)
			return
		}
		select {
		case pending.response <- message:
		case <-c.done:
		}
		return
	}

	handlerCtx, handler, active := c.messageHandler()
	if handler == nil {
		if len(message.ID) > 0 && message.Method != "" {
			_ = c.Respond(context.Background(), message.ID, nil, &acpError{Code: -32601, Message: "method not supported"})
		}
		return
	}
	if err := handler(handlerCtx, message); err != nil {
		if active != nil {
			select {
			case active.errors <- err:
			default:
			}
			return
		}
		slog.Warn("agent session ACP message handler failed",
			"event", "agent_session.acp.message_handler.failed",
			"method", message.Method,
			"id", strings.TrimSpace(string(message.ID)),
			"error", err.Error(),
		)
	}
}

func (c *acpClient) pendingCall(id int64) *acpPendingCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pending[id]
}

func (c *acpClient) messageHandler() (context.Context, acpMessageHandler, *acpActiveHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active != nil && c.active.handler != nil {
		handlerCtx := c.active.ctx
		if handlerCtx == nil {
			handlerCtx = context.Background()
		}
		return handlerCtx, c.active.handler, c.active
	}
	return context.Background(), c.handler, nil
}

func (c *acpClient) finish(err error) {
	c.doneOnce.Do(func() {
		if err == nil {
			err = io.EOF
		}
		c.mu.Lock()
		c.doneErr = err
		c.mu.Unlock()
		close(c.done)
	})
}

func (c *acpClient) finishError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.doneErr == nil {
		return io.EOF
	}
	return c.doneErr
}

func acpIDInt64(raw json.RawMessage) (int64, bool) {
	var number int64
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if parsed, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64); err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func acpErrorSummary(err *acpError) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Message)
	if message == "" {
		message = fmt.Sprintf("code %d", err.Code)
	}
	data := strings.TrimSpace(string(err.Data))
	if data != "" {
		return fmt.Sprintf("%s (code %d, data: %s)", message, err.Code, truncateACPLogValue(data, 1200))
	}
	return fmt.Sprintf("%s (code %d)", message, err.Code)
}

func acpErrorCode(err *acpError) int {
	if err == nil {
		return 0
	}
	return err.Code
}

func acpErrorMessage(err *acpError) string {
	if err == nil {
		return ""
	}
	return err.Message
}

func acpErrorData(err *acpError) string {
	if err == nil {
		return ""
	}
	return truncateACPLogValue(string(err.Data), 1200)
}

func acpTextContent(value any) string {
	if value == nil {
		return ""
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	trim := bytes.TrimSpace(raw)
	if len(trim) > 0 && trim[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(trim, &blocks); err != nil {
			return ""
		}
		var b strings.Builder
		for _, block := range blocks {
			if block.Type == "text" && block.Text != "" {
				b.WriteString(block.Text)
			}
		}
		return b.String()
	}
	var content struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &content); err != nil {
		return ""
	}
	if content.Type == "text" {
		return content.Text
	}
	return ""
}
