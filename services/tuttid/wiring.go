package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttiserver "github.com/tutti-os/tutti/services/tuttid/server"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type tuttiWiring struct {
	api                     tuttiapi.DaemonAPI
	appCenterService        *workspaceservice.AppCenterService
	workspaceStore          *workspacedata.SQLiteStore
	analyticsReporter       reporterservice.Reporter
	browserService          *browsersvc.Service
	computerService         *computersvc.Service
	agentTargetSetup        *agentextensionservice.SetupService
	agentRuntime            *agentdaemon.Runtime
	providerAuthWatcher     *agentservice.ProviderAuthWatcher
	agentCLIUpdateScheduler *agentstatusservice.ProviderUpdateScheduler
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
	wiring.startAgentCLIUpdateScheduler()

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
	preferencesService, preferencesOK := api.PreferencesService.(*preferencesservice.Service)
	agentStatusService, agentStatusOK := api.AgentStatusService.(*agentstatusservice.Service)
	if !preferencesOK || !agentStatusOK {
		return errors.New("agent CLI update scheduler wiring is invalid")
	}
	w.agentCLIUpdateScheduler = agentstatusservice.NewProviderUpdateScheduler(
		agentstatusservice.ProviderUpdateSchedulerConfig{Discoverer: agentStatusService},
	)
	previousAfterPut := preferencesService.AfterPut
	preferencesService.AfterPut = func(ctx context.Context, previous, current preferencesbiz.DesktopPreferences) {
		if previousAfterPut != nil {
			previousAfterPut(ctx, previous, current)
		}
		if previous.AgentCLIUpdateCheckEnabled != current.AgentCLIUpdateCheckEnabled {
			w.agentCLIUpdateScheduler.SetEnabled(current.AgentCLIUpdateCheckEnabled)
		}
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
	return nil
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

func (w *tuttiWiring) Close() error {
	if w == nil {
		return nil
	}

	var closeErr error
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
