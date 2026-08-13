package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
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
	deletedSessions := &deletedSessionAdapterStoreStub{}
	connector := &testConnectorRuntime{}
	config := ServiceConfig{
		Runtime:  ServiceRuntimeConfig{Connector: connector},
		Sessions: ServiceSessionConfig{DeletedSessions: deletedSessions},
	}
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
	if _, err := host.ListDeletedSessions(context.Background(), agenthost.ListDeletedSessionsInput{
		WorkspaceID: "workspace-deleted-sessions",
	}); err != nil {
		t.Fatalf("ListDeletedSessions() error = %v", err)
	}
	if deletedSessions.listInput.WorkspaceID != "workspace-deleted-sessions" {
		t.Fatalf("ListDeletedSessions() input = %#v, want injected adapter store", deletedSessions.listInput)
	}
	if _, err := host.RestoreDeletedSession(context.Background(), agenthost.RestoreDeletedSessionInput{
		WorkspaceID: "workspace-deleted-sessions", AgentSessionID: "session-restore",
	}); err != nil {
		t.Fatalf("RestoreDeletedSession() error = %v", err)
	}
	if deletedSessions.restoreInput.AgentSessionID != "session-restore" {
		t.Fatalf("RestoreDeletedSession() input = %#v, want injected adapter store", deletedSessions.restoreInput)
	}
	if _, err := host.PurgeDeletedSessionTrees(context.Background(), agenthost.PurgeDeletedSessionTreesInput{
		WorkspaceID: "workspace-deleted-sessions", RootSessionIDs: []string{"session-purge"},
	}); err != nil {
		t.Fatalf("PurgeDeletedSessionTrees() error = %v", err)
	}
	if len(deletedSessions.purgeInput.RootSessionIDs) != 1 || deletedSessions.purgeInput.RootSessionIDs[0] != "session-purge" {
		t.Fatalf("PurgeDeletedSessionTrees() input = %#v, want injected adapter store", deletedSessions.purgeInput)
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
	if service.ConnectorRuntime != connector || components.runtimePreparation.connectorRuntime != connector {
		t.Fatal("configured Service and Host preparation did not retain the stable Connector runtime")
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
