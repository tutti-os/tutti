package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttiserver "github.com/tutti-os/tutti/services/tuttid/server"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
	agentmaintenanceservice "github.com/tutti-os/tutti/services/tuttid/service/agentmaintenance"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	agenttargetservice "github.com/tutti-os/tutti/services/tuttid/service/agenttarget"
	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	appclicli "github.com/tutti-os/tutti/services/tuttid/service/cli/appcli"
	agentcontextcli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/agentcontext"
	browsercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/browser"
	computercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/computer"
	diagnosticscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/diagnostics"
	issuemanagercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/issuemanager"
	managedmodelscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/managedmodels"
	modelconsultcli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/modelconsult"
	referencescli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/references"
	tuttimodeplancli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/tuttimodeplan"
	workbenchappscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/workbenchapps"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
	modelbindingservice "github.com/tutti-os/tutti/services/tuttid/service/modelbinding"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
	modelpolicyservice "github.com/tutti-os/tutti/services/tuttid/service/modelpolicy"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	tuttiagentservice "github.com/tutti-os/tutti/services/tuttid/service/tuttiagent"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type tuttiWiring struct {
	api                 tuttiapi.DaemonAPI
	appCenterService    *workspaceservice.AppCenterService
	workspaceStore      *workspacedata.SQLiteStore
	analyticsReporter   reporterservice.Reporter
	browserService      *browsersvc.Service
	computerService     *computersvc.Service
	agentTargetSetup    *agentextensionservice.SetupService
	agentRuntime        *agentdaemon.Runtime
	providerAuthWatcher *agentservice.ProviderAuthWatcher
}

type analyticsDebugEventPublisher struct {
	service analyticsDebugEventStream
}

type analyticsDebugEventStream interface {
	PublishFromServer(context.Context, string, []byte) error
}

type analyticsDebugReportedPayload struct {
	Events []analyticsDebugReportedEventPayload `json:"events"`
}

type analyticsDebugReportedEventPayload struct {
	Name     string         `json:"name"`
	ClientTS int64          `json:"clientTs"`
	Params   map[string]any `json:"params"`
}

func (p analyticsDebugEventPublisher) PublishAnalyticsDebugEvents(ctx context.Context, events []reporterservice.DebugEvent) {
	if p.service == nil || len(events) == 0 {
		return
	}
	payload := analyticsDebugReportedPayload{
		Events: make([]analyticsDebugReportedEventPayload, 0, len(events)),
	}
	for _, event := range events {
		payload.Events = append(payload.Events, analyticsDebugReportedEventPayload{
			Name:     event.Name,
			ClientTS: event.ClientTS,
			Params:   event.Params,
		})
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = p.service.PublishFromServer(ctx, eventstreamservice.TopicAnalyticsDebugReported, encoded)
}

func newTuttiWiring() (*tuttiWiring, error) {
	wiring := &tuttiWiring{}
	if err := wiring.buildWorkspaceModule(context.Background()); err != nil {
		_ = wiring.Close()
		return nil, err
	}

	return wiring, nil
}

func buildTuttiServer() (*http.Server, net.Listener, *tuttiWiring, error) {
	wiring, err := newTuttiWiring()
	if err != nil {
		return nil, nil, nil, err
	}

	listenerSpec, err := tuttiserver.ListenerSpecFromEnv()
	if err != nil {
		_ = wiring.Close()
		return nil, nil, nil, fmt.Errorf("resolve tuttid listener spec: %w", err)
	}
	listener, err := tuttiserver.NewListener(listenerSpec)
	if err != nil {
		_ = wiring.Close()
		return nil, nil, nil, fmt.Errorf("create tuttid listener: %w", err)
	}

	if err := tuttiserver.WriteListenerInfo(listener, listenerSpec); err != nil {
		_ = listener.Close()
		_ = wiring.Close()
		return nil, nil, nil, fmt.Errorf("write tuttid listener info: %w", err)
	}

	return tuttiserver.NewHTTPServer(listenerSpec, wiring.routes()), listener, wiring, nil
}

func (w *tuttiWiring) routes() tuttiserver.Routes {
	return tuttiapi.NewRoutes(w.api)
}

func (w *tuttiWiring) buildWorkspaceModule(ctx context.Context) error {
	workspaceStore, err := openWorkspaceStore(ctx)
	if err != nil {
		return err
	}

	w.workspaceStore = workspaceStore
	// Browser use is delivered through the daemon-owned `tutti browser` CLI;
	// the service owns a chrome-devtools-mcp subprocess per workspace.
	if runtimeprep.BrowserUseDefaultEnabled() {
		w.browserService = browsersvc.NewService(workspaceStore)
	}
	// Computer use is delivered through the daemon-owned `tutti computer` CLI;
	// the service owns a cua-driver MCP subprocess per workspace.
	if runtimeprep.ComputerUseDefaultEnabled() {
		w.computerService = computersvc.NewService()
	}
	api, appCenterService, agentRuntime, providerAuthWatcher, err := buildDaemonAPI(ctx, workspaceStore, nil, w.browserService, w.computerService)
	if err != nil {
		return err
	}
	agentTargetSetup, ok := api.AgentTargetSetupService.(*agentextensionservice.SetupService)
	if !ok {
		agentRuntime.Close()
		providerAuthWatcher.Close()
		return errors.New("agent target setup service wiring is invalid")
	}
	w.agentTargetSetup = agentTargetSetup
	w.agentRuntime = agentRuntime
	w.providerAuthWatcher = providerAuthWatcher

	analyticsConfig := tuttitypes.ResolveAnalyticsConfig()
	debugPublisher := resolveAnalyticsDebugPublisher(analyticsConfig, api.EventStreamService)
	analyticsReporter, err := reporterservice.New(reporterservice.Config{
		Analytics:      analyticsConfig,
		DebugPublisher: debugPublisher,
		StateDir:       tuttitypes.DefaultStateDir(),
	})
	if err != nil {
		return fmt.Errorf("create analytics reporter: %w", err)
	}
	attachAnalyticsReporter(&api, analyticsReporter)
	w.analyticsReporter = analyticsReporter
	w.api = api
	w.appCenterService = appCenterService
	return nil
}

func resolveAnalyticsDebugPublisher(analyticsConfig tuttitypes.AnalyticsConfig, service analyticsDebugEventStream) reporterservice.DebugPublisher {
	if analyticsConfig.Disabled || service == nil {
		return nil
	}
	return analyticsDebugEventPublisher{
		service: service,
	}
}

func attachAnalyticsReporter(api *tuttiapi.DaemonAPI, analyticsReporter reporterservice.Reporter) {
	if api == nil {
		return
	}
	api.AnalyticsReporter = analyticsReporter
	if service, ok := api.AgentSessionService.(*agentservice.Service); ok {
		service.AnalyticsReporter = analyticsReporter
		if projection, ok := service.SessionReader.(*agentservice.ActivityProjection); ok {
			projection.SetAnalyticsReporter(analyticsReporter)
		}
	}
	if service, ok := api.AgentStatusService.(*agentstatusservice.Service); ok {
		service.AnalyticsReporter = analyticsReporter
	}
}

func openWorkspaceStore(ctx context.Context) (*workspacedata.SQLiteStore, error) {
	workspaceStore, err := workspacedata.OpenSQLiteStore(workspacedata.DefaultDBPath())
	if err != nil {
		return nil, fmt.Errorf("open workspace database: %w", err)
	}
	if err := workspaceStore.Migrate(ctx); err != nil {
		_ = workspaceStore.Close()
		return nil, fmt.Errorf("migrate workspace database: %w", err)
	}

	return workspaceStore, nil
}

func buildDaemonAPI(ctx context.Context, store workspacedata.CatalogStore, analyticsReporter reporterservice.Reporter, browserService *browsersvc.Service, computerService *computersvc.Service) (tuttiapi.DaemonAPI, *workspaceservice.AppCenterService, *agentdaemon.Runtime, *agentservice.ProviderAuthWatcher, error) {
	workspaceStore, _ := store.(workspacedata.WorkbenchStore)
	issueStore, _ := store.(workspaceissues.Store)
	preferencesStore, _ := store.(workspacedata.PreferencesStore)
	agentTargetStore, _ := store.(workspacedata.AgentTargetStore)
	managedCredentialsStore, _ := store.(workspacedata.ManagedCredentialsStore)
	modelPlansStore, _ := store.(workspacedata.ModelPlansStore)
	agentActivityRepo, _ := store.(workspacedata.AgentActivityStore)
	userProjectStore, _ := store.(workspacedata.UserProjectStore)
	appStore, _ := store.(workspacedata.AppStore)
	appFactoryStore, _ := store.(workspacedata.AppFactoryStore)
	workflowStore, _ := store.(tuttimodeplanservice.Store)
	sourceSessionDeletionStore, _ := store.(tuttimodeplanservice.SourceSessionDeletionStore)
	tuttiModeActivationStore, _ := store.(tuttimodeactivationservice.Store)
	fileAdapter := workspacedata.LocalFilesAdapter{}

	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	preferencesPublisher := eventstreamservice.DesktopPreferencesPublisher{Service: events}
	tuttiModeActivations := &tuttimodeactivationservice.Service{
		Store:     tuttiModeActivationStore,
		Publisher: eventstreamservice.TuttiModeActivationPublisher{Service: events},
	}
	modelConfigurationPublisher := eventstreamservice.AgentModelConfigurationPublisher{Service: events}
	preferences := &preferencesservice.Service{
		Store:                          preferencesStore,
		Publisher:                      preferencesPublisher,
		AgentComposerDefaultsPublisher: preferencesPublisher,
	}
	agentTargets := agenttargetservice.Service{
		Store: agentTargetStore,
	}
	agentRuntimeDir, err := tuttitypes.DefaultAgentRuntimeDir()
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("resolve agent runtime directory: %w", err)
	}
	agentExtensionBinDir, err := tuttitypes.DefaultAgentExecutableDir()
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("resolve agent extension executable directory: %w", err)
	}
	agentExtensionStateDir := tuttitypes.DefaultStateDir()
	agentSetupDiscovery := agentextensiondata.NewFileSetupDiscoveryDirectory(agentExtensionStateDir)
	agentExtensionManager := &agentextensionservice.Manager{
		Sources:           tuttitypes.ResolveAgentExtensionSources(),
		RuntimeInstallDir: agentRuntimeDir,
		RuntimeBinDir:     agentExtensionBinDir,
		Store:             agentTargetStore,
		Installations:     agentextensiondata.NewFileInstallationStore(agentExtensionStateDir),
		Discovery:         agentSetupDiscovery,
		Preferences:       preferencesStore,
	}
	preferences.AfterPut = func(ctx context.Context, previous, current preferencesbiz.DesktopPreferences) {
		for _, reconcileErr := range agentExtensionManager.ReconcileDesktopPreferencesChange(ctx, previous, current) {
			payload, _ := json.Marshal(map[string]string{"error": reconcileErr.Error()})
			slog.Warn("agent_extension.reconcile_failed", "payload", string(payload))
		}
	}
	agentTargetInstallPlans := agentextensionservice.InstallPlanService{
		Manager: agentExtensionManager, Workspaces: store, Targets: agentTargetStore,
	}
	agentTargets.AvailabilityResolver = agentExtensionManager
	for _, reconcileErr := range agentExtensionManager.Reconcile(ctx) {
		payload, _ := json.Marshal(map[string]string{"error": reconcileErr.Error()})
		slog.Warn("agent_extension.reconcile_failed", "payload", string(payload))
	}
	managedCredentials := &managedcredentialsservice.Service{
		Store: managedCredentialsStore,
		Plans: modelPlansStore,
	}
	modelBindingsStore, _ := store.(workspacedata.AgentModelBindingsStore)
	modelBindings := &modelbindingservice.Service{
		Store:                  modelBindingsStore,
		Plans:                  modelPlansStore,
		Targets:                agentTargetStore,
		ConfigurationPublisher: modelConfigurationPublisher,
	}
	modelPolicyStore, _ := store.(modelpolicyservice.Store)
	modelPolicies := &modelpolicyservice.Service{
		Store: modelPolicyStore,
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
	modelPlans := &modelplanservice.Service{
		Store:                  modelPlansStore,
		References:             modelplanservice.CompositeReferenceResolver{modelBindings, workspaceAgents, automationRules, modelPolicies, managedCredentials},
		Bindings:               modelplanservice.CompositeAgentTargetBindingResolver{modelBindings, workspaceAgents},
		ConfigurationPublisher: modelConfigurationPublisher,
	}
	collabRunsStore, _ := store.(workspacedata.CollaborationRunsStore)
	collabRuns := &collabrunservice.Service{
		Store:     collabRunsStore,
		Plans:     modelPlansStore,
		Completer: modelPlans,
		Publisher: eventstreamservice.AgentCollaborationPublisher{Service: events},
	}
	events.RegisterIntentHandler(
		eventstreamservice.TopicPreferencesDesktopUpdateRequested,
		eventstreamservice.NewPreferencesDesktopUpdateRequestedHandler(preferences),
	)
	events.RegisterIntentHandler(
		eventstreamservice.TopicPreferencesAgentComposerDefaultsPatchRequested,
		eventstreamservice.NewPreferencesAgentComposerDefaultsPatchRequestedHandler(preferences),
	)
	agentActivityProjection := agentservice.NewActivityProjection(agentActivityRepo)
	collabRuns.Timeline = agentservice.CollaborationTimelineReporter{Projection: agentActivityProjection}
	agentActivityProjection.SetAnalyticsReporter(analyticsReporter)
	agentActivityProjection.SetPublisher(eventstreamservice.AgentActivityPublisher{Service: events})
	if agentTargetResolver, ok := store.(agentservice.AgentTargetResolver); ok {
		agentActivityProjection.SetAgentTargetResolver(agentTargetResolver)
	}
	if workspaceAgentTargetResolver, ok := store.(agentservice.WorkspaceAgentTargetResolver); ok {
		agentActivityProjection.SetWorkspaceAgentTargetResolver(workspaceAgentTargetResolver)
	}
	managedRuntimeResolver := managedruntime.DefaultResolver{}
	// Shared so a runtime auth failure (reporter side) surfaces in the status
	// probe (List side) — see agentRunOutcomeReporter.
	runOutcomes := agentstatusservice.NewRunOutcomeStore()
	agentStatusService := agentstatusservice.Service{
		AnalyticsReporter:    analyticsReporter,
		ManagedRuntime:       managedRuntimeResolver,
		ClaudeCodeRuntimeDir: filepath.Join(agentRuntimeDir, "claude-code"),
		RunOutcomes:          runOutcomes,
		StatusCache:          agentstatusservice.NewProviderStatusCache(),
	}
	accountService := accountservice.NewService("")
	agentProcessTransport := agentdaemon.NewLocalProcessTransport()
	agentHostMetadata := agentdaemon.HostMetadata{
		ClientInfo:       agentdaemon.ClientInfo{Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0"},
		WorkspaceEnvName: "TUTTI_WORKSPACE_ID", OpenClawSessionKeyPrefix: "agent:main:tsh-",
	}
	agentTargetSetup := agentextensionservice.NewSetupService(context.Background())
	agentTargetSetup.Plans = agentTargetInstallPlans
	agentTargetSetup.Transport = agentProcessTransport
	agentTargetSetup.Host = agentHostMetadata
	agentTargetSetup.Actions = agentextensiondata.NewFileSetupActionStore(agentExtensionStateDir)
	agentTargetSetup.Discovery = agentSetupDiscovery
	agentTargetSetup.AuthInvalidation = runOutcomes
	agentRuntime, err := agentdaemon.NewRuntime(agentdaemon.Config{
		Reporter: agentRunOutcomeReporter{
			DurableActivityReporter: agentActivityProjection,
			store:                   runOutcomes,
		},
		ProcessTransport: agentProcessTransport,
		AdapterResolver: agentextensionservice.RuntimeResolver{
			Manager: agentExtensionManager, Transport: agentProcessTransport, Host: agentHostMetadata,
		},
		ProviderCommandResolver: func(ctx context.Context, provider string) (agentdaemon.ProviderCommand, error) {
			resolved, err := agentStatusService.ResolveProviderCommand(ctx, provider)
			if err != nil {
				return agentdaemon.ProviderCommand{}, err
			}
			return agentdaemon.ProviderCommand{
				Command: resolved.Command,
				Env:     resolved.Env,
			}, nil
		},
		HostMetadata: agentHostMetadata,
	})
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("create agent runtime: %w", err)
	}
	agentRuntimePreparer := runtimeprep.NewDefaultPreparer(tuttitypes.DefaultStateDir())
	agentRuntimePreparer.RegisterProvider(tuttiagentservice.NewPreparer())
	agentRuntimePreparer.ComputerUseAvailable = func() bool {
		return runtimeprep.ComputerUseDefaultEnabled() && computersvc.CheckReady() == nil
	}
	userProjectService := userprojectservice.Service{
		Store:     userProjectStore,
		Publisher: eventstreamservice.UserProjectPublisher{Service: events},
	}
	agentRuntimeController := newAgentRuntimeAdapter(agentRuntime.Controller())
	agentSessionService := agentservice.NewService(agentRuntimeController)
	agentActivityProjection.SetRootTurnObserver(agentRuntimeController)
	agentSessionService.AnalyticsReporter = analyticsReporter
	agentModelCapabilities := agentservice.NewModelCapabilitiesService()
	agentModelCatalog := agentservice.NewAgentModelCatalog()
	agentModelCatalog.ModelCapabilities = agentModelCapabilities
	agentSessionService.ModelCatalog = agentModelCatalog
	agentSessionService.ConfigureModelPlanBinding(modelBindingsStore, modelPlansStore, modelPlans)
	agentSessionService.ModelCapabilities = agentModelCapabilities
	agentSessionService.AgentTargetStore = agentTargetStore
	agentSessionService.AgentComposerDefaultsReader = preferences
	preferences.AgentComposerDefaultsValidator = agentSessionService
	agentSessionService.ExtensionComposerProfiles = agentExtensionComposerProfileResolver{
		manager: agentExtensionManager,
	}
	agentSessionService.SessionInitializer = agentActivityProjection
	agentSessionService.WorkspaceAgentResolver = workspaceAgents
	agentSessionService.SessionReader = agentActivityProjection
	agentSessionPurgeStore, ok := agentActivityRepo.(agenthost.SessionPurgeStore)
	if !ok {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("agent session purge store is unavailable")
	}
	agentSessionService.SessionPurgeStore = agentSessionPurgeStore
	agentSessionService.UserProjectReader = userProjectService
	agentSessionService.MessageReader = agentActivityProjection
	agentSessionService.ExternalImportStore = agentActivityRepo
	agentSessionService.TurnStore = agentActivityRepo
	agentSessionService.TurnSummaryReader = agentActivityRepo
	agentSessionService.RuntimeOperationStore = agentActivityRepo
	agentSessionService.GoalStateStore = agentActivityRepo
	agentSessionService.CommitObserver = agentActivityProjection
	agentSessionService.SubmitClaimStore = agentActivityRepo
	agentSessionService.RuntimeOperationEventPublisher = agentActivityProjection
	agentSessionService.AutomationRuleOverrides = automationRules
	agentSessionService.TuttiModeActivations = tuttiModeActivations
	agentSessionService.RuntimeOperationOwner = uuid.NewString()
	agentSessionService.StaleTurnSettler = agentActivityProjection
	agentSessionService.GoalOperationOwner = uuid.NewString()
	goalReconcileInbox, ok := agentActivityRepo.(interface {
		agentservice.GoalReconcileInboxStore
		agentservice.GoalReconcileInboxWriter
	})
	if !ok {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("agent goal reconcile inbox store is unavailable")
	}
	agentSessionService.GoalReconcileInboxStore = goalReconcileInbox
	agentActivityProjection.SetGoalReconcileInboxWriter(goalReconcileInbox)
	goalProvenanceLedger, ok := agentActivityRepo.(agentservice.GoalProvenanceLedgerStore)
	if !ok {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("agent goal provenance ledger store is unavailable")
	}
	agentActivityProjection.SetGoalProvenanceLedger(goalProvenanceLedger)
	agentSessionService.SessionDirectoryAllocator = agentservice.LocalSessionDirectoryAllocator{
		StateDir: tuttitypes.DefaultStateDir(),
	}
	agentSessionService.WorktreeStateDir = tuttitypes.DefaultStateDir()
	agentSessionService.WorkspaceIDs = func(ctx context.Context) ([]string, error) {
		workspaces, err := store.List(ctx)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(workspaces))
		for _, workspace := range workspaces {
			ids = append(ids, workspace.ID)
		}
		return ids, nil
	}
	agentSessionService.PromptAttachmentStore = agentservice.PromptAttachmentStore{
		RootDir:       tuttitypes.DefaultStateDir(),
		SourceRootDir: filepath.Join(tuttitypes.DefaultStateDir(), "agent-prompt-assets"),
	}
	agentSessionService.RuntimePreparer = agentRuntimePreparer
	agentSessionService.ComputerUseAvailable = agentRuntimePreparer.ComputerUseAvailable
	agentSessionService.AvailabilityChecker = agentservice.AgentStatusProviderAvailabilityChecker{
		Service: &agentStatusService,
	}
	modelPlans.NativeSubscriptionProbe = modelPlanNativeSubscriptionProbe{Agents: agentSessionService}
	collabRuns.Canceller = agentCollaborationSessionCanceller{Service: agentSessionService}
	collabRuns.Launcher = agentSessionService
	// Collaboration settlement observes startup interruption before the later
	// full observer fan-out is installed.
	agentActivityProjection.SetSessionStateObserver(collabRuns)
	automationExecutor := &automationruleservice.DaemonExecutor{Agents: agentSessionService, Ledger: automationRulesStore}
	automationRules.Executor = automationExecutor
	automationRules.Sources = automationExecutor

	agentHost := agentservice.NewApplicationHost(agentSessionService)
	agentSessionService.SetApplicationHost(agentHost)
	// Host fixes startup order: durable runtime operations first, then goal
	// operations and reconcile inbox work, and only then stale turns.
	if err := agentHost.Recover(ctx); err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("recover agent host: %w", err)
	}
	go func() {
		if err := agentHost.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.ErrorContext(ctx, "agent Host worker lifecycle stopped", "error", err)
		}
	}()
	var agentMaintenance *agentmaintenanceservice.Service
	if maintenanceState, ok := store.(agentmaintenanceservice.StateStore); ok {
		agentMaintenance = &agentmaintenanceservice.Service{
			Host: agentHost, Preferences: preferences, State: maintenanceState,
			IsIdle: agentSessionService.IdleForDataMaintenance,
		}
		if compactor, ok := store.(agentmaintenanceservice.DatabaseCompactor); ok {
			agentMaintenance.Compactor = compactor
		}
		go agentMaintenance.Run(ctx)
	}

	workspaceService := workspaceservice.CatalogService{
		Store:            store,
		PreferencesStore: preferencesStore,
	}
	issueService := workspaceservice.IssueManagerService{
		AgentSessionCreator: agentSessionService,
		AgentSessionReader:  agentActivityProjection,
		CollaborationRuns:   collabRuns,
		Publisher:           eventstreamservice.WorkspaceIssuePublisher{Service: events},
		Store:               issueStore,
		AgentTargetReader:   agentTargetStore,
		WorkspaceAgents:     workspaceAgents,
		ModelPlanReader:     modelPlansStore,
		AutomationRules:     automationRules,
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
			return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("recover Tutti Mode plan operations: %w", err)
		}
	}
	automationExecutor.IssueRescues = &issueService
	collabRuns.TerminalObserver = &issueService
	issueService.RunSessionCanceller = agentCollaborationSessionCanceller{Service: agentSessionService}
	// A user's stop on a planning conversation cascades to every running task
	// run its accepted plan dispatched.
	agentSessionService.TurnCancelObserver = &issueService
	issueService.RunReconcileQueue = workspaceservice.NewIssueRunReconcileQueue(workspaceservice.IssueRunReconcileQueueOptions{
		Delay:     3 * time.Second,
		Interval:  15 * time.Second,
		Reconcile: issueService.ReconcileRunningRuns,
	})
	appCenterService := &workspaceservice.AppCenterService{
		Store:                 appStore,
		AppFactoryStore:       appFactoryStore,
		WorkspaceStore:        store,
		PreferencesStore:      preferencesStore,
		Runner:                &workspaceservice.AppRunner{RuntimeResolver: managedRuntimeResolver},
		StateDir:              tuttitypes.DefaultStateDir(),
		HostTuttiVersion:      tuttitypes.ResolveAppVersion(),
		HostTuttiCapabilities: tuttitypes.ResolveAppCapabilities(),
		Publisher:             eventstreamservice.WorkspaceAppPublisher{Service: events},
	}
	go func() {
		startedAt := time.Now()
		slog.Info("managed runtime profile preload started", "event", "tutti.managed_runtime.profile_preload_started", "profile", managedruntime.NodeStaticProfile)
		if err := managedRuntimeResolver.PreloadProfile(context.Background(), managedruntime.NodeStaticProfile); err != nil {
			slog.Warn("managed runtime profile preload failed", "event", "tutti.managed_runtime.profile_preload_failed", "profile", managedruntime.NodeStaticProfile, "durationMs", time.Since(startedAt).Milliseconds(), "error", err)
			return
		}
		slog.Info("managed runtime profile preload completed", "event", "tutti.managed_runtime.profile_preload_completed", "profile", managedruntime.NodeStaticProfile, "durationMs", time.Since(startedAt).Milliseconds())
	}()
	go func() {
		// The packaged sidecar bundle no longer carries the native claude
		// binary; provision it up front so the first Claude session does not
		// pay the download. Sessions started before this completes fall back
		// to a PATH-installed claude (see runtimeprep.ClaudeCodePreparer).
		// The deadline bounds a stalled CDN/npm connection (the shared HTTP
		// client deliberately has no timeout) while leaving room for a large
		// fallback download through a slow proxy.
		preloadCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		startedAt := time.Now()
		slog.Info("claude code binary preload started", "event", "tutti.claude_code_binary.preload_started")
		status, err := agentStatusService.EnsureClaudeCodeBinary(preloadCtx)
		if err != nil {
			slog.Warn("claude code binary preload failed", "event", "tutti.claude_code_binary.preload_failed", "durationMs", time.Since(startedAt).Milliseconds(), "error", err)
			return
		}
		slog.Info("claude code binary preload completed", "event", "tutti.claude_code_binary.preload_completed", "source", status.Source, "version", status.Version, "path", status.Path, "durationMs", time.Since(startedAt).Milliseconds())
	}()
	appCLIRegistry := appclicli.NewRegistry(workspaceService, appCenterService)
	appCenterService.AppCLIRegistry = appCLIRegistry
	if err := appCenterService.InitBuiltinPackages(ctx); err != nil {
		agentRuntime.Close()
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("initialize builtin workspace apps: %w", err)
	}
	appFactoryService := &workspaceservice.AppFactoryService{
		Store:                 appFactoryStore,
		AppStore:              appStore,
		WorkspaceStore:        store,
		WorkspaceRootResolver: workspaceservice.FileService{Adapter: fileAdapter},
		AppCenter:             appCenterService,
		AgentSessionService:   agentSessionService,
		AgentTargetStore:      agentTargetStore,
		AgentMessageReader:    agentActivityProjection,
		AgentSessionReader:    agentActivityProjection,
		AgentSessionState:     agentActivityProjection,
		Runner:                &workspaceservice.AppRunner{RuntimeResolver: managedRuntimeResolver},
		StateDir:              tuttitypes.DefaultStateDir(),
		Publisher:             eventstreamservice.WorkspaceAppFactoryPublisher{Service: events},
	}
	agentActivityProjection.SetSessionMessageObserver(appFactoryService)
	agentActivityProjection.SetSessionStateObserver(agentservice.SessionStateObservers{appFactoryService, agentSessionService, &issueService, modelPolicies, automationRules, collabRuns})
	// Canonical root-turn settlements (root-provider aggregation, child-drain
	// reconcile, cancel) fan out at-least-once to this dedicated opt-in list
	// only. Each consumer needs its own semantic ruling before opting in
	// (W4③-11). Cleared so far: automation rules (durable execution-ledger
	// dedup) and the Issue-run observer (it matches the settled turn against
	// the run's initiating "issue-run:<runID>" submit, so an unrelated turn
	// settling in a delegate session can never complete the run, and repeated
	// terminal completion is idempotent). Without the Issue-run observer here,
	// codex delegate runs never settle live — root-provider-lifecycle adapters
	// report no settled state patch — and the failure-biased fallback
	// reconciler was marking successfully completed tasks as failed.
	agentActivityProjection.SetRootTurnSettleStateObserver(agentservice.SessionStateObservers{automationRules, &issueService})
	if _, err := appFactoryService.ReconcileInterruptedJobs(ctx); err != nil {
		agentRuntime.Close()
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("reconcile interrupted app factory jobs: %w", err)
	}
	if workspaces, err := workspaceService.List(ctx); err == nil {
		for _, workspace := range workspaces {
			issueService.RunReconcileQueue.Enqueue(workspace.ID)
		}
	}
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
		modelconsultcli.NewProvider(workspaceService, modelPlans, collabRuns),
		tuttimodeplancli.NewProvider(workspaceService, tuttiModePlans),
	}
	if browserService != nil {
		cliProviders = append(cliProviders, browsercli.NewProvider(workspaceService, browserService))
	}
	if computerService != nil {
		cliProviders = append(cliProviders, computercli.NewProvider(workspaceService, computerService))
	}
	cliRegistry, err := cliservice.NewRegistryFromProviders(cliProviders...)
	if err != nil {
		agentRuntime.Close()
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("create cli registry: %w", err)
	}
	cliRegistry.AppCommands = appCLIRegistry
	agentRuntimePreparer.CommandCatalog = runtimePrepCommandCatalog{Catalog: cliRegistry}

	terminalService := &workspaceservice.TerminalService{}
	accountService.OnLoginCompleted = func(ctx context.Context) {
		tuttiagentservice.BootstrapTuttiAgentUserAuth(ctx)
	}
	accountService.OnLogoutCompleted = func(ctx context.Context) {
		tuttiagentservice.LogoutTuttiAgentUserAuth(ctx)
	}
	go tuttiagentservice.BootstrapTuttiAgentUserAuth(context.Background())

	// External credential switchers (for example cc-switch) rewrite provider
	// auth/config files without notifying tuttid. Watch those files so cached
	// model catalogs are dropped and the GUI hears about it immediately.
	agentModelCatalogPublisher := eventstreamservice.AgentModelCatalogPublisher{Service: events}
	providerAuthWatcher := &agentservice.ProviderAuthWatcher{
		Entries: agentservice.DefaultProviderAuthWatchEntries(),
		OnChange: func(providers []string) {
			agentModelCatalog.Invalidate(providers...)
			for _, provider := range providers {
				agentSessionService.InvalidateLiveComposerModels(provider)
			}
			if err := agentModelCatalogPublisher.PublishAgentModelCatalogInvalidated(context.Background(), providers); err != nil {
				slog.Warn("agent model catalog invalidation publish failed",
					"event", "agent.model_catalog.invalidation_publish_failed",
					"providers", providers,
					"error", err,
				)
				return
			}
			slog.Info("agent provider auth files changed; model catalog invalidated",
				"event", "agent.model_catalog.invalidated",
				"providers", providers,
			)
		},
	}
	providerAuthWatcher.Start()

	return tuttiapi.DaemonAPI{
		AccountService:            accountService,
		UserProjectService:        userProjectService,
		AgentTargetService:        agentTargets,
		AgentTargetSetupService:   agentTargetSetup,
		PreferencesService:        preferences,
		AgentMaintenanceService:   agentMaintenance,
		ManagedCredentialsService: managedCredentials,
		ModelPlanService:          modelPlans,
		WorkspaceAgentService:     workspaceAgents,
		AutomationRuleService:     automationRules,
		AgentModelBindingService:  modelBindings,
		ModelPolicyService:        modelPolicies,
		CollaborationRunService:   collabRuns,
		EventStreamService:        events,
		WorkspaceService:          workspaceService,
		WorkbenchService: workspaceservice.WorkbenchService{
			Store: workspaceStore,
			SnapshotReconciler: workspaceservice.TerminalWorkbenchSnapshotReconciler{
				TerminalService: terminalService,
			},
		},
		AppCenterService:  appCenterService,
		AppFactoryService: appFactoryService,
		FileService: workspaceservice.FileService{
			Adapter: fileAdapter,
		},
		AgentSessionService:        agentSessionService,
		AgentStatusService:         &agentStatusService,
		TerminalService:            terminalService,
		IssueService:               issueService,
		TuttiModePlanService:       tuttiModePlans,
		TuttiModeActivationService: tuttiModeActivations,
		CLIRegistry:                cliRegistry,
		AnalyticsReporter:          analyticsReporter,
	}, appCenterService, agentRuntime, providerAuthWatcher, nil
}

func (w *tuttiWiring) Close() error {
	if w == nil {
		return nil
	}

	var closeErr error
	if w.appCenterService != nil && w.appCenterService.Runner != nil {
		w.appCenterService.Runner.StopAll(context.Background())
	}
	if w.appCenterService != nil {
		w.appCenterService.StopWorkspaceAppUploadJanitor()
	}
	if w.browserService != nil {
		w.browserService.Close()
	}
	if w.computerService != nil {
		w.computerService.Close()
	}
	if w.providerAuthWatcher != nil {
		w.providerAuthWatcher.Close()
	}
	if w.agentTargetSetup != nil {
		if err := w.agentTargetSetup.Close(); err != nil {
			closeErr = err
		}
	}
	if w.agentRuntime != nil {
		w.agentRuntime.Close()
	}
	if w.analyticsReporter != nil {
		if err := w.analyticsReporter.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
	}
	if w.workspaceStore == nil {
		return closeErr
	}
	if err := w.workspaceStore.Close(); err != nil && closeErr == nil {
		closeErr = err
	}
	return closeErr
}
