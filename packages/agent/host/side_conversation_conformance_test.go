package agenthost_test

import (
	"context"
	"errors"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/host/conformance"
)

type sideHostConformanceDriver struct {
	host    *agenthost.Host
	runtime *sideHostRuntime
}

type sideHostRuntime struct {
	sessions        map[string]agenthost.ProviderRuntimeSession
	parentTurnID    string
	sideLive        bool
	transientEvents int
	canonicalWrites int
}

func (d *sideHostConformanceDriver) ResetSideConversation(context.Context) error {
	active := "parent-turn"
	d.runtime = &sideHostRuntime{
		sessions: map[string]agenthost.ProviderRuntimeSession{
			"parent": {
				ID: "parent", WorkspaceID: "workspace-side",
				Provider: "conformance", ProviderSessionID: "provider-parent",
				Scope: agenthost.RuntimeSessionScopeCanonical,
				TurnLifecycle: &agenthost.TurnLifecycle{
					ActiveTurnID: &active, Phase: "running",
				},
			},
		},
		parentTurnID: active,
	}
	d.host = agenthost.New(agenthost.Config{
		Runtime: d.runtime, SideConversationRuntime: d.runtime,
	})
	return nil
}

func (d *sideHostConformanceDriver) SettleSideParent(context.Context) error {
	parent := d.runtime.sessions["parent"]
	parent.TurnLifecycle = nil
	d.runtime.sessions["parent"] = parent
	return nil
}

func (d *sideHostConformanceDriver) OpenSideConversation(
	ctx context.Context,
	input agenthost.OpenSideConversationInput,
) (agenthost.OpenSideConversationResult, error) {
	return d.host.OpenSideConversation(ctx, input)
}

func (d *sideHostConformanceDriver) SendSideConversation(
	ctx context.Context,
	input agenthost.RuntimeExecInput,
) (agenthost.RuntimeExecResult, error) {
	return d.host.SendSideConversation(ctx, input)
}

func (d *sideHostConformanceDriver) CloseSideConversation(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
) error {
	return d.host.CloseSideConversation(ctx, workspaceID, sideAgentSessionID)
}

func (d *sideHostConformanceDriver) SideConversationMetrics() conformance.SideConversationMetrics {
	parent := d.runtime.sessions["parent"]
	return conformance.SideConversationMetrics{
		ParentActive: parent.TurnLifecycle != nil &&
			parent.TurnLifecycle.ActiveTurnID != nil &&
			*parent.TurnLifecycle.ActiveTurnID == d.runtime.parentTurnID,
		CanonicalWrites: d.runtime.canonicalWrites,
		TransientEvents: d.runtime.transientEvents,
		SideLive:        d.runtime.sideLive,
	}
}

func (*sideHostRuntime) Start(
	context.Context,
	agenthost.RuntimeStartInput,
) (agenthost.RuntimeStartResult, error) {
	return agenthost.RuntimeStartResult{}, nil
}

func (*sideHostRuntime) Resume(
	context.Context,
	agenthost.RuntimeResumeInput,
) (agenthost.ProviderRuntimeSession, error) {
	return agenthost.ProviderRuntimeSession{}, nil
}

func (r *sideHostRuntime) Session(
	_ string,
	agentSessionID string,
) (agenthost.ProviderRuntimeSession, bool) {
	session, found := r.sessions[agentSessionID]
	return session, found
}

func (*sideHostRuntime) CanResume(agenthost.RuntimeResumeInput) bool {
	return false
}

func (r *sideHostRuntime) Exec(
	_ context.Context,
	input agenthost.RuntimeExecInput,
) (agenthost.RuntimeExecResult, error) {
	r.transientEvents++
	return agenthost.RuntimeExecResult{
		AgentSessionID: input.AgentSessionID, TurnID: input.TurnID,
		Accepted: true, Status: "started", SessionStatus: "ready",
	}, nil
}

func (*sideHostRuntime) ValidatePromptContent(
	context.Context,
	agenthost.RuntimeExecInput,
) error {
	return nil
}

func (*sideHostRuntime) Cancel(
	context.Context,
	agenthost.RuntimeCancelInput,
) (agenthost.RuntimeCancelResult, error) {
	return agenthost.RuntimeCancelResult{}, nil
}

func (*sideHostRuntime) SubmitInteractive(
	context.Context,
	agenthost.RuntimeSubmitInteractiveInput,
) (agenthost.RuntimeSubmitInteractiveResult, error) {
	return agenthost.RuntimeSubmitInteractiveResult{}, nil
}

func (*sideHostRuntime) InteractiveDisposition(
	string, string, string, string, string,
) agenthost.RuntimeInteractiveDisposition {
	return agenthost.RuntimeInteractiveDispositionUnknown
}

func (*sideHostRuntime) UpdateSettings(
	context.Context,
	agenthost.RuntimeUpdateSettingsInput,
) error {
	return nil
}

func (*sideHostRuntime) SetTitle(
	context.Context,
	agenthost.RuntimeSetTitleInput,
) (agenthost.ProviderRuntimeSession, error) {
	return agenthost.ProviderRuntimeSession{}, nil
}

func (*sideHostRuntime) SetVisible(
	context.Context,
	agenthost.RuntimeSetVisibleInput,
) (agenthost.ProviderRuntimeSession, error) {
	return agenthost.ProviderRuntimeSession{}, nil
}

func (r *sideHostRuntime) Close(
	_ context.Context,
	input agenthost.RuntimeCloseInput,
) error {
	delete(r.sessions, input.AgentSessionID)
	r.sideLive = false
	return nil
}

func (*sideHostRuntime) ResolveSideConversation(
	context.Context,
	agenthost.ProviderRuntimeSession,
) (agenthost.SideConversationCapabilities, error) {
	return agenthost.SideConversationCapabilities{
		Supported: true, ActiveSourceTurn: true, Ephemeral: true,
		HideInheritedTurns: true, ModelBoundaryInjected: true,
	}, nil
}

func (r *sideHostRuntime) OpenSideConversation(
	_ context.Context,
	input agenthost.RuntimeOpenSideConversationInput,
) (agenthost.OpenSideConversationResult, error) {
	side := input.Source
	side.ID = input.SideAgentSessionID
	side.ProviderSessionID = "provider-side"
	side.Scope = agenthost.RuntimeSessionScopeSide
	side.SourceAgentSessionID = input.Source.ID
	side.SideRequestID = input.RequestID
	side.Resumable = false
	side.TurnLifecycle = nil
	r.sessions[side.ID] = side
	r.sideLive = true
	capabilities, _ := r.ResolveSideConversation(context.Background(), input.Source)
	return agenthost.OpenSideConversationResult{
		Session: side, Capabilities: capabilities,
	}, nil
}

func TestHostSideConversationConformance(t *testing.T) {
	for _, scenario := range conformance.SideConversationScenarios() {
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &sideHostConformanceDriver{}
			if err := conformance.RunSideConversation(
				t.Context(), driver, scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type blockingSideHostRuntime struct {
	*sideHostRuntime
	openEntered chan struct{}
	openRelease chan struct{}
}

func (r *blockingSideHostRuntime) OpenSideConversation(
	ctx context.Context,
	input agenthost.RuntimeOpenSideConversationInput,
) (agenthost.OpenSideConversationResult, error) {
	close(r.openEntered)
	select {
	case <-ctx.Done():
		return agenthost.OpenSideConversationResult{}, ctx.Err()
	case <-r.openRelease:
	}
	return r.sideHostRuntime.OpenSideConversation(ctx, input)
}

func TestHostCloseWaitsForCreatingSideAndCannotLeaveGhostReady(t *testing.T) {
	base := &sideHostRuntime{
		sessions: map[string]agenthost.ProviderRuntimeSession{
			"parent": {
				ID: "parent", WorkspaceID: "workspace-side",
				Provider: "conformance", ProviderSessionID: "provider-parent",
				Scope: agenthost.RuntimeSessionScopeCanonical,
			},
		},
	}
	runtime := &blockingSideHostRuntime{
		sideHostRuntime: base,
		openEntered:     make(chan struct{}),
		openRelease:     make(chan struct{}),
	}
	host := agenthost.New(agenthost.Config{
		Runtime: runtime, SideConversationRuntime: runtime,
	})
	openDone := make(chan error, 1)
	go func() {
		_, err := host.OpenSideConversation(t.Context(), agenthost.OpenSideConversationInput{
			WorkspaceID: "workspace-side", SourceAgentSessionID: "parent",
			SideAgentSessionID: "side-race", RequestID: "open-race",
		})
		openDone <- err
	}()
	select {
	case <-runtime.openEntered:
	case <-time.After(time.Second):
		t.Fatal("OpenSideConversation did not reach runtime")
	}
	closeDone := make(chan error, 1)
	go func() {
		closeDone <- host.CloseSideConversation(
			t.Context(), "workspace-side", "side-race",
		)
	}()
	select {
	case err := <-closeDone:
		t.Fatalf("CloseSideConversation overtook creating Side: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(runtime.openRelease)
	if err := <-openDone; err != nil {
		t.Fatal(err)
	}
	if err := <-closeDone; err != nil {
		t.Fatal(err)
	}
	if _, found := runtime.Session("workspace-side", "side-race"); found {
		t.Fatal("Side runtime survived serialized Close")
	}
	_, err := host.SendSideConversation(t.Context(), agenthost.RuntimeExecInput{
		WorkspaceID: "workspace-side", AgentSessionID: "side-race",
		TurnID: "turn-after-close",
	})
	if !errors.Is(err, agenthost.ErrSideConversationExpired) {
		t.Fatalf("SendSideConversation error = %v, want expired", err)
	}
}

func TestHostStaleSideRegistrationCannotTargetCanonicalRuntime(t *testing.T) {
	runtime := &sideHostRuntime{
		sessions: map[string]agenthost.ProviderRuntimeSession{
			"parent": {
				ID: "parent", WorkspaceID: "workspace-side",
				Provider: "conformance", ProviderSessionID: "provider-parent",
				Scope: agenthost.RuntimeSessionScopeCanonical,
			},
		},
	}
	host := agenthost.New(agenthost.Config{
		Runtime: runtime, SideConversationRuntime: runtime,
	})
	if _, err := host.OpenSideConversation(t.Context(), agenthost.OpenSideConversationInput{
		WorkspaceID: "workspace-side", SourceAgentSessionID: "parent",
		SideAgentSessionID: "side-stale", RequestID: "open-stale",
	}); err != nil {
		t.Fatal(err)
	}
	runtime.sessions["side-stale"] = agenthost.ProviderRuntimeSession{
		ID: "side-stale", WorkspaceID: "workspace-side",
		Provider: "conformance", ProviderSessionID: "canonical-replacement",
		Scope: agenthost.RuntimeSessionScopeCanonical,
	}
	if _, err := host.SendSideConversation(t.Context(), agenthost.RuntimeExecInput{
		WorkspaceID: "workspace-side", AgentSessionID: "side-stale",
		TurnID: "turn-stale",
	}); !errors.Is(err, agenthost.ErrSideConversationExpired) {
		t.Fatalf("SendSideConversation error = %v, want expired", err)
	}
	if err := host.CloseSideConversation(
		t.Context(), "workspace-side", "side-stale",
	); !errors.Is(err, agenthost.ErrSideConversationExpired) {
		t.Fatalf("CloseSideConversation error = %v, want expired", err)
	}
	if session, found := runtime.Session("workspace-side", "side-stale"); !found ||
		session.Scope != agenthost.RuntimeSessionScopeCanonical {
		t.Fatal("stale Side close mutated canonical replacement")
	}
}
