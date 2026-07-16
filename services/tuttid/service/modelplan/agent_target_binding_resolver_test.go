package modelplan

import (
	"context"
	"testing"
)

type staticAgentTargetDefaults map[string]string

func (s staticAgentTargetDefaults) ResolveBoundAgentTargetDefaultModels(context.Context, string, string) (map[string]string, error) {
	return s, nil
}

func TestCompositeAgentTargetBindingResolverMergesLegacyAndWorkspaceAgents(t *testing.T) {
	resolver := CompositeAgentTargetBindingResolver{
		staticAgentTargetDefaults{"local:codex": "gpt-5"},
		staticAgentTargetDefaults{"workspace-agent:one": "gpt-5-mini"},
	}
	defaults, err := resolver.ResolveBoundAgentTargetDefaultModels(context.Background(), "ws", "mp-one")
	if err != nil {
		t.Fatalf("ResolveBoundAgentTargetDefaultModels() error = %v", err)
	}
	if defaults["local:codex"] != "gpt-5" || defaults["workspace-agent:one"] != "gpt-5-mini" {
		t.Fatalf("ResolveBoundAgentTargetDefaultModels() = %#v", defaults)
	}
}
