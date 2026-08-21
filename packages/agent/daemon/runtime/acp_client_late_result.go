package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// CallNoHandlerWithLateResult keeps the response identity alive after the
// caller's deadline so operations with provider-side creation semantics can
// clean up a resource whenever its response eventually arrives. These calls
// remain registered until a response or client shutdown because forgetting the
// response identity could leak a provider-owned resource. The late callback
// never restores the original caller.
func (c *acpClient) CallNoHandlerWithLateResult(
	ctx context.Context,
	timeout time.Duration,
	method string,
	params any,
	late func(json.RawMessage),
) (json.RawMessage, error) {
	if c == nil {
		return nil, errors.New("acp client is nil")
	}
	callCtx := ctx
	cancel := func() {}
	if timeout > 0 {
		callCtx, cancel = context.WithTimeout(ctx, timeout)
	}
	defer cancel()

	id := c.nextID.Add(1)
	message := c.messageEnvelope()
	message["id"] = id
	message["method"] = method
	if params != nil {
		message["params"] = params
	}
	pending := &acpPendingCall{response: make(chan acpMessage, 1)}
	c.registerCall(id, pending, nil)
	if err := c.sendJSON(callCtx, message); err != nil {
		c.unregisterCall(id, nil)
		return nil, err
	}
	select {
	case response := <-pending.response:
		c.unregisterCall(id, nil)
		if response.Error != nil {
			return nil, &acpCallError{Method: method, Err: *response.Error}
		}
		return response.Result, nil
	case <-c.done:
		c.unregisterCall(id, nil)
		return nil, c.finishError()
	case <-callCtx.Done():
		go func() {
			defer c.unregisterCall(id, nil)
			select {
			case response := <-pending.response:
				if response.Error == nil && late != nil {
					late(response.Result)
				}
			case <-c.done:
			}
		}()
		if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
			return nil, &acpCallTimeoutError{Method: method, Timeout: timeout}
		}
		return nil, callCtx.Err()
	}
}
