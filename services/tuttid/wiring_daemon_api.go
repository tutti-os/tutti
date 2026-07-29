package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agenthostadapter "github.com/tutti-os/tutti/packages/agent/daemon/hostadapter"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentstoresqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentextensiondata "github.com/tutti-os/tutti/services/tuttid/data/agentextension"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
	agentmaintenanceservice "github.com/tutti-os/tutti/services/tuttid/service/agentmaintenance"
	agentquickpromptservice "github.com/tutti-os/tutti/services/tuttid/service/agentquickprompt"
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
	referencescli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/references"
	tuttigoalreviewcli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/tuttigoalreview"
	tuttimodeplancli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/tuttimodeplan"
	workbenchappscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/workbenchapps"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
	modelbindingservice "github.com/tutti-os/tutti/services/tuttid/service/modelbinding"
	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
	modelpolicyservice "github.com/tutti-os/tutti/services/tuttid/service/modelpolicy"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	tuttiagentservice "github.com/tutti-os/tutti/services/tuttid/service/tuttiagent"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type workspaceAgentTargetResolverSetter interface {
	SetWorkspaceAgentTargetResolver(agentservice.WorkspaceAgentTargetResolver)
}

func configureWorkspaceAgentResolution(
	agentSessions *agentservice.Service,
	activityProjection workspaceAgentTargetResolverSetter,
	workspaceAgents *workspaceagentservice.Service,
	workspaceAgentTargets agentservice.WorkspaceAgentTargetResolver,
) {
	agentSessions.WorkspaceAgentResolver = workspaceAgents
	if workspaceAgentTargets != nil {
		activityProjection.SetWorkspaceAgentTargetResolver(workspaceAgentTargets)
	}
}

func buildDaemonAPI(
	ctx context.Context,
	store workspacedata.CatalogStore,
	analyticsReporter reporterservice.Reporter,
	browserService *browsersvc.Service,
	computerService *computersvc.Service,
	modelGateway *modelgatewayservice.Gateway,
	installTuttiModeWatchdog func(tuttimodeexecutionservice.Worker),
) (tuttiapi.DaemonAPI, *workspaceservice.AppCenterService, *agentdaemon.Runtime, *agentservice.ProviderAuthWatcher, error) {
	workspaceStore, _ := store.(workspacedata.WorkbenchStore)
	issueStore, _ := store.(workspaceissues.Store)
	tuttiModeExecutionStore, _ := store.(tuttimodeexecutionservice.Store)
	tuttiModeArchiveStore, _ := store.(tuttimodeexecutionservice.ArchiveStore)
	tuttiModeDeletionAdmissionStore, _ := store.(tuttimodeexecutionservice.SourceDeletionAdmissionStore)
	tuttiModeWakeStore, _ := store.(tuttimodeexecutionservice.WakeStore)
	tuttiModeReviewerActivity, ok := store.(tuttimodeexecutionservice.ReviewerActivityReader)
	if !ok {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf(
			"tutti mode reviewer activity reader is unavailable",
		)
	}
	preferencesStore, _ := store.(workspacedata.PreferencesStore)
	agentTargetStore, _ := store.(workspacedata.AgentTargetStore)
	managedCredentialsStore, _ := store.(workspacedata.ManagedCredentialsStore)
	modelPlansStore, _ := store.(workspacedata.ModelPlansStore)
	agentActivityRepo, _ := store.(workspacedata.AgentActivityStore)
	agentQuickPromptStore, _ := store.(workspacedata.AgentQuickPromptStore)
	userProjectStore, _ := store.(workspacedata.UserProjectStore)
	appStore, _ := store.(workspacedata.AppStore)
	appFactoryStore, _ := store.(workspacedata.AppFactoryStore)
	workflowStore, _ := store.(tuttimodeplanservice.Store)
	tuttiModeActivationStore, _ := store.(tuttimodeactivationservice.Store)
	fileAdapter := workspacedata.LocalFilesAdapter{}

	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	preferencesPublisher := eventstreamservice.DesktopPreferencesPublisher{Service: events}
	tuttiModeActivations := &tuttimodeactivationservice.Service{
		Store:     tuttiModeActivationStore,
		Publisher: eventstreamservice.TuttiModeActivationPublisher{Service: events},
	}
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
	refreshAgentExtensionsInBackground := restoreAgentExtensionsForStartup(ctx, agentExtensionManager)
	managedCredentials := &managedcredentialsservice.Service{
		Store: managedCredentialsStore,
	}
	modelBindingsStore, _ := store.(workspacedata.AgentModelBindingsStore)
	modelPolicyStore, _ := store.(modelpolicyservice.Store)
	// Narrow cross-domain reads over biz types keep referential integrity
	// bidirectional without any modelbinding <-> modelpolicy service cycle:
	// bindings validate their policy link, and policy deletion checks bindings.
	bindingPolicyLookup, _ := store.(modelbindingservice.PolicyLookup)
	policyBindingReferences, _ := store.(modelpolicyservice.BindingReferenceReader)
	modelBindings := &modelbindingservice.Service{
		Store:    modelBindingsStore,
		Plans:    modelPlansStore,
		Targets:  agentTargetStore,
		Policies: bindingPolicyLookup,
	}
	modelPolicies := &modelpolicyservice.Service{
		Store:             modelPolicyStore,
		BindingReferences: policyBindingReferences,
	}
	modelConfigurationPublisher := eventstreamservice.AgentModelConfigurationPublisher{Service: events}
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
		Store: modelPlansStore,
		// Plan deletion stays blocked while any consumer domain still points at
		// the plan: agent model bindings, model usage policies, and workspace agents.
		References: modelplanservice.CompositeReferenceResolver{modelBindings, modelPolicies, workspaceAgents},
	}
	collabRunsStore, _ := store.(workspacedata.CollaborationRunsStore)
	collabRuns := &collabrunservice.Service{
		Store:     collabRunsStore,
		Plans:     modelPlansStore,
		Completer: modelPlans,
		Publisher: eventstreamservice.AgentCollaborationPublisher{Service: events},
	}
	modelPolicies.ConfigureReviewAutomation(modelBindingsStore, nil, collabRuns, collabRuns)
	events.RegisterIntentHandler(
		eventstreamservice.TopicPreferencesDesktopUpdateRequested,
		eventstreamservice.NewPreferencesDesktopUpdateRequestedHandler(preferences),
	)
	events.RegisterIntentHandler(
		eventstreamservice.TopicPreferencesAgentComposerDefaultsPatchRequested,
		eventstreamservice.NewPreferencesAgentComposerDefaultsPatchRequestedHandler(preferences),
	)
	agentActivityProjection := agentservice.NewActivityProjection(agentActivityRepo)
	modelPolicies.Sessions = modelPolicySessionTargetResolver{projection: agentActivityProjection}
	collabRuns.Timeline = agentservice.CollaborationTimelineReporter{Projection: agentActivityProjection}
	agentActivityProjection.SetAnalyticsReporter(analyticsReporter)
	agentActivityProjection.SetPublisher(eventstreamservice.AgentActivityPublisher{Service: events})
	if agentTargetResolver, ok := store.(agentservice.AgentTargetResolver); ok {
		agentActivityProjection.SetAgentTargetResolver(agentTargetResolver)
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
		CLIVersionCache:      agentstatusservice.NewCLIVersionCache(),
		AdapterProbeCache:    agentstatusservice.NewAdapterProbeCache(),
		DetectionCommands:    agentstatusservice.NewDetectionCommandLimiter(4),
		UpdateCache:          agentstatusservice.NewProviderUpdateCache(),
	}
	accountService := accountservice.NewService("")
	mobileRemoteService, err := buildMobileRemoteService(
		agentExtensionStateDir,
		accountService,
		events,
	)
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, err
	}
	sessionRecordingTransport, err := buildSessionRecordingProcessTransport()
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, err
	}
	replayComposition := agentCassetteReplayActive()
	agentHostMetadata := agentdaemon.HostMetadata{
		ClientInfo:       agentdaemon.ClientInfo{Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0"},
		WorkspaceEnvName: "TUTTI_WORKSPACE_ID", OpenClawSessionKeyPrefix: "agent:main:tsh-",
	}
	agentTargetSetup := agentextensionservice.NewSetupService(context.Background())
	agentTargetSetup.Plans = agentTargetInstallPlans
	agentTargetSetup.Transport = sessionRecordingTransport
	agentTargetSetup.Host = agentHostMetadata
	agentTargetSetup.Actions = agentextensiondata.NewFileSetupActionStore(agentExtensionStateDir)
	agentTargetSetup.Discovery = agentSetupDiscovery
	agentTargetSetup.AuthInvalidation = runOutcomes
	providerCommandResolver := agentProviderCommandResolver(&agentStatusService)
	agentRuntimeConfig := agentdaemon.Config{
		Reporter: agentRunOutcomeReporter{
			DurableActivityReporter: agentActivityProjection,
			store:                   runOutcomes,
		},
		ProcessTransport: sessionRecordingTransport,
		HostMetadata:     agentHostMetadata,
		AdapterResolver: agentextensionservice.RuntimeResolver{
			Manager: agentExtensionManager, Transport: sessionRecordingTransport, Host: agentHostMetadata,
		},
		ProviderCommandResolver:    providerCommandResolver,
		CommandNetworkAccessPolicy: tuttiDesktopCommandNetworkAccessPolicy,
	}
	agentRuntimeConfig = applyAgentReplayRuntimeComposition(agentRuntimeConfig, replayComposition)
	agentRuntime, err := agentdaemon.NewRuntime(agentRuntimeConfig)
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("create agent runtime: %w", err)
	}
	agentRuntimePreparer := runtimeprep.NewDefaultPreparer(tuttitypes.DefaultStateDir())
	configureReplayAwareCodexRuntimePreparer(agentRuntimePreparer, replayComposition, providerCommandResolver)
	agentRuntimePreparer.RegisterProvider(tuttiagentservice.NewPreparer())
	agentRuntimePreparer.ComputerUseAvailable = func() bool {
		return runtimeprep.ComputerUseDefaultEnabled() && computersvc.CheckReady() == nil
	}
	userProjectService := userprojectservice.Service{
		Store:     userProjectStore,
		Publisher: eventstreamservice.UserProjectPublisher{Service: events},
	}
	agentQuickPromptService := agentquickpromptservice.Service{
		Store:     agentQuickPromptStore,
		Publisher: eventstreamservice.AgentQuickPromptPublisher{Service: events},
	}
	agentRuntimeController := newAgentRuntimeAdapter(agentRuntime.Controller())
	agentRuntime.Controller().SetStreamEventObserver(agentRuntimeActivityEventBridge{
		publisher: eventstreamservice.AgentActivityPublisher{Service: events},
	})
	agentSessionService := agentservice.NewService(agentRuntimeController)
	agentSessionService.ModelGateway = modelGateway
	if browserService != nil {
		agentSessionService.AgentSessionResourceReleaser = browserService
	}
	agentActivityProjection.SetRootTurnObserver(agentRuntimeController)
	agentSessionService.AnalyticsReporter = analyticsReporter
	agentModelCapabilities := agentservice.NewModelCapabilitiesService()
	agentModelCatalog := agentservice.NewAgentModelCatalog()
	agentModelCatalog.ModelCapabilities = agentModelCapabilities
	agentModelCatalog.ProviderCommands = &agentStatusService
	agentSessionService.ModelCatalog = agentModelCatalog
	agentSessionService.ConfigureModelPlanBinding(modelBindingsStore, modelPlansStore)
	agentSessionService.ModelCapabilities = agentModelCapabilities
	agentSessionService.AgentTargetStore = agentTargetStore
	configureWorkspaceAgentResolution(
		agentSessionService,
		agentActivityProjection,
		workspaceAgents,
		workspaceAgentsStore,
	)
	agentSessionService.AgentComposerDefaultsReader = preferences
	preferences.AgentComposerDefaultsValidator = agentSessionService
	agentSessionService.ExtensionComposerProfiles = agentExtensionComposerProfileResolver{
		manager: agentExtensionManager,
	}
	agentSessionService.SessionInitializer = agentActivityProjection
	agentSessionService.SessionReader = agentActivityProjection
	agentSessionPurgeStore, ok := agentActivityRepo.(agenthost.SessionPurgeStore)
	if !ok {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("agent session purge store is unavailable")
	}
	agentSessionService.SessionPurgeStore = agentSessionPurgeStore
	if tuttiModeDeletionAdmissionStore != nil {
		sourceDeletionGuard := &tuttimodeexecutionservice.SourceDeletionGuard{
			Store:   tuttiModeDeletionAdmissionStore,
			Context: ctx,
		}
		if err := sourceDeletionGuard.Recover(ctx); err != nil {
			return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf(
				"recover source session deletion admissions: %w", err,
			)
		}
		agentSessionService.SessionDeletionGuard = sourceDeletionGuard
	}
	agentSessionService.UserProjectReader = userProjectService
	agentSessionService.MessageReader = agentActivityProjection
	agentSessionService.ExternalImportStore = agentActivityRepo
	agentSessionService.TurnStore = agentActivityRepo
	agentSessionService.TurnSummaryReader = agentActivityRepo
	agentSessionService.RuntimeOperationStore = agentActivityRepo
	agentSessionService.GoalStateStore = agentActivityRepo
	agentSessionService.GoalGenerationFenceStore = agentActivityRepo
	agentSessionService.CommitObserver = agentActivityProjection
	agentSessionRecordingService, err := buildAgentSessionRecordingService(
		store, sessionRecordingTransport, agentSessionService,
	)
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, err
	}
	configureAgentSessionRecordingObservers(agentActivityProjection, agentSessionService, agentRuntimeController, agentSessionRecordingService)
	agentSessionService.SubmitClaimStore = agentActivityRepo
	agentSessionService.RuntimeOperationEventPublisher = agentActivityProjection
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
	if !replayComposition {
		agentSessionService.RuntimePreparer = agentRuntimePreparer
		agentSessionService.ComputerUseAvailable = agentRuntimePreparer.ComputerUseAvailable
		agentSessionService.AvailabilityChecker = agentservice.AgentStatusProviderAvailabilityChecker{
			Service: &agentStatusService,
		}
	} else {
		agentSessionService.AvailabilityChecker = replayProviderAvailabilityChecker{}
	}
	modelPlans.NativeSubscriptionProbe = modelPlanNativeSubscriptionProbe{Agents: agentSessionService}
	automationExecutor := &automationruleservice.DaemonExecutor{Agents: agentSessionService, Ledger: automationRulesStore}
	automationRules.Executor = automationExecutor
	automationRules.Sources = automationExecutor

	canonicalStoreProvider, ok := store.(interface {
		AgentCanonicalStore() *agentstoresqlite.Store
	})
	if !ok || canonicalStoreProvider.AgentCanonicalStore() == nil {
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("canonical agent store is unavailable")
	}
	canonicalHostStore := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(string) *agentstoresqlite.Store {
			return canonicalStoreProvider.AgentCanonicalStore()
		},
		Observer:             agentActivityProjection,
		InitializationPolicy: agentActivityProjection,
	}
	agentHost := agentservice.NewApplicationHostWithPorts(
		agentSessionService,
		canonicalHostStore,
		canonicalStoreProvider.AgentCanonicalStore(),
		&agenthostadapter.RuntimeController{
			Backend: agentRuntime.Controller(),
		},
	)
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
	issueRunLaunchGate := workspaceservice.NewIssueRunLaunchGate()
	issueRunCanceller := issueRunSessionCanceller{Host: agentHost, Sessions: agentSessionService}
	tuttiModeMainWakeOwner := "tuttid-main-wake:" + uuid.NewString()
	tuttiModeExecutions := &tuttimodeexecutionservice.Service{
		Store:                  tuttiModeExecutionStore,
		Archives:               tuttiModeArchiveStore,
		Wakes:                  tuttiModeWakeStore,
		ArchiveAutomationTurns: issueRunCanceller,
		MainWakeTargets: tuttiModeMainWakeAgentAdapter{
			Host:     agentHost,
			Sessions: agentSessionService,
		},
		ReviewerActivity: tuttiModeReviewerActivity,
	}
	tuttiModeExecutions.ReviewerTargets = tuttiModeReviewerAgentAdapter{
		Host:     agentHost,
		Sessions: agentSessionService,
	}
	tuttiModeSourceActivity := tuttiModeSourceActivityAdapter{
		Executions: tuttiModeExecutions,
	}
	agentSessionService.TuttiModeSourceActivity = tuttiModeSourceActivity
	tuttiModeMainWakeRecovery := &tuttiModeMainWakeReadyRecovery{
		Delegate: tuttiModeExecutions,
	}
	issueService := workspaceservice.IssueManagerService{
		RunLauncher:                  issueRunAgentLauncher{Sessions: agentSessionService, Host: agentHost},
		RunLaunchGate:                issueRunLaunchGate,
		RunCancellationRequester:     issueRunCanceller,
		SourceSessionContextResolver: issueSourceSessionContextResolver{Sessions: agentActivityProjection},
		Publisher:                    eventstreamservice.WorkspaceIssuePublisher{Service: events},
		Store:                        issueStore,
		AgentTargetReader:            agentTargetStore,
		PlanningTimeline:             agentservice.IssuePlanningTimelineReporter{Projection: agentActivityProjection},
		TuttiModeExecutions:          tuttiModeExecutions,
		MutationLocks:                workspaceservice.NewIssueMutationLocks(),
	}
	tuttiModePlans := &tuttimodeplanservice.Service{
		Store:             workflowStore,
		Revisions:         workspacedata.WorkflowRevisionFiles{StateDir: tuttitypes.DefaultStateDir()},
		Publisher:         eventstreamservice.WorkspaceWorkflowPublisher{Service: events},
		IssueMaterializer: tuttimodeplanservice.WorkspaceIssueMaterializer{Issues: &issueService},
		FeedbackDispatcher: &tuttiModePlanFeedbackDispatcher{
			Agents:    agentSessionService,
			TurnLinks: workflowStore,
		},
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
	issueExecutionCoordinator := &workspaceservice.IssueExecutionCoordinator{
		Issues:              &issueService,
		RunSessionCanceller: issueRunCanceller,
		SettlementReader:    issueRunSettlementReader{Host: agentHost},
	}
	issueService.RunReconciler = issueExecutionCoordinator
	tuttiModeExecutions.ArchiveRuns = issueExecutionCoordinator
	// A user's stop on a planning conversation cascades to every running task
	// run its accepted plan dispatched.
	agentSessionService.TurnCancelObserver = issueExecutionCoordinator
	issueService.ExecutionRecoveryQueue = workspaceservice.NewWorkspaceExecutionRecoveryQueue(workspaceservice.WorkspaceExecutionRecoveryQueueOptions{
		Context:  ctx,
		Delay:    3 * time.Second,
		Interval: 15 * time.Second,
		Reconcile: func(ctx context.Context, workspaceID string) (workspaceservice.WorkspaceExecutionRecoveryResult, error) {
			runResult, err := reconcileTuttiModeRunsAndMainWakes(
				ctx,
				workspaceID,
				tuttiModeMainWakeOwner,
				issueExecutionCoordinator.ReconcileTuttiModeRunLaunchesAndRunningRuns,
				tuttiModeMainWakeRecovery,
			)
			if err != nil {
				return workspaceservice.WorkspaceExecutionRecoveryResult{}, err
			}
			pendingArchives, err := tuttiModeExecutions.RecoverArchivesAndCount(ctx, workspaceID)
			return workspaceservice.WorkspaceExecutionRecoveryResult{
				Pending: runResult.RunningCount > runResult.CompletedCount ||
					pendingArchives > 0,
			}, err
		},
	})
	tuttiModeExecutions.ArchiveRecoveryQueue = issueService.ExecutionRecoveryQueue
	if tuttiModeArchiveStore != nil {
		workspaces, err := store.List(ctx)
		if err != nil {
			return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("list workspaces for Tutti archive recovery: %w", err)
		}
		for _, workspace := range workspaces {
			pendingArchives, err := tuttiModeExecutions.RecoverArchivesAndCount(ctx, workspace.ID)
			if err != nil {
				return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf(
					"recover Tutti archives for workspace %s: %w", workspace.ID, err,
				)
			}
			if pendingArchives > 0 {
				issueService.ExecutionRecoveryQueue.Enqueue(workspace.ID)
			}
		}
	}
	agentActivityProjection.SetRootTurnObserver(rootTurnObserverFanout{
		agentRuntimeController,
		tuttiModeSourceTurnActivityObserver{
			Activities: tuttiModeSourceActivity,
		},
		tuttiModeMainWakeTurnObserver{
			Settlements: tuttiModeExecutions,
			Queue:       issueService.ExecutionRecoveryQueue,
		},
		tuttiModeReviewerTurnObserver{
			Settlements: tuttiModeExecutions,
		},
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
	agentActivityProjection.SetSessionStateObserver(agentservice.SessionStateObservers{appFactoryService, modelPolicies, automationRules, issueExecutionCoordinator})
	// Canonical root-turn settlements (root-provider aggregation, child-drain
	// reconcile, cancel) fan out at-least-once to this dedicated opt-in list
	// only. Automation rules and the Issue-run observer are the consumers
	// cleared for it today: the general session-state observers historically
	// never received live turn settles, and each needs its own semantic ruling
	// before opting in (W4③-11). The Issue-run observer matches the settled
	// turn against the run's initiating "issue-run:<runID>" submit, so an
	// unrelated turn settling in a delegate session can never complete the
	// run, and repeated terminal completion is idempotent.
	agentActivityProjection.SetRootTurnSettleStateObserver(agentservice.SessionStateObservers{automationRules, issueExecutionCoordinator})
	if _, err := appFactoryService.ReconcileInterruptedJobs(ctx); err != nil {
		agentRuntime.Close()
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf("reconcile interrupted app factory jobs: %w", err)
	}
	workspaces, err := workspaceService.List(ctx)
	if err != nil {
		agentRuntime.Close()
		return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf(
			"list workspaces for Issue Run startup recovery: %w",
			err,
		)
	}
	for _, workspace := range workspaces {
		if _, err := issueExecutionCoordinator.ReconcileTuttiModeRunLaunchesAndRunningRuns(ctx, workspace.ID); err != nil {
			agentRuntime.Close()
			return tuttiapi.DaemonAPI{}, nil, nil, nil, fmt.Errorf(
				"recover Tutti mode Run launch intents at startup for workspace %q: %w",
				workspace.ID,
				err,
			)
		}
		repairTuttiModeMainWakesAtStartup(
			ctx,
			tuttiModeExecutions,
			workspace.ID,
		)
	}
	tuttiModeWatchdogWorker := newTuttiModeWatchdogWorker(
		ctx, tuttiModeExecutions, tuttiModeMainWakeOwner,
		func(ctx context.Context) ([]string, error) {
			summaries, err := workspaceService.List(ctx)
			if err != nil {
				return nil, err
			}
			ids := make([]string, 0, len(summaries))
			for _, summary := range summaries {
				ids = append(ids, summary.ID)
			}
			return ids, nil
		},
	)
	if installTuttiModeWatchdog != nil {
		installTuttiModeWatchdog(tuttiModeWatchdogWorker)
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
		tuttimodeplancli.NewProviderWithExecutionSnapshot(
			workspaceService, tuttiModePlans, agentSessionService,
			&issueService, &issueService, tuttiModeExecutions,
			&issueService, tuttiModeExecutions, tuttiModeExecutions,
		),
		tuttigoalreviewcli.NewProvider(
			tuttiModeExecutions,
			agentSessionService,
		),
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
	cliRegistry.AgentSessionCapabilities = agentSessionCLIProjectionResolver{
		Sessions: agentSessionService,
	}
	cliRegistry.AppCommands = appCLIRegistry
	agentRuntimePreparer.CommandCatalog = runtimePrepCommandCatalog{Catalog: cliRegistry}

	terminalService := &workspaceservice.TerminalService{}
	tuttiAgentReadiness := configureReplayAwareTuttiAgentReadiness(
		replayComposition, accountService, &agentStatusService, agentTargets,
	)

	// External credential switchers (for example cc-switch) rewrite provider
	// auth/config files without notifying tuttid. Watch those files so cached
	// model catalogs are dropped and the GUI hears about it immediately.
	agentModelCatalogPublisher := eventstreamservice.AgentModelCatalogPublisher{Service: events}
	providerAuthWatcher := startProviderAuthWatcher(replayComposition, func(providers []string) {
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
	})

	if refreshAgentExtensionsInBackground {
		startAgentExtensionBackgroundRefresh(agentExtensionManager)
	}

	return tuttiapi.DaemonAPI{
		AccountService:            accountService,
		MobileRemoteService:       mobileRemoteService,
		UserProjectService:        userProjectService,
		AgentQuickPromptService:   agentQuickPromptService,
		AgentTargetService:        agentTargets,
		AgentTargetSetupService:   agentTargetSetup,
		PreferencesService:        preferences,
		AgentMaintenanceService:   agentMaintenance,
		ManagedCredentialsService: managedCredentials,
		ModelPlanService:          modelPlans,
		WorkspaceAgentService:     workspaceAgents,
		AgentModelBindingService:  modelBindings,
		ModelPolicyService:        modelPolicies,
		CollaborationRunService:   collabRuns,
		AutomationRuleService:     automationRules,

		EventStreamService: events,
		WorkspaceService:   workspaceService,
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
		AgentSessionService:          agentSessionService,
		AgentSessionRecordingService: agentSessionRecordingService,
		AgentSessionReplayVerifier: agentReplayTransportVerifier{
			enabled: replayComposition, transport: sessionRecordingTransport,
		},
		AgentStatusService:         &agentStatusService,
		TuttiAgentReadiness:        tuttiAgentReadiness,
		TerminalService:            terminalService,
		IssueService:               issueService,
		IssueExecutionService:      issueExecutionCoordinator,
		TuttiModePlanService:       tuttiModePlans,
		TuttiModeExecutionService:  tuttiModeExecutions,
		TuttiModeActivationService: tuttiModeActivations,
		TuttiModeGoalReviewService: tuttiModeExecutions,
		CLIRegistry:                cliRegistry,
		AnalyticsReporter:          analyticsReporter,
		OnListenerReady: func() {
			tuttiModeMainWakeRecovery.MarkReady()
			for _, workspace := range workspaces {
				issueService.ExecutionRecoveryQueue.Enqueue(workspace.ID)
			}
		},
	}, appCenterService, agentRuntime, providerAuthWatcher, nil
}
