package runtimeprep

import (
	"context"
	"strings"
)

func tuttiCLIPolicy(input PrepareInput) (string, error) {
	if input.resolved == nil {
		if resolved, err := resolveCapabilities(context.Background(), input, StandardProfile(), nil); err == nil {
			input.resolved = resolved
		} else {
			return "", err
		}
	}
	return tuttiRuntimePolicy(input)
}

func hostAppContextPolicy(input PrepareInput) (string, error) {
	generatedImageOutput, err := renderPolicyTemplate(
		"policy_templates/generated-image-output.md",
		input,
	)
	if err != nil {
		return "", err
	}
	rendered, err := renderProviderSkillTemplate(
		"policy_templates/host-app-context.md",
		input,
		map[string]string{
			"{{GENERATED_IMAGE_OUTPUT_POLICY}}": generatedImageOutput,
		},
	)
	return strings.TrimSpace(rendered), err
}

func tuttiRuntimePolicy(input PrepareInput) (string, error) {
	providerMentionRouting, err := renderPolicyTemplate(
		"policy_templates/provider-mention-routing.md",
		input,
	)
	if err != nil {
		return "", err
	}
	rendered, err := renderProviderSkillTemplate(
		"policy_templates/tutti-runtime.md",
		input,
		map[string]string{
			"{{PROVIDER_SPECIFIC_MENTION_ROUTING}}":       providerMentionRouting,
			"{{PROVIDER_SPECIFIC_EXECUTION_ENVIRONMENT}}": "",
			"{{ENVIRONMENT_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorEnvironment, PolicyDeliveryProviderRuntime),
			"{{TOOLS_POLICY_SECTIONS}}":                   capabilityPolicyLines(input, PolicyDeliveryProviderRuntime),
			"{{SKILL_STRATEGY_POLICY_SECTIONS}}":          renderPolicySections(input, PolicyAnchorSkillStrategy, PolicyDeliveryProviderRuntime),
			"{{SPECIALIZED_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorSpecialized, PolicyDeliveryProviderRuntime),
		},
	)
	return strings.TrimSpace(rendered), err
}

func resolvedProfileTitle(input PrepareInput) string {
	if input.resolved != nil && strings.TrimSpace(input.resolved.Title) != "" {
		return input.resolved.Title
	}
	return "Tutti Runtime"
}

func resolvedProfileIntro(input PrepareInput) string {
	if input.resolved != nil && strings.TrimSpace(input.resolved.Intro) != "" {
		return input.resolved.Intro
	}
	return "This directory is being used by a Tutti AgentGUI session."
}

func tuttiSkillBundleRecommendedPolicy(input PrepareInput) (string, error) {
	providerMentionRouting, err := renderPolicyTemplate(
		"policy_templates/provider-mention-routing.md",
		input,
	)
	if err != nil {
		return "", err
	}
	rendered, err := renderProviderSkillTemplate(
		"policy_templates/skill-bundle-routing.md",
		input,
		map[string]string{
			"{{PROVIDER_SPECIFIC_MENTION_ROUTING}}":       providerMentionRouting,
			"{{PROVIDER_SPECIFIC_EXECUTION_ENVIRONMENT}}": "",
			"{{ENVIRONMENT_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorEnvironment, PolicyDeliverySkillBundle),
			"{{TOOLS_POLICY_SECTIONS}}":                   capabilityPolicyLines(input, PolicyDeliverySkillBundle),
			"{{SKILL_STRATEGY_POLICY_SECTIONS}}":          renderPolicySections(input, PolicyAnchorSkillStrategy, PolicyDeliverySkillBundle),
			"{{SPECIALIZED_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorSpecialized, PolicyDeliverySkillBundle),
		},
	)
	return strings.TrimSpace(rendered), err
}

func capabilityPolicyLines(input PrepareInput, delivery PolicyDelivery) string {
	if input.resolved != nil {
		return renderPolicySections(input, PolicyAnchorTools, delivery)
	}
	return ""
}

func commandGuide(input PrepareInput) (string, error) {
	if input.commandCapabilities != nil {
		return input.commandCapabilities.Guide()
	}
	return "- No agent-facing runtime CLI commands were advertised by the current host.", nil
}

func commandGuideReference(input PrepareInput) (string, error) {
	guide, err := commandGuide(input)
	if err != nil {
		return "", err
	}
	return "# Tutti CLI Command Guide\n\n" + guide + "\n", nil
}
