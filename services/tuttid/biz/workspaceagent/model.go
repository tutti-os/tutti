// Package workspaceagent defines named, workspace-scoped Agent
// configurations. A WorkspaceAgent is the user-facing Agent option: it maps
// one daemon-owned Harness target to an optional model access plan and keeps
// Agent-specific behavior separate from the Harness implementation.
package workspaceagent

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

const (
	IDPrefix       = "workspace-agent:"
	legacyIDPrefix = IDPrefix + "legacy:"

	SourceUser          = "user"
	SourceLegacyBinding = "legacy_binding"

	maxNameLength         = 120
	maxPurposeLength      = 1000
	maxInstructionsLength = 100000
)

var ErrInvalidAgent = errors.New("invalid workspace agent")

// Agent is the durable configuration. Its ID is also the opaque AgentTargetID
// presented to AgentGUI and session creation APIs.
type Agent struct {
	ID                   string     `json:"id"`
	WorkspaceID          string     `json:"workspaceId"`
	Name                 string     `json:"name"`
	Purpose              string     `json:"purpose"`
	HarnessAgentTargetID string     `json:"harnessAgentTargetId"`
	ModelPlanID          string     `json:"modelPlanId,omitempty"`
	DefaultModel         string     `json:"defaultModel,omitempty"`
	ModelFallbacks       []ModelRef `json:"modelFallbacks"`
	Instructions         string     `json:"instructions"`
	CallConditions       []string   `json:"callConditions"`
	CapabilitiesExplicit bool       `json:"capabilitiesExplicit"`
	Skills               []string   `json:"skills"`
	Tools                []string   `json:"tools"`
	Permissions          []string   `json:"permissions"`
	Enabled              bool       `json:"enabled"`
	Source               string     `json:"source"`
	Revision             int64      `json:"revision"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

// ModelRef is one ordered fallback destination. It is deliberately explicit:
// the runtime never searches arbitrary credentials when a Plan is unavailable.
type ModelRef struct {
	ModelPlanID string `json:"modelPlanId"`
	Model       string `json:"model,omitempty"`
}

// Harness is the redaction-safe target projection shown with an Agent. An
// Agent remains listable when the referenced target disappears so it can be
// repaired or deleted.
type Harness struct {
	AgentTargetID string `json:"agentTargetId"`
	Available     bool   `json:"available"`
	Provider      string `json:"provider,omitempty"`
	Name          string `json:"name,omitempty"`
	IconKey       string `json:"iconKey,omitempty"`
	Enabled       bool   `json:"enabled,omitempty"`
}

// View is the public, redaction-safe WorkspaceAgent representation.
type View struct {
	Agent   Agent   `json:"agent"`
	Harness Harness `json:"harness"`
}

// Resolved is the runtime-facing WorkspaceAgent configuration. ModelPlan may
// contain the daemon-owned credential and must never be serialized to clients.
type Resolved struct {
	Agent          Agent
	HarnessTarget  agenttargetbiz.Target
	ModelPlan      *modelplanbiz.Plan
	EffectiveModel string
}

// Normalize validates and canonicalizes one durable Agent record.
func Normalize(agent Agent) (Agent, error) {
	agent.ID = strings.TrimSpace(agent.ID)
	agent.WorkspaceID = strings.TrimSpace(agent.WorkspaceID)
	agent.Name = strings.TrimSpace(agent.Name)
	agent.Purpose = strings.TrimSpace(agent.Purpose)
	agent.HarnessAgentTargetID = strings.TrimSpace(agent.HarnessAgentTargetID)
	agent.ModelPlanID = strings.TrimSpace(agent.ModelPlanID)
	agent.DefaultModel = strings.TrimSpace(agent.DefaultModel)
	agent.ModelFallbacks = normalizeModelRefs(agent.ModelFallbacks)
	agent.Instructions = strings.TrimSpace(agent.Instructions)
	agent.Source = strings.TrimSpace(agent.Source)
	agent.CallConditions = NormalizeStringList(agent.CallConditions)
	agent.Skills = NormalizeStringList(agent.Skills)
	agent.Tools = NormalizeStringList(agent.Tools)
	agent.Permissions = NormalizeStringList(agent.Permissions)

	switch {
	case agent.ID == "":
		return Agent{}, fmt.Errorf("%w: id is required", ErrInvalidAgent)
	case agent.WorkspaceID == "":
		return Agent{}, fmt.Errorf("%w: workspace id is required", ErrInvalidAgent)
	case agent.Name == "":
		return Agent{}, fmt.Errorf("%w: name is required", ErrInvalidAgent)
	case utf8.RuneCountInString(agent.Name) > maxNameLength:
		return Agent{}, fmt.Errorf("%w: name is too long", ErrInvalidAgent)
	case utf8.RuneCountInString(agent.Purpose) > maxPurposeLength:
		return Agent{}, fmt.Errorf("%w: purpose is too long", ErrInvalidAgent)
	case utf8.RuneCountInString(agent.Instructions) > maxInstructionsLength:
		return Agent{}, fmt.Errorf("%w: instructions are too long", ErrInvalidAgent)
	case agent.HarnessAgentTargetID == "":
		return Agent{}, fmt.Errorf("%w: harness agent target id is required", ErrInvalidAgent)
	case agent.DefaultModel != "" && agent.ModelPlanID == "":
		return Agent{}, fmt.Errorf("%w: default model requires a model plan", ErrInvalidAgent)
	case len(agent.ModelFallbacks) > 0 && agent.ModelPlanID == "":
		return Agent{}, fmt.Errorf("%w: model fallbacks require a primary model plan", ErrInvalidAgent)
	case agent.Source != SourceUser && agent.Source != SourceLegacyBinding:
		return Agent{}, fmt.Errorf("%w: source is unsupported", ErrInvalidAgent)
	case agent.Revision < 1:
		return Agent{}, fmt.Errorf("%w: revision must be positive", ErrInvalidAgent)
	}

	return agent, nil
}

// NormalizeStringList trims, removes empty values, and de-duplicates while
// preserving the user's order.
func NormalizeStringList(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

// Clone returns an Agent whose list fields do not alias the input.
func Clone(agent Agent) Agent {
	agent.CallConditions = append([]string(nil), agent.CallConditions...)
	agent.Skills = append([]string(nil), agent.Skills...)
	agent.Tools = append([]string(nil), agent.Tools...)
	agent.Permissions = append([]string(nil), agent.Permissions...)
	agent.ModelFallbacks = append([]ModelRef(nil), agent.ModelFallbacks...)
	if agent.Skills == nil {
		agent.Skills = []string{}
	}
	if agent.CallConditions == nil {
		agent.CallConditions = []string{}
	}
	if agent.Tools == nil {
		agent.Tools = []string{}
	}
	if agent.Permissions == nil {
		agent.Permissions = []string{}
	}
	if agent.ModelFallbacks == nil {
		agent.ModelFallbacks = []ModelRef{}
	}
	return agent
}

func normalizeModelRefs(values []ModelRef) []ModelRef {
	result := make([]ModelRef, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value.ModelPlanID = strings.TrimSpace(value.ModelPlanID)
		value.Model = strings.TrimSpace(value.Model)
		if value.ModelPlanID == "" {
			continue
		}
		key := value.ModelPlanID + "\x00" + value.Model
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result
}

// LegacyBindingID deterministically maps a legacy workspace/target binding to
// one opaque WorkspaceAgent id. The hash avoids leaking arbitrary target ids
// into HTTP path segments while remaining idempotent across migrations.
func LegacyBindingID(workspaceID string, harnessAgentTargetID string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(harnessAgentTargetID)))
	return fmt.Sprintf("%s%x", legacyIDPrefix, digest[:12])
}
