package mobileremote

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"testing"
	"time"
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
	if err := readRemoteFrame(client, maxRemoteResponseBytes, &response); err != nil {
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
	binary.BigEndian.PutUint32(size[:], uint32(maxRemoteRequestBytes+1))
	raw.Write(size[:])
	var value map[string]any
	if err := readRemoteFrame(&raw, maxRemoteRequestBytes, &value); err == nil {
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

func TestRemoteProtocolStreamHonorsCanceledContext(t *testing.T) {
	t.Parallel()
	server, client := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() {
		done <- serveRemoteStream(ctx, server, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Context().Err() == nil {
				t.Fatal("expected canceled request context")
			}
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
	if err := readRemoteFrame(client, maxRemoteResponseBytes, &response); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
