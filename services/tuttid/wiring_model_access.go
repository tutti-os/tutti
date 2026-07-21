package main

import (
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	modelbindingservice "github.com/tutti-os/tutti/services/tuttid/service/modelbinding"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
	modelpolicyservice "github.com/tutti-os/tutti/services/tuttid/service/modelpolicy"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
)

// modelAccessWiring carries the model-access services (bindings, workspace
// agents, automation rules, policies, plans, collaboration runs) assembled by
// wireModelAccessServices.
type modelAccessWiring struct {
	modelBindings   *modelbindingservice.Service
	workspaceAgents *workspaceagentservice.Service
	automationRules *automationruleservice.Service
	modelPolicies   *modelpolicyservice.Service
	modelPlans      *modelplanservice.Service
	collabRuns      *collabrunservice.Service
}

// wireModelAccessServices assembles the model access service cluster and the
// review-automation links between them. Moved out of buildDaemonAPI to keep
// wiring.go within the file-length budget; construction order is unchanged.
func wireModelAccessServices(
	store workspacedata.CatalogStore,
	modelPlansStore workspacedata.ModelPlansStore,
	modelPlanFirstUseStore workspacedata.ModelPlanFirstUseStore,
	agentTargetStore workspacedata.AgentTargetStore,
	modelConfigurationPublisher eventstreamservice.AgentModelConfigurationPublisher,
	events *eventstreamservice.Service,
) modelAccessWiring {
	modelBindingsStore, _ := store.(workspacedata.AgentModelBindingsStore)
	modelBindings := &modelbindingservice.Service{
		Store:   modelBindingsStore,
		Plans:   modelPlansStore,
		Targets: agentTargetStore,
	}
	workspaceAgentsStore, _ := store.(workspacedata.WorkspaceAgentsStore)
	workspaceAgents := &workspaceagentservice.Service{
		Store:      workspaceAgentsStore,
		Targets:    agentTargetStore,
		Plans:      modelPlansStore,
		Workspaces: store,
		Publisher:  modelConfigurationPublisher,
	}
	automationRulesStore, _ := store.(workspacedata.AutomationRulesStore)
	automationRules := &automationruleservice.Service{
		Store:     automationRulesStore,
		Agents:    workspaceAgents,
		Targets:   agentTargetStore,
		Usage:     automationRulesStore,
		Publisher: eventstreamservice.AgentAutomationRulesPublisher{Service: events},
	}
	modelPolicyStore, _ := store.(modelpolicyservice.Store)
	modelPolicies := &modelpolicyservice.Service{
		Store: modelPolicyStore,
	}
	modelPlans := &modelplanservice.Service{
		Store:         modelPlansStore,
		FirstUseStore: modelPlanFirstUseStore,
		References:    modelplanservice.CompositeReferenceResolver{modelBindings, workspaceAgents, modelPolicies},
	}
	collabRunsStore, _ := store.(workspacedata.CollaborationRunsStore)
	collabRuns := &collabrunservice.Service{
		Store:     collabRunsStore,
		Plans:     modelPlansStore,
		Completer: modelPlans,
		Publisher: eventstreamservice.AgentCollaborationPublisher{Service: events},
	}
	modelPolicies.ConfigureReviewAutomation(modelBindingsStore, nil, collabRuns, collabRuns)
	return modelAccessWiring{
		modelBindings:   modelBindings,
		workspaceAgents: workspaceAgents,
		automationRules: automationRules,
		modelPolicies:   modelPolicies,
		modelPlans:      modelPlans,
		collabRuns:      collabRuns,
	}
}
