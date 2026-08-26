package agentruntime

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestProbeClaudeSDKAccountUsageUsesStatelessSidecarControlRequest(t *testing.T) {
	t.Parallel()
	conn := &ackClaudeSDKConnection{probeUsagePayload: map[string]any{
		"subscriptionType":    "pro",
		"rateLimitsAvailable": true,
		"rateLimits": map[string]any{
			"five_hour": map[string]any{"utilization": float64(25)},
		},
	}}
	transport := &recordingClaudeSDKTransport{conn: conn}
	result := ProbeClaudeSDKAccountUsage(context.Background(), ClaudeSDKAccountUsageProbeInput{
		Provider: "claude-code", Command: []string{"node", "sidecar.ts"}, Env: []string{"TOKEN=hidden"},
		CWD: "/workspace", Timeout: time.Second, Transport: transport,
	})
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	if result.Usage["subscriptionType"] != "pro" || result.Usage["rateLimitsAvailable"] != true {
		t.Fatalf("usage = %#v", result.Usage)
	}
	if !reflect.DeepEqual(transport.spec.Command, []string{"node", "sidecar.ts"}) ||
		transport.spec.CWD != "/workspace" || !reflect.DeepEqual(transport.spec.Env, []string{"TOKEN=hidden"}) {
		t.Fatalf("process spec = %#v", transport.spec)
	}
	requests := conn.sentRequests()
	if len(requests) != 1 || requests[0].Type != "probe_usage" ||
		requests[0].Payload["cwd"] != "/workspace" {
		t.Fatalf("requests = %#v", requests)
	}
	conn.mu.Lock()
	closed := conn.closed
	conn.mu.Unlock()
	if !closed {
		t.Fatal("sidecar connection was not closed")
	}
}

func TestProbeClaudeSDKAccountUsageRejectsEmptyPayload(t *testing.T) {
	t.Parallel()
	conn := &ackClaudeSDKConnection{}
	result := ProbeClaudeSDKAccountUsage(context.Background(), ClaudeSDKAccountUsageProbeInput{
		Provider: "claude-code", Command: []string{"node", "sidecar.ts"}, Timeout: time.Second,
		Transport: &recordingClaudeSDKTransport{conn: conn},
	})
	if result.Error == nil {
		t.Fatalf("result = %#v, want empty response error", result)
	}
}
