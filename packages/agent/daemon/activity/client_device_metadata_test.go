package agentsessionstore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestReportSessionStateIncludesOptionalAgentTargetAndDeviceMetadata(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	_, err := client.ReportSessionState(context.Background(), ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "target-1",
		DeviceID:       "device-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Source: EventSource{
			Provider:      "codex",
			AgentID:       "session-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		State: WorkspaceAgentSessionStateUpdate{LifecycleStatus: "active"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["agentTargetId"] != "target-1" || got["deviceId"] != "device-1" {
		t.Fatalf("request metadata = %#v, want top-level agentTargetId/deviceId", got)
	}
	source, ok := got["source"].(map[string]any)
	if !ok || source["agentTargetId"] != "target-1" || source["deviceId"] != "device-1" {
		t.Fatalf("source = %#v, want propagated metadata", got["source"])
	}
	state, ok := got["state"].(map[string]any)
	if !ok || state["agentTargetId"] != "target-1" || state["deviceId"] != "device-1" {
		t.Fatalf("state = %#v, want propagated metadata", got["state"])
	}
}

func TestReportSessionStateOmitsMetadataKeysWhenUnset(t *testing.T) {
	var raw map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	_, err := client.ReportSessionState(context.Background(), ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Source: EventSource{
			Provider:      "codex",
			AgentID:       "session-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		State: WorkspaceAgentSessionStateUpdate{LifecycleStatus: "active"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"agentTargetId", "deviceId"} {
		if _, present := raw[key]; present {
			t.Fatalf("request unexpectedly contains %q: %s", key, raw[key])
		}
	}
	var source map[string]json.RawMessage
	if err := json.Unmarshal(raw["source"], &source); err != nil {
		t.Fatal(err)
	}
	if _, present := source["deviceId"]; present {
		t.Fatalf("source unexpectedly contains deviceId: %s", raw["source"])
	}
}

func TestReportSessionStateDerivesTopLevelMetadataFromSourceAndState(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	// The adapter path carries metadata only inside Source/State; the
	// explicit input fields stay empty. Top-level request metadata must still
	// be populated so controlplanes keying off it get scoped activity.
	_, err := client.ReportSessionState(context.Background(), ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Source: EventSource{
			Provider:      "codex",
			AgentTargetID: "target-1",
			DeviceID:      "device-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		State: WorkspaceAgentSessionStateUpdate{LifecycleStatus: "active"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["agentTargetId"] != "target-1" || got["deviceId"] != "device-1" {
		t.Fatalf("request metadata = %#v, want top-level metadata derived from source", got)
	}
	state, ok := got["state"].(map[string]any)
	if !ok || state["agentTargetId"] != "target-1" || state["deviceId"] != "device-1" {
		t.Fatalf("state = %#v, want metadata filled from source", got["state"])
	}
}

func TestReportSessionMessagesDerivesTopLevelMetadataFromSource(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"acceptedCount":1}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	_, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Source: EventSource{
			Provider:      "codex",
			AgentTargetID: "target-1",
			DeviceID:      "device-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			TurnID:    "turn-1",
			Role:      "assistant",
			Kind:      "text",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["agentTargetId"] != "target-1" || got["deviceId"] != "device-1" {
		t.Fatalf("request metadata = %#v, want top-level metadata derived from source", got)
	}
}

func TestReportSessionStateRequestBodyIsByteIdenticalWhenMetadataUnset(t *testing.T) {
	var raw []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		raw = body
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	_, err := client.ReportSessionState(context.Background(), ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Source:         EventSource{Provider: "codex"},
		State:          WorkspaceAgentSessionStateUpdate{LifecycleStatus: "active"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Golden body: exactly what this request serialized to before the
	// optional AgentTargetID/DeviceID inputs existed. Guards the hard
	// constraint that unset metadata leaves the wire byte-for-byte unchanged.
	want := `{"roomId":"ws-1","agentSessionId":"session-1",` +
		`"sessionOrigin":"WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",` +
		`"source":{"provider":"codex"},"state":{"lifecycleStatus":"active"}}`
	if string(raw) != want {
		t.Fatalf("request body = %s, want %s", raw, want)
	}
}

func TestReportSessionMessagesSplitBatchesPreserveMetadata(t *testing.T) {
	rawText := strings.Repeat("x", maxUpstreamToolPayloadStringBytes+512)
	var requestCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var got reportSessionMessagesRequest
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		requestCount++
		if got.AgentTargetID != "target-1" || got.DeviceID != "device-1" {
			t.Fatalf("batch %d metadata = %q/%q, want target-1/device-1", requestCount, got.AgentTargetID, got.DeviceID)
		}
		_, _ = w.Write([]byte(`{"acceptedCount":` + strconv.Itoa(len(got.Updates)) + `}`))
	}))
	defer server.Close()

	updates := make([]WorkspaceAgentSessionMessageUpdate, 0, 80)
	for i := 0; i < 80; i++ {
		updates = append(updates, WorkspaceAgentSessionMessageUpdate{
			MessageID: "message-" + strconv.Itoa(i),
			TurnID:    "turn-1",
			Role:      "assistant",
			Kind:      "tool_call",
			Payload: map[string]any{
				"input":  map[string]any{"stdout": rawText},
				"output": map[string]any{"stdout": rawText},
			},
		})
	}

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	if _, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "target-1",
		DeviceID:       "device-1",
		Updates:        updates,
	}); err != nil {
		t.Fatal(err)
	}
	if requestCount < 2 {
		t.Fatalf("requestCount = %d, want oversized request split into multiple uploads", requestCount)
	}
}

func TestReportSessionMessagesIncludesOptionalMetadata(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"acceptedCount":1}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	_, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "target-1",
		DeviceID:       "device-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Source: EventSource{
			Provider:      "codex",
			AgentID:       "session-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			TurnID:    "turn-1",
			Role:      "assistant",
			Kind:      "text",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["agentTargetId"] != "target-1" || got["deviceId"] != "device-1" {
		t.Fatalf("request metadata = %#v, want top-level agentTargetId/deviceId", got)
	}
	source, ok := got["source"].(map[string]any)
	if !ok || source["deviceId"] != "device-1" {
		t.Fatalf("source = %#v, want propagated deviceId", got["source"])
	}
}

func TestListSessionMessagesSendsDeviceIDQueryOnlyWhenSet(t *testing.T) {
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.Query().Get("device_id"))
		_, _ = w.Write([]byte(`{"messages":[]}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	if _, err := client.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		DeviceID:       "device-1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if len(queries) != 2 || queries[0] != "device-1" || queries[1] != "" {
		t.Fatalf("device_id queries = %#v, want [device-1 \"\"]", queries)
	}
}

func TestListAgentsWithFilterSendsDeviceIDQuery(t *testing.T) {
	var deviceID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deviceID = r.URL.Query().Get("device_id")
		_, _ = w.Write([]byte(`{"presences":[],"sessions":[]}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	if _, err := client.ListAgentsWithFilter(context.Background(), ListAgentsInput{
		WorkspaceID: "ws-1",
		DeviceID:    "device-1",
	}); err != nil {
		t.Fatal(err)
	}
	if deviceID != "device-1" {
		t.Fatalf("device_id query = %q, want device-1", deviceID)
	}
}

func TestWorkspaceAgentSessionUnmarshalsDeviceIDLeniently(t *testing.T) {
	var camel ProviderActivitySessionProjection
	if err := json.Unmarshal([]byte(`{"agentSessionId":"session-1","deviceId":"device-1"}`), &camel); err != nil {
		t.Fatal(err)
	}
	if camel.DeviceID != "device-1" {
		t.Fatalf("camelCase deviceId = %q, want device-1", camel.DeviceID)
	}

	var snake ProviderActivitySessionProjection
	if err := json.Unmarshal([]byte(`{"agent_session_id":"session-1","device_id":"device-2"}`), &snake); err != nil {
		t.Fatal(err)
	}
	if snake.DeviceID != "device-2" {
		t.Fatalf("snake_case device_id = %q, want device-2", snake.DeviceID)
	}

	roundtrip, err := json.Marshal(ProviderActivitySessionProjection{AgentSessionID: "session-1", DeviceID: "device-1"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(roundtrip, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["deviceId"] != "device-1" {
		t.Fatalf("marshal output = %s, want deviceId", roundtrip)
	}
}
