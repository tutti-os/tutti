package agentstatus

import (
	"context"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

func TestCodexAccountUsageQuotaMapsProviderWindow(t *testing.T) {
	quota, ok := codexAccountUsageQuota(map[string]any{
		"usedPercent": float64(25), "windowDurationMins": float64(7 * 24 * 60),
		"resetsAt": float64(1_750_000_000),
	})
	if !ok || quota.QuotaType != "weekly" || quota.PercentRemaining != 75 ||
		quota.ResetsAtUnixMS == nil || *quota.ResetsAtUnixMS != 1_750_000_000_000 {
		t.Fatalf("quota = %#v, ok = %v", quota, ok)
	}
}

func TestClaudeAccountUsageQuotaMapsSDKWindow(t *testing.T) {
	reset := "2026-08-21T08:00:00Z"
	quota, ok := claudeAccountUsageQuota(map[string]any{
		"utilization": float64(12.5), "resets_at": reset,
	}, "model", "Opus")
	wantReset, _ := time.Parse(time.RFC3339, reset)
	if !ok || quota.QuotaType != "model" || quota.ModelName != "Opus" ||
		quota.PercentRemaining != 87.5 || quota.ResetsAtUnixMS == nil ||
		*quota.ResetsAtUnixMS != wantReset.UnixMilli() {
		t.Fatalf("quota = %#v, ok = %v", quota, ok)
	}
}

func TestAccountUsageQuotaRejectsInvalidUtilization(t *testing.T) {
	if _, ok := codexAccountUsageQuota(map[string]any{"usedPercent": float64(101)}); ok {
		t.Fatal("Codex quota accepted utilization above 100")
	}
	if _, ok := claudeAccountUsageQuota(map[string]any{"utilization": "25"}, "session", ""); ok {
		t.Fatal("Claude quota accepted a non-numeric utilization")
	}
}

func TestCodexAccountUsageNotApplicableForNonSubscriptionAuth(t *testing.T) {
	for _, authMethod := range []string{"apiKey", "amazonBedrock"} {
		if !codexAccountUsageNotApplicable(authMethod) {
			t.Fatalf("auth method %q should not have subscription quotas", authMethod)
		}
	}
	if codexAccountUsageNotApplicable("chatgpt") {
		t.Fatal("ChatGPT auth should retain subscription quota probing")
	}
}

func TestClaudeUnavailableAccountUsageDistinguishesAPIFromSubscription(t *testing.T) {
	billingMode, quotaState := claudeUnavailableAccountUsage("")
	if billingMode != "api" || quotaState != "not_applicable" {
		t.Fatalf("API usage = (%q, %q)", billingMode, quotaState)
	}
	billingMode, quotaState = claudeUnavailableAccountUsage("pro")
	if billingMode != "provider_account" || quotaState != "unavailable" {
		t.Fatalf("subscription usage = (%q, %q)", billingMode, quotaState)
	}
}

func TestClaudeAccountUsageWaitsForSharedCredentialGate(t *testing.T) {
	gate := claudecodeservice.NewStartupGate()
	if err := gate.Acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	called := make(chan struct{})
	service := Service{
		ClaudeStartupGate: gate,
		ClaudeAccountUsageProbe: func(context.Context, agentruntime.ClaudeSDKAccountUsageProbeInput) agentruntime.ClaudeSDKAccountUsageProbeResult {
			close(called)
			return agentruntime.ClaudeSDKAccountUsageProbeResult{Usage: completeClaudeUsageFixture()}
		},
	}
	resultCh := make(chan ProviderAccountUsageResult, 1)
	go func() {
		resultCh <- service.probeClaudeAccountUsage(
			context.Background(), "claude-code",
			ProviderCommandResolution{Command: []string{"node", "sidecar.ts"}},
			"/workspace", ProviderAccountUsageResult{CapturedAtUnixMS: 1},
		)
	}()
	select {
	case <-called:
		t.Fatal("Claude usage started while the shared credential gate was held")
	case <-time.After(50 * time.Millisecond):
	}
	gate.Release()
	select {
	case result := <-resultCh:
		if result.Outcome != "available" || result.QuotaState != "complete" {
			t.Fatalf("result = %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("Claude usage did not start after the shared credential gate was released")
	}
}

func TestClaudeAccountUsageGateWaitHonorsCancellation(t *testing.T) {
	gate := claudecodeservice.NewStartupGate()
	if err := gate.Acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	called := false
	service := Service{
		ClaudeStartupGate: gate,
		ClaudeAccountUsageProbe: func(context.Context, agentruntime.ClaudeSDKAccountUsageProbeInput) agentruntime.ClaudeSDKAccountUsageProbeResult {
			called = true
			return agentruntime.ClaudeSDKAccountUsageProbeResult{}
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := service.probeClaudeAccountUsage(
		ctx, "claude-code", ProviderCommandResolution{Command: []string{"node"}},
		"/workspace", ProviderAccountUsageResult{CapturedAtUnixMS: 1},
	)
	if called || result.Outcome != "error" {
		t.Fatalf("called = %v, result = %#v", called, result)
	}
}

func TestClaudeAccountUsageAcceptsPartialOptionalWindows(t *testing.T) {
	service := Service{
		ClaudeStartupGate: claudecodeservice.NewStartupGate(),
		ClaudeAccountUsageProbe: func(context.Context, agentruntime.ClaudeSDKAccountUsageProbeInput) agentruntime.ClaudeSDKAccountUsageProbeResult {
			usage := completeClaudeUsageFixture()
			delete(usage["rateLimits"].(map[string]any), "seven_day")
			return agentruntime.ClaudeSDKAccountUsageProbeResult{Usage: usage}
		},
	}
	result := service.probeClaudeAccountUsage(
		context.Background(), "claude-code", ProviderCommandResolution{Command: []string{"node"}},
		"/workspace", ProviderAccountUsageResult{CapturedAtUnixMS: 1},
	)
	if result.Outcome != "available" || result.QuotaState != "complete" || len(result.Quotas) != 1 {
		t.Fatalf("result = %#v", result)
	}
}

func TestClaudeAccountUsageTreatsNullOptionalWindowsAsUnavailable(t *testing.T) {
	service := Service{
		ClaudeStartupGate: claudecodeservice.NewStartupGate(),
		ClaudeAccountUsageProbe: func(context.Context, agentruntime.ClaudeSDKAccountUsageProbeInput) agentruntime.ClaudeSDKAccountUsageProbeResult {
			return agentruntime.ClaudeSDKAccountUsageProbeResult{Usage: map[string]any{
				"subscriptionType": "team", "rateLimitsAvailable": true,
				"rateLimits": map[string]any{"five_hour": nil, "seven_day": nil},
			}}
		},
	}
	result := service.probeClaudeAccountUsage(
		context.Background(), "claude-code", ProviderCommandResolution{Command: []string{"node"}},
		"/workspace", ProviderAccountUsageResult{CapturedAtUnixMS: 1},
	)
	if result.Outcome != "available" || result.QuotaState != "unavailable" || len(result.Quotas) != 0 {
		t.Fatalf("result = %#v", result)
	}
}

func completeClaudeUsageFixture() map[string]any {
	return map[string]any{
		"subscriptionType": "pro", "rateLimitsAvailable": true,
		"rateLimits": map[string]any{
			"five_hour": map[string]any{"utilization": float64(25)},
			"seven_day": map[string]any{"utilization": float64(40)},
		},
	}
}
