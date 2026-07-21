package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agenttargetservice "github.com/tutti-os/tutti/services/tuttid/service/agenttarget"
	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	agentcontextcli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/agentcontext"
	browsercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/browser"
	computercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/computer"
	diagnosticscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/diagnostics"
	issuemanagercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/issuemanager"
	managedmodelscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/managedmodels"
	referencescli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/references"
	tuttimodeplancli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/tuttimodeplan"
	workbenchappscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/workbenchapps"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

// tuttiIssueWiring carries the issue orchestration and Tutti Mode planning
// services buildDaemonAPI assembles through wireIssueAndTuttiModeServices.
type tuttiIssueWiring struct {
	issueService   workspaceservice.IssueManagerService
	tuttiModePlans *tuttimodeplanservice.Service
}

// wireIssueAndTuttiModeServices assembles the issue manager and Tutti Mode
// plan services, links their observers, and runs the one-shot durable
// recovery passes. Moved out of buildDaemonAPI to keep wiring.go within the
// file-length budget; behavior is unchanged.
func wireIssueAndTuttiModeServices(
	ctx context.Context,
	events *eventstreamservice.Service,
	agentSessionService *agentservice.Service,
	agentActivityProjection *agentservice.ActivityProjection,
	issueStore workspaceissues.Store,
	agentTargetStore workspacedata.AgentTargetStore,
	agentActivityRepo workspacedata.AgentActivityStore,
	workflowStore tuttimodeplanservice.Store,
	sourceSessionDeletionStore tuttimodeplanservice.SourceSessionDeletionStore,
	tuttiModeFeatureFlags func(context.Context) (map[string]bool, error),
) (tuttiIssueWiring, error) {
	issueService := workspaceservice.IssueManagerService{
		AgentSessionCreator: agentSessionService,
		AgentSessionReader:  agentActivityProjection,
		Publisher:           eventstreamservice.WorkspaceIssuePublisher{Service: events},
		Store:               issueStore,
		AgentTargetReader:   agentTargetStore,
		PlanningTimeline:    agentservice.IssuePlanningTimelineReporter{Projection: agentActivityProjection},
		CompletionNotifier: &tuttiPlanIssueCompletionDispatcher{
			Agents: agentSessionService,
		},
		RunTurnResolver: agentActivityRepo,
		MutationLocks:   workspaceservice.NewIssueMutationLocks(),
	}
	tuttiModePlans := &tuttimodeplanservice.Service{
		Store:                  workflowStore,
		SourceSessionDeletions: sourceSessionDeletionStore,
		Revisions:              workspacedata.WorkflowRevisionFiles{StateDir: tuttitypes.DefaultStateDir()},
		Publisher:              eventstreamservice.WorkspaceWorkflowPublisher{Service: events},
		IssueMaterializer:      tuttimodeplanservice.WorkspaceIssueMaterializer{Issues: &issueService},
		FeatureFlags:           tuttiModeFeatureFlags,
		FeedbackDispatcher: &tuttiModePlanFeedbackDispatcher{
			Agents:    agentSessionService,
			TurnLinks: workflowStore,
		},
	}
	if sourceSessionDeletionStore != nil {
		agentSessionService.SourceSessionDeletions = tuttiModePlans
		agentSessionService.SessionDeletionEvents = agentActivityProjection
	}
	// Recover accepted Tutti Mode plans before buildDaemonAPI returns the
	// public service graph. This is a one-shot durable recovery pass, not a
	// background worker; deterministic Issue materialization makes retries
	// converge after a response or process loss.
	if workflowStore != nil {
		// The single-review flow retired the two-phase configuration
		// checkpoint. Cancel any legacy pending configuration reviews first so
		// stale review panels cannot reappear alongside the new flow. A
		// failure to retire one legacy row must not block daemon startup; the
		// next boot retries the remaining pending rows idempotently.
		if err := tuttiModePlans.RetireConfigurationReviewWorkflows(ctx); err != nil {
			slog.Warn("retire legacy Tutti Mode configuration reviews failed",
				"event", "tutti_mode_plan.configuration_review_retirement_failed",
				"error", err)
		}
		if err := tuttiModePlans.RecoverCreateIssueOperations(ctx); err != nil {
			return tuttiIssueWiring{}, fmt.Errorf("recover Tutti Mode plan operations: %w", err)
		}
	}
	issueService.RunSessionCanceller = agentCollaborationSessionCanceller{Service: agentSessionService}
	// A user's stop on a planning conversation cascades to every running task
	// run its accepted plan dispatched.
	agentSessionService.TurnCancelObserver = &issueService
	issueService.RunReconcileQueue = workspaceservice.NewIssueRunReconcileQueue(workspaceservice.IssueRunReconcileQueueOptions{
		Delay:     3 * time.Second,
		Interval:  15 * time.Second,
		Reconcile: issueService.ReconcileRunningRuns,
	})
	return tuttiIssueWiring{issueService: issueService, tuttiModePlans: tuttiModePlans}, nil
}

// buildDaemonCLIProviders assembles the workspace CLI provider list. Moved
// out of buildDaemonAPI to keep wiring.go within the file-length budget;
// provider order is unchanged.
func buildDaemonCLIProviders(
	workspaceService workspaceservice.CatalogService,
	issueService workspaceservice.IssueManagerService,
	appCenterService *workspaceservice.AppCenterService,
	managedCredentials *managedcredentialsservice.Service,
	events *eventstreamservice.Service,
	agentSessionService *agentservice.Service,
	agentTargets agenttargetservice.Service,
	preferences *preferencesservice.Service,
	tuttiModePlans *tuttimodeplanservice.Service,
	browserService *browsersvc.Service,
	computerService *computersvc.Service,
) []cliservice.Provider {
	cliProviders := []cliservice.Provider{
		diagnosticscli.NewProvider(),
		managedmodelscli.NewProvider(managedCredentials),
		issuemanagercli.NewProvider(workspaceService, issueService, appCenterService),
		referencescli.NewProvider(workspaceService, appCenterService, issueService),
		workbenchappscli.NewProvider(
			workspaceService,
			appCenterService,
			eventstreamservice.WorkbenchNodeLaunchPublisher{Service: events},
		),
		agentcontextcli.NewProviderWithAgentTargets(
			workspaceService,
			agentSessionService,
			eventstreamservice.AgentGUILaunchPublisher{Service: events},
			agentTargets,
			preferences,
		),
		tuttimodeplancli.NewProvider(workspaceService, tuttiModePlans, agentSessionService),
	}
	if browserService != nil {
		cliProviders = append(cliProviders, browsercli.NewProvider(workspaceService, browserService))
	}
	if computerService != nil {
		cliProviders = append(cliProviders, computercli.NewProvider(workspaceService, computerService))
	}
	return cliProviders
}
