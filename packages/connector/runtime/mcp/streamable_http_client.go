// Package mcp contains host-neutral MCP protocol building blocks. It does not
// own connector lifecycle, workspace routing, or authorization.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type RequestAuthorizer func(*http.Request) error

type StreamableHTTPClientConfig struct {
	Endpoint         string
	AllowedHosts     []string
	HTTPClient       *http.Client
	AuthorizeRequest RequestAuthorizer
	Timeout          time.Duration
	MaxResponseBytes int
}

// StreamableHTTPClient implements the request/response portion of the MCP
// Streamable HTTP transport. It retains only the opaque MCP transport session
// identifier returned by the server; account credentials stay in the host
// authorizer and are loaded for each request.
type StreamableHTTPClient struct {
	endpoint     *url.URL
	allowedHosts map[string]struct{}
	httpClient   *http.Client
	authorize    RequestAuthorizer
	timeout      time.Duration
	maxResponse  int64

	mu        sync.Mutex
	nextID    int64
	sessionID string
	closed    bool
}

func NewStreamableHTTPClient(config StreamableHTTPClientConfig) (*StreamableHTTPClient, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return nil, errors.New("MCP Streamable HTTP endpoint is invalid")
	}
	allowed := make(map[string]struct{}, len(config.AllowedHosts))
	for _, value := range config.AllowedHosts {
		host := strings.ToLower(strings.TrimSpace(value))
		if host != "" {
			allowed[host] = struct{}{}
		}
	}
	if _, ok := allowed[strings.ToLower(endpoint.Hostname())]; !ok {
		return nil, errors.New("MCP Streamable HTTP endpoint host is not allowed")
	}
	if config.Timeout <= 0 {
		config.Timeout = 30 * time.Second
	}
	if config.MaxResponseBytes <= 0 {
		config.MaxResponseBytes = defaultMaxMessageBytes
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{}
	} else {
		copy := *client
		client = &copy
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &StreamableHTTPClient{
		endpoint: endpoint, allowedHosts: allowed, httpClient: client,
		authorize: config.AuthorizeRequest, timeout: config.Timeout,
		maxResponse: int64(config.MaxResponseBytes),
	}, nil
}

func (client *StreamableHTTPClient) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return nil, errors.New("MCP Streamable HTTP client is closed")
	}
	client.nextID++
	id := client.nextID
	client.mu.Unlock()

	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	})
	if err != nil {
		return nil, err
	}
	response, err := client.do(ctx, http.MethodPost, payload)
	if err != nil {
		return nil, err
	}
	messages, err := decodeStreamableHTTPMessages(response.contentType, response.body)
	if err != nil {
		return nil, err
	}
	for _, message := range messages {
		if message.ID != nil && string(message.ID) == strconv.FormatInt(id, 10) {
			if message.Error != nil {
				return nil, message.Error
			}
			return message.Result, nil
		}
	}
	return nil, errors.New("MCP Streamable HTTP response did not contain the matching request id")
}

func (client *StreamableHTTPClient) Notify(ctx context.Context, method string, params any) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": method, "params": params,
	})
	if err != nil {
		return err
	}
	_, err = client.do(ctx, http.MethodPost, payload)
	return err
}

func (client *StreamableHTTPClient) Close(ctx context.Context) error {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return nil
	}
	client.closed = true
	hasSession := client.sessionID != ""
	client.mu.Unlock()
	if !hasSession {
		return nil
	}
	_, err := client.doAllowClosed(ctx, http.MethodDelete, nil)
	return err
}

type streamableHTTPResponse struct {
	contentType string
	body        []byte
}

func (client *StreamableHTTPClient) do(ctx context.Context, method string, payload []byte) (streamableHTTPResponse, error) {
	client.mu.Lock()
	closed := client.closed
	client.mu.Unlock()
	if closed {
		return streamableHTTPResponse{}, errors.New("MCP Streamable HTTP client is closed")
	}
	return client.doAllowClosed(ctx, method, payload)
}

func (client *StreamableHTTPClient) doAllowClosed(ctx context.Context, method string, payload []byte) (streamableHTTPResponse, error) {
	requestContext, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, method, client.endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return streamableHTTPResponse{}, err
	}
	request.Header.Set("Accept", "application/json, text/event-stream")
	if method == http.MethodPost {
		request.Header.Set("Content-Type", "application/json")
	}
	client.mu.Lock()
	sessionID := client.sessionID
	client.mu.Unlock()
	if sessionID != "" {
		request.Header.Set("Mcp-Session-Id", sessionID)
	}
	if client.authorize != nil {
		if err := client.authorize(request); err != nil {
			return streamableHTTPResponse{}, err
		}
	}
	if _, ok := client.allowedHosts[strings.ToLower(request.URL.Hostname())]; !ok {
		return streamableHTTPResponse{}, errors.New("MCP Streamable HTTP request host is not allowed")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return streamableHTTPResponse{}, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode <= 399 {
		return streamableHTTPResponse{}, fmt.Errorf("MCP Streamable HTTP redirect is forbidden: status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, client.maxResponse+1))
	if err != nil {
		return streamableHTTPResponse{}, err
	}
	if int64(len(body)) > client.maxResponse {
		return streamableHTTPResponse{}, fmt.Errorf("MCP Streamable HTTP response exceeds limit %d", client.maxResponse)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return streamableHTTPResponse{}, fmt.Errorf("MCP Streamable HTTP request failed: status %d", response.StatusCode)
	}
	if nextSession := strings.TrimSpace(response.Header.Get("Mcp-Session-Id")); nextSession != "" {
		client.mu.Lock()
		client.sessionID = nextSession
		client.mu.Unlock()
	}
	contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	return streamableHTTPResponse{contentType: contentType, body: body}, nil
}

type streamableRPCMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

func decodeStreamableHTTPMessages(contentType string, payload []byte) ([]streamableRPCMessage, error) {
	if len(bytes.TrimSpace(payload)) == 0 {
		return nil, nil
	}
	switch contentType {
	case "application/json", "":
		var message streamableRPCMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return nil, fmt.Errorf("decode MCP Streamable HTTP JSON response: %w", err)
		}
		return []streamableRPCMessage{message}, nil
	case "text/event-stream":
		var messages []streamableRPCMessage
		for _, event := range bytes.Split(payload, []byte("\n\n")) {
			var data []byte
			for _, line := range bytes.Split(event, []byte("\n")) {
				if bytes.HasPrefix(line, []byte("data:")) {
					part := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
					data = append(data, part...)
				}
			}
			if len(data) == 0 {
				continue
			}
			var message streamableRPCMessage
			if err := json.Unmarshal(data, &message); err != nil {
				return nil, fmt.Errorf("decode MCP Streamable HTTP SSE response: %w", err)
			}
			messages = append(messages, message)
		}
		return messages, nil
	default:
		return nil, fmt.Errorf("MCP Streamable HTTP response content type %q is unsupported", contentType)
	}
}
