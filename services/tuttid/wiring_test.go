package main

import (
	"context"
	"testing"

	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type fakeAnalyticsDebugEventStream struct{}

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

type recordingWorkspaceAgentTargetResolverSetter struct {
	resolver agentservice.WorkspaceAgentTargetResolver
}

func (r *recordingWorkspaceAgentTargetResolverSetter) SetWorkspaceAgentTargetResolver(
	resolver agentservice.WorkspaceAgentTargetResolver,
) {
	r.resolver = resolver
}

type fakeWorkspaceAgentTargetResolver struct{}

func (fakeWorkspaceAgentTargetResolver) GetWorkspaceAgent(
	context.Context,
	string,
	string,
) (workspaceagentbiz.Agent, error) {
	return workspaceagentbiz.Agent{}, nil
}

func TestConfigureWorkspaceAgentResolutionWiresLaunchAndProjection(t *testing.T) {
	agentSessions := &agentservice.Service{}
	activityProjection := &recordingWorkspaceAgentTargetResolverSetter{}
	workspaceAgents := &workspaceagentservice.Service{}
	workspaceAgentTargets := fakeWorkspaceAgentTargetResolver{}

	configureWorkspaceAgentResolution(
		agentSessions,
		activityProjection,
		workspaceAgents,
		workspaceAgentTargets,
	)

	if agentSessions.WorkspaceAgentResolver != workspaceAgents {
		t.Fatalf(
			"agent session WorkspaceAgentResolver = %T, want workspace agent service",
			agentSessions.WorkspaceAgentResolver,
		)
	}
	if activityProjection.resolver != workspaceAgentTargets {
		t.Fatalf(
			"activity projection WorkspaceAgentTargetResolver = %T, want workspace agent service",
			activityProjection.resolver,
		)
	}
}

var _ reporterservice.DebugPublisher = analyticsDebugEventPublisher{}
