package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	agentdaemon "github.com/tutti-os/tutti/packages/agentactivity/daemon"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttiserver "github.com/tutti-os/tutti/services/tuttid/server"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	agenttargetservice "github.com/tutti-os/tutti/services/tuttid/service/agenttarget"
	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	appclicli "github.com/tutti-os/tutti/services/tuttid/service/cli/appcli"
	agentcontextcli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/agentcontext"
	browsercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/browser"
	computercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/computer"
	diagnosticscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/diagnostics"
	issuemanagercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/issuemanager"
	referencescli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/references"
	workbenchappscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/workbenchapps"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type tuttiWiring struct {
	api               tuttiapi.DaemonAPI
	appCenterService  *workspaceservice.AppCenterService
	workspaceStore    *workspacedata.SQLiteStore
	analyticsReporter reporterservice.Reporter
	browserService    *browsersvc.Service
	computerService   *computersvc.Service
	agentRuntime      *agentdaemon.Runtime
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
	if agentsidecarservice.BrowserUseDefaultEnabled() {
		w.browserService = browsersvc.NewService(workspaceStore)
	}
	// Computer use is delivered through the daemon-owned `tutti computer` CLI;
	// the service owns a cua-driver MCP subprocess per workspace.
	if agentsidecarservice.ComputerUseDefaultEnabled() {
		w.computerService = computersvc.NewService()
	}
	api, appCenterService, agentRuntime, err := buildDaemonAPI(ctx, workspaceStore, nil, w.browserService, w.computerService)
	if err != nil {
		return err
	}

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
	w.agentRuntime = agentRuntime
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

func buildDaemonAPI(ctx context.Context, store workspacedata.CatalogStore, analyticsReporter reporterservice.Reporter, browserService *browsersvc.Service, computerService *computersvc.Service) (tuttiapi.DaemonAPI, *workspaceservice.AppCenterService, *agentdaemon.Runtime, error) {
	workspaceStore, _ := store.(workspacedata.WorkbenchStore)
	issueStore, _ := store.(workspaceissues.Store)
	preferencesStore, _ := store.(workspacedata.PreferencesStore)
	agentTargetStore, _ := store.(workspacedata.AgentTargetStore)
	managedCredentialsStore, _ := store.(workspacedata.ManagedCredentialsStore)
	agentActivityRepo, _ := store.(workspacedata.AgentActivityStore)
	userProjectStore, _ := store.(workspacedata.UserProjectStore)
	appStore, _ := store.(workspacedata.AppStore)
	appFactoryStore, _ := store.(workspacedata.AppFactoryStore)
	fileAdapter := workspacedata.LocalFilesAdapter{}

	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	preferences := preferencesservice.Service{
		Store:     preferencesStore,
		Publisher: eventstreamservice.DesktopPreferencesPublisher{Service: events},
	}
	agentTargets := agenttargetservice.Service{
		Store: agentTargetStore,
	}
	managedCredentials := &managedcredentialsservice.Service{
		Store: managedCredentialsStore,
	}
	events.RegisterIntentHandler(
		eventstreamservice.TopicPreferencesDesktopUpdateRequested,
		eventstreamservice.NewPreferencesDesktopUpdateRequestedHandler(preferences),
	)
	agentActivityProjection := agentservice.NewActivityProjection(agentActivityRepo)
	agentActivityProjection.SetAnalyticsReporter(analyticsReporter)
	agentActivityProjection.SetPublisher(eventstreamservice.AgentActivityPublisher{Service: events})
	managedRuntimeResolver := managedruntime.DefaultResolver{}
	// Shared so a runtime auth failure (reporter side) surfaces in the status
	// probe (List side) — see agentRunOutcomeReporter.
	runOutcomes := agentstatusservice.NewRunOutcomeStore()
	agentStatusService := agentstatusservice.Service{
		AnalyticsReporter: analyticsReporter,
		ManagedRuntime:    managedRuntimeResolver,
		RunOutcomes:       runOutcomes,
	}
	agentRuntime, err := agentdaemon.NewRuntime(agentdaemon.Config{
		Reporter: agentRunOutcomeReporter{
			inner: agentActivityProjection,
			store: runOutcomes,
		},
		ProcessTransport: agentdaemon.NewLocalProcessTransport(),
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
		HostMetadata: agentdaemon.HostMetadata{
			ClientInfo: agentdaemon.ClientInfo{
				Name:    "tutti-desktop",
				Title:   "Tutti",
				Version: "0.1.0",
			},
			WorkspaceEnvName:         "TUTTI_WORKSPACE_ID",
			OpenClawSessionKeyPrefix: "agent:main:tsh-",
		},
	})
	if err != nil {
		return tuttiapi.DaemonAPI{}, nil, nil, fmt.Errorf("create agent runtime: %w", err)
	}
	agentSidecarPreparer := agentsidecarservice.NewDefaultPreparer(tuttitypes.DefaultStateDir())
	userProjectService := userprojectservice.Service{
		Store: userProjectStore,
	}
	agentSessionService := agentservice.NewService(
		newAgentRuntimeAdapter(agentRuntime.Controller()),
	)
	agentSessionService.AnalyticsReporter = analyticsReporter
	agentSessionService.ModelCatalog = agentservice.NewAgentModelCatalog()
	agentSessionService.AgentTargetStore = agentTargetStore
	agentSessionService.SessionReader = agentActivityProjection
	agentSessionService.UserProjectReader = userProjectService
	agentSessionService.MessageReader = agentActivityProjection
	agentSessionService.ExternalImportStore = agentActivityRepo
	agentSessionService.SessionDirectoryAllocator = agentservice.LocalSessionDirectoryAllocator{
		StateDir: tuttitypes.DefaultStateDir(),
	}
	agentSessionService.PromptAttachmentStore = agentservice.PromptAttachmentStore{
		RootDir: tuttitypes.DefaultStateDir(),
	}
	agentSessionService.RuntimePreparer = agentSidecarPreparer
	agentSessionService.AvailabilityChecker = agentservice.AgentStatusProviderAvailabilityChecker{
		Service: &agentStatusService,
	}

	workspaceService := workspaceservice.CatalogService{
		Store:            store,
		PreferencesStore: preferencesStore,
	}
	issueService := workspaceservice.IssueManagerService{
		AgentSessionReader: agentActivityProjection,
		Publisher:          eventstreamservice.WorkspaceIssuePublisher{Service: events},
		Store:              issueStore,
	}
	issueService.RunReconcileQueue = workspaceservice.NewIssueRunReconcileQueue(workspaceservice.IssueRunReconcileQueueOptions{
		Delay:     3 * time.Second,
		Interval:  15 * time.Second,
		Reconcile: issueService.ReconcileRunningRuns,
	})
	appCenterService := &workspaceservice.AppCenterService{
		Store:                 appStore,
		AppFactoryStore:       appFactoryStore,
		WorkspaceRootResolver: workspaceservice.FileService{Adapter: fileAdapter},
		WorkspaceStore:        store,
		PreferencesStore:      preferencesStore,
		Runner:                &workspaceservice.AppRunner{RuntimeResolver: managedRuntimeResolver},
		StateDir:              tuttitypes.DefaultStateDir(),
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
	appCLIRegistry := appclicli.NewRegistry(workspaceService, appCenterService)
	appCenterService.AppCLIRegistry = appCLIRegistry
	if err := appCenterService.InitBuiltinPackages(ctx); err != nil {
		agentRuntime.Close()
		return tuttiapi.DaemonAPI{}, nil, nil, fmt.Errorf("initialize builtin workspace apps: %w", err)
	}
	appFactoryService := &workspaceservice.AppFactoryService{
		Store:                 appFactoryStore,
		AppStore:              appStore,
		WorkspaceStore:        store,
		WorkspaceRootResolver: workspaceservice.FileService{Adapter: fileAdapter},
		AppCenter:             appCenterService,
		AgentSessionService:   agentSessionService,
		AgentMessageReader:    agentActivityProjection,
		AgentSessionReader:    agentActivityProjection,
		AgentSessionState:     agentActivityProjection,
		Runner:                &workspaceservice.AppRunner{RuntimeResolver: managedRuntimeResolver},
		StateDir:              tuttitypes.DefaultStateDir(),
		Publisher:             eventstreamservice.WorkspaceAppFactoryPublisher{Service: events},
	}
	agentActivityProjection.SetSessionMessageObserver(appFactoryService)
	agentActivityProjection.SetSessionStateObserver(appFactoryService)
	if _, err := appFactoryService.ReconcileInterruptedJobs(ctx); err != nil {
		agentRuntime.Close()
		return tuttiapi.DaemonAPI{}, nil, nil, fmt.Errorf("reconcile interrupted app factory jobs: %w", err)
	}
	if workspaces, err := workspaceService.List(ctx); err == nil {
		for _, workspace := range workspaces {
			issueService.RunReconcileQueue.Enqueue(workspace.ID)
		}
	}
	cliProviders := []cliservice.Provider{
		diagnosticscli.NewProvider(),
		issuemanagercli.NewProvider(workspaceService, issueService, appCenterService),
		referencescli.NewProvider(workspaceService, appCenterService, issueService),
		workbenchappscli.NewProvider(
			workspaceService,
			appCenterService,
			eventstreamservice.WorkbenchNodeLaunchPublisher{Service: events},
		),
		agentcontextcli.NewProviderWithLaunchPublisher(
			workspaceService,
			agentSessionService,
			eventstreamservice.AgentGUILaunchPublisher{Service: events},
			preferences,
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
		return tuttiapi.DaemonAPI{}, nil, nil, fmt.Errorf("create cli registry: %w", err)
	}
	cliRegistry.AppCommands = appCLIRegistry
	agentSidecarPreparer.CommandCatalog = cliRegistry

	terminalService := &workspaceservice.TerminalService{}

	return tuttiapi.DaemonAPI{
		AccountService:            accountservice.NewService(""),
		UserProjectService:        userProjectService,
		AgentTargetService:        agentTargets,
		PreferencesService:        preferences,
		ManagedCredentialsService: managedCredentials,
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
		AgentSessionService: agentSessionService,
		AgentStatusService:  &agentStatusService,
		TerminalService:     terminalService,
		IssueService:        issueService,
		CLIRegistry:         cliRegistry,
		AnalyticsReporter:   analyticsReporter,
	}, appCenterService, agentRuntime, nil
}

func (w *tuttiWiring) Close() error {
	if w == nil {
		return nil
	}

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
	if w.agentRuntime != nil {
		w.agentRuntime.Close()
	}
	var closeErr error
	if w.analyticsReporter != nil {
		if err := w.analyticsReporter.Close(); err != nil {
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
