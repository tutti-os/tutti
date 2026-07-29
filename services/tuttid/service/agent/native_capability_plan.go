package agent

import "github.com/tutti-os/tutti/packages/agent/runtimeprep"

const nativeCapabilityPlanRuntimeContextKey = "codexNativeCapabilityPlan"

func nativeCapabilityPlanRuntimeContext(plan *runtimeprep.NativeCapabilityPlan) map[string]any {
	if plan == nil || len(plan.Entries) == 0 {
		return nil
	}
	entries := make([]map[string]any, 0, len(plan.Entries))
	for _, entry := range plan.Entries {
		entries = append(entries, map[string]any{
			"capability": entry.Capability,
			"pluginId":   entry.PluginID,
			"state":      string(entry.State),
			"backend":    string(entry.Backend),
			"reason":     entry.Reason,
			"pluginPath": entry.PluginPath,
			"explicit":   entry.Explicit,
		})
	}
	return map[string]any{
		nativeCapabilityPlanRuntimeContextKey: map[string]any{
			"codexHome": plan.CodexHome,
			"entries":   entries,
		},
	}
}

func mergeRuntimeContext(parts ...map[string]any) map[string]any {
	var merged map[string]any
	for _, part := range parts {
		if len(part) == 0 {
			continue
		}
		if merged == nil {
			merged = make(map[string]any, len(part))
		}
		for key, value := range part {
			merged[key] = clonePayloadValue(value)
		}
	}
	return merged
}
