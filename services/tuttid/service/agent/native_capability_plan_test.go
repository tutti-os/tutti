package agent

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

func TestNativeCapabilityPlanRuntimeContextProjection(t *testing.T) {
	plan := &runtimeprep.NativeCapabilityPlan{
		CodexHome: "/tmp/session/codex-home",
		Entries: []runtimeprep.NativeCapabilityPlanEntry{{
			Capability: runtimeprep.CodexNativeCapabilityBrowser,
			PluginID:   runtimeprep.CodexNativePluginBrowser,
			State:      runtimeprep.NativeCapabilityReady,
			Backend:    runtimeprep.CapabilityBackendCodexNative,
			Reason:     "ready",
			PluginPath: "plugin://browser@openai-bundled",
		}},
	}
	projected := nativeCapabilityPlanRuntimeContext(plan)
	raw, ok := projected[nativeCapabilityPlanRuntimeContextKey].(map[string]any)
	if !ok {
		t.Fatalf("projected = %#v", projected)
	}
	if raw["codexHome"] != plan.CodexHome {
		t.Fatalf("codexHome = %#v", raw["codexHome"])
	}
	entries, ok := raw["entries"].([]map[string]any)
	if !ok || len(entries) != 1 || entries[0]["backend"] != string(runtimeprep.CapabilityBackendCodexNative) {
		t.Fatalf("entries = %#v", raw["entries"])
	}

	merged := mergeRuntimeContext(map[string]any{"keep": true}, projected)
	if merged["keep"] != true {
		t.Fatalf("merged = %#v", merged)
	}
	if _, ok := merged[nativeCapabilityPlanRuntimeContextKey]; !ok {
		t.Fatalf("missing plan in merged = %#v", merged)
	}
}
