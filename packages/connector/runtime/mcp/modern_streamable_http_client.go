package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const ModernProtocolVersion = "2026-07-28"

var modernHeaderNamePattern = regexp.MustCompile(`^[!#$%&'*+\-.^_` + "`" + `|~0-9A-Za-z]+$`)

type ModernStreamableHTTPClientConfig struct {
	Endpoint         string
	AllowedHosts     []string
	ConnectorVersion string
	ClientName       string
	ClientVersion    string
	HTTPClient       *http.Client
	AuthorizeRequest RequestAuthorizer
	Timeout          time.Duration
	MaxResponseBytes int
}

// ModernStreamableHTTPClient implements the stateless MCP 2026-07-28
// Streamable HTTP transport. Every JSON-RPC request is a separate HTTP POST;
// the client never creates or retains protocol-level transport sessions.
type ModernStreamableHTTPClient struct {
	endpoint         *url.URL
	allowedHosts     map[string]struct{}
	connectorVersion string
	clientName       string
	clientVersion    string
	httpClient       *http.Client
	authorize        RequestAuthorizer
	timeout          time.Duration
	maxResponse      int64

	mu          sync.RWMutex
	nextID      int64
	closed      bool
	toolHeaders map[string][]modernToolHeader
}

type modernToolHeader struct {
	name string
	path []string
	kind string
}

type ModernHTTPError struct {
	StatusCode int
	Body       []byte
	Cause      error
}

func (err *ModernHTTPError) Error() string {
	return fmt.Sprintf("MCP Streamable HTTP request failed: status %d", err.StatusCode)
}

func (err *ModernHTTPError) Unwrap() error { return err.Cause }

func NewModernStreamableHTTPClient(config ModernStreamableHTTPClientConfig) (*ModernStreamableHTTPClient, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || !modernMCPEndpointSchemeAllowed(endpoint) || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return nil, errors.New("modern MCP Streamable HTTP endpoint is invalid")
	}
	allowed := make(map[string]struct{}, len(config.AllowedHosts))
	for _, value := range config.AllowedHosts {
		host := strings.ToLower(strings.TrimSpace(value))
		if host != "" {
			allowed[host] = struct{}{}
		}
	}
	if _, ok := allowed[strings.ToLower(endpoint.Hostname())]; !ok {
		return nil, errors.New("modern MCP Streamable HTTP endpoint host is not allowed")
	}
	connectorVersion := strings.TrimSpace(config.ConnectorVersion)
	if connectorVersion == "" {
		return nil, errors.New("modern MCP Connector version is required")
	}
	if config.Timeout <= 0 {
		config.Timeout = 30 * time.Second
	}
	if config.MaxResponseBytes <= 0 {
		config.MaxResponseBytes = defaultMaxMessageBytes
	}
	clientName := strings.TrimSpace(config.ClientName)
	if clientName == "" {
		clientName = "tutti-connector-host"
	}
	clientVersion := strings.TrimSpace(config.ClientVersion)
	if clientVersion == "" {
		clientVersion = "1"
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	} else {
		copy := *httpClient
		httpClient = &copy
	}
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return &ModernStreamableHTTPClient{
		endpoint: endpoint, allowedHosts: allowed, connectorVersion: connectorVersion,
		clientName: clientName, clientVersion: clientVersion, httpClient: httpClient,
		authorize: config.AuthorizeRequest, timeout: config.Timeout, maxResponse: int64(config.MaxResponseBytes),
		toolHeaders: make(map[string][]modernToolHeader),
	}, nil
}

func modernMCPEndpointSchemeAllowed(endpoint *url.URL) bool {
	if endpoint == nil {
		return false
	}
	if endpoint.Scheme == "https" {
		return true
	}
	host := strings.ToLower(endpoint.Hostname())
	if endpoint.Scheme != "http" || (host != "localhost" && net.ParseIP(host) == nil) {
		return false
	}
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}

// RegisterTool records the schema metadata required to mirror x-mcp-header
// arguments on later tools/call requests. An invalid annotation rejects only
// that Tool, as required by the modern HTTP transport.
func (client *ModernStreamableHTTPClient) RegisterTool(name string, schema map[string]any) error {
	name = strings.TrimSpace(name)
	if name == "" || schema == nil {
		return errors.New("modern MCP Tool schema is invalid")
	}
	headers, err := collectModernToolHeaders(schema)
	if err != nil {
		return err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closed {
		return errors.New("modern MCP Streamable HTTP client is closed")
	}
	client.toolHeaders[name] = headers
	return nil
}

// ReplaceTools atomically replaces all tool-derived header bindings. A live
// tools/list can therefore remove tools or change x-mcp-header annotations
// without retaining stale metadata from route bootstrap.
func (client *ModernStreamableHTTPClient) ReplaceTools(schemas map[string]map[string]any) error {
	replacement := make(map[string][]modernToolHeader, len(schemas))
	for name, schema := range schemas {
		name = strings.TrimSpace(name)
		if name == "" || schema == nil {
			return errors.New("modern MCP Tool schema is invalid")
		}
		headers, err := collectModernToolHeaders(schema)
		if err != nil {
			return err
		}
		replacement[name] = headers
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closed {
		return errors.New("modern MCP Streamable HTTP client is closed")
	}
	client.toolHeaders = replacement
	return nil
}

func (client *ModernStreamableHTTPClient) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	method = strings.TrimSpace(method)
	if method == "" {
		return nil, errors.New("modern MCP method is required")
	}
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return nil, errors.New("modern MCP Streamable HTTP client is closed")
	}
	client.nextID++
	id := client.nextID
	client.mu.Unlock()

	requestParams, err := modernRequestParams(params)
	if err != nil {
		return nil, err
	}
	requestParams["_meta"] = map[string]any{
		"io.modelcontextprotocol/protocolVersion":    ModernProtocolVersion,
		"io.modelcontextprotocol/clientInfo":         map[string]any{"name": client.clientName, "version": client.clientVersion},
		"io.modelcontextprotocol/clientCapabilities": map[string]any{},
		"sh.tutti/connectorVersion":                  client.connectorVersion,
	}
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": requestParams})
	if err != nil {
		return nil, err
	}
	requestContext, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, client.endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", ModernProtocolVersion)
	request.Header.Set("Mcp-Method", method)
	request.Header.Set("Tutti-Connector-Version", client.connectorVersion)
	if err := client.applyMethodHeaders(request, method, requestParams); err != nil {
		return nil, err
	}
	if client.authorize != nil {
		if err := client.authorize(request); err != nil {
			return nil, err
		}
	}
	if _, ok := client.allowedHosts[strings.ToLower(request.URL.Hostname())]; !ok {
		return nil, errors.New("modern MCP Streamable HTTP request host is not allowed")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode <= 399 {
		return nil, fmt.Errorf("modern MCP Streamable HTTP redirect is forbidden: status %d", response.StatusCode)
	}
	contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, readErr := readModernRawResponse(response.Body, client.maxResponse)
		httpErr := &ModernHTTPError{StatusCode: response.StatusCode, Body: raw, Cause: readErr}
		if readErr == nil && (contentType == "application/json" || contentType == "" || contentType == "text/event-stream") {
			message, _, decodeErr := readModernResponse(bytes.NewReader(raw), contentType, id, int64(len(raw)))
			switch {
			case decodeErr != nil:
				httpErr.Cause = decodeErr
			case message != nil && message.Error != nil:
				httpErr.Cause = message.Error
			}
		}
		return nil, httpErr
	}
	message, _, err := readModernResponse(response.Body, contentType, id, client.maxResponse)
	if err != nil {
		return nil, err
	}
	if message != nil && message.Error != nil {
		return nil, message.Error
	}
	if message == nil {
		return nil, errors.New("modern MCP Streamable HTTP response did not contain the matching request id")
	}
	return message.Result, nil
}

func readModernRawResponse(body io.Reader, limit int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return raw, err
	}
	if int64(len(raw)) > limit {
		return raw[:limit], fmt.Errorf("modern MCP Streamable HTTP response exceeds limit %d", limit)
	}
	return raw, nil
}

func (client *ModernStreamableHTTPClient) Close(context.Context) error {
	client.mu.Lock()
	client.closed = true
	client.mu.Unlock()
	return nil
}

func (client *ModernStreamableHTTPClient) applyMethodHeaders(request *http.Request, method string, params map[string]any) error {
	if method != "tools/call" {
		return nil
	}
	name, ok := params["name"].(string)
	name = strings.TrimSpace(name)
	if !ok || name == "" {
		return errors.New("modern MCP tools/call name is required")
	}
	request.Header.Set("Mcp-Name", encodeModernHeaderValue(name))
	client.mu.RLock()
	headers, registered := client.toolHeaders[name]
	client.mu.RUnlock()
	if !registered {
		return fmt.Errorf("modern MCP Tool %q is not registered", name)
	}
	arguments, _ := params["arguments"].(map[string]any)
	for _, binding := range headers {
		value, exists := nestedModernValue(arguments, binding.path)
		if !exists || value == nil {
			continue
		}
		text, err := modernPrimitiveHeaderValue(value, binding.kind)
		if err != nil {
			return fmt.Errorf("modern MCP Tool %q header %q: %w", name, binding.name, err)
		}
		request.Header.Set("Mcp-Param-"+binding.name, encodeModernHeaderValue(text))
	}
	return nil
}

func modernRequestParams(params any) (map[string]any, error) {
	if params == nil {
		return map[string]any{}, nil
	}
	payload, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(payload, &result); err != nil || result == nil {
		return nil, errors.New("modern MCP request params must be an object")
	}
	return result, nil
}

func collectModernToolHeaders(schema map[string]any) ([]modernToolHeader, error) {
	seen := map[string]struct{}{}
	var result []modernToolHeader
	var walk func(map[string]any, []string, bool) error
	walk = func(node map[string]any, path []string, reachable bool) error {
		if raw, exists := node["x-mcp-header"]; exists {
			name, ok := raw.(string)
			kind, _ := node["type"].(string)
			key := strings.ToLower(name)
			if !ok || !reachable || name == "" || !modernHeaderNamePattern.MatchString(name) ||
				(kind != "string" && kind != "integer" && kind != "boolean") {
				return errors.New("modern MCP x-mcp-header annotation is invalid")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("modern MCP x-mcp-header names must be unique")
			}
			seen[key] = struct{}{}
			result = append(result, modernToolHeader{name: name, path: append([]string(nil), path...), kind: kind})
		}
		for key, raw := range node {
			if key == "properties" {
				properties, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				for propertyName, propertyRaw := range properties {
					property, ok := propertyRaw.(map[string]any)
					if ok {
						if err := walk(property, append(path, propertyName), reachable); err != nil {
							return err
						}
					}
				}
				continue
			}
			if key == "x-mcp-header" {
				continue
			}
			if child, ok := raw.(map[string]any); ok {
				if err := walk(child, path, false); err != nil {
					return err
				}
			}
			if children, ok := raw.([]any); ok {
				for _, childRaw := range children {
					if child, ok := childRaw.(map[string]any); ok {
						if err := walk(child, path, false); err != nil {
							return err
						}
					}
				}
			}
		}
		return nil
	}
	if err := walk(schema, nil, true); err != nil {
		return nil, err
	}
	return result, nil
}

func nestedModernValue(arguments map[string]any, path []string) (any, bool) {
	var current any = arguments
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[key]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func modernPrimitiveHeaderValue(value any, kind string) (string, error) {
	switch kind {
	case "string":
		result, ok := value.(string)
		if !ok {
			return "", errors.New("value is not a string")
		}
		return result, nil
	case "boolean":
		result, ok := value.(bool)
		if !ok {
			return "", errors.New("value is not a boolean")
		}
		return strconv.FormatBool(result), nil
	case "integer":
		result, ok := value.(float64)
		if !ok || result != math.Trunc(result) || math.Abs(result) > 9007199254740991 {
			return "", errors.New("value is not a safe integer")
		}
		return strconv.FormatInt(int64(result), 10), nil
	default:
		return "", errors.New("unsupported primitive type")
	}
}

func encodeModernHeaderValue(value string) string {
	safe := value == strings.TrimSpace(value) && value != "" &&
		(!strings.HasPrefix(value, "=?base64?") || !strings.HasSuffix(value, "?="))
	for _, character := range []byte(value) {
		if character < 0x20 || character > 0x7e {
			safe = false
			break
		}
	}
	if safe {
		return value
	}
	return "=?base64?" + base64.StdEncoding.EncodeToString([]byte(value)) + "?="
}

func readModernResponse(body io.Reader, contentType string, id int64, limit int64) (*streamableRPCMessage, []byte, error) {
	switch contentType {
	case "application/json", "":
		raw, err := io.ReadAll(io.LimitReader(body, limit+1))
		if err != nil {
			return nil, nil, err
		}
		if int64(len(raw)) > limit {
			return nil, nil, fmt.Errorf("modern MCP Streamable HTTP response exceeds limit %d", limit)
		}
		var message streamableRPCMessage
		if err := json.Unmarshal(raw, &message); err != nil {
			return nil, raw, fmt.Errorf("decode modern MCP JSON response: %w", err)
		}
		if message.ID != nil && string(message.ID) == strconv.FormatInt(id, 10) {
			return &message, raw, nil
		}
		return nil, raw, nil
	case "text/event-stream":
		reader := bufio.NewReader(body)
		var total int64
		var raw bytes.Buffer
		var data bytes.Buffer
		for {
			line, err := reader.ReadString('\n')
			total += int64(len(line))
			if total > limit {
				return nil, raw.Bytes(), fmt.Errorf("modern MCP Streamable HTTP response exceeds limit %d", limit)
			}
			raw.WriteString(line)
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "data:") {
				if data.Len() != 0 {
					data.WriteByte('\n')
				}
				data.WriteString(strings.TrimSpace(strings.TrimPrefix(trimmed, "data:")))
			}
			if trimmed == "" || errors.Is(err, io.EOF) {
				if data.Len() != 0 {
					var message streamableRPCMessage
					if decodeErr := json.Unmarshal(data.Bytes(), &message); decodeErr != nil {
						return nil, raw.Bytes(), fmt.Errorf("decode modern MCP SSE response: %w", decodeErr)
					}
					if message.ID != nil && string(message.ID) == strconv.FormatInt(id, 10) {
						return &message, raw.Bytes(), nil
					}
					data.Reset()
				}
			}
			if errors.Is(err, io.EOF) {
				return nil, raw.Bytes(), nil
			}
			if err != nil {
				return nil, raw.Bytes(), err
			}
		}
	default:
		return nil, nil, fmt.Errorf("modern MCP Streamable HTTP response content type %q is unsupported", contentType)
	}
}
