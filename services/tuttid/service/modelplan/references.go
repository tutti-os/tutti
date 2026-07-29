package modelplan

import (
	"context"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

// CompositeReferenceResolver fans a plan-reference lookup out to each
// underlying resolver and concatenates the results. A plan stays referenced
// (and therefore protected from deletion) while any single consumer domain —
// agent model bindings or model usage policies — still points at it. Nil
// resolvers are skipped so wiring can compose optional consumers.
type CompositeReferenceResolver []ReferenceResolver

// ListModelPlanReferences returns every consumer reported by every resolver.
// The first resolver error aborts the lookup so plan deletion never proceeds
// on a partial reference view.
func (resolvers CompositeReferenceResolver) ListModelPlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error) {
	references := make([]modelplanbiz.Reference, 0)
	for _, resolver := range resolvers {
		if resolver == nil {
			continue
		}
		found, err := resolver.ListModelPlanReferences(ctx, workspaceID, planID)
		if err != nil {
			return nil, err
		}
		references = append(references, found...)
	}
	return references, nil
}
