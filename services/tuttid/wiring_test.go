package main

import (
	"context"
	"testing"

	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type fakeAnalyticsDebugEventStream struct{}

type recordingDaemonAppRuntimeStopper struct {
	stopAllCalls int
}

func (s *recordingDaemonAppRuntimeStopper) StopAll(context.Context) {
	s.stopAllCalls += 1
}

func (fakeAnalyticsDebugEventStream) PublishFromServer(context.Context, string, []byte) error {
	return nil
}

func TestResolveAnalyticsDebugPublisherAllowsProductionAnalyticsDebugStream(t *testing.T) {
	got := resolveAnalyticsDebugPublisher(tuttitypes.AnalyticsConfig{
		AppID:         20004092,
		AppKey:        "app-key",
		ChannelDomain: "https://example.test",
	}, fakeAnalyticsDebugEventStream{})

	if _, ok := got.(analyticsDebugEventPublisher); !ok {
		t.Fatalf("debug publisher = %T, want analyticsDebugEventPublisher", got)
	}
}

func TestResolveAnalyticsDebugPublisherSkipsDisabledAnalytics(t *testing.T) {
	got := resolveAnalyticsDebugPublisher(tuttitypes.AnalyticsConfig{
		Disabled:      true,
		AppID:         20004092,
		AppKey:        "app-key",
		ChannelDomain: "https://example.test",
	}, fakeAnalyticsDebugEventStream{})

	if got != nil {
		t.Fatalf("debug publisher = %T, want nil", got)
	}
}

func TestTuttiWiringCloseStopsEveryDaemonAppRuntime(t *testing.T) {
	appCenterRuntime := &recordingDaemonAppRuntimeStopper{}
	appFactoryRuntime := &recordingDaemonAppRuntimeStopper{}
	wiring := &tuttiWiring{
		appRuntimeStoppers: []daemonAppRuntimeStopper{
			appCenterRuntime,
			appFactoryRuntime,
		},
	}

	if err := wiring.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if appCenterRuntime.stopAllCalls != 1 {
		t.Fatalf("App Center runtime StopAll() calls = %d, want 1", appCenterRuntime.stopAllCalls)
	}
	if appFactoryRuntime.stopAllCalls != 1 {
		t.Fatalf("App Factory runtime StopAll() calls = %d, want 1", appFactoryRuntime.stopAllCalls)
	}
}

func TestResolveDaemonAppRuntimeStoppersIncludesAppCenterAndFactory(t *testing.T) {
	appCenterRuntime := &workspaceservice.AppRunner{}
	appFactoryRuntime := &workspaceservice.AppRunner{}
	stoppers := resolveDaemonAppRuntimeStoppers(
		&workspaceservice.AppCenterService{Runner: appCenterRuntime},
		&workspaceservice.AppFactoryService{Runner: appFactoryRuntime},
	)

	if len(stoppers) != 2 {
		t.Fatalf("runtime stopper count = %d, want 2", len(stoppers))
	}
	if stoppers[0] != appCenterRuntime {
		t.Fatalf("first runtime stopper = %T, want App Center runner", stoppers[0])
	}
	if stoppers[1] != appFactoryRuntime {
		t.Fatalf("second runtime stopper = %T, want App Factory runner", stoppers[1])
	}
}

func TestResolveDaemonAppRuntimeStoppersDeduplicatesSharedRunner(t *testing.T) {
	sharedRuntime := &workspaceservice.AppRunner{}
	stoppers := resolveDaemonAppRuntimeStoppers(
		&workspaceservice.AppCenterService{Runner: sharedRuntime},
		&workspaceservice.AppFactoryService{Runner: sharedRuntime},
	)

	if len(stoppers) != 1 {
		t.Fatalf("runtime stopper count = %d, want 1", len(stoppers))
	}
	if stoppers[0] != sharedRuntime {
		t.Fatalf("runtime stopper = %T, want shared runner", stoppers[0])
	}
}

var _ reporterservice.DebugPublisher = analyticsDebugEventPublisher{}
