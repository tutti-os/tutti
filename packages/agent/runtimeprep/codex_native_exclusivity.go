package runtimeprep

import "strings"

// ApplyNativeCapabilityExclusivity disables Tutti browser/computer delivery when
// the session plan selected Codex native for that capability. Sites has no Tutti
// counterpart. Callers must rebuild provider instructions/skills after this.
func ApplyNativeCapabilityExclusivity(input *PrepareInput, plan NativeCapabilityPlan) {
	if input == nil {
		return
	}
	if plan.Backend(CodexNativeCapabilityBrowser) == CapabilityBackendCodexNative {
		input.BrowserUse = false
	}
	if plan.Backend(CodexNativeCapabilityComputer) == CapabilityBackendCodexNative {
		input.ComputerUse = false
	}
	if input.resolved == nil {
		return
	}
	filteredSkills := make([]SkillSpec, 0, len(input.resolved.Skills))
	for _, skill := range input.resolved.Skills {
		id := strings.TrimSpace(skill.ID)
		if plan.Backend(CodexNativeCapabilityBrowser) == CapabilityBackendCodexNative &&
			(id == "tutti/browser-use" || skill.Name == browserUseSkillName) {
			continue
		}
		if plan.Backend(CodexNativeCapabilityComputer) == CapabilityBackendCodexNative &&
			(id == "tutti/computer-use" || skill.Name == computerUseSkillName) {
			continue
		}
		filteredSkills = append(filteredSkills, skill)
	}
	input.resolved.Skills = filteredSkills

	filteredSections := make([]PolicySection, 0, len(input.resolved.PolicySections))
	for _, section := range input.resolved.PolicySections {
		key := strings.TrimSpace(section.Key)
		if plan.Backend(CodexNativeCapabilityBrowser) == CapabilityBackendCodexNative &&
			strings.HasPrefix(key, "browser-use/") {
			continue
		}
		if plan.Backend(CodexNativeCapabilityComputer) == CapabilityBackendCodexNative &&
			strings.HasPrefix(key, "computer-use/") {
			continue
		}
		filteredSections = append(filteredSections, section)
	}
	input.resolved.PolicySections = filteredSections

	filteredEnv := make([]string, 0, len(input.resolved.EnvOverlay))
	for _, entry := range input.resolved.EnvOverlay {
		if plan.Backend(CodexNativeCapabilityBrowser) == CapabilityBackendCodexNative &&
			strings.HasPrefix(entry, browserUseEnabledSessionEnv+"=") {
			continue
		}
		if plan.Backend(CodexNativeCapabilityComputer) == CapabilityBackendCodexNative &&
			strings.HasPrefix(entry, computerUseEnabledSessionEnv+"=") {
			continue
		}
		filteredEnv = append(filteredEnv, entry)
	}
	input.resolved.EnvOverlay = filteredEnv
}

// FilterEnvForNativeCapabilityPlan removes Tutti capability session markers that
// conflict with an active Codex native backend.
func FilterEnvForNativeCapabilityPlan(env []string, plan *NativeCapabilityPlan) []string {
	if plan == nil || len(env) == 0 {
		return env
	}
	result := make([]string, 0, len(env))
	for _, entry := range env {
		if plan.Backend(CodexNativeCapabilityBrowser) == CapabilityBackendCodexNative &&
			strings.HasPrefix(entry, browserUseEnabledSessionEnv+"=") {
			continue
		}
		if plan.Backend(CodexNativeCapabilityComputer) == CapabilityBackendCodexNative &&
			strings.HasPrefix(entry, computerUseEnabledSessionEnv+"=") {
			continue
		}
		result = append(result, entry)
	}
	return result
}
