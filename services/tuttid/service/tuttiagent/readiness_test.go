package tuttiagent

import (
	"context"
	"sync/atomic"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

type readinessRuntimeStub struct {
	status      agentstatusservice.ProviderStatus
	action      agentstatusservice.RunActionResult
	listCalls   atomic.Int32
	actionCalls atomic.Int32
}

func (s *readinessRuntimeStub) List(context.Context, agentstatusservice.ListInput) (agentstatusservice.Snapshot, error) {
	s.listCalls.Add(1)
	return agentstatusservice.Snapshot{Providers: []agentstatusservice.ProviderStatus{s.status}}, nil
}

func (s *readinessRuntimeStub) RunAction(context.Context, agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error) {
	s.actionCalls.Add(1)
	return s.action, nil
}

type readinessTargetsStub struct {
	enabled bool
}

func (s readinessTargetsStub) List(context.Context) ([]agenttargetbiz.Target, error) {
	return []agenttargetbiz.Target{{
		ID:      agenttargetbiz.IDLocalTuttiAgent,
		Enabled: s.enabled,
	}}, nil
}

func TestReadinessCoordinatorInstallsRuntimeWhenTargetDisabled(t *testing.T) {
	runtime := missingReadinessRuntime()
	var authCalls atomic.Int32
	coordinator := ReadinessCoordinator{
		Runtime: runtime,
		Targets: readinessTargetsStub{enabled: false},
		BootstrapAuth: func(context.Context) {
			authCalls.Add(1)
		},
	}

	if err := coordinator.Reconcile(t.Context()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if runtime.actionCalls.Load() != 1 {
		t.Fatalf("install calls = %d, want 1", runtime.actionCalls.Load())
	}
	if authCalls.Load() != 0 {
		t.Fatalf("auth calls = %d, want 0 while target is disabled", authCalls.Load())
	}
}

func TestReadinessCoordinatorAuthenticatesAfterRuntimeInstallWhenTargetEnabled(t *testing.T) {
	runtime := missingReadinessRuntime()
	var authCalls atomic.Int32
	coordinator := ReadinessCoordinator{
		Runtime: runtime,
		Targets: readinessTargetsStub{enabled: true},
		BootstrapAuth: func(context.Context) {
			authCalls.Add(1)
		},
	}

	if err := coordinator.Reconcile(t.Context()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if runtime.actionCalls.Load() != 1 || authCalls.Load() != 1 {
		t.Fatalf("install calls = %d, auth calls = %d; want 1, 1", runtime.actionCalls.Load(), authCalls.Load())
	}
}

func TestReadinessCoordinatorSkipsInstallForReadyRuntimeButStillAuthenticates(t *testing.T) {
	runtime := &readinessRuntimeStub{
		status: agentstatusservice.ProviderStatus{
			Provider: tuttiAgentProvider,
			Availability: agentstatusservice.Availability{
				Status: agentstatusservice.AvailabilityReady,
			},
		},
	}
	var authCalls atomic.Int32
	coordinator := ReadinessCoordinator{
		Runtime: runtime,
		Targets: readinessTargetsStub{enabled: true},
		BootstrapAuth: func(context.Context) {
			authCalls.Add(1)
		},
	}

	if err := coordinator.Reconcile(t.Context()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if runtime.actionCalls.Load() != 0 || authCalls.Load() != 1 {
		t.Fatalf("install calls = %d, auth calls = %d; want 0, 1", runtime.actionCalls.Load(), authCalls.Load())
	}
}

func TestReadinessCoordinatorTreatsAuthRequiredAsInstalledRuntime(t *testing.T) {
	runtime := &readinessRuntimeStub{
		status: agentstatusservice.ProviderStatus{
			Provider: tuttiAgentProvider,
			Availability: agentstatusservice.Availability{
				Status: agentstatusservice.AvailabilityAuthRequired,
			},
			CLI: agentstatusservice.CLIStatus{BinaryPath: "/managed/bin/tutti-agent"},
		},
	}
	var authCalls atomic.Int32
	coordinator := ReadinessCoordinator{
		Runtime: runtime,
		Targets: readinessTargetsStub{enabled: true},
		BootstrapAuth: func(context.Context) {
			authCalls.Add(1)
		},
	}

	if err := coordinator.Reconcile(t.Context()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if runtime.actionCalls.Load() != 0 || authCalls.Load() != 1 {
		t.Fatalf("install calls = %d, auth calls = %d; want 0, 1", runtime.actionCalls.Load(), authCalls.Load())
	}
}

func TestReadinessCoordinatorWaitsForExistingInstallAction(t *testing.T) {
	runtime := missingReadinessRuntime()
	runtime.status.ActiveAction = &agentstatusservice.ActiveAction{
		ID:     agentstatusservice.ActionInstall,
		Status: "running",
	}
	var authCalls atomic.Int32
	coordinator := ReadinessCoordinator{
		Runtime: runtime,
		Targets: readinessTargetsStub{enabled: true},
		BootstrapAuth: func(context.Context) {
			authCalls.Add(1)
		},
	}

	if err := coordinator.Reconcile(t.Context()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if runtime.actionCalls.Load() != 0 || authCalls.Load() != 0 {
		t.Fatalf("install calls = %d, auth calls = %d; want 0, 0", runtime.actionCalls.Load(), authCalls.Load())
	}
}

func missingReadinessRuntime() *readinessRuntimeStub {
	return &readinessRuntimeStub{
		status: agentstatusservice.ProviderStatus{
			Provider: tuttiAgentProvider,
			Availability: agentstatusservice.Availability{
				Status:     agentstatusservice.AvailabilityNotInstalled,
				ReasonCode: "cli_not_found",
			},
			Actions: []agentstatusservice.Action{{ID: agentstatusservice.ActionInstall}},
		},
		action: agentstatusservice.RunActionResult{
			Provider: tuttiAgentProvider,
			ActionID: agentstatusservice.ActionInstall,
			Status:   agentstatusservice.RunActionCompleted,
			Probe: &agentstatusservice.ProbeResult{
				Provider:   tuttiAgentProvider,
				Status:     agentstatusservice.ProbeReady,
				BinaryPath: "/managed/bin/tutti-agent",
			},
		},
	}
}
