package agent

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

const nativeProviderProbeTimeout = 5 * time.Minute

type NativeProviderProbeInput struct {
	WorkspaceID    string
	AgentTargetID  string
	Provider       string
	Model          string
	FallbackModels []string
}

type NativeProviderProbeResult struct {
	Availability          *ProviderAvailability
	AvailabilityError     string
	AvailabilityLatencyMs int64
	Models                []ComposerConfigOptionValue
	DiscoveryError        string
	DiscoveryLatencyMs    int64
	InferenceAttempted    bool
	InferencePassed       bool
	InferenceModel        string
	InferenceDetail       string
	InferenceLatencyMs    int64
}

// ProbeNativeProvider checks a built-in provider's own login and model route.
// The real inference runs in a hidden, automation-disabled session, ignores
// workspace Model Plan bindings, and is deleted when the probe settles.
func (s *Service) ProbeNativeProvider(ctx context.Context, input NativeProviderProbeInput) (NativeProviderProbeResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	provider := strings.TrimSpace(input.Provider)
	if workspaceID == "" || agentTargetID == "" || provider == "" {
		return NativeProviderProbeResult{}, ErrInvalidArgument
	}

	probeCtx, cancel := context.WithTimeout(ctx, nativeProviderProbeTimeout)
	defer cancel()
	result := NativeProviderProbeResult{}

	started := time.Now()
	availability, err := s.ListProviderAvailability(probeCtx, ProviderAvailabilityInput{Provider: provider})
	result.AvailabilityLatencyMs = time.Since(started).Milliseconds()
	if err != nil {
		result.AvailabilityError = err.Error()
		return result, nil
	}
	for index := range availability {
		if strings.TrimSpace(availability[index].Provider) == provider {
			item := availability[index]
			result.Availability = &item
			break
		}
	}
	if result.Availability == nil {
		result.AvailabilityError = "provider availability was not returned"
		return result, nil
	}
	if !nativeProviderProbeChecksPassed(*result.Availability, "cli", "adapter", "auth") {
		return result, nil
	}

	includeCapabilities := false
	started = time.Now()
	options, optionsErr := s.GetComposerOptions(probeCtx, ComposerOptionsInput{
		AgentTargetID:            agentTargetID,
		Provider:                 provider,
		WorkspaceID:              workspaceID,
		Settings:                 ComposerSettings{Model: strings.TrimSpace(input.Model)},
		IncludeCapabilityCatalog: &includeCapabilities,
		IgnoreModelPlanBinding:   true,
	})
	result.DiscoveryLatencyMs = time.Since(started).Milliseconds()
	if optionsErr != nil {
		result.DiscoveryError = optionsErr.Error()
	} else {
		result.Models = append([]ComposerConfigOptionValue(nil), options.ModelConfig.Options...)
	}

	model := strings.TrimSpace(input.Model)
	if model == "" && optionsErr == nil {
		model = strings.TrimSpace(options.EffectiveSettings.Model)
	}
	if model == "" {
		for _, fallback := range input.FallbackModels {
			if model = strings.TrimSpace(fallback); model != "" {
				break
			}
		}
	}
	if model == "" && len(result.Models) > 0 {
		model = strings.TrimSpace(result.Models[0].Value)
	}
	result.InferenceModel = model
	if model == "" {
		return result, nil
	}

	visible := false
	started = time.Now()
	session, createErr := s.Create(probeCtx, workspaceID, CreateSessionInput{
		AgentTargetID:          agentTargetID,
		Provider:               provider,
		Model:                  &model,
		IgnoreModelPlanBinding: true,
		InitialContent: []PromptContentBlock{{
			Type: "text",
			Text: "Reply with exactly OK. Do not use tools and do not modify any files.",
		}},
		InitialDisplayPrompt: "Verify model access",
		Metadata: map[string]any{
			"origin": "model_plan_detection",
		},
		AutomationRuleOverride: &automationrulebiz.SessionOverride{Disabled: true},
		Visible:                &visible,
	})
	result.InferenceAttempted = true
	if createErr != nil {
		result.InferenceLatencyMs = time.Since(started).Milliseconds()
		result.InferenceDetail = createErr.Error()
		return result, nil
	}
	defer s.cleanupNativeProviderProbeSession(workspaceID, session.ID)

	wait, waitErr := s.Wait(probeCtx, WaitInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: session.ID,
		Timeout:        nativeProviderProbeTimeout,
		MessageLimit:   1,
	})
	result.InferenceLatencyMs = time.Since(started).Milliseconds()
	if waitErr != nil {
		result.InferenceDetail = waitErr.Error()
		return result, nil
	}
	result.InferencePassed = wait.Reason == WaitReasonCompleted
	if !result.InferencePassed {
		result.InferenceDetail = fmt.Sprintf("provider probe stopped with %s", wait.Reason)
	}
	return result, nil
}

func nativeProviderProbeChecksPassed(availability ProviderAvailability, names ...string) bool {
	checks := make(map[string]bool, len(availability.Checks))
	for _, check := range availability.Checks {
		checks[strings.TrimSpace(check.Name)] = check.Passed
	}
	for _, name := range names {
		if !checks[name] {
			return false
		}
	}
	return true
}

func (s *Service) cleanupNativeProviderProbeSession(workspaceID string, sessionID string) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := s.Delete(cleanupCtx, workspaceID, sessionID); err != nil {
		slog.Warn(
			"clean up native model provider probe session failed",
			"event", "tutti.model_plan.native_probe.cleanup_failed",
			"workspace_id", strings.TrimSpace(workspaceID),
			"agent_session_id", strings.TrimSpace(sessionID),
			"error", err,
		)
	}
}
