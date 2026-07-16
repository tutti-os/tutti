package modelconsult

import (
	"context"
	"strings"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

// consultContextMaxChars bounds caller-supplied context so one consult cannot
// swallow a plan budget with an unbounded transcript paste.
const consultContextMaxChars = 4000

type modelPlansInput struct{}

func (p Provider) newModelPlansCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[modelPlansInput]{
		ID:          appID + ".agent.model-plans",
		Path:        []string{"agent", "model-plans"},
		Summary:     "List model access plans available to consult",
		Description: "List enabled workspace model access plans and their models. Use this to find a --model-plan-id (and optionally --model) for `agent consult`.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[modelPlansInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: modelPlansJSONValue,
			},
			ListCompact: true,
		},
		Run: p.runModelPlans,
	})
}

func (p Provider) runModelPlans(ctx context.Context, invoke framework.InvokeContext, _ modelPlansInput) (any, error) {
	if err := p.requirePlans(); err != nil {
		return nil, err
	}
	plans, err := p.plans.ListPlans(ctx, invoke.WorkspaceID)
	if err != nil {
		return nil, err
	}
	enabled := make([]modelplanbiz.PublicPlan, 0, len(plans))
	for _, plan := range plans {
		if plan.Enabled {
			enabled = append(enabled, plan)
		}
	}
	return enabled, nil
}

func modelPlansJSONValue(result any) map[string]any {
	plans := result.([]modelplanbiz.PublicPlan)
	values := make([]map[string]any, 0, len(plans))
	for _, plan := range plans {
		models := make([]map[string]any, 0, len(plan.Models))
		for _, model := range plan.Models {
			value := map[string]any{"id": model.ID, "name": model.Name, "capabilities": append([]string(nil), model.Capabilities...)}
			if model.Pricing != nil {
				value["pricing"] = modelPricingJSONValue(model.Pricing)
			}
			models = append(models, value)
		}
		values = append(values, map[string]any{
			"id":           plan.ID,
			"name":         plan.Name,
			"protocol":     string(plan.Protocol),
			"defaultModel": plan.DefaultModel,
			"models":       models,
		})
	}
	return map[string]any{"plans": values}
}

type recommendModelsInput struct {
	RequiredCapabilities []string `cli:"required-capability" description:"Required model capability. May be passed multiple times (for example vision or reasoning)."`
	PreferredPlanID      string   `cli:"preferred-plan-id" description:"Preferred ModelPlan id, used only after detection health."`
	Limit                int      `cli:"limit" validate:"min=0,max=100" description:"Maximum routes to return; defaults to 10."`
}

func (p Provider) newRecommendModelsCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[recommendModelsInput]{
		ID:          appID + ".agent.recommend-models",
		Path:        []string{"agent", "recommend-models"},
		Summary:     "Recommend compatible workspace models",
		Description: "Filter enabled model access plans by capability and return the daemon-owned deterministic ranking with machine-readable reasons. Detection health outranks preference, and known same-currency pricing breaks ties.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[recommendModelsInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: recommendationsJSONValue,
			},
			ListCompact: true,
		},
		Run: p.runRecommendModels,
	})
}

func (p Provider) runRecommendModels(ctx context.Context, invoke framework.InvokeContext, input recommendModelsInput) (any, error) {
	if err := p.requirePlans(); err != nil {
		return nil, err
	}
	plans, err := p.plans.ListPlans(ctx, invoke.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return modelplanbiz.RecommendModels(plans, modelplanbiz.RecommendInput{
		RequiredCapabilities: input.RequiredCapabilities,
		PreferredPlanID:      input.PreferredPlanID,
		Limit:                input.Limit,
	}), nil
}

func recommendationsJSONValue(result any) map[string]any {
	recommendations := result.([]modelplanbiz.Recommendation)
	values := make([]map[string]any, 0, len(recommendations))
	for _, recommendation := range recommendations {
		value := map[string]any{
			"planId":       recommendation.PlanID,
			"planName":     recommendation.PlanName,
			"modelId":      recommendation.ModelID,
			"modelName":    recommendation.ModelName,
			"capabilities": append([]string(nil), recommendation.Capabilities...),
			"status":       string(recommendation.Status),
			"rank":         recommendation.Rank,
			"reasons":      append([]string(nil), recommendation.Reasons...),
		}
		if recommendation.Pricing != nil {
			value["pricing"] = modelPricingJSONValue(recommendation.Pricing)
		}
		values = append(values, value)
	}
	return map[string]any{"recommendations": values}
}

func modelPricingJSONValue(pricing *modelplanbiz.ModelPricing) map[string]any {
	return map[string]any{
		"currency":                   pricing.Currency,
		"inputMicrosPerMillion":      pricing.InputMicrosPerMillion,
		"outputMicrosPerMillion":     pricing.OutputMicrosPerMillion,
		"cacheReadMicrosPerMillion":  pricing.CacheReadMicrosPerMillion,
		"cacheWriteMicrosPerMillion": pricing.CacheWriteMicrosPerMillion,
	}
}

type consultInput struct {
	ModelPlanID string `cli:"model-plan-id" validate:"required" description:"Model access plan id from agent model-plans."`
	Model       string `cli:"model" description:"Model id to consult; defaults to the plan's default model."`
	Question    string `cli:"question" validate:"required" description:"The question or request for advice."`
	Context     string `cli:"context" description:"Optional supporting context (e.g. a conversation excerpt). Truncated to 4000 characters."`
	MaxTokens   int    `cli:"max-tokens" validate:"min=0" description:"Optional output token cap; the daemon also applies its own budget ceiling."`
}

func (p Provider) newConsultCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[consultInput]{
		ID:          appID + ".agent.consult",
		Path:        []string{"agent", "consult"},
		Summary:     "Consult another registered model for advice",
		Description: "Advisor mode: ask another workspace model-access-plan model for a second opinion on demand. Tool-free — the consulted model cannot execute tools and never takes ownership of this session's task; the reply is advice only. Use agent model-plans first to discover --model-plan-id/--model.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[consultInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: consultJSONValue,
			},
		},
		Run: p.runConsult,
	})
}

func (p Provider) runConsult(ctx context.Context, invoke framework.InvokeContext, input consultInput) (any, error) {
	if err := p.requireRuns(); err != nil {
		return nil, err
	}
	sessionID := strings.TrimSpace(invoke.Request.Context.AgentSessionID)
	if sessionID == "" {
		return nil, cliservice.MissingRequiredInputError("agent-session-id")
	}
	contextText := strings.TrimSpace(input.Context)
	if len(contextText) > consultContextMaxChars {
		contextText = contextText[:consultContextMaxChars]
	}
	run, err := p.runs.StartConsult(ctx, collabrunservice.StartConsultInput{
		WorkspaceID:     invoke.WorkspaceID,
		SourceSessionID: sessionID,
		ModelPlanID:     input.ModelPlanID,
		Model:           input.Model,
		Question:        input.Question,
		ContextText:     contextText,
		TriggerSource:   string(collabrunbiz.TriggerAgent),
		TriggerReason:   "cli",
		MaxTokens:       input.MaxTokens,
	})
	if err != nil {
		return nil, err
	}
	return run, nil
}

func consultJSONValue(result any) map[string]any {
	run := result.(collabrunbiz.Run)
	value := map[string]any{
		"id":          run.ID,
		"status":      string(run.Status),
		"model":       run.Model,
		"modelPlanId": run.ModelPlanID,
		"durationMs":  run.DurationMs,
		"usage": map[string]any{
			"inputTokens":  run.Usage.InputTokens,
			"outputTokens": run.Usage.OutputTokens,
		},
	}
	if run.ResultText != "" {
		value["resultText"] = run.ResultText
	}
	if run.FailureReason != "" {
		value["failureReason"] = run.FailureReason
	}
	return value
}
