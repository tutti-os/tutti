package providerregistry

import "strings"

// ComposerSkillProjection is the provider-authored invocation contract for one
// discovered skill. Discovery adapters supply identity and plugin ownership;
// the registry owns how that skill is presented and invoked.
type ComposerSkillProjection struct {
	Trigger    string
	Invocation SkillInvocation
}

// ProjectComposerSkill resolves the canonical trigger and invocation strategy
// for a discovered skill. Callers must not reconstruct these values from
// provider identity.
func ProjectComposerSkill(providerID, name, pluginName string) (ComposerSkillProjection, bool) {
	descriptor, ok := Find(providerID)
	if !ok {
		return ComposerSkillProjection{}, false
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return ComposerSkillProjection{}, false
	}
	skill := descriptor.ComposerProfile.Skills
	trigger := ""
	switch skill.Kind {
	case SkillKindCodex, SkillKindCursor:
		trigger = "$" + name
	case SkillKindClaudeCode:
		pluginName = strings.TrimSpace(pluginName)
		if pluginName != "" {
			trigger = "/" + pluginName + ":" + name
		} else {
			trigger = "/" + name
		}
	case SkillKindOpenCode:
		trigger = "/" + name
	default:
		return ComposerSkillProjection{}, false
	}
	if skill.Invocation == "" {
		return ComposerSkillProjection{}, false
	}
	return ComposerSkillProjection{
		Trigger:    trigger,
		Invocation: skill.Invocation,
	}, true
}
