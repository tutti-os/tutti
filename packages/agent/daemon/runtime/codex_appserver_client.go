package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
)

type codexAppServerClient struct {
	raw *acpClient
	// closeOnce makes Close idempotent: the client is closed from several
	// owners (session replacement, lifecycle Close/Release, force-cancel,
	// startup failure defers) and only the first close may reach the process.
	closeOnce sync.Once
	closeErr  error
	// parsedNotificationMethods tracks notification methods already run
	// through the typed schema parse (telemetry only).
	parsedNotificationMethods sync.Map
}

type codexAppServerCaller struct {
	raw       *acpClient
	timeout   time.Duration
	handler   acpMessageHandler
	noHandler bool
	rawResult json.RawMessage
}

func newCodexAppServerClient(conn ProcessConnection) *codexAppServerClient {
	return &codexAppServerClient{raw: newAppServerJSONRPCClient(conn)}
}

func (c *codexAppServerClient) SetMessageHandler(handler acpMessageHandler) {
	if c == nil || c.raw == nil {
		return
	}
	c.raw.SetMessageHandler(func(ctx context.Context, message acpMessage) error {
		c.parseInboundMessage(message)
		if handler == nil {
			return nil
		}
		return handler(ctx, message)
	})
}

func (c *codexAppServerClient) SetStderrSink(sink func([]byte)) {
	if c == nil || c.raw == nil {
		return
	}
	c.raw.SetStderrSink(sink)
}

func (c *codexAppServerClient) Close() error {
	if c == nil || c.raw == nil {
		return nil
	}
	c.closeOnce.Do(func() {
		c.closeErr = c.raw.Close()
	})
	return c.closeErr
}

func (c *codexAppServerClient) Done() <-chan struct{} {
	if c == nil || c.raw == nil {
		done := make(chan struct{})
		close(done)
		return done
	}
	return c.raw.Done()
}

func (c *codexAppServerClient) Err() error {
	if c == nil || c.raw == nil {
		return ErrSessionDisconnected
	}
	return c.raw.Err()
}

func (c *codexAppServerClient) Diagnostics() acpClientDiagnostics {
	if c == nil || c.raw == nil {
		return acpClientDiagnostics{}
	}
	return c.raw.Diagnostics()
}

func (c *codexAppServerClient) Respond(ctx context.Context, id json.RawMessage, result any, responseErr *acpError) error {
	if c == nil || c.raw == nil {
		return errors.New("app-server client is nil")
	}
	return c.raw.Respond(ctx, id, result, responseErr)
}

func (c *codexAppServerClient) Initialized(ctx context.Context) error {
	if c == nil || c.raw == nil {
		return errors.New("app-server client is nil")
	}
	return c.raw.Notify(ctx, appServerMethodInitialized, nil)
}

func (c *codexAppServerClient) typed(timeout time.Duration, handler acpMessageHandler, noHandler bool) (*codexproto.Client, *codexAppServerCaller) {
	caller := &codexAppServerCaller{
		raw:       c.raw,
		timeout:   timeout,
		handler:   c.wrapHandler(handler),
		noHandler: noHandler,
	}
	return codexproto.NewClient(caller), caller
}

func (c *codexAppServerClient) wrapHandler(handler acpMessageHandler) acpMessageHandler {
	if handler == nil {
		return nil
	}
	return func(ctx context.Context, message acpMessage) error {
		c.parseInboundMessage(message)
		return handler(ctx, message)
	}
}

func (c *codexAppServerClient) parseInboundMessage(message acpMessage) {
	method := strings.TrimSpace(message.Method)
	if method == "" {
		return
	}
	if len(message.ID) > 0 {
		_, err := codexproto.ParseServerRequest(method, message.Params)
		if err != nil {
			slog.Warn("agent session app-server server request parse failed",
				"event", "agent_session.app_server.server_request.parse_failed",
				"method", method,
				"error", err.Error(),
			)
			return
		}
		if !codexproto.IsKnownServerRequestMethod(method) {
			slog.Warn("agent session app-server unknown server request",
				"event", "agent_session.app_server.server_request.unknown",
				"method", method,
			)
		}
		return
	}
	// Notifications are the hot path (token-delta traffic) and the reducer
	// re-decodes params into map[string]any anyway (D7): the typed parse here
	// is schema-drift telemetry only, so run it once per method per client
	// instead of paying a second full decode on every frame.
	if _, seen := c.parsedNotificationMethods.LoadOrStore(method, struct{}{}); seen {
		return
	}
	_, err := codexproto.ParseServerNotification(method, message.Params)
	if err != nil {
		slog.Warn("agent session app-server notification parse failed",
			"event", "agent_session.app_server.notification.parse_failed",
			"method", method,
			"error", err.Error(),
		)
		return
	}
	if !codexproto.IsKnownServerNotificationMethod(method) {
		slog.Warn("agent session app-server unknown notification",
			"event", "agent_session.app_server.notification.unknown",
			"method", method,
		)
	}
}

func (c *codexAppServerCaller) Call(ctx context.Context, method string, params any, result any) error {
	if c.raw == nil {
		return errors.New("app-server client is nil")
	}
	var raw json.RawMessage
	var err error
	if c.noHandler {
		raw, err = c.raw.CallNoHandlerWithTimeout(ctx, c.timeout, method, params)
	} else {
		raw, err = c.raw.CallWithTimeout(ctx, c.timeout, method, params, c.handler)
	}
	if err != nil {
		return err
	}
	c.rawResult = append(c.rawResult[:0], raw...)
	if result == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, result); err != nil {
		slog.Warn("agent session app-server typed response decode failed",
			"event", "agent_session.app_server.typed_response.decode_failed",
			"method", method,
			"error", err.Error(),
		)
	}
	return nil
}

func codexProtoParams[T any](params map[string]any) (T, error) {
	var out T
	if params == nil {
		return out, nil
	}
	data, err := json.Marshal(params)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, err
	}
	return out, nil
}

func (c *codexAppServerClient) Initialize(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.InitializeParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, handler, false)
	_, err = client.Initialize(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) AccountRead(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.GetAccountParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, handler, false)
	_, err = client.AccountRead(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ModelList(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ModelListParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, handler, false)
	_, err = client.ModelList(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ModelListNoHandler(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ModelListParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, nil, true)
	_, err = client.ModelList(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ConfigRead(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ConfigReadParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, handler, false)
	_, err = client.ConfigRead(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) AccountRateLimitsRead(
	ctx context.Context,
	timeout time.Duration,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	client, caller := c.typed(timeout, handler, false)
	_, err := client.AccountRateLimitsRead(ctx)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) AccountRateLimitsReadNoHandler(
	ctx context.Context,
	timeout time.Duration,
) (json.RawMessage, error) {
	client, caller := c.typed(timeout, nil, true)
	_, err := client.AccountRateLimitsRead(ctx)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) CollaborationModeList(
	ctx context.Context,
	timeout time.Duration,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	client, caller := c.typed(timeout, handler, false)
	_, err := client.CollaborationModeList(ctx, codexproto.CollaborationModeListParams{})
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadStart(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadStartParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, handler, false)
	_, err = client.ThreadStart(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadResume(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadResumeParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, handler, false)
	_, err = client.ThreadResume(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) TurnStart(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.TurnStartParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, nil, false)
	_, err = client.TurnStart(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) TurnSteerNoHandler(
	ctx context.Context,
	timeout time.Duration,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.TurnSteerParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, nil, true)
	_, err = client.TurnSteer(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadCompactStart(
	ctx context.Context,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadCompactStartParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, handler, false)
	_, err = client.ThreadCompactStart(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadGoalSet(
	ctx context.Context,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadGoalSetParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, handler, false)
	_, err = client.ThreadGoalSet(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadGoalGet(
	ctx context.Context,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadGoalGetParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, handler, false)
	_, err = client.ThreadGoalGet(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadGoalClear(
	ctx context.Context,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadGoalClearParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, handler, false)
	_, err = client.ThreadGoalClear(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

// The NoHandler goal variants are for background or mid-turn goal RPCs: a
// handler-carrying call claims the single active message handler slot and
// serializes behind other calls, so concurrent turn notifications would be
// swallowed (or the call would block) while the RPC is in flight.

func (c *codexAppServerClient) ThreadGoalSetNoHandler(
	ctx context.Context,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadGoalSetParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, nil, true)
	_, err = client.ThreadGoalSet(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadGoalGetNoHandler(
	ctx context.Context,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadGoalGetParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, nil, true)
	_, err = client.ThreadGoalGet(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadGoalClearNoHandler(
	ctx context.Context,
	params map[string]any,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadGoalClearParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, nil, true)
	_, err = client.ThreadGoalClear(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

// callGoalNoHandler mirrors callGoal for the NoHandler variants.
func (s *codexAppServerSession) callGoalNoHandler(
	ctx context.Context,
	method string,
	params map[string]any,
) (json.RawMessage, error) {
	if s == nil || s.client == nil {
		return nil, ErrSessionDisconnected
	}
	switch method {
	case appServerMethodThreadGoalClear:
		return s.client.ThreadGoalClearNoHandler(ctx, params)
	case appServerMethodThreadGoalGet:
		return s.client.ThreadGoalGetNoHandler(ctx, params)
	case appServerMethodThreadGoalSet:
		return s.client.ThreadGoalSetNoHandler(ctx, params)
	default:
		return nil, errors.New("unsupported app-server goal method")
	}
}

func (s *codexAppServerSession) callGoal(
	ctx context.Context,
	method string,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	if s == nil || s.client == nil {
		return nil, ErrSessionDisconnected
	}
	switch method {
	case appServerMethodThreadGoalClear:
		return s.client.ThreadGoalClear(ctx, params, handler)
	case appServerMethodThreadGoalGet:
		return s.client.ThreadGoalGet(ctx, params, handler)
	case appServerMethodThreadGoalSet:
		return s.client.ThreadGoalSet(ctx, params, handler)
	default:
		return nil, errors.New("unsupported app-server goal method")
	}
}

func (c *codexAppServerClient) ThreadRollback(
	ctx context.Context,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadRollbackParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, handler, false)
	_, err = client.ThreadRollback(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ReviewStart(
	ctx context.Context,
	params map[string]any,
	handler acpMessageHandler,
) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ReviewStartParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(0, handler, false)
	_, err = client.ReviewStart(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) ThreadReadNoHandler(ctx context.Context, timeout time.Duration, params map[string]any) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.ThreadReadParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, nil, true)
	_, err = client.ThreadRead(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}

func (c *codexAppServerClient) TurnInterruptNoHandler(ctx context.Context, timeout time.Duration, params map[string]any) (json.RawMessage, error) {
	typedParams, err := codexProtoParams[codexproto.TurnInterruptParams](params)
	if err != nil {
		return nil, err
	}
	client, caller := c.typed(timeout, nil, true)
	_, err = client.TurnInterrupt(ctx, typedParams)
	if err != nil {
		return nil, err
	}
	return caller.rawResult, nil
}
