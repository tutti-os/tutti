package modelplan

import (
	"context"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

// CompositeReferenceResolver aggregates plan references from several
// consumer domains (agent bindings, model usage policies, workspace apps).
type CompositeReferenceResolver []ReferenceResolver

func (resolvers CompositeReferenceResolver) ListModelPlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error) {
	references := []modelplanbiz.Reference{}
	for _, resolver := range resolvers {
		if resolver == nil {
			continue
		}
		part, err := resolver.ListModelPlanReferences(ctx, workspaceID, planID)
		if err != nil {
			return nil, err
		}
		references = append(references, part...)
	}
	return references, nil
}
