package mobileremote

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
)

const (
	ApplicationProtocolEpoch = 1
	AgentHTTPService         = "agent_http"
	maxRemoteRequestBytes    = 8 << 20
	maxRemoteResponseBytes   = 16 << 20
	maxRemoteFrameBytes      = maxRemoteResponseBytes + (1 << 20)
)

type RemoteRequest struct {
	ProtocolEpoch int                 `json:"protocolEpoch"`
	Service       string              `json:"service"`
	RequestID     string              `json:"requestId"`
	Method        string              `json:"method"`
	Path          string              `json:"path"`
	Headers       map[string][]string `json:"headers,omitempty"`
	Body          []byte              `json:"body,omitempty"`
}

type RemoteResponse struct {
	ProtocolEpoch int                 `json:"protocolEpoch"`
	RequestID     string              `json:"requestId"`
	Status        int                 `json:"status"`
	Headers       map[string][]string `json:"headers,omitempty"`
	Body          []byte              `json:"body,omitempty"`
	ErrorCode     string              `json:"errorCode,omitempty"`
}

func serveRemoteStream(ctx context.Context, stream net.Conn, handler http.Handler) error {
	defer stream.Close()
	var request RemoteRequest
	if err := readRemoteFrame(stream, maxRemoteRequestBytes, &request); err != nil {
		return err
	}
	response := executeRemoteRequest(ctx, handler, request)
	return writeRemoteFrame(stream, response)
}

func executeRemoteRequest(ctx context.Context, handler http.Handler, request RemoteRequest) RemoteResponse {
	response := RemoteResponse{
		ProtocolEpoch: ApplicationProtocolEpoch,
		RequestID:     strings.TrimSpace(request.RequestID),
		Status:        http.StatusBadRequest,
	}
	if request.ProtocolEpoch != ApplicationProtocolEpoch {
		response.Status = http.StatusUpgradeRequired
		response.ErrorCode = "protocol_epoch_mismatch"
		return response
	}
	if strings.TrimSpace(request.Service) != AgentHTTPService || response.RequestID == "" {
		response.ErrorCode = "invalid_request"
		return response
	}
	method := strings.ToUpper(strings.TrimSpace(request.Method))
	parsedURL, err := url.ParseRequestURI(strings.TrimSpace(request.Path))
	if err != nil || parsedURL.IsAbs() || parsedURL.Host != "" || !remoteRouteAllowed(method, parsedURL.Path) {
		response.Status = http.StatusForbidden
		response.ErrorCode = "route_not_allowed"
		return response
	}
	if len(request.Body) > maxRemoteRequestBytes {
		response.Status = http.StatusRequestEntityTooLarge
		response.ErrorCode = "request_too_large"
		return response
	}
	if handler == nil {
		response.Status = http.StatusServiceUnavailable
		response.ErrorCode = "service_unavailable"
		return response
	}

	httpRequest := httptest.NewRequestWithContext(ctx, method, parsedURL.RequestURI(), bytes.NewReader(request.Body))
	copyRemoteRequestHeaders(httpRequest.Header, request.Headers)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httpRequest)
	result := recorder.Result()
	defer result.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(result.Body, maxRemoteResponseBytes+1))
	if readErr != nil {
		response.Status = http.StatusInternalServerError
		response.ErrorCode = "response_read_failed"
		return response
	}
	if len(body) > maxRemoteResponseBytes {
		response.Status = http.StatusInsufficientStorage
		response.ErrorCode = "response_too_large"
		return response
	}
	response.Status = result.StatusCode
	response.Headers = selectRemoteResponseHeaders(result.Header)
	response.Body = body
	return response
}

func remoteRouteAllowed(method, path string) bool {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) == 2 && segments[0] == "v1" && segments[1] == "agent-targets" {
		return method == http.MethodGet
	}
	if len(segments) == 2 && segments[0] == "v1" && segments[1] == "workspaces" {
		return method == http.MethodGet
	}
	if len(segments) < 3 || segments[0] != "v1" || segments[1] != "workspaces" ||
		strings.TrimSpace(segments[2]) == "" {
		return false
	}
	if len(segments) == 3 {
		return method == http.MethodGet
	}
	if len(segments) >= 4 && segments[3] == "agent-sessions" {
		switch method {
		case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			return true
		default:
			return false
		}
	}
	if len(segments) == 4 && segments[3] == "agent-session-sections" {
		return method == http.MethodGet
	}
	return false
}

func copyRemoteRequestHeaders(target http.Header, source map[string][]string) {
	headers := http.Header(source)
	for _, name := range []string{"Accept", "Content-Type", "Idempotency-Key", "X-Client-Submit-Id"} {
		for _, value := range headers.Values(name) {
			target.Add(name, value)
		}
	}
}

func selectRemoteResponseHeaders(source http.Header) map[string][]string {
	selected := make(map[string][]string)
	for _, name := range []string{"Content-Type", "ETag", "Retry-After"} {
		if values := source.Values(name); len(values) > 0 {
			selected[name] = append([]string(nil), values...)
		}
	}
	if len(selected) == 0 {
		return nil
	}
	return selected
}

func writeRemoteFrame(writer io.Writer, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode mobile remote frame: %w", err)
	}
	if len(raw) > maxRemoteFrameBytes {
		return fmt.Errorf("mobile remote frame exceeds %d bytes", maxRemoteFrameBytes)
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(raw)))
	if _, err := writer.Write(size[:]); err != nil {
		return fmt.Errorf("write mobile remote frame size: %w", err)
	}
	if _, err := writer.Write(raw); err != nil {
		return fmt.Errorf("write mobile remote frame: %w", err)
	}
	return nil
}

func readRemoteFrame(reader io.Reader, limit int, value any) error {
	buffered := bufio.NewReader(reader)
	var size [4]byte
	if _, err := io.ReadFull(buffered, size[:]); err != nil {
		return fmt.Errorf("read mobile remote frame size: %w", err)
	}
	length := int(binary.BigEndian.Uint32(size[:]))
	if length <= 0 || length > limit {
		return fmt.Errorf("mobile remote frame size %d exceeds limit %d", length, limit)
	}
	raw := make([]byte, length)
	if _, err := io.ReadFull(buffered, raw); err != nil {
		return fmt.Errorf("read mobile remote frame: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("decode mobile remote frame: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("mobile remote frame contains trailing data")
	}
	return nil
}
