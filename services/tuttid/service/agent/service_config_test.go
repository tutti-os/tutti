package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestConfiguredServiceReturnsPrecomposedApplicationHost(t *testing.T) {
	runtime := newFakeRuntime()
	storeService := newTestService(runtime)
	canonical := configuredServiceHostCanonical{
		serviceHostStore: serviceHostStore{service: storeService},
	}
	hostRuntime := configuredServiceHostRuntime{
		serviceHostRuntime:     serviceHostRuntime{service: storeService},
		serviceHostGoalRuntime: serviceHostGoalRuntime{service: storeService},
	}
	config := ServiceConfig{}
	components := NewServiceComponents(runtime, config, canonical)
	host := NewApplicationHostWithPorts(
		components.HostSupportPorts(),
		canonical,
		nil,
		nil,
		hostRuntime,
	)
	if host == nil {
		t.Fatal("NewApplicationHostWithPorts() = nil")
	}
	if health := host.RuntimeOperationHealth(t.Context()); !health.ActiveStateAvailable {
		t.Fatalf("production canonical health projection unavailable: %#v", health)
	}
	availability, err := host.GetEditRetryAvailability(t.Context(), agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"})
	if err != nil {
		t.Fatalf("production edit retry availability: %v", err)
	}
	if availability.ReasonCode == agenthost.EditRetryReasonCodeRolloutDisabled {
		t.Fatalf("production composition still denies new edit retries: %#v", availability)
	}
	config.Host = ServiceHostConfig{
		ApplicationHost: host,
		Components:      components,
	}

	service := NewService(runtime, config)
	if got := service.ApplicationHost(); got != host {
		t.Fatalf("ApplicationHost() = %p, want %p", got, host)
	}
	if service.hostRuntimePreparation != components.runtimePreparation ||
		service.sessionSettingsState != components.sessionSettings ||
		service.worktreeIsolationLock != components.worktreeIsolationLock {
		t.Fatal("configured Service did not retain the precomposed narrow components")
	}
}

type configuredServiceHostRuntime struct {
	serviceHostRuntime
	serviceHostGoalRuntime
}

func (configuredServiceHostRuntime) SupportsEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (bool, error) {
	return false, nil
}

func (configuredServiceHostRuntime) ReadEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	return agenthost.RuntimeHistorySnapshot{}, nil
}

func (configuredServiceHostRuntime) RollbackLatestTurn(context.Context, agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	return agenthost.RuntimeHistoryMutationResult{}, nil
}

// This constructor-only fixture supplies the complete production composition
// shape while its test intentionally avoids exercising canonical mutations.
type configuredServiceHostCanonical struct {
	serviceHostStore
	agenthost.TurnSubmissionStore
	agenthost.EffectiveHistoryStore
}

func (configuredServiceHostCanonical) ListActiveEditRetryDegradations(context.Context, int) ([]storesqlite.ActiveEditRetryDegradation, int64, bool, error) {
	return nil, 0, false, nil
}

func TestConfiguredServiceRejectsIncompleteHostComposition(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NewService() accepted an incomplete production config")
		}
	}()
	NewService(newFakeRuntime(), ServiceConfig{
		Host: ServiceHostConfig{ApplicationHost: agenthost.New(agenthost.Config{})},
	})
}
