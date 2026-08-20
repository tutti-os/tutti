package relaytransport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
)

const maxHandshakeErrorBody = 64 << 10

// Dial opens one Relay WebSocket and exposes binary messages as a byte stream.
func Dial(ctx context.Context, request DialRequest) (net.Conn, error) {
	ws, err := dialWebSocket(ctx, request)
	if err != nil {
		return nil, err
	}
	return newDialWebSocketByteConn(ws, request.Liveness), nil
}

func dialWebSocket(ctx context.Context, request DialRequest) (*websocket.Conn, error) {
	request, err := normalizeDialRequest(request)
	if err != nil {
		return nil, err
	}

	header := request.Header.Clone()
	dialer := *websocket.DefaultDialer
	dialer.Subprotocols = []string{request.Subprotocol}

	endpoint, _ := url.Parse(request.Endpoint)
	query := endpoint.Query()
	for key, values := range request.Query {
		query[key] = append([]string(nil), values...)
	}
	endpoint.RawQuery = query.Encode()

	ws, response, err := dialer.DialContext(ctx, endpoint.String(), header)
	if err != nil {
		if ws != nil {
			_ = ws.Close()
		}
		return nil, newDialError(response, err)
	}
	if ws.Subprotocol() != request.Subprotocol {
		_ = ws.Close()
		return nil, fmt.Errorf("relay websocket requires subprotocol %q, got %q", request.Subprotocol, ws.Subprotocol())
	}
	return ws, nil
}

func normalizeDialRequest(request DialRequest) (DialRequest, error) {
	endpoint, err := url.Parse(strings.TrimSpace(request.Endpoint))
	if err != nil {
		return DialRequest{}, fmt.Errorf("parse relay endpoint: %w", err)
	}
	if endpoint.Scheme != "ws" && endpoint.Scheme != "wss" {
		return DialRequest{}, fmt.Errorf("relay endpoint scheme %q is not ws or wss", endpoint.Scheme)
	}
	if strings.TrimSpace(endpoint.Host) == "" {
		return DialRequest{}, errors.New("relay endpoint host is empty")
	}
	if endpoint.User != nil {
		return DialRequest{}, errors.New("relay endpoint userinfo is not allowed")
	}
	request.Endpoint = endpoint.String()
	request.Subprotocol = strings.TrimSpace(request.Subprotocol)
	if request.Subprotocol == "" {
		return DialRequest{}, errors.New("relay websocket subprotocol is required")
	}
	query := make(url.Values, len(request.Query))
	for key, values := range request.Query {
		query[key] = append([]string(nil), values...)
	}
	request.Query = query
	request.Header = request.Header.Clone()
	return request, nil
}

// DialError exposes bounded HTTP handshake metadata without including response
// bodies or authorization headers in its Error string. Product adapters may
// inspect HTTPResponseBody to classify a product-owned wire reason, but must
// not persist the raw body in ordinary logs or metrics.
type DialError struct {
	statusCode    int
	retryAfter    string
	responseBody  []byte
	bodyTruncated bool
	cause         error
}

func newDialError(response *http.Response, cause error) error {
	if response == nil || response.StatusCode <= 0 {
		return fmt.Errorf("dial relay websocket: %w", cause)
	}
	if response.Body != nil {
		body, readErr := io.ReadAll(io.LimitReader(response.Body, maxHandshakeErrorBody+1))
		_ = response.Body.Close()
		if readErr == nil {
			truncated := len(body) > maxHandshakeErrorBody
			if truncated {
				body = body[:maxHandshakeErrorBody]
			}
			return &DialError{
				statusCode:    response.StatusCode,
				retryAfter:    strings.TrimSpace(response.Header.Get("Retry-After")),
				responseBody:  body,
				bodyTruncated: truncated,
				cause:         cause,
			}
		}
	}
	return &DialError{
		statusCode: response.StatusCode,
		retryAfter: strings.TrimSpace(response.Header.Get("Retry-After")),
		cause:      cause,
	}
}

func (e *DialError) Error() string {
	return fmt.Sprintf("dial relay websocket: http %d: %v", e.statusCode, e.cause)
}

func (e *DialError) Unwrap() error          { return e.cause }
func (e *DialError) HTTPStatusCode() int    { return e.statusCode }
func (e *DialError) HTTPRetryAfter() string { return e.retryAfter }

// HTTPResponseBody returns a copy of the bounded handshake response body. The
// value is opaque product material and must not be written to ordinary logs.
func (e *DialError) HTTPResponseBody() []byte {
	return append([]byte(nil), e.responseBody...)
}

// HTTPResponseBodyTruncated reports whether the handshake response body
// exceeded the package limit.
func (e *DialError) HTTPResponseBodyTruncated() bool { return e.bodyTruncated }
