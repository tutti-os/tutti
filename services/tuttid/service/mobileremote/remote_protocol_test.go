package mobileremote

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
)

func TestRemoteProtocolRoundTripsAllowedAgentRequest(t *testing.T) {
	t.Parallel()
	server, client := net.Pipe()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/workspaces/workspace-1/agent-sessions/session-1/input" {
			t.Fatalf("unexpected proxied request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("unexpected content type: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Private-Header", "must-not-cross")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	})
	done := make(chan error, 1)
	go func() {
		done <- serveRemoteStream(context.Background(), server, handler)
	}()

	request := RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch,
		Service:       AgentHTTPService,
		RequestID:     "request-1",
		Method:        http.MethodPost,
		Path:          "/v1/workspaces/workspace-1/agent-sessions/session-1/input",
		Headers:       map[string][]string{"Content-Type": {"application/json"}, "Authorization": {"secret"}},
		Body:          []byte(`{"text":"hello"}`),
	}
	if err := writeRemoteFrame(client, request); err != nil {
		t.Fatal(err)
	}
	var response RemoteResponse
	if err := readRemoteFrame(client, maxRemoteResponseFrameBytes, &response); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if response.Status != http.StatusAccepted || string(response.Body) != `{"accepted":true}` ||
		response.Headers["Content-Type"][0] != "application/json" || response.Headers["X-Private-Header"] != nil {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestRemoteProtocolRejectsRoutesOutsideAgentSurface(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/v1/workspaces/workspace-1/files/file?path=/secret"},
		{http.MethodPost, "/v1/workspaces/workspace-1/terminals"},
		{http.MethodGet, "/v1/account/session"},
		{http.MethodPut, "/v1/preferences/desktop"},
		{http.MethodPost, "/v1/agent-quick-prompts"},
		{http.MethodGet, "/v1/agent-quick-prompts/prompt-1"},
		{http.MethodGet, "/v1/agent-providers/codex/composer-options"},
		{http.MethodPost, "/v1/agent-providers/codex/composer-options/extra"},
		{http.MethodPost, "https://example.com/v1/workspaces/workspace-1/agent-sessions"},
	} {
		response := executeRemoteRequest(context.Background(), http.NotFoundHandler(), RemoteRequest{
			ProtocolEpoch: ApplicationProtocolEpoch, Service: AgentHTTPService, RequestID: "request-1",
			Method: test.method, Path: test.path,
		})
		if response.Status != http.StatusForbidden || response.ErrorCode != "route_not_allowed" {
			t.Fatalf("%s %s unexpectedly allowed: %+v", test.method, test.path, response)
		}
	}
}

func TestRemoteProtocolAllowsAgentComposerOptions(t *testing.T) {
	t.Parallel()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/agent-providers/codex/composer-options" {
			t.Fatalf("unexpected proxied request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("unexpected content type: %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != `{"agentTargetId":"local:codex","workspaceId":"workspace-1"}` {
			t.Fatalf("unexpected request body: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"provider":"codex"}`))
	})
	response := executeRemoteRequest(context.Background(), handler, RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch,
		Service:       AgentHTTPService,
		RequestID:     "request-1",
		Method:        http.MethodPost,
		Path:          "/v1/agent-providers/codex/composer-options",
		Headers:       map[string][]string{"Content-Type": {"application/json"}},
		Body:          []byte(`{"agentTargetId":"local:codex","workspaceId":"workspace-1"}`),
	})
	if response.Status != http.StatusOK || string(response.Body) != `{"provider":"codex"}` {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestRemoteProtocolFailsFastOnEpochMismatch(t *testing.T) {
	t.Parallel()
	response := executeRemoteRequest(context.Background(), http.NotFoundHandler(), RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch + 1, Service: AgentHTTPService,
		RequestID: "request-1", Method: http.MethodGet, Path: "/v1/workspaces",
	})
	if response.Status != http.StatusUpgradeRequired || response.ErrorCode != "protocol_epoch_mismatch" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestRemoteProtocolRejectsOversizedFrameBeforeAllocation(t *testing.T) {
	t.Parallel()
	var raw bytes.Buffer
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(maxRemoteRequestFrameBytes+1))
	raw.Write(size[:])
	var value map[string]any
	if err := readRemoteFrame(&raw, maxRemoteRequestFrameBytes, &value); err == nil {
		t.Fatal("expected oversized frame rejection")
	}
}

func TestRemoteProtocolPreservesQueryString(t *testing.T) {
	t.Parallel()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "20" {
			t.Fatalf("query string was not preserved: %s", r.URL.RawQuery)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	response := executeRemoteRequest(context.Background(), handler, RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch, Service: AgentHTTPService,
		RequestID: "request-1", Method: http.MethodGet,
		Path: "/v1/workspaces/workspace-1/agent-sessions?limit=20",
	})
	if response.Status != http.StatusNoContent {
		encoded, _ := json.Marshal(response)
		t.Fatalf("unexpected response: %s", encoded)
	}
}

func TestRemoteProtocolAllowsReadOnlyAgentTargetCatalog(t *testing.T) {
	t.Parallel()
	response := executeRemoteRequest(context.Background(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-targets" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}), RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch, Service: AgentHTTPService,
		RequestID: "request-1", Method: http.MethodGet, Path: "/v1/agent-targets",
	})
	if response.Status != http.StatusNoContent {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestRemoteProtocolAllowsReadOnlyQuickPromptCapability(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"/v1/preferences/desktop",
		"/v1/agent-quick-prompts",
	} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			response := executeRemoteRequest(
				context.Background(),
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet || r.URL.Path != path {
						t.Fatalf("unexpected proxied request: %s %s", r.Method, r.URL.Path)
					}
					w.WriteHeader(http.StatusNoContent)
				}),
				RemoteRequest{
					ProtocolEpoch: ApplicationProtocolEpoch,
					Service:       AgentHTTPService,
					RequestID:     "request-quick-prompts",
					Method:        http.MethodGet,
					Path:          path,
				},
			)
			if response.Status != http.StatusNoContent {
				t.Fatalf("unexpected response: %+v", response)
			}
		})
	}
}

func TestRemoteProtocolStreamHonorsCanceledContext(t *testing.T) {
	t.Parallel()
	server, client := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	requestContextErr := make(chan error, 1)
	go func() {
		done <- serveRemoteStream(ctx, server, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestContextErr <- r.Context().Err()
			w.WriteHeader(http.StatusServiceUnavailable)
		}))
	}()
	_ = client.SetDeadline(time.Now().Add(time.Second))
	if err := writeRemoteFrame(client, RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch, Service: AgentHTTPService,
		RequestID: "request-1", Method: http.MethodGet, Path: "/v1/workspaces",
	}); err != nil {
		t.Fatal(err)
	}
	var response RemoteResponse
	if err := readRemoteFrame(client, maxRemoteResponseFrameBytes, &response); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-requestContextErr; err == nil {
		t.Fatal("expected canceled request context")
	}
}

type stubAgentLiveEventSource struct {
	payloads [][]byte
}

func (s stubAgentLiveEventSource) StreamAgentActivity(
	ctx context.Context,
	_ string,
	ready func() error,
	emit func([]byte) error,
) error {
	if err := ready(); err != nil {
		return err
	}
	for _, payload := range s.payloads {
		if err := emit(payload); err != nil {
			return err
		}
	}
	<-ctx.Done()
	return nil
}

func TestRemoteProtocolStreamsValidatedAgentLiveFrames(t *testing.T) {
	t.Parallel()
	server, client := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- serveRemoteStreamWithAgentLive(
			context.Background(),
			server,
			http.NotFoundHandler(),
			"pairing-1",
			stubAgentLiveEventSource{payloads: [][]byte{[]byte(`{
				"workspaceId":"workspace-1",
				"agentSessionId":"session-1",
				"eventType":"message_delta",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"session-1",
					"messageId":"message-1",
					"turnId":"turn-1",
					"role":"assistant",
					"kind":"text",
					"occurredAtUnixMs":10,
					"content":{"operation":"set","value":"hello"}
				}
			}`)}},
		)
	}()
	body, err := json.Marshal(agentLiveSubscribeRequest{
		ProtocolRevision: liveprotocol.ProtocolRevision,
		WorkspaceID:      "workspace-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemoteFrame(client, RemoteRequest{
		ProtocolEpoch: ApplicationProtocolEpoch,
		Service:       AgentLiveService,
		RequestID:     "request-live-1",
		Method:        AgentLiveSubscribeMethod,
		Path:          "/v1/workspaces/workspace-1/agent-live",
		Body:          body,
	}); err != nil {
		t.Fatal(err)
	}
	ready := readAgentLiveTestFrame(t, client)
	if len(ready.Deliveries) != 1 ||
		ready.Deliveries[0].Kind != liveprotocol.DeliveryKindStreamReady ||
		ready.BindingID != "pairing-1" {
		t.Fatalf("unexpected ready frame: %+v", ready)
	}
	eventFrame := readAgentLiveTestFrame(t, client)
	if len(eventFrame.Deliveries) != 1 ||
		eventFrame.Deliveries[0].Kind != liveprotocol.DeliveryKindEvent {
		t.Fatalf("unexpected event frame: %+v", eventFrame)
	}
	event, err := liveprotocol.DecodeEvent(eventFrame.Deliveries[0].Event)
	if err != nil {
		t.Fatal(err)
	}
	if event.EventType != liveprotocol.EventTypeMessageDelta ||
		event.WorkspaceID != "workspace-1" ||
		event.AgentSessionID != "session-1" {
		t.Fatalf("unexpected live event: %+v", event)
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRemoteProtocolProjectsCanonicalOnlyEventAsDiscontinuity(t *testing.T) {
	t.Parallel()
	publisher, err := liveprotocol.NewPublisher(liveprotocol.PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- publishAgentActivityEnvelope(
			server,
			publisher,
			"workspace-1",
			[]byte(`{
				"workspaceId":"workspace-1",
				"agentSessionId":"session-1",
				"eventType":"message_update",
				"data":{"workspaceId":"workspace-1","agentSessionId":"session-1"}
			}`),
		)
	}()
	frame := readAgentLiveTestFrame(t, client)
	if len(frame.Deliveries) != 1 ||
		frame.Deliveries[0].Kind != liveprotocol.DeliveryKindDiscontinuity ||
		frame.Deliveries[0].Discontinuity.Reason != "canonical_update" {
		t.Fatalf("unexpected discontinuity frame: %+v", frame)
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRemoteProtocolPreservesCanonicalSessionDeletion(t *testing.T) {
	t.Parallel()
	publisher, err := liveprotocol.NewPublisher(liveprotocol.PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- publishAgentActivityEnvelope(
			server,
			publisher,
			"workspace-1",
			[]byte(`{
				"workspaceId":"workspace-1",
				"agentSessionId":"session-1",
				"eventType":"session_deleted",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"session-1",
					"eventType":"session_deleted",
					"deletedAtUnixMs":10
				}
			}`),
		)
	}()
	frame := readAgentLiveTestFrame(t, client)
	if len(frame.Deliveries) != 1 ||
		frame.Deliveries[0].Kind != liveprotocol.DeliveryKindDiscontinuity ||
		frame.Deliveries[0].Discontinuity.Reason != "session_deleted" ||
		len(frame.Deliveries[0].Discontinuity.ReconcileKeys) != 1 ||
		frame.Deliveries[0].Discontinuity.ReconcileKeys[0].AgentSessionID != "session-1" {
		t.Fatalf("unexpected session deletion frame: %+v", frame)
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRemoteProtocolRejectsMismatchedCanonicalSessionDeletion(t *testing.T) {
	t.Parallel()
	publisher, err := liveprotocol.NewPublisher(liveprotocol.PublisherConfig{
		StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- publishAgentActivityEnvelope(
			server,
			publisher,
			"workspace-1",
			[]byte(`{
				"workspaceId":"workspace-1",
				"agentSessionId":"session-1",
				"eventType":"session_deleted",
				"data":{
					"workspaceId":"workspace-1",
					"agentSessionId":"different-session",
					"eventType":"session_deleted",
					"deletedAtUnixMs":10
				}
			}`),
		)
	}()
	frame := readAgentLiveTestFrame(t, client)
	if len(frame.Deliveries) != 1 ||
		frame.Deliveries[0].Kind != liveprotocol.DeliveryKindDiscontinuity ||
		frame.Deliveries[0].Discontinuity.Reason != "invalid_event" {
		t.Fatalf("unexpected mismatched deletion frame: %+v", frame)
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func readAgentLiveTestFrame(t *testing.T, reader net.Conn) liveprotocol.Frame {
	t.Helper()
	var size [4]byte
	if _, err := io.ReadFull(reader, size[:]); err != nil {
		t.Fatal(err)
	}
	length := int(binary.BigEndian.Uint32(size[:]))
	if length <= 0 || length > liveprotocol.DefaultFrameMaxBytes {
		t.Fatalf("invalid agent live frame size: %d", length)
	}
	raw := make([]byte, length)
	if _, err := io.ReadFull(reader, raw); err != nil {
		t.Fatal(err)
	}
	frame, err := liveprotocol.DecodeFrame(raw)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}
