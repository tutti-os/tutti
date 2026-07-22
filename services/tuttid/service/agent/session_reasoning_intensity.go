package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

// applyCreateSessionReasoningIntensity compiles the Issue-level continuous
// strength control into the selected model's discrete runtime vocabulary.
// An explicit effort remains authoritative for non-Issue callers.
func (s *Service) applyCreateSessionReasoningIntensity(
	ctx context.Context,
	provider string,
	model string,
	input *CreateSessionInput,
) error {
	if input == nil || input.ReasoningIntensity == nil || input.ReasoningEffort != nil {
		return nil
	}
	intensity := *input.ReasoningIntensity
	if intensity < 0 || intensity > 100 {
		return fmt.Errorf("%w: reasoning intensity must be between 0 and 100", ErrInvalidArgument)
	}
	profile := composerProfileFor(provider)
	if !profile.ReasoningEffort {
		return nil
	}

	values := reasoningEffortValuesForProvider(provider)
	if composerProviderUsesModelReasoningCatalog(provider) {
		catalog, ok := composerModelOptionsFromCatalog(ctx, s.ModelCatalog, provider, "", model)
		if ok && catalog.Selection.ReasoningEffortsAdvertised {
			values = make([]string, 0, len(catalog.Selection.ReasoningEfforts))
			for _, option := range catalog.Selection.ReasoningEfforts {
				values = append(values, option.Value)
			}
		} else if profile.ReasoningEffortOptions == providerregistry.ReasoningEffortOptionsStrictModelCatalog {
			// A strict catalog explicitly owns whether reasoning is configurable.
			// Do not invent a provider-wide value when it is unavailable.
			return nil
		} else {
			// Codex-derived providers accept this common ordered vocabulary. The
			// normal model clamp below replaces it with the authoritative catalog
			// value whenever discovery is available.
			values = []string{"minimal", "low", "medium", "high", "xhigh"}
		}
	}
	effort := reasoningEffortForIntensity(values, intensity)
	if effort == "" {
		return nil
	}
	input.ReasoningEffort = &effort
	return nil
}

// reasoningEffortForIntensity divides 0-100 into equal bands across the
// provider/model catalog order, which is the same weak-to-strong order shown
// by the Composer. Duplicate and blank values are ignored.
func reasoningEffortForIntensity(values []string, intensity int) string {
	ordered := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		ordered = append(ordered, value)
	}
	if len(ordered) == 0 {
		return ""
	}
	if intensity < 0 {
		intensity = 0
	}
	if intensity > 100 {
		intensity = 100
	}
	index := intensity * len(ordered) / 101
	if index >= len(ordered) {
		index = len(ordered) - 1
	}
	return ordered[index]
}
