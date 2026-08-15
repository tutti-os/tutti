package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agenthttpx "github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	connectorcontrolplane "github.com/tutti-os/tutti/packages/clients/connector-controlplane"
	connectormarketdaemon "github.com/tutti-os/tutti/packages/connector/daemon"
	connectormarkethost "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	connectoragentgateway "github.com/tutti-os/tutti/packages/connector/runtime/agentgateway"
	marketartifact "github.com/tutti-os/tutti/packages/connector/runtime/artifact"
	connectormarketdata "github.com/tutti-os/tutti/packages/connector/store-sqlite"
	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttiserver "github.com/tutti-os/tutti/services/tuttid/server"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
	connectormarketservice "github.com/tutti-os/tutti/services/tuttid/service/connectormarket"
	connectormcpservice "github.com/tutti-os/tutti/services/tuttid/service/connectormcp"
	desktopupdateadmissionservice "github.com/tutti-os/tutti/services/tuttid/service/desktopupdateadmission"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	managedruntimeservice "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
	mobileremoteservice "github.com/tutti-os/tutti/services/tuttid/service/mobileremote"
	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const connectorMarketDefaultBaseURL = "https://api.tutti.sh/api/desktop"
const connectorMCPDefaultBaseURL = "https://tutti.sh/api/desktop"
const connectorArtifactBaseURL = "https://d27a59zdy4534h.cloudfront.net/tutti/connector-market/"

type tuttiWiring struct {
	api                          tuttiapi.DaemonAPI
	appCenterService             *workspaceservice.AppCenterService
	workspaceStore               *workspacedata.SQLiteStore
	connectorMarketStore         *connectormarketdata.Store
	connectorMarketHost          *connectormarketdaemon.Host
	connectorMCPServer           *connectormcpservice.Server
	connectorAgentGateway        *connectoragentgateway.Gateway
	analyticsReporter            reporterservice.Reporter
	browserService               *browsersvc.Service
	computerService              *computersvc.Service
	desktopUpdateAdmission       *desktopupdateadmissionservice.Service
	agentTargetSetup             *agentextensionservice.SetupService
	agentRuntime                 *agentdaemon.Runtime
	providerAuthWatcher          *agentservice.ProviderAuthWatcher
	agentCLIUpdateScheduler      *agentstatusservice.ProviderUpdateScheduler
	tuttiModeWakeRecoveryStarter func()
	tuttiModeWatchdogMu          sync.Mutex
	tuttiModeWatchdogWorker      *tuttimodeexecutionservice.Worker
	tuttiModeWatchdogCancel      context.CancelFunc
	tuttiModeWatchdogDone        <-chan struct{}
	tuttiModeWatchdogClosed      bool
	mobileRemoteHost             mobileRemoteHost
	mobileRemoteHandler          http.Handler
	modelGateway                 *modelgatewayservice.Gateway
}

type mobileRemoteHost interface {
	StartRemoteHost(http.Handler)
	StopRemoteHost()
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
	desktopUpdateAdmission, err := desktopupdateadmissionservice.NewFromEnvironment()
	if err != nil {
		return nil, fmt.Errorf("configure desktop update admission: %w", err)
	}
	wiring.desktopUpdateAdmission = desktopUpdateAdmission
	if desktopUpdateAdmission != nil {
		desktopUpdateAdmission.Start(context.Background())
	}
	if err := wiring.buildWorkspaceModule(context.Background()); err != nil {
		_ = wiring.Close()
		return nil, err
	}

	return wiring, nil
}

func buildTuttiServer() (*http.Server, net.Listener, *tuttiWiring, error) {
	listenerSpec, err := tuttiserver.ListenerSpecFromEnv()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("resolve tuttid listener spec: %w", err)
	}
	listener, err := tuttiserver.NewListener(listenerSpec)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create tuttid listener: %w", err)
	}

	if err := tuttiserver.WriteListenerInfo(listener, listenerSpec); err != nil {
		_ = listener.Close()
		return nil, nil, nil, fmt.Errorf("write tuttid listener info: %w", err)
	}
	slog.Info("tuttid listener allocated",
		"event", "tutti.listen.allocated",
		"addr", listener.Addr().String(),
	)

	wiringStartedAt := time.Now()
	slog.Info("tuttid wiring build started", "event", "tutti.wiring.build_started")
	wiring, err := newTuttiWiring()
	if err != nil {
		_ = listener.Close()
		_ = os.Remove(tuttitypes.TuttidListenerInfoPath())
		return nil, nil, nil, err
	}
	slog.Info("tuttid wiring build completed",
		"event", "tutti.wiring.build_completed",
		"durationMs", time.Since(wiringStartedAt).Milliseconds(),
	)

	wiring.startTuttiModeWakeRecovery()
	wiring.startAgentCLIUpdateScheduler()

	routes := wiring.routes()
	wiring.startMobileRemoteHost(tuttiserver.NewMux(routes))
	return tuttiserver.NewHTTPServer(listenerSpec, routes), listener, wiring, nil
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
	modelGateway, err := modelgatewayservice.New(modelgatewayservice.Config{})
	if err != nil {
		return fmt.Errorf("start model gateway: %w", err)
	}
	w.modelGateway = modelGateway
	connectorsEnabled, err := connectorModuleEnabled(ctx, workspaceStore)
	if err != nil {
		slog.Warn(
			"connector module remains disabled because desktop preferences could not be read",
			"event", "tutti.connector.activation.preference_read_failed",
			"error", err,
		)
		connectorsEnabled = false
	}
	var connectorRegistry *connectormarketservice.ConnectorRuntimeRegistry
	var connectorCommands *connectormarketservice.ConnectorCommandProvider
	var connectorAgent *connectorAgentRuntime
	var agentConnectorRuntime agentservice.ConnectorRuntime
	if connectorsEnabled {
		connectorRegistry = connectormarketservice.NewConnectorRuntimeRegistry()
		connectorCommands = connectormarketservice.NewConnectorCommandProvider(connectorRegistry)
		connectorMCPServer, startErr := connectormcpservice.Start(connectormcpservice.Config{Registry: connectorRegistry.MCPRegistry()})
		if startErr != nil {
			return fmt.Errorf("start connector MCP server: %w", startErr)
		}
		w.connectorMCPServer = connectorMCPServer
		connectorGateway, startErr := connectoragentgateway.Start(connectoragentgateway.Config{})
		if startErr != nil {
			return fmt.Errorf("start connector Agent gateway: %w", startErr)
		}
		if bindErr := connectorGateway.SetBackend(fmt.Sprintf("tuttid-%d", time.Now().UnixNano()), connectorMCPServer); bindErr != nil {
			_ = connectorGateway.Close(context.Background())
			return fmt.Errorf("bind connector MCP backend: %w", bindErr)
		}
		w.connectorAgentGateway = connectorGateway
		connectorAgent = &connectorAgentRuntime{routes: connectorRegistry.RouteRegistry(), server: connectorGateway,
			cliBinDir: filepath.Join(tuttitypes.DefaultStateDir(), "connectors", "user-state", "bin")}
		agentConnectorRuntime = connectorAgent
	}
	api, appCenterService, agentRuntime, providerAuthWatcher, err := buildDaemonAPI(
		ctx, workspaceStore, nil, w.browserService, w.computerService,
		modelGateway, agentConnectorRuntime, w.installTuttiModeWatchdogWorker,
	)
	if err != nil {
		_ = modelGateway.Close()
		w.modelGateway = nil
		return err
	}
	if connectorsEnabled {
		connectorMarketStore, err := connectormarketdata.Open(ctx, workspacedata.DefaultDBPath())
		if err != nil {
			agentRuntime.Close()
			providerAuthWatcher.Close()
			return fmt.Errorf("open connector market store: %w", err)
		}
		connectorMarketBaseURL := strings.TrimSpace(os.Getenv("TUTTI_CONNECTOR_MARKET_BASE_URL"))
		if connectorMarketBaseURL == "" {
			connectorMarketBaseURL = connectorMarketDefaultBaseURL
		}
		connectorMarketType := strings.ToLower(strings.TrimSpace(os.Getenv("TUTTI_CONNECTOR_MARKET_TYPE")))
		if connectorMarketType == "" {
			connectorMarketType = "overseas"
		}
		accountService, ok := api.AccountService.(*accountservice.Service)
		if !ok || accountService == nil {
			return errors.New("connector market account session adapter is unavailable")
		}
		marketAuthorizer, err := connectormarketservice.NewAccountSessionAuthorizer(
			accountService.AuthJSONPath,
			os.Getenv("TUTTI_PPE_LANE"),
		)
		if err != nil {
			return fmt.Errorf("configure connector market account authorization: %w", err)
		}
		connectorCatalog, err := connectormarketdaemon.NewCatalogSource(connectormarketdaemon.CatalogSourceConfig{
			BaseURL:            connectorMarketBaseURL,
			ExpectedMarketType: connectorMarketType,
			HTTPClient:         agenthttpx.NewClient(30 * time.Second),
			AuthorizeRequest:   marketAuthorizer.Authorize,
		})
		if err != nil {
			_ = connectorMarketStore.Close()
			agentRuntime.Close()
			providerAuthWatcher.Close()
			return fmt.Errorf("configure connector market catalog: %w", err)
		}
		events, eventsOK := api.EventStreamService.(*eventstreamservice.Service)
		if !eventsOK {
			_ = connectorMarketStore.Close()
			agentRuntime.Close()
			providerAuthWatcher.Close()
			return errors.New("connector market event stream wiring is invalid")
		}
		artifactBaseURL := strings.TrimSpace(os.Getenv("TUTTI_CONNECTOR_ARTIFACT_BASE_URL"))
		if artifactBaseURL == "" {
			artifactBaseURL = connectorArtifactBaseURL
		}
		artifactFetcher, err := marketartifact.NewDirectFetcher(marketartifact.DirectFetcherConfig{
			BaseURL: artifactBaseURL, HTTPClient: agenthttpx.NewClient(5 * time.Minute),
		})
		if err != nil {
			return fmt.Errorf("configure connector artifact download: %w", err)
		}
		connectorStateRoot := filepath.Join(tuttitypes.DefaultStateDir(), "connectors")
		artifactPreparer, err := marketartifact.NewPreparer(marketartifact.Config{RootDir: filepath.Join(connectorStateRoot, "artifacts"), Fetcher: artifactFetcher})
		if err != nil {
			return fmt.Errorf("configure connector artifact preparer: %w", err)
		}
		runtimeResolver, err := managedruntimeservice.NewConnectorRuntimeResolver(managedruntimeservice.ConnectorRuntimeResolverConfig{
			Resolver: managedruntimeservice.DefaultResolver{},
		})
		if err != nil {
			return fmt.Errorf("configure connector managed runtime: %w", err)
		}
		processTransport, err := agentruntime.NewConnectorProcessTransport()
		if err != nil {
			return fmt.Errorf("configure connector process transport: %w", err)
		}
		nodePackageInstaller, err := connectorruntime.NewNodePackageInstaller(connectorruntime.NodePackageInstallerConfig{
			RootDir: filepath.Join(connectorStateRoot, "node-packages"), Runtimes: runtimeResolver, Processes: processTransport,
		})
		if err != nil {
			return fmt.Errorf("configure connector node package installer: %w", err)
		}
		releaseInstaller, err := connectorruntime.NewReleaseInstaller(artifactPreparer, nodePackageInstaller)
		if err != nil {
			return fmt.Errorf("configure connector release installer: %w", err)
		}
		userHome, err := os.UserHomeDir()
		if err != nil || !filepath.IsAbs(userHome) {
			return errors.New("configure connector implementation host: user home is unavailable")
		}
		connectorMCPBaseURL := strings.TrimSpace(os.Getenv("TUTTI_CONNECTOR_MCP_BASE_URL"))
		if connectorMCPBaseURL == "" {
			connectorMCPBaseURL = connectorMCPDefaultBaseURL
		}
		remoteMCPClientFactory, err := connectormarketservice.NewDirectRemoteMCPClientFactory(connectormarketservice.DirectRemoteMCPClientFactoryConfig{
			BaseURL: connectorMCPBaseURL, HTTPClient: agenthttpx.NewClient(2 * time.Minute),
			Timeout: 30 * time.Second, MaxResponseBytes: 4 * 1024 * 1024,
			AuthorizeAccountRequest: marketAuthorizer.AuthorizeForAccount,
		})
		if err != nil {
			return fmt.Errorf("configure remote connector MCP client factory: %w", err)
		}
		implementationHost, err := connectormarketservice.NewImplementationHost(connectormarketservice.ImplementationHostConfig{
			Artifacts: artifactPreparer, CLIInstallations: nodePackageInstaller,
			Runtimes: runtimeResolver, Processes: processTransport, Registry: connectorRegistry,
			RemoteMCPClientFactory: remoteMCPClientFactory,
			StateRoot:              filepath.Join(connectorStateRoot, "user-state"),
			BinDir:                 filepath.Join(tuttitypes.DefaultStateDir(), "bin"),
			UserHome:               userHome,
		})
		if err != nil {
			return fmt.Errorf("configure connector implementation host: %w", err)
		}
		connectorAuthorizationClient, err := connectorcontrolplane.NewAuthorizationClient(connectorcontrolplane.AuthorizationClientConfig{
			BaseURL: connectorMarketBaseURL, APIPrefix: "/v1", HTTPClient: agenthttpx.NewClient(30 * time.Second),
			AuthorizeAccountRequest: marketAuthorizer.AuthorizeForAccount,
		})
		if err != nil {
			return fmt.Errorf("configure connector authorization: %w", err)
		}
		connectorDeviceID, err := tuttitypes.LoadOrCreateDeviceID(tuttitypes.DefaultStateDir())
		if err != nil {
			return fmt.Errorf("configure connector authorization realtime identity: %w", err)
		}
		connectorRealtimeURL := strings.TrimSpace(os.Getenv("TUTTI_CONNECTOR_REALTIME_URL"))
		if connectorRealtimeURL == "" {
			connectorRealtimeURL = strings.TrimSpace(os.Getenv("TUTTI_MOBILE_REALTIME_URL"))
		}
		connectorAuthorizationEvents, err := connectorcontrolplane.NewAuthorizationEventSource(connectorcontrolplane.AuthorizationEventSourceConfig{
			URL: connectorRealtimeURL, DeviceID: connectorDeviceID, HeadersForAccount: marketAuthorizer.HeadersForAccount,
		})
		if err != nil {
			return fmt.Errorf("configure connector authorization realtime: %w", err)
		}
		connectorRuntime, connectorAuthorization, compatibility, implementations := connectormarketservice.ProductionPorts(implementationHost, connectorAuthorizationClient)
		if api.CLIRegistry == nil {
			return errors.New("connector command registry cannot attach to daemon CLI")
		}
		api.CLIRegistry.AppCommands = cliservice.CompositeDynamicCommandRegistry{Registries: []cliservice.DynamicCommandRegistry{
			api.CLIRegistry.AppCommands, connectorCommands,
		}}
		connectorAuthorizationReadiness := connectormarkethost.NewAuthorizationReadinessGate()
		connectorMarketScope := func() connectormarkethost.OperationScope {
			session, sessionErr := accountService.ReadSession()
			if sessionErr != nil || session == nil {
				return connectormarkethost.OperationScope{}
			}
			return connectormarkethost.OperationScope{AccountID: strings.TrimSpace(session.UserID)}
		}
		connectorMarketHost, err := connectormarketdaemon.NewHost(ctx, connectormarketdaemon.HostConfig{
			Repository: connectorMarketStore, CatalogSource: connectorCatalog,
			ReleaseInstallations: releaseInstaller, ImplementationHost: connectorRuntime,
			Authorization: connectorAuthorization, Compatibility: compatibility,
			AuthorizationProjections: connectorMarketStore,
			AuthorizationSnapshots:   connectorAuthorizationClient,
			AuthorizationEvents:      connectorAuthorizationEvents,
			AuthorizationReadiness:   connectorAuthorizationReadiness,
			RuntimeBindings:          connectormarkethost.AccountRuntimeBindingResolver{Projections: connectorMarketStore, Readiness: connectorAuthorizationReadiness},
			ImplementationRegistry:   implementations, Outbox: connectorMarketStore, Lifecycle: connectorMarketStore,
			Publisher: eventstreamservice.ConnectorMarketPublisher{Service: events, CurrentScope: connectorMarketScope},
		})
		if err != nil {
			_ = connectorMarketStore.Close()
			agentRuntime.Close()
			providerAuthWatcher.Close()
			return fmt.Errorf("start connector market host: %w", err)
		}
		if service, ok := api.AgentSessionService.(*agentservice.Service); ok {
			service.ConnectorMarketSnapshots = connectorMarketHost.Application
		}
		api.ConnectorMarketService = connectorMarketHost.Application
		api.ConnectorMarketScope = connectorMarketScope
		api.ConnectorAuthorizationReady = connectorAuthorizationReadiness.Ready
		existingAccountLoginCompleted := accountService.OnLoginCompleted
		accountService.OnLoginCompleted = func(loginContext context.Context) {
			if existingAccountLoginCompleted != nil {
				existingAccountLoginCompleted(loginContext)
			}
			go bootstrapConnectorMarket(connectorMarketHost, connectorMarketScope)
		}
		existingAccountLogoutCompleted := accountService.OnLogoutCompleted
		accountService.OnLogoutCompleted = func(logoutContext context.Context) {
			if existingAccountLogoutCompleted != nil {
				existingAccountLogoutCompleted(logoutContext)
			}
			connectorAgent.RevokeAll()
			fenceContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if fenceErr := connectorMarketHost.FenceForScope(fenceContext, connectormarkethost.OperationScope{}); fenceErr != nil {
				slog.Warn("connector market logout fence failed", "error", fenceErr)
			}
		}
		w.connectorMarketStore = connectorMarketStore
		w.connectorMarketHost = connectorMarketHost
		connectorRegistry.MCPRegistry().SetAuthorizationErrorObserver(connectorMarketHost.NotifyAuthorizationChanged)
		startExistingListenerWork := api.OnListenerReady
		api.OnListenerReady = func() {
			if startExistingListenerWork != nil {
				startExistingListenerWork()
			}
			go bootstrapConnectorMarket(connectorMarketHost, connectorMarketScope)
		}
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
	mobileRemoteService, mobileRemoteOK := api.MobileRemoteService.(*mobileremoteservice.Service)
	if !mobileRemoteOK {
		return errors.New("mobile remote service wiring is invalid")
	}
	w.mobileRemoteHost = mobileRemoteService
	preferencesService, preferencesOK := api.PreferencesService.(*preferencesservice.Service)
	agentUpdateDiscoverer, agentUpdateDiscovererOK := api.AgentStatusService.(agentstatusservice.ManagedProviderUpdateDiscoverer)
	if !preferencesOK || !agentUpdateDiscovererOK {
		return errors.New("agent CLI update scheduler wiring is invalid")
	}
	w.agentCLIUpdateScheduler = agentstatusservice.NewProviderUpdateScheduler(
		agentstatusservice.ProviderUpdateSchedulerConfig{Discoverer: agentUpdateDiscoverer},
	)
	w.observeDesktopPreferenceChanges(preferencesService)

	analyticsConfig := tuttitypes.ResolveAnalyticsConfig()
	debugPublisher := resolveAnalyticsDebugPublisher(analyticsConfig, api.EventStreamService)
	var dynamicContextProvider func() reporterservice.DynamicContext
	if account, ok := api.AccountService.(*accountservice.Service); ok {
		dynamicContextProvider = account.AnalyticsContext
	}
	analyticsReporter, err := reporterservice.New(reporterservice.Config{
		Analytics:      analyticsConfig,
		DebugPublisher: debugPublisher,
		StateDir:       tuttitypes.DefaultStateDir(),
		CommonParams: map[string]any{
			"authority":       "client",
			"business_app_id": "233749",
			"client":          "desktop",
			"environment":     tuttitypes.ResolveDefaultsFromEnv().Runtime.Env,
			"schema_version":  1,
		},
		DynamicContextProvider: dynamicContextProvider,
	})
	if err != nil {
		return fmt.Errorf("create analytics reporter: %w", err)
	}
	attachAnalyticsReporter(&api, analyticsReporter)
	w.analyticsReporter = analyticsReporter
	w.api = api
	w.api.DesktopUpdateAdmissionService = w.desktopUpdateAdmission
	w.appCenterService = appCenterService
	w.tuttiModeWakeRecoveryStarter = api.OnListenerReady
	return nil
}

type desktopPreferencesReader interface {
	GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error)
}

func connectorModuleEnabled(ctx context.Context, preferences desktopPreferencesReader) (bool, error) {
	if preferences == nil {
		return false, errors.New("desktop preferences reader is unavailable")
	}
	current, err := preferences.GetDesktopPreferences(ctx)
	if err != nil {
		return false, err
	}
	return preferencesbiz.IsLabFlagEnabled(current.FeatureFlags, preferencesbiz.LabFlagConnectors), nil
}

func (w *tuttiWiring) observeDesktopPreferenceChanges(preferences *preferencesservice.Service) {
	if w == nil || preferences == nil {
		return
	}
	preferences.RegisterChangeObserver(func(_ context.Context, previous, current preferencesbiz.DesktopPreferences) {
		if w.agentCLIUpdateScheduler != nil && previous.AgentCLIUpdateCheckEnabled != current.AgentCLIUpdateCheckEnabled {
			w.agentCLIUpdateScheduler.SetEnabled(current.AgentCLIUpdateCheckEnabled)
		}
	})
	preferences.RegisterChangeObserver(func(_ context.Context, previous, current preferencesbiz.DesktopPreferences) {
		previousMobileRemoteEnabled := preferencesbiz.IsCapabilityFlagEnabled(
			previous.FeatureFlags,
			preferencesbiz.FeatureFlagMobileRemoteAccess,
		)
		currentMobileRemoteEnabled := preferencesbiz.IsCapabilityFlagEnabled(
			current.FeatureFlags,
			preferencesbiz.FeatureFlagMobileRemoteAccess,
		)
		if previousMobileRemoteEnabled != currentMobileRemoteEnabled {
			w.setMobileRemoteAccessEnabled(currentMobileRemoteEnabled)
		}
	})
}

func (w *tuttiWiring) startTuttiModeWakeRecovery() {
	if w == nil {
		return
	}
	w.tuttiModeWatchdogMu.Lock()
	if w.tuttiModeWatchdogClosed ||
		w.tuttiModeWakeRecoveryStarter == nil {
		w.tuttiModeWatchdogMu.Unlock()
		return
	}
	start := w.tuttiModeWakeRecoveryStarter
	w.tuttiModeWakeRecoveryStarter = nil
	w.tuttiModeWatchdogMu.Unlock()
	start()

	w.tuttiModeWatchdogMu.Lock()
	defer w.tuttiModeWatchdogMu.Unlock()
	if w.tuttiModeWatchdogClosed ||
		w.tuttiModeWatchdogWorker == nil ||
		w.tuttiModeWatchdogDone != nil {
		return
	}
	workerCtx, cancel := context.WithCancel(context.Background())
	w.tuttiModeWatchdogCancel = cancel
	w.tuttiModeWatchdogDone = startTuttiModeWatchdogWorker(
		workerCtx, *w.tuttiModeWatchdogWorker,
	)
}

func (w *tuttiWiring) installTuttiModeWatchdogWorker(
	worker tuttimodeexecutionservice.Worker,
) {
	if w == nil {
		return
	}
	w.tuttiModeWatchdogMu.Lock()
	defer w.tuttiModeWatchdogMu.Unlock()
	if w.tuttiModeWatchdogClosed {
		return
	}
	w.tuttiModeWatchdogWorker = &worker
}

func (w *tuttiWiring) stopTuttiModeWatchdogWorker() {
	if w == nil {
		return
	}
	w.tuttiModeWatchdogMu.Lock()
	w.tuttiModeWatchdogClosed = true
	cancel := w.tuttiModeWatchdogCancel
	done := w.tuttiModeWatchdogDone
	w.tuttiModeWatchdogMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (w *tuttiWiring) startAgentCLIUpdateScheduler() {
	if w == nil || w.agentCLIUpdateScheduler == nil || w.api.PreferencesService == nil {
		return
	}
	preferences, err := w.api.PreferencesService.Get(context.Background())
	if err != nil {
		slog.Warn("failed to read agent CLI update check preference",
			"event", "tutti.agent_provider.update_scheduler.preference_read_failed",
			"error", err,
		)
		w.agentCLIUpdateScheduler.Start(false)
		return
	}
	w.agentCLIUpdateScheduler.Start(preferences.AgentCLIUpdateCheckEnabled)
}

func (w *tuttiWiring) startMobileRemoteHost(handler http.Handler) {
	if w == nil || w.mobileRemoteHost == nil || handler == nil || w.api.PreferencesService == nil {
		return
	}
	w.mobileRemoteHandler = handler
	enabled := false
	preferences, err := w.api.PreferencesService.Get(context.Background())
	if err != nil {
		slog.Warn(
			"failed to read mobile remote access preference",
			"event", "tutti.mobile_remote.preference_read_failed",
			"error", err,
		)
	} else {
		enabled = preferencesbiz.IsCapabilityFlagEnabled(
			preferences.FeatureFlags,
			preferencesbiz.FeatureFlagMobileRemoteAccess,
		)
	}
	w.setMobileRemoteAccessEnabled(enabled)
}

func (w *tuttiWiring) setMobileRemoteAccessEnabled(enabled bool) {
	if w == nil || w.mobileRemoteHost == nil {
		return
	}
	if enabled {
		w.mobileRemoteHost.StartRemoteHost(w.mobileRemoteHandler)
		return
	}
	w.mobileRemoteHost.StopRemoteHost()
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
	if service, ok := api.AccountService.(*accountservice.Service); ok {
		service.SetAnalyticsReporter(analyticsReporter)
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

func bootstrapConnectorMarket(host *connectormarketdaemon.Host, scope func() connectormarkethost.OperationScope) {
	if host == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	operationScope := connectormarkethost.OperationScope{}
	if scope != nil {
		operationScope = scope()
	}
	err := host.BootstrapForScope(ctx, operationScope)
	if err != nil {
		slog.Warn("connector market bootstrap failed; routes remain fenced", "error", err)
	}
}

func (w *tuttiWiring) Close() error {
	if w == nil {
		return nil
	}
	w.stopTuttiModeWatchdogWorker()
	if w.desktopUpdateAdmission != nil {
		w.desktopUpdateAdmission.Close()
	}

	var closeErr error
	if w.mobileRemoteHost != nil {
		w.mobileRemoteHost.StopRemoteHost()
	}
	if w.agentCLIUpdateScheduler != nil {
		w.agentCLIUpdateScheduler.Close()
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
	if w.modelGateway != nil {
		if err := w.modelGateway.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
	}
	if w.connectorMarketHost != nil {
		w.connectorMarketHost.Close()
	}
	// Stop the stable Agent-facing listener before retiring its replaceable
	// backend so no new request can race backend shutdown.
	if w.connectorAgentGateway != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := w.connectorAgentGateway.Close(closeCtx); err != nil && closeErr == nil {
			closeErr = err
		}
		cancel()
	}
	if w.connectorMCPServer != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := w.connectorMCPServer.Close(closeCtx); err != nil && closeErr == nil {
			closeErr = err
		}
		cancel()
	}
	if w.connectorMarketStore != nil {
		if err := w.connectorMarketStore.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
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
