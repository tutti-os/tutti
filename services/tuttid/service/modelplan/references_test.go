package modelplan

import (
	"context"
	"errors"
	"testing"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

type erroringReferences struct{ err error }

func (e erroringReferences) ListModelPlanReferences(context.Context, string, string) ([]modelplanbiz.Reference, error) {
	return nil, e.err
}

func TestCompositeReferenceResolverConcatenatesConsumers(t *testing.T) {
	t.Parallel()

	bindings := staticReferences{references: []modelplanbiz.Reference{
		{Kind: modelplanbiz.ReferenceAgentTarget, ID: "local:codex", Name: "Codex"},
	}}
	policies := staticReferences{references: []modelplanbiz.Reference{
		{Kind: modelplanbiz.ReferenceModelPolicy, ID: "pol-1", Name: "Careful", Role: "review"},
	}}

	// A nil resolver is skipped rather than panicking so wiring can compose
	// optional consumers.
	composite := CompositeReferenceResolver{bindings, nil, policies}
	references, err := composite.ListModelPlanReferences(context.Background(), "ws", "mp-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	if len(references) != 2 {
		t.Fatalf("references = %#v, want both binding and policy consumers", references)
	}
	kinds := map[modelplanbiz.ReferenceKind]bool{}
	for _, reference := range references {
		kinds[reference.Kind] = true
	}
	if !kinds[modelplanbiz.ReferenceAgentTarget] || !kinds[modelplanbiz.ReferenceModelPolicy] {
		t.Fatalf("references kinds = %#v, want agent_target and model_policy", kinds)
	}
}

func TestCompositeReferenceResolverPropagatesError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("boom")
	composite := CompositeReferenceResolver{
		staticReferences{references: []modelplanbiz.Reference{{Kind: modelplanbiz.ReferenceAgentTarget, ID: "local:codex"}}},
		erroringReferences{err: sentinel},
	}
	if _, err := composite.ListModelPlanReferences(context.Background(), "ws", "mp-1"); !errors.Is(err, sentinel) {
		t.Fatalf("ListModelPlanReferences() error = %v, want sentinel", err)
	}
}

func TestCompositeReferenceResolverEmptyReturnsNonNil(t *testing.T) {
	t.Parallel()

	references, err := CompositeReferenceResolver{}.ListModelPlanReferences(context.Background(), "ws", "mp-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	if references == nil {
		t.Fatalf("references = nil, want non-nil empty slice")
	}
	if len(references) != 0 {
		t.Fatalf("references = %#v, want empty", references)
	}
}
