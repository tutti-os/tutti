package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

type modelPlanNativeSubscriptionProbe struct {
	Agents *agentservice.Service
}

func (p modelPlanNativeSubscriptionProbe) ProbeNativeSubscription(
	ctx context.Context,
	input modelplanservice.NativeSubscriptionProbeInput,
) (modelplanservice.NativeSubscriptionProbeResult, error) {
	if p.Agents == nil {
		return modelplanservice.NativeSubscriptionProbeResult{}, fmt.Errorf("agent service is unavailable")
	}
	provider, targetID, ok := nativeSubscriptionAgentTarget(input.Protocol)
	if !ok {
		return modelplanservice.NativeSubscriptionProbeResult{}, fmt.Errorf("unsupported native subscription protocol %q", input.Protocol)
	}
	fallbackModels := make([]string, 0, len(input.Models))
	for _, model := range input.Models {
		fallbackModels = append(fallbackModels, model.ID)
	}
	probe, err := p.Agents.ProbeNativeProvider(ctx, agentservice.NativeProviderProbeInput{
		WorkspaceID:    input.WorkspaceID,
		AgentTargetID:  targetID,
		Provider:       provider,
		Model:          input.Model,
		FallbackModels: fallbackModels,
	})
	if err != nil {
		return modelplanservice.NativeSubscriptionProbeResult{}, err
	}

	result := modelplanservice.NativeSubscriptionProbeResult{
		RuntimeLatencyMs:   probe.AvailabilityLatencyMs,
		DiscoveryDetail:    probe.DiscoveryError,
		DiscoveryLatencyMs: probe.DiscoveryLatencyMs,
		InferenceAttempted: probe.InferenceAttempted,
		InferencePassed:    probe.InferencePassed,
		InferenceModel:     probe.InferenceModel,
		InferenceDetail:    probe.InferenceDetail,
		InferenceLatencyMs: probe.InferenceLatencyMs,
	}
	if probe.Availability == nil {
		result.RuntimeDetail = probe.AvailabilityError
		return result, nil
	}
	result.RuntimeAvailable, result.RuntimeDetail = nativeSubscriptionRuntimeStatus(*probe.Availability)
	result.Authenticated, result.AuthDetail = nativeSubscriptionAuthStatus(*probe.Availability)
	for _, option := range probe.Models {
		modelID := strings.TrimSpace(option.Value)
		if modelID == "" {
			continue
		}
		name := strings.TrimSpace(option.Label)
		if name == "" {
			name = modelID
		}
		result.DiscoveredModels = append(result.DiscoveredModels, modelplanbiz.Model{
			ID:   modelID,
			Name: name,
		})
	}
	return result, nil
}

func nativeSubscriptionAgentTarget(protocol modelplanbiz.Protocol) (string, string, bool) {
	target, ok := providerregistry.ResolveNativeSubscriptionTarget(providerregistry.ModelPlanProtocol(protocol))
	if !ok {
		return "", "", false
	}
	return target.ProviderID, target.AgentTargetID, true
}

func nativeSubscriptionRuntimeStatus(availability agentservice.ProviderAvailability) (bool, string) {
	details := make([]string, 0, 2)
	passed := true
	seen := 0
	for _, check := range availability.Checks {
		name := strings.TrimSpace(check.Name)
		if name != "cli" && name != "adapter" {
			continue
		}
		seen++
		if check.Passed {
			continue
		}
		passed = false
		if detail := strings.TrimSpace(check.Detail); detail != "" {
			details = append(details, detail)
		}
	}
	if seen != 2 {
		passed = false
	}
	return passed, strings.Join(details, "; ")
}

func nativeSubscriptionAuthStatus(availability agentservice.ProviderAvailability) (bool, string) {
	for _, check := range availability.Checks {
		if strings.TrimSpace(check.Name) == "auth" {
			return check.Passed, strings.TrimSpace(check.Detail)
		}
	}
	return false, "authentication status is unavailable"
}
