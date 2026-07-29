// Package modelplan defines the workspace-level model access plan domain.
//
// A model access plan is a named, reusable model access configuration
// (credential, protocol, base URL, model list, detection state). Plans are
// workspace-global resources referenced by agent targets; multiple named
// plans may share one protocol.
package modelplan

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Protocol is the wire protocol family used to call the plan's models.
type Protocol string

const (
	ProtocolOpenAI    Protocol = "openai"
	ProtocolAnthropic Protocol = "anthropic"
)

func IsProtocol(value string) bool {
	switch Protocol(value) {
	case ProtocolOpenAI, ProtocolAnthropic:
		return true
	default:
		return false
	}
}

// TemplateKind is the access-scheme template a plan was created from. It is a
// presentation and guidance hint; runtime behavior derives from Protocol.
type TemplateKind string

const (
	TemplateOfficialSubscription TemplateKind = "official_subscription"
	TemplateCodingPlan           TemplateKind = "coding_plan"
	TemplateDomestic             TemplateKind = "domestic"
	TemplateRelay                TemplateKind = "relay"
	TemplateCustom               TemplateKind = "custom"
)

func IsTemplateKind(value string) bool {
	switch TemplateKind(value) {
	case TemplateOfficialSubscription, TemplateCodingPlan, TemplateDomestic, TemplateRelay, TemplateCustom:
		return true
	default:
		return false
	}
}

// DetectionStage identifies one stage of the staged connection check.
type DetectionStage string

const (
	StageNetwork        DetectionStage = "network"
	StageAuth           DetectionStage = "auth"
	StageModelDiscovery DetectionStage = "model_discovery"
	StageInference      DetectionStage = "inference"
)

// DetectionStages lists every stage in execution order.
func DetectionStages() []DetectionStage {
	return []DetectionStage{StageNetwork, StageAuth, StageModelDiscovery, StageInference}
}

// StageStatus is the outcome of one detection stage.
type StageStatus string

const (
	StagePassed  StageStatus = "passed"
	StageFailed  StageStatus = "failed"
	StageSkipped StageStatus = "skipped"
)

// StageResult is the structured record of one detection stage run.
type StageResult struct {
	Stage         DetectionStage `json:"stage"`
	Status        StageStatus    `json:"status"`
	LatencyMs     int64          `json:"latencyMs,omitempty"`
	FailureReason string         `json:"failureReason,omitempty"`
	Remedy        string         `json:"remedy,omitempty"`
	Detail        string         `json:"detail,omitempty"`
	CheckedAt     time.Time      `json:"checkedAt,omitempty"`
}

// DetectionSnapshot is the latest staged detection outcome for a plan.
type DetectionSnapshot struct {
	Stages    []StageResult `json:"stages"`
	CheckedAt time.Time     `json:"checkedAt,omitempty"`
	// Model is the model id exercised by the inference stage.
	Model string `json:"model,omitempty"`
}

// StageOutcome returns the recorded result for one stage.
func (d DetectionSnapshot) StageOutcome(stage DetectionStage) (StageResult, bool) {
	for _, result := range d.Stages {
		if result.Stage == stage {
			return result, true
		}
	}
	return StageResult{}, false
}

// CorePassed reports whether the daemon-verifiable stages (network through
// inference) all passed or were explicitly skipped.
func (d DetectionSnapshot) CorePassed() bool {
	core := []DetectionStage{StageNetwork, StageAuth, StageModelDiscovery, StageInference}
	for _, stage := range core {
		result, ok := d.StageOutcome(stage)
		if !ok {
			return false
		}
		if result.Status != StagePassed && result.Status != StageSkipped {
			return false
		}
	}
	return true
}

// PlanStatus is the derived lifecycle status shown to users.
type PlanStatus string

const (
	StatusDisabled        PlanStatus = "disabled"
	StatusUndetected      PlanStatus = "undetected"
	StatusDetectionFailed PlanStatus = "detection_failed"
	StatusReady           PlanStatus = "ready"
)

// Model is one model exposed by a plan.
type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Capabilities uses the shared capability vocabulary (for example
	// "vision", "reasoning", "functionCalling"). Empty means unknown.
	Capabilities []string `json:"capabilities,omitempty"`
	// Pricing stores user/provider supplied unit prices as currency micros
	// per one million tokens. It is metadata only and never contains
	// credentials.
	Pricing *ModelPricing `json:"pricing,omitempty"`
}

// BillingMode distinguishes metered API cost from subscription quota
// protection. Subscription plans never expose a fabricated monetary amount.
type BillingMode string

const (
	BillingAPIMetered        BillingMode = "api_metered"
	BillingSubscriptionQuota BillingMode = "subscription_quota"
)

func (kind TemplateKind) BillingMode() BillingMode {
	switch kind {
	case TemplateOfficialSubscription, TemplateCodingPlan:
		return BillingSubscriptionQuota
	default:
		return BillingAPIMetered
	}
}

// ModelPricing stores user/provider supplied unit prices as currency micros
// per one million tokens. It is metadata only and never contains credentials.
type ModelPricing struct {
	Currency                   string `json:"currency"`
	InputMicrosPerMillion      int64  `json:"inputMicrosPerMillion"`
	OutputMicrosPerMillion     int64  `json:"outputMicrosPerMillion"`
	CacheReadMicrosPerMillion  int64  `json:"cacheReadMicrosPerMillion"`
	CacheWriteMicrosPerMillion int64  `json:"cacheWriteMicrosPerMillion"`
}

// Plan is the durable model access plan record.
type Plan struct {
	ID          string
	WorkspaceID string
	// Revision is a monotonically increasing immutable configuration version.
	// Runtime-facing consumers use it to pin the exact plan configuration a
	// session started with. Zero means unspecified for records written
	// before revisions were tracked.
	Revision     uint64
	Name         string
	TemplateKind TemplateKind
	Protocol     Protocol
	// APIKey never serializes; only PublicPlan projections leave the daemon.
	APIKey       string `json:"-"`
	BaseURL      string
	Models       []Model
	DefaultModel string
	Enabled      bool
	Detection    DetectionSnapshot
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Status derives the user-facing lifecycle status.
func (p Plan) Status() PlanStatus {
	if !p.Enabled {
		return StatusDisabled
	}
	if len(p.Detection.Stages) == 0 {
		return StatusUndetected
	}
	if !p.Detection.CorePassed() {
		return StatusDetectionFailed
	}
	return StatusReady
}

// PublicPlan is the redaction-safe projection of a plan.
type PublicPlan struct {
	ID           string            `json:"id"`
	WorkspaceID  string            `json:"workspaceId"`
	Revision     uint64            `json:"revision"`
	Name         string            `json:"name"`
	BillingMode  BillingMode       `json:"billingMode"`
	TemplateKind TemplateKind      `json:"templateKind"`
	Protocol     Protocol          `json:"protocol"`
	HasAPIKey    bool              `json:"hasApiKey"`
	BaseURL      string            `json:"baseUrl,omitempty"`
	Models       []Model           `json:"models"`
	DefaultModel string            `json:"defaultModel,omitempty"`
	Enabled      bool              `json:"enabled"`
	Status       PlanStatus        `json:"status"`
	Detection    DetectionSnapshot `json:"detection"`
	CreatedAt    time.Time         `json:"createdAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`
}

// Public projects a plan into its redaction-safe form.
func Public(plan Plan) PublicPlan {
	return PublicPlan{
		ID:           plan.ID,
		WorkspaceID:  plan.WorkspaceID,
		Revision:     plan.Revision,
		Name:         plan.Name,
		BillingMode:  plan.TemplateKind.BillingMode(),
		TemplateKind: plan.TemplateKind,
		Protocol:     plan.Protocol,
		HasAPIKey:    plan.APIKey != "",
		BaseURL:      plan.BaseURL,
		Models:       CloneModels(plan.Models),
		DefaultModel: plan.DefaultModel,
		Enabled:      plan.Enabled,
		Status:       plan.Status(),
		Detection:    plan.Detection,
		CreatedAt:    plan.CreatedAt,
		UpdatedAt:    plan.UpdatedAt,
	}
}

// ReferenceKind identifies what kind of consumer references a plan.
type ReferenceKind string

const (
	ReferenceAgentTarget    ReferenceKind = "agent_target"
	ReferenceModelPolicy    ReferenceKind = "model_policy"
	ReferenceWorkspaceAgent ReferenceKind = "workspace_agent"
	ReferenceAutomationRule ReferenceKind = "automation_rule"
)

// Reference is one consumer that currently references a plan. Deleting a plan
// with live references must be blocked until the consumer is rebound.
type Reference struct {
	Kind ReferenceKind `json:"kind"`
	ID   string        `json:"id"`
	Name string        `json:"name,omitempty"`
	// Role describes how the consumer uses the plan. Agent target bindings
	// report "default"; model usage policies report the bound role
	// ("execution", "planning", or "review").
	Role string `json:"role,omitempty"`
}

var (
	ErrInvalidPlan = errors.New("invalid model plan")
)

// Normalize validates and canonicalizes a plan record.
func Normalize(plan Plan) (Plan, error) {
	plan.ID = strings.TrimSpace(plan.ID)
	plan.WorkspaceID = strings.TrimSpace(plan.WorkspaceID)
	plan.Name = strings.TrimSpace(plan.Name)
	plan.BaseURL = strings.TrimSpace(plan.BaseURL)
	plan.DefaultModel = strings.TrimSpace(plan.DefaultModel)
	if plan.ID == "" {
		return Plan{}, fmt.Errorf("%w: id is required", ErrInvalidPlan)
	}
	if plan.WorkspaceID == "" {
		return Plan{}, fmt.Errorf("%w: workspace id is required", ErrInvalidPlan)
	}
	if plan.Name == "" {
		return Plan{}, fmt.Errorf("%w: name is required", ErrInvalidPlan)
	}
	if !IsProtocol(string(plan.Protocol)) {
		return Plan{}, fmt.Errorf("%w: protocol is unsupported", ErrInvalidPlan)
	}
	if plan.TemplateKind == "" {
		plan.TemplateKind = TemplateCustom
	}
	if !IsTemplateKind(string(plan.TemplateKind)) {
		return Plan{}, fmt.Errorf("%w: template kind is unsupported", ErrInvalidPlan)
	}
	plan.Models = NormalizeModels(plan.Models)
	if plan.DefaultModel != "" && !ModelsContain(plan.Models, plan.DefaultModel) {
		return Plan{}, fmt.Errorf("%w: default model is not in the model list", ErrInvalidPlan)
	}
	return plan, nil
}

// NormalizeModels trims, de-duplicates by id, and defaults names to ids.
func NormalizeModels(models []Model) []Model {
	seen := map[string]bool{}
	normalized := make([]Model, 0, len(models))
	for _, model := range models {
		id := strings.TrimSpace(model.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(model.Name)
		if name == "" {
			name = id
		}
		capabilities := make([]string, 0, len(model.Capabilities))
		capSeen := map[string]bool{}
		for _, capability := range model.Capabilities {
			capability = strings.TrimSpace(capability)
			if capability == "" || capSeen[capability] {
				continue
			}
			capSeen[capability] = true
			capabilities = append(capabilities, capability)
		}
		if len(capabilities) == 0 {
			capabilities = nil
		}
		normalized = append(normalized, Model{ID: id, Name: name, Capabilities: capabilities})
	}
	return normalized
}

// ModelsContain reports whether the model list includes the model id.
func ModelsContain(models []Model, modelID string) bool {
	modelID = strings.TrimSpace(modelID)
	for _, model := range models {
		if model.ID == modelID {
			return true
		}
	}
	return false
}

// CloneModels returns a defensive copy that is never nil.
func CloneModels(models []Model) []Model {
	if len(models) == 0 {
		return []Model{}
	}
	return append([]Model(nil), models...)
}
