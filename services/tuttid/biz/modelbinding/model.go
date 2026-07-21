// Package modelbinding defines the per-workspace binding between an agent
// target and its default model access plan and model. Bindings never duplicate
// agent targets: switching plans or models rebinds the same target.
package modelbinding

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidBinding = errors.New("invalid agent model binding")

// Binding is the durable per-workspace agent target model binding.
type Binding struct {
	WorkspaceID   string `json:"workspaceId"`
	AgentTargetID string `json:"agentTargetId"`
	// ModelPlanID references a workspace model access plan. Empty means the
	// target keeps its provider-native model source.
	ModelPlanID string `json:"modelPlanId,omitempty"`
	// DefaultModel is the model id used for new sessions unless overridden
	// before send. It must belong to the referenced plan when a plan is set.
	DefaultModel string    `json:"defaultModel,omitempty"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// IsZero reports whether the binding carries no configuration.
func (b Binding) IsZero() bool {
	return b.ModelPlanID == "" && b.DefaultModel == ""
}

// Normalize validates and canonicalizes a binding record.
func Normalize(binding Binding) (Binding, error) {
	binding.WorkspaceID = strings.TrimSpace(binding.WorkspaceID)
	binding.AgentTargetID = strings.TrimSpace(binding.AgentTargetID)
	binding.ModelPlanID = strings.TrimSpace(binding.ModelPlanID)
	binding.DefaultModel = strings.TrimSpace(binding.DefaultModel)
	if binding.WorkspaceID == "" {
		return Binding{}, fmt.Errorf("%w: workspace id is required", ErrInvalidBinding)
	}
	if binding.AgentTargetID == "" {
		return Binding{}, fmt.Errorf("%w: agent target id is required", ErrInvalidBinding)
	}
	if binding.DefaultModel != "" && binding.ModelPlanID == "" {
		return Binding{}, fmt.Errorf("%w: default model requires a model plan", ErrInvalidBinding)
	}
	return binding, nil
}
