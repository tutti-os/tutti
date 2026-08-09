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

	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	eventsgenerated "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
)

const (
	ApplicationProtocolEpoch    = 1
	AgentHTTPService            = "agent_http"
	AgentLiveService            = "agent_live"
	AgentLiveSubscribeMethod    = "SUBSCRIBE"
	maxRemoteRequestBodyBytes   = 8 << 20
	maxRemoteResponseBodyBytes  = 16 << 20
	remoteFrameEnvelopeBytes    = 1 << 20
	maxRemoteRequestFrameBytes  = ((maxRemoteRequestBodyBytes + 2) / 3 * 4) + remoteFrameEnvelopeBytes
	maxRemoteResponseFrameBytes = ((maxRemoteResponseBodyBytes + 2) / 3 * 4) +
		remoteFrameEnvelopeBytes
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
	return serveRemoteStreamWithAgentLive(ctx, stream, handler, "", nil)
}

func serveRemoteStreamWithAgentLive(
	ctx context.Context,
	stream net.Conn,
	handler http.Handler,
	bindingID string,
	liveEvents AgentLiveEventSource,
) error {
	defer stream.Close()
	var request RemoteRequest
	if err := readRemoteFrame(stream, maxRemoteRequestFrameBytes, &request); err != nil {
		return err
	}
	if strings.TrimSpace(request.Service) == AgentLiveService {
		return serveAgentLiveStream(ctx, stream, request, bindingID, liveEvents)
	}
	response := executeRemoteRequest(ctx, handler, request)
	return writeRemoteFrame(stream, response)
}

type agentLiveSubscribeRequest struct {
	ProtocolRevision string `json:"protocolRevision"`
	WorkspaceID      string `json:"workspaceId"`
	Epoch            uint64 `json:"epoch,omitempty"`
	AfterSeq         uint64 `json:"afterSeq,omitempty"`
}

func serveAgentLiveStream(
	ctx context.Context,
	stream net.Conn,
	request RemoteRequest,
	bindingID string,
	liveEvents AgentLiveEventSource,
) error {
	subscription, err := validateAgentLiveSubscription(request, bindingID, liveEvents)
	if err != nil {
		return err
	}
	streamID := "device-link:" + strings.TrimSpace(request.RequestID)
	publisher, err := liveprotocol.NewPublisher(liveprotocol.PublisherConfig{
		StreamID:  streamID,
		BindingID: strings.TrimSpace(bindingID),
		Epoch:     1,
	})
	if err != nil {
		return err
	}
	if subscription.ProtocolRevision != liveprotocol.ProtocolRevision {
		return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
			Rejected: &liveprotocol.Rejected{
				Reason:           liveprotocol.RejectionProtocolRevisionMismatch,
				ExpectedRevision: liveprotocol.ProtocolRevision,
				ReceivedRevision: subscription.ProtocolRevision,
			},
			Immediate: true,
		})
	}
	liveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		var probe [1]byte
		_, _ = stream.Read(probe[:])
		cancel()
	}()
	return liveEvents.StreamAgentActivity(
		liveCtx,
		subscription.WorkspaceID,
		func() error {
			if err := publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
				StreamReady: &liveprotocol.StreamReady{
					ProtocolRevision: liveprotocol.ProtocolRevision,
					StreamID:         streamID,
					BindingID:        strings.TrimSpace(bindingID),
				},
				Immediate: true,
			}); err != nil {
				return err
			}
			if subscription.Epoch == 0 && subscription.AfterSeq == 0 {
				return nil
			}
			return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
				Discontinuity: &liveprotocol.Discontinuity{
					Reason: "resume_miss",
					ReconcileKeys: []liveprotocol.ReconcileKey{{
						Kind:        "workspace",
						WorkspaceID: subscription.WorkspaceID,
					}},
				},
				Immediate: true,
			})
		},
		func(payload []byte) error {
			return publishAgentActivityEnvelope(
				stream,
				publisher,
				subscription.WorkspaceID,
				payload,
			)
		},
	)
}

func validateAgentLiveSubscription(
	request RemoteRequest,
	bindingID string,
	liveEvents AgentLiveEventSource,
) (agentLiveSubscribeRequest, error) {
	if request.ProtocolEpoch != ApplicationProtocolEpoch {
		return agentLiveSubscribeRequest{}, fmt.Errorf("agent live protocol epoch mismatch")
	}
	if strings.TrimSpace(request.RequestID) == "" ||
		strings.ToUpper(strings.TrimSpace(request.Method)) != AgentLiveSubscribeMethod ||
		strings.TrimSpace(bindingID) == "" {
		return agentLiveSubscribeRequest{}, fmt.Errorf("invalid agent live subscription")
	}
	if liveEvents == nil {
		return agentLiveSubscribeRequest{}, fmt.Errorf("agent live event source is unavailable")
	}
	var subscription agentLiveSubscribeRequest
	decoder := json.NewDecoder(bytes.NewReader(request.Body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&subscription); err != nil {
		return agentLiveSubscribeRequest{}, fmt.Errorf("decode agent live subscription: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return agentLiveSubscribeRequest{}, errors.New("agent live subscription contains trailing data")
	}
	subscription.ProtocolRevision = strings.TrimSpace(subscription.ProtocolRevision)
	subscription.WorkspaceID = strings.TrimSpace(subscription.WorkspaceID)
	if subscription.ProtocolRevision == "" || subscription.WorkspaceID == "" {
		return agentLiveSubscribeRequest{}, fmt.Errorf("agent live subscription identity is required")
	}
	expectedPath := "/v1/workspaces/" + url.PathEscape(subscription.WorkspaceID) + "/agent-live"
	if strings.TrimSpace(request.Path) != expectedPath {
		return agentLiveSubscribeRequest{}, fmt.Errorf("agent live subscription path is invalid")
	}
	return subscription, nil
}

func publishAgentActivityEnvelope(
	stream net.Conn,
	publisher *liveprotocol.Publisher,
	workspaceID string,
	payload []byte,
) error {
	var envelope eventsgenerated.AgentActivityUpdatedPayload
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
			Discontinuity: &liveprotocol.Discontinuity{Reason: "invalid_event"},
			Immediate:     true,
		})
	}
	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &rawFields); err != nil {
		return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
			Discontinuity: &liveprotocol.Discontinuity{Reason: "invalid_event"},
			Immediate:     true,
		})
	}
	envelope.WorkspaceId = strings.TrimSpace(envelope.WorkspaceId)
	envelope.AgentSessionId = strings.TrimSpace(envelope.AgentSessionId)
	envelope.EventType = strings.TrimSpace(envelope.EventType)
	if envelope.WorkspaceId != strings.TrimSpace(workspaceID) {
		return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
			Discontinuity: &liveprotocol.Discontinuity{
				Reason: "scope_mismatch",
				ReconcileKeys: []liveprotocol.ReconcileKey{{
					Kind:        "workspace",
					WorkspaceID: strings.TrimSpace(workspaceID),
				}},
			},
			Immediate: true,
		})
	}
	event := liveprotocol.Event{
		WorkspaceID:    envelope.WorkspaceId,
		AgentSessionID: envelope.AgentSessionId,
		EventType:      liveprotocol.EventType(envelope.EventType),
		Data:           rawFields["data"],
	}
	if _, err := liveprotocol.MarshalEvent(event); err == nil {
		return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
			Event:     &event,
			Immediate: true,
		})
	}
	reconcileKeys := make([]liveprotocol.ReconcileKey, 0, 1)
	if envelope.WorkspaceId != "" || envelope.AgentSessionId != "" {
		reconcileKeys = append(reconcileKeys, liveprotocol.ReconcileKey{
			Kind:           "session",
			WorkspaceID:    envelope.WorkspaceId,
			AgentSessionID: envelope.AgentSessionId,
		})
	}
	reason := "canonical_update"
	if envelope.EventType == "session_deleted" || envelope.EventType == "session_restored" {
		var lifecycleIdentity struct {
			WorkspaceID    string `json:"workspaceId"`
			AgentSessionID string `json:"agentSessionId"`
			EventType      string `json:"eventType"`
		}
		if err := json.Unmarshal(rawFields["data"], &lifecycleIdentity); err != nil ||
			strings.TrimSpace(lifecycleIdentity.WorkspaceID) != envelope.WorkspaceId ||
			strings.TrimSpace(lifecycleIdentity.AgentSessionID) != envelope.AgentSessionId ||
			strings.TrimSpace(lifecycleIdentity.EventType) != envelope.EventType {
			return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
				Discontinuity: &liveprotocol.Discontinuity{Reason: "invalid_event"},
				Immediate:     true,
			})
		}
		reason = envelope.EventType
	}
	return publishAgentLiveInput(stream, publisher, liveprotocol.PublishInput{
		Discontinuity: &liveprotocol.Discontinuity{
			Reason:        reason,
			ReconcileKeys: reconcileKeys,
		},
		Immediate: true,
	})
}

func publishAgentLiveInput(
	stream net.Conn,
	publisher *liveprotocol.Publisher,
	input liveprotocol.PublishInput,
) error {
	frames, err := publisher.Publish(input)
	if err != nil {
		return err
	}
	for _, frame := range frames {
		encoded, err := liveprotocol.EncodeFrame(frame)
		if err != nil {
			return err
		}
		if err := writeBinaryFrame(stream, encoded); err != nil {
			return err
		}
	}
	return nil
}

func writeBinaryFrame(writer io.Writer, payload []byte) error {
	if len(payload) == 0 || len(payload) > liveprotocol.DefaultFrameMaxBytes {
		return fmt.Errorf("agent live frame size %d is invalid", len(payload))
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(payload)))
	if _, err := writer.Write(size[:]); err != nil {
		return fmt.Errorf("write agent live frame size: %w", err)
	}
	if _, err := writer.Write(payload); err != nil {
		return fmt.Errorf("write agent live frame: %w", err)
	}
	return nil
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
	if len(request.Body) > maxRemoteRequestBodyBytes {
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
	body, readErr := io.ReadAll(io.LimitReader(result.Body, maxRemoteResponseBodyBytes+1))
	if readErr != nil {
		response.Status = http.StatusInternalServerError
		response.ErrorCode = "response_read_failed"
		return response
	}
	if len(body) > maxRemoteResponseBodyBytes {
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
	if len(segments) == 3 &&
		segments[0] == "v1" &&
		segments[1] == "preferences" &&
		segments[2] == "desktop" {
		return method == http.MethodGet
	}
	if len(segments) == 2 &&
		segments[0] == "v1" &&
		segments[1] == "agent-quick-prompts" {
		return method == http.MethodGet
	}
	if len(segments) == 2 && segments[0] == "v1" && segments[1] == "user-projects" {
		return method == http.MethodGet
	}
	if len(segments) == 2 && segments[0] == "v1" && segments[1] == "agent-targets" {
		return method == http.MethodGet
	}
	if len(segments) == 4 &&
		segments[0] == "v1" &&
		segments[1] == "agent-providers" &&
		strings.TrimSpace(segments[2]) != "" &&
		segments[3] == "composer-options" {
		return method == http.MethodPost
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
	if len(raw) > maxRemoteResponseFrameBytes {
		return fmt.Errorf("mobile remote frame exceeds %d bytes", maxRemoteResponseFrameBytes)
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
