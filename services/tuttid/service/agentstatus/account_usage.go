package agentstatus

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

type ProviderAccountUsageResult struct {
	Outcome          string
	CapturedAtUnixMS int64
	BillingMode      string
	QuotaState       string
	Quotas           []ProviderAccountUsageQuota
	ErrorCode        string
}

type ProviderAccountUsageQuota struct {
	QuotaType        string
	PercentRemaining float64
	ResetsAtUnixMS   *int64
	ModelName        string
}

func (s Service) ProbeProviderAccountUsage(ctx context.Context, provider string) ProviderAccountUsageResult {
	if s.ProviderAccountUsageProbe != nil {
		return s.ProviderAccountUsageProbe(ctx, strings.TrimSpace(provider))
	}
	result := ProviderAccountUsageResult{CapturedAtUnixMS: s.now().UnixMilli()}
	descriptor, found := providerregistry.Find(provider)
	if !found || descriptor.Desktop.UsageProbeKind == "" {
		result.Outcome = "unsupported"
		return result
	}
	resolution, err := s.ResolveProviderCommand(ctx, provider)
	if err != nil {
		result.Outcome = "error"
		result.ErrorCode = "runtime_unavailable"
		return result
	}
	cwd, err := s.homeDir()
	if err != nil || strings.TrimSpace(cwd) == "" {
		result.Outcome = "error"
		result.ErrorCode = "runtime_unavailable"
		return result
	}
	switch descriptor.Desktop.UsageProbeKind {
	case providerregistry.DesktopUsageProbeCodex:
		return probeCodexAccountUsage(ctx, resolution, cwd, result)
	case providerregistry.DesktopUsageProbeClaudeCode:
		resolution.Env = s.claudeAccountUsageEnv(resolution.Env)
		return s.probeClaudeAccountUsage(ctx, provider, resolution, cwd, result)
	default:
		result.Outcome = "unsupported"
		return result
	}
}

func probeCodexAccountUsage(ctx context.Context, resolution ProviderCommandResolution, cwd string, result ProviderAccountUsageResult) ProviderAccountUsageResult {
	probe := agentruntime.ProbeCodexAppServer(ctx, agentruntime.CodexAppServerProbeInput{
		Command: resolution.Command, Env: resolution.Env, CWD: cwd,
		Host: agentruntime.HostMetadata{ClientInfo: agentruntime.ClientInfo{
			Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0",
		}},
		ReadAccount: true, ReadRateLimits: true, StartupTimeout: 10 * time.Second,
		HandshakeTimeout: 30 * time.Second, ShutdownTimeout: 2 * time.Second,
	})
	if probe.AccountRead && codexAccountUsageNotApplicable(probe.AuthMethod) {
		result.Outcome = "available"
		result.BillingMode = "api"
		result.QuotaState = "not_applicable"
		return result
	}
	if !probe.RateLimitsRead {
		return accountUsageProbeError(ctx, result,
			probe.RateLimitsCategory == agentruntime.CodexProbeStartupTimeout ||
				probe.RateLimitsCategory == agentruntime.CodexProbeHandshakeTimeout ||
				probe.Category == agentruntime.CodexProbeStartupTimeout ||
				probe.Category == agentruntime.CodexProbeHandshakeTimeout)
	}
	rateLimits := accountUsageMap(probe.RateLimits["rateLimits"])
	if rateLimits == nil {
		return accountUsageParseError(result)
	}
	primary, ok := codexAccountUsageQuota(accountUsageMap(rateLimits["primary"]))
	if !ok {
		return accountUsageParseError(result)
	}
	result.Quotas = append(result.Quotas, primary)
	if rawSecondary, present := rateLimits["secondary"]; present && rawSecondary != nil {
		secondary, valid := codexAccountUsageQuota(accountUsageMap(rawSecondary))
		if !valid {
			return accountUsageParseError(result)
		}
		result.Quotas = append(result.Quotas, secondary)
	}
	result.Outcome = "available"
	result.BillingMode = "subscription"
	result.QuotaState = "complete"
	return result
}

func (s Service) probeClaudeAccountUsage(ctx context.Context, provider string, resolution ProviderCommandResolution, cwd string, result ProviderAccountUsageResult) ProviderAccountUsageResult {
	gate := s.ClaudeStartupGate
	if gate == nil {
		gate = claudecodeservice.DefaultStartupGate
	}
	if err := gate.Acquire(ctx); err != nil {
		return accountUsageProbeError(ctx, result, errors.Is(err, context.DeadlineExceeded))
	}
	defer gate.Release()
	probeUsage := s.ClaudeAccountUsageProbe
	if probeUsage == nil {
		probeUsage = agentruntime.ProbeClaudeSDKAccountUsage
	}
	probe := probeUsage(ctx, agentruntime.ClaudeSDKAccountUsageProbeInput{
		Provider: provider, Command: resolution.Command, Env: resolution.Env, CWD: cwd, Timeout: 30 * time.Second,
	})
	if probe.Error != nil {
		return accountUsageProbeError(ctx, result, errors.Is(probe.Error, context.DeadlineExceeded))
	}
	available, ok := probe.Usage["rateLimitsAvailable"].(bool)
	if !ok {
		return accountUsageParseError(result)
	}
	result.Outcome = "available"
	result.BillingMode, result.QuotaState = claudeUnavailableAccountUsage(
		accountUsageString(probe.Usage["subscriptionType"]),
	)
	if !available {
		return result
	}
	rateLimits := accountUsageMap(probe.Usage["rateLimits"])
	if rateLimits == nil {
		return accountUsageParseError(result)
	}
	candidates := []struct {
		key       string
		quotaType string
		modelName string
	}{
		{key: "five_hour", quotaType: "session"},
		{key: "seven_day", quotaType: "weekly"},
		{key: "seven_day_oauth_apps", quotaType: "model", modelName: "OAuth apps"},
		{key: "seven_day_opus", quotaType: "model", modelName: "Opus"},
		{key: "seven_day_sonnet", quotaType: "model", modelName: "Sonnet"},
	}
	for _, candidate := range candidates {
		raw, present := rateLimits[candidate.key]
		if !present || raw == nil {
			continue
		}
		window := accountUsageMap(raw)
		if window == nil {
			return accountUsageParseError(result)
		}
		if window["utilization"] == nil {
			continue
		}
		quota, valid := claudeAccountUsageQuota(window, candidate.quotaType, candidate.modelName)
		if !valid {
			return accountUsageParseError(result)
		}
		result.Quotas = append(result.Quotas, quota)
	}
	if models, ok := rateLimits["model_scoped"].([]any); ok {
		for _, raw := range models {
			model := accountUsageMap(raw)
			if model != nil && model["utilization"] == nil {
				continue
			}
			if quota, valid := claudeAccountUsageQuota(model, "model", accountUsageString(model["display_name"])); valid {
				result.Quotas = append(result.Quotas, quota)
			} else {
				return accountUsageParseError(result)
			}
		}
	} else if raw, present := rateLimits["model_scoped"]; present && raw != nil {
		return accountUsageParseError(result)
	}
	if extra := accountUsageMap(rateLimits["extra_usage"]); extra != nil {
		if enabled, _ := extra["is_enabled"].(bool); enabled {
			if extra["utilization"] != nil {
				if quota, valid := claudeAccountUsageQuota(extra, "cost", ""); valid {
					result.Quotas = append(result.Quotas, quota)
				} else {
					return accountUsageParseError(result)
				}
			}
		}
	} else if raw, present := rateLimits["extra_usage"]; present && raw != nil {
		return accountUsageParseError(result)
	}
	result.BillingMode = "subscription"
	result.QuotaState = "unavailable"
	if len(result.Quotas) > 0 {
		result.QuotaState = "complete"
	}
	return result
}

func (s Service) claudeAccountUsageEnv(env []string) []string {
	const fallbackExecutableEnv = "TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE"
	for _, value := range env {
		if strings.HasPrefix(value, "CLAUDE_CODE_EXECUTABLE=") ||
			strings.HasPrefix(value, fallbackExecutableEnv+"=") {
			return append([]string(nil), env...)
		}
	}
	result := append([]string(nil), env...)
	if executable := strings.TrimSpace(s.managedClaudeCodeExecutable()); executable != "" {
		result = append(result, fallbackExecutableEnv+"="+executable)
	}
	return result
}

func codexAccountUsageNotApplicable(authMethod string) bool {
	switch strings.TrimSpace(authMethod) {
	case "apiKey", "amazonBedrock":
		return true
	default:
		return false
	}
}

func claudeUnavailableAccountUsage(subscriptionType string) (billingMode string, quotaState string) {
	if strings.TrimSpace(subscriptionType) == "" {
		return "api", "not_applicable"
	}
	return "provider_account", "unavailable"
}

func codexAccountUsageQuota(window map[string]any) (ProviderAccountUsageQuota, bool) {
	if window == nil {
		return ProviderAccountUsageQuota{}, false
	}
	used, ok := accountUsageNumber(window["usedPercent"])
	if !ok || used < 0 || used > 100 {
		return ProviderAccountUsageQuota{}, false
	}
	duration, _ := accountUsageNumber(window["windowDurationMins"])
	quotaType := "session"
	if duration >= 7*24*60 {
		quotaType = "weekly"
	} else if duration >= 24*60 {
		quotaType = "daily"
	}
	return ProviderAccountUsageQuota{
		QuotaType: quotaType, PercentRemaining: 100 - used,
		ResetsAtUnixMS: accountUsageResetUnixMS(window["resetsAt"], true),
	}, true
}

func claudeAccountUsageQuota(window map[string]any, quotaType string, modelName string) (ProviderAccountUsageQuota, bool) {
	if window == nil || (quotaType == "model" && strings.TrimSpace(modelName) == "") {
		return ProviderAccountUsageQuota{}, false
	}
	used, ok := accountUsageNumber(window["utilization"])
	if !ok || used < 0 || used > 100 {
		return ProviderAccountUsageQuota{}, false
	}
	var resetsAt *int64
	if rawReset, present := window["resets_at"]; present && rawReset != nil {
		resetText, ok := rawReset.(string)
		if !ok || strings.TrimSpace(resetText) == "" {
			return ProviderAccountUsageQuota{}, false
		}
		resetsAt = accountUsageResetUnixMS(resetText, false)
		if resetsAt == nil {
			return ProviderAccountUsageQuota{}, false
		}
	}
	return ProviderAccountUsageQuota{
		QuotaType: quotaType, PercentRemaining: 100 - used,
		ResetsAtUnixMS: resetsAt,
		ModelName:      strings.TrimSpace(modelName),
	}, true
}

func accountUsageProbeError(ctx context.Context, result ProviderAccountUsageResult, probeTimedOut bool) ProviderAccountUsageResult {
	result.Outcome = "error"
	result.ErrorCode = "execution_failed"
	if probeTimedOut || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		result.ErrorCode = "timeout"
	}
	return result
}

func accountUsageParseError(result ProviderAccountUsageResult) ProviderAccountUsageResult {
	result.Outcome = "error"
	result.ErrorCode = "parse_failed"
	return result
}

func accountUsageMap(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func accountUsageString(value any) string {
	result, _ := value.(string)
	return strings.TrimSpace(result)
}

func accountUsageNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	default:
		return 0, false
	}
}

func accountUsageResetUnixMS(value any, seconds bool) *int64 {
	if timestamp, ok := accountUsageNumber(value); ok && timestamp >= 0 {
		if seconds {
			timestamp *= 1000
		}
		result := int64(timestamp)
		return &result
	}
	if text, ok := value.(string); ok {
		if parsed, err := time.Parse(time.RFC3339, text); err == nil {
			result := parsed.UnixMilli()
			return &result
		}
	}
	return nil
}
