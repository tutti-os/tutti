package modelplan

import "context"

// CompositeAgentTargetBindingResolver merges default-model projections from
// legacy fixed-target bindings and first-class WorkspaceAgents so plan change
// events invalidate every affected AgentGUI composer.
type CompositeAgentTargetBindingResolver []AgentTargetBindingResolver

func (resolvers CompositeAgentTargetBindingResolver) ResolveBoundAgentTargetDefaultModels(ctx context.Context, workspaceID string, planID string) (map[string]string, error) {
	result := map[string]string{}
	for _, resolver := range resolvers {
		if resolver == nil {
			continue
		}
		defaults, err := resolver.ResolveBoundAgentTargetDefaultModels(ctx, workspaceID, planID)
		if err != nil {
			return nil, err
		}
		for agentTargetID, defaultModel := range defaults {
			result[agentTargetID] = defaultModel
		}
	}
	return result, nil
}
