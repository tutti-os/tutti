package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

type agentExtensionStartupTargetStore struct{}

func (agentExtensionStartupTargetStore) DeleteAgentTarget(context.Context, string) error { return nil }

func (agentExtensionStartupTargetStore) GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error) {
	return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
}

func (agentExtensionStartupTargetStore) ListAgentTargets(context.Context) ([]agenttargetbiz.Target, error) {
	return nil, nil
}

func (agentExtensionStartupTargetStore) PutAgentTarget(
	_ context.Context,
	target agenttargetbiz.Target,
) (agenttargetbiz.Target, error) {
	return target, nil
}

type agentExtensionStartupDiscovery struct{ root string }

func (d agentExtensionStartupDiscovery) Ensure(context.Context) (string, error) { return d.root, nil }

type agentExtensionStartupTransport struct{}

func (agentExtensionStartupTransport) Start(
	context.Context,
	agentruntime.ProcessSpec,
) (agentruntime.ProcessConnection, error) {
	return nil, errors.New("unexpected process start")
}

func TestStartAgentExtensionReconcilersClosesManagedWorkerAfterPartialFailure(t *testing.T) {
	setup := agentextensionservice.NewSetupService(context.Background())
	setup.Plans.Manager = &agentextensionservice.Manager{
		Store:                       agentExtensionStartupTargetStore{},
		AccountUsageNodeSnapshotDir: t.TempDir(),
	}
	setup.Discovery = agentExtensionStartupDiscovery{root: t.TempDir()}
	setup.Transport = agentExtensionStartupTransport{}

	err := startAgentExtensionReconcilers(setup)
	if err == nil || !strings.Contains(err.Error(), "account usage companion reconciler") {
		t.Fatalf("startAgentExtensionReconcilers() error = %v", err)
	}
	if err := setup.StartManagedRuntimeReconciler(); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("managed runtime reconciler remained open after partial failure: %v", err)
	}
}
