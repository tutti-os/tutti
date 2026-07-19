package agent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

func TestTuttiModeSnapshotForGuidanceUsesBoundTurnRevision(t *testing.T) {
	t.Parallel()
	activeTurnID := "turn-1"
	coordinator := &fakeTuttiModeActivationCoordinator{
		current:  activationSnapshot("activation-1", "revision-2", 2, tuttimodeactivationbiz.StateInactive, tuttimodeactivationbiz.SourceBadgeRemove),
		existing: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	service := &Service{TuttiModeActivations: coordinator}
	snapshot, err := service.tuttiModeSnapshotForExec(context.Background(), "workspace-1", "session-1", true, ProviderRuntimeSession{
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID},
	})
	if err != nil {
		t.Fatalf("tuttiModeSnapshotForExec() error = %v", err)
	}
	if snapshot.Revision != 1 || snapshot.State != tuttimodeactivationbiz.StateActive || coordinator.existingTurnID != "turn-1" || coordinator.currentCalls != 0 {
		t.Fatalf("snapshot = %#v, coordinator = %#v", snapshot, coordinator)
	}
}

func TestTuttiModeSnapshotForNewTurnReadsCurrentRevisionAndBindsOnce(t *testing.T) {
	t.Parallel()
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-2", 2, tuttimodeactivationbiz.StateInactive, tuttimodeactivationbiz.SourceBadgeRemove),
	}
	service := &Service{TuttiModeActivations: coordinator}
	turnID, snapshot, err := service.prepareTuttiModeExec(context.Background(), "workspace-1", "session-1", false, ProviderRuntimeSession{}, "")
	if err != nil {
		t.Fatalf("prepareTuttiModeExec() error = %v", err)
	}
	if coordinator.currentCalls != 1 || coordinator.boundTurnID != turnID || coordinator.bound.Revision != 2 || turnID == "" || snapshot.Revision != 2 {
		t.Fatalf("coordinator = %#v", coordinator)
	}
}

func TestExecWithTuttiModeSnapshotDoesNotDispatchWhenPersistenceFails(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("snapshot persistence failed")
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
		bindErr: wantErr,
	}
	service := &Service{TuttiModeActivations: coordinator}
	dispatches := 0
	_, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", false, ProviderRuntimeSession{}, "turn-1", func(string, *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		dispatches++
		return RuntimeExecResult{}, nil
	})
	if !errors.Is(err, wantErr) || disposition != submitDeliveryRejectedBeforeAcceptance || dispatches != 0 {
		t.Fatalf("exec error=%v disposition=%q dispatches=%d", err, disposition, dispatches)
	}
}

func TestExecWithTuttiModeSnapshotUsesBoundCanonicalTurnID(t *testing.T) {
	t.Parallel()
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	service := &Service{TuttiModeActivations: coordinator}
	var runtimeTurnID string
	result, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", false, ProviderRuntimeSession{}, "turn-1", func(turnID string, snapshot *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		runtimeTurnID = turnID
		if snapshot == nil || snapshot.RevisionID != "revision-1" {
			t.Fatalf("runtime snapshot = %#v", snapshot)
		}
		return RuntimeExecResult{TurnID: turnID, Accepted: true}, nil
	})
	if err != nil {
		t.Fatalf("execWithTuttiModeSnapshot() error = %v", err)
	}
	if disposition != submitDeliveryAcceptedExact {
		t.Fatalf("disposition = %q, want accepted exact", disposition)
	}
	if result.TurnID == "" || result.TurnID != runtimeTurnID || result.TurnID != coordinator.boundTurnID || coordinator.acceptedTurnID != result.TurnID {
		t.Fatalf("result=%#v runtime=%q coordinator=%#v", result, runtimeTurnID, coordinator)
	}
}

func TestExecWithTuttiModeSnapshotAbandonsOnlyExplicitlyRejectedDispatch(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("runtime rejected before dispatch")
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	service := &Service{TuttiModeActivations: coordinator}
	_, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", false, ProviderRuntimeSession{}, "turn-1", func(string, *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		return RuntimeExecResult{}, wantErr
	})
	if !errors.Is(err, wantErr) || disposition != submitDeliveryRejectedBeforeAcceptance || coordinator.abandonedTurnID == "" || coordinator.abandonedTurnID != coordinator.boundTurnID || coordinator.acceptedTurnID != "" {
		t.Fatalf("error=%v disposition=%q coordinator=%#v", err, disposition, coordinator)
	}
}

func TestExecWithTuttiModeSnapshotFailsClosedOnUnacceptedResult(t *testing.T) {
	t.Parallel()
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	service := &Service{TuttiModeActivations: coordinator}
	_, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", false, ProviderRuntimeSession{}, "turn-1", func(turnID string, _ *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		return RuntimeExecResult{TurnID: turnID, Accepted: false}, nil
	})
	if !errors.Is(err, ErrSubmitRejectedBeforeAcceptance) || errors.Is(err, ErrSubmitDeliveryUnknown) || disposition != submitDeliveryRejectedBeforeAcceptance || coordinator.abandonedTurnID == "" || coordinator.abandonedTurnID != coordinator.boundTurnID {
		t.Fatalf("error=%v disposition=%q coordinator=%#v", err, disposition, coordinator)
	}
}

func TestExecWithTuttiModeSnapshotDoesNotAbandonAcceptedMismatchedTurn(t *testing.T) {
	t.Parallel()
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	service := &Service{TuttiModeActivations: coordinator}
	_, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", false, ProviderRuntimeSession{}, "turn-1", func(string, *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		return RuntimeExecResult{TurnID: "unexpected-provider-turn", Accepted: true}, nil
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || disposition != submitDeliveryUnknown || coordinator.abandonedTurnID != "" || coordinator.acceptedTurnID != "" {
		t.Fatalf("error=%v disposition=%q coordinator=%#v", err, disposition, coordinator)
	}
}

func TestExecWithTuttiModeSnapshotKeepsPreparedEvidenceWhenSnapshotAcceptanceCannotBeConfirmed(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("snapshot accept persistence failed")
	coordinator := &fakeTuttiModeActivationCoordinator{
		current:   activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
		acceptErr: wantErr,
	}
	service := &Service{TuttiModeActivations: coordinator}
	_, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", false, ProviderRuntimeSession{}, "turn-1", func(turnID string, _ *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		return RuntimeExecResult{TurnID: turnID, Accepted: true}, nil
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || !errors.Is(err, wantErr) || disposition != submitDeliveryUnknown || coordinator.abandonedTurnID != "" || coordinator.boundTurnID != "turn-1" {
		t.Fatalf("error=%v disposition=%q coordinator=%#v", err, disposition, coordinator)
	}
}

func TestExecWithTuttiModeSnapshotTreatsGuidanceTransportErrorAsUnknownWithoutDeletingExistingSnapshot(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("guidance transport failed")
	activeTurnID := "turn-1"
	coordinator := &fakeTuttiModeActivationCoordinator{
		existing: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	service := &Service{TuttiModeActivations: coordinator}
	_, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", true, ProviderRuntimeSession{
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID},
	}, "turn-1", func(string, *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		return RuntimeExecResult{}, wantErr
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || !errors.Is(err, wantErr) || disposition != submitDeliveryUnknown || coordinator.abandonedTurnID != "" || coordinator.existingTurnID != "turn-1" {
		t.Fatalf("error=%v disposition=%q coordinator=%#v", err, disposition, coordinator)
	}
}

func TestExecWithTuttiModeSnapshotRejectsGuidanceWhenActiveTurnChangedBeforeDispatch(t *testing.T) {
	t.Parallel()
	activeTurnID := "turn-new"
	coordinator := &fakeTuttiModeActivationCoordinator{
		existing: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	service := &Service{TuttiModeActivations: coordinator}
	dispatches := 0
	_, disposition, err := service.execWithTuttiModeSnapshot(context.Background(), "workspace-1", "session-1", true, ProviderRuntimeSession{
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID},
	}, "turn-old", func(string, *TuttiModeTurnSnapshot) (RuntimeExecResult, error) {
		dispatches++
		return RuntimeExecResult{}, nil
	})
	if !errors.Is(err, ErrSubmitRejectedBeforeAcceptance) || disposition != submitDeliveryRejectedBeforeAcceptance || dispatches != 0 || coordinator.abandonedTurnID != "" {
		t.Fatalf("error=%v disposition=%q dispatches=%d coordinator=%#v", err, disposition, dispatches, coordinator)
	}
}

func TestCreateKeepsClaimSessionActivationAndSnapshotOnAmbiguousAcceptedTurn(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.execHook = func(_ RuntimeExecInput) (RuntimeExecResult, error) {
		return RuntimeExecResult{TurnID: "provider-returned-other-turn", Accepted: true}, nil
	}
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	store := openAgentServiceSQLiteStore(t)
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TuttiModeActivations = coordinator

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-ambiguous",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		ClientSubmitID: "submit-ambiguous",
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) {
		t.Fatalf("Create() error = %v, want delivery unknown", err)
	}
	if len(runtime.execCalls) != 1 || len(runtime.provenanceCalls) != 0 || len(runtime.closeCalls) != 0 {
		t.Fatalf("exec=%#v provenance=%#v close=%#v", runtime.execCalls, runtime.provenanceCalls, runtime.closeCalls)
	}
	if _, ok := runtime.Session("ws-1", "session-ambiguous"); !ok {
		t.Fatal("ambiguous runtime session was deleted")
	}
	if coordinator.boundTurnID == "" || coordinator.abandonedTurnID != "" || len(coordinator.deleteSessionIDs) != 0 || len(coordinator.setInputs) != 1 {
		t.Fatalf("coordinator=%#v", coordinator)
	}
	claim, created, claimErr := store.PrepareSubmitClaim(context.Background(), agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-ambiguous", ClientSubmitID: "submit-ambiguous",
		CanonicalTurnID: "retry-must-not-replace", NowUnixMS: 100,
	})
	if claimErr != nil || created || claim.Status != "prepared" || claim.CanonicalTurnID != runtime.execCalls[0].TurnID {
		t.Fatalf("claim=%#v created=%v error=%v", claim, created, claimErr)
	}
}

func TestCreateInitialTuttiActivationPublishesOnlyAfterBlockedCreateCommitsReadableSession(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Activation barrier"}); err != nil {
		t.Fatal(err)
	}
	projection := NewActivityProjection(store)
	publisher := &testTuttiModeActivationPublisher{store: store}
	activations := &tuttimodeactivationservice.Service{
		Store: store, Publisher: publisher, Sessions: &testTuttiModeActivationSessionReader{store: store},
	}
	started := make(chan struct{})
	release := make(chan struct{})
	runtime := newFakeRuntime()
	runtime.startHook = func(_ RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		close(started)
		<-release
		return session
	}
	service := newTestService(runtime)
	service.SessionReader = projection
	service.SessionInitializer = projection
	service.TuttiModeActivations = activations

	type createResult struct {
		session Session
		err     error
	}
	resultCh := make(chan createResult, 1)
	go func() {
		session, err := service.Create(ctx, "ws-1", CreateSessionInput{
			AgentSessionID: "session-blocked", AgentTargetID: agenttargetbiz.IDLocalCodex,
			InitialTuttiModeActivation: &TuttiModeActivationIntent{
				State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
			},
		})
		resultCh <- createResult{session: session, err: err}
	}()
	<-started
	if publisher.count() != 0 {
		t.Fatalf("events while create is blocked=%d", publisher.count())
	}
	if activation, err := activations.Get(ctx, "ws-1", "session-blocked"); err != nil || activation != nil {
		t.Fatalf("public prepared activation=%#v error=%v", activation, err)
	}
	close(release)
	result := <-resultCh
	if result.err != nil || result.session.ID != "session-blocked" {
		t.Fatalf("Create() session=%#v error=%v", result.session, result.err)
	}
	if publisher.count() != 1 || !publisher.allSessionsReadable() {
		t.Fatalf("events=%d allSessionsReadable=%v", publisher.count(), publisher.allSessionsReadable())
	}
}

func TestCreateInitialContentDoesNotAcceptActivationWhenCreateReturnsWithoutProvenanceBarrier(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Activation retry barrier"}); err != nil {
		t.Fatal(err)
	}
	projection := NewActivityProjection(store)
	if _, err := projection.InitializeRuntimeSession(ctx, ProviderRuntimeSession{
		ID: "session-returned-before-provenance", WorkspaceID: "ws-1", AgentTargetID: agenttargetbiz.IDLocalCodex,
		Provider: "codex", Status: "ready", Visible: true, CreatedAtUnixMS: 10, UpdatedAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("InitializeRuntimeSession() error=%v", err)
	}
	if _, created, err := store.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-returned-before-provenance",
		ClientSubmitID: "submit-returned-before-provenance", CanonicalTurnID: "turn-1", NowUnixMS: 20,
	}); err != nil || !created {
		t.Fatalf("PrepareSubmitClaim() created=%v error=%v", created, err)
	}
	if _, accepted, err := store.AcceptSubmitClaim(
		ctx, "ws-1", "session-returned-before-provenance", "submit-returned-before-provenance", "turn-1", 30,
	); err != nil || !accepted {
		t.Fatalf("AcceptSubmitClaim() accepted=%v error=%v", accepted, err)
	}
	publisher := &testTuttiModeActivationPublisher{store: store}
	activations := &tuttimodeactivationservice.Service{
		Store: store, Publisher: publisher, Sessions: &testTuttiModeActivationSessionReader{store: store},
	}
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.SessionReader = projection
	service.SessionInitializer = projection
	service.TurnStore = store
	service.SubmitClaimStore = store
	service.TuttiModeActivations = activations

	result, err := service.Create(ctx, "ws-1", CreateSessionInput{
		AgentSessionID: "session-returned-before-provenance", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"), ClientSubmitID: "submit-returned-before-provenance",
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if err != nil || result.ID != "session-returned-before-provenance" {
		t.Fatalf("Create() result=%#v error=%v", result, err)
	}
	if len(runtime.startCalls) != 0 || len(runtime.execCalls) != 0 || len(runtime.provenanceCalls) != 0 {
		t.Fatalf("runtime start=%#v exec=%#v provenance=%#v", runtime.startCalls, runtime.execCalls, runtime.provenanceCalls)
	}
	prepared, prepareErr := store.ListPreparedTuttiModeActivations(ctx)
	if prepareErr != nil || len(prepared) != 1 || prepared[0].InitialTurnID != "turn-1" || publisher.count() != 0 {
		t.Fatalf("prepared=%#v events=%d error=%v", prepared, publisher.count(), prepareErr)
	}
	accepted, acceptErr := store.IsTuttiModeTurnSnapshotAccepted(
		ctx, "ws-1", "session-returned-before-provenance", "turn-1",
	)
	if acceptErr != nil || accepted {
		t.Fatalf("snapshot accepted=%v error=%v", accepted, acceptErr)
	}
	if activation, getErr := activations.Get(ctx, "ws-1", "session-returned-before-provenance"); getErr != nil || activation != nil {
		t.Fatalf("public prepared activation=%#v error=%v", activation, getErr)
	}
	if err := activations.RecoverPrepared(ctx); err != nil {
		t.Fatalf("RecoverPrepared() error=%v", err)
	}
	prepared, prepareErr = store.ListPreparedTuttiModeActivations(ctx)
	if prepareErr != nil || len(prepared) != 1 || publisher.count() != 0 {
		t.Fatalf("prepared after recovery=%#v events=%d error=%v", prepared, publisher.count(), prepareErr)
	}
}

func TestCreateInitialTuttiActivationExplicitFailureAbandonsWithoutEvent(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Activation failure"}); err != nil {
		t.Fatal(err)
	}
	publisher := &testTuttiModeActivationPublisher{store: store}
	activations := &tuttimodeactivationservice.Service{
		Store: store, Publisher: publisher, Sessions: &testTuttiModeActivationSessionReader{store: store},
	}
	runtime := newFakeRuntime()
	runtime.startErr = errors.New("provider start rejected")
	service := newTestService(runtime)
	service.TuttiModeActivations = activations

	_, err := service.Create(ctx, "ws-1", CreateSessionInput{
		AgentSessionID: "session-failed", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if err == nil {
		t.Fatal("Create() error=nil")
	}
	prepared, prepareErr := store.ListPreparedTuttiModeActivations(ctx)
	if prepareErr != nil || len(prepared) != 0 || publisher.count() != 0 {
		t.Fatalf("prepared=%#v events=%d error=%v", prepared, publisher.count(), prepareErr)
	}
}

func TestCreateInitialTuttiActivationDeliveryUnknownKeepsPreparedAndInvisible(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Activation unknown"}); err != nil {
		t.Fatal(err)
	}
	projection := NewActivityProjection(store)
	publisher := &testTuttiModeActivationPublisher{store: store}
	activations := &tuttimodeactivationservice.Service{
		Store: store, Publisher: publisher, Sessions: &testTuttiModeActivationSessionReader{store: store},
	}
	runtime := newFakeRuntime()
	runtime.execHook = func(RuntimeExecInput) (RuntimeExecResult, error) {
		return RuntimeExecResult{TurnID: "provider-mismatch", Accepted: true}, nil
	}
	service := newTestService(runtime)
	service.SessionReader = projection
	service.SessionInitializer = projection
	service.TuttiModeActivations = activations

	_, err := service.Create(ctx, "ws-1", CreateSessionInput{
		AgentSessionID: "session-unknown", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) {
		t.Fatalf("Create() error=%v, want delivery unknown", err)
	}
	prepared, prepareErr := store.ListPreparedTuttiModeActivations(ctx)
	if prepareErr != nil || len(prepared) != 1 || publisher.count() != 0 {
		t.Fatalf("prepared=%#v events=%d error=%v", prepared, publisher.count(), prepareErr)
	}
	if activation, getErr := activations.Get(ctx, "ws-1", "session-unknown"); getErr != nil || activation != nil {
		t.Fatalf("public prepared activation=%#v error=%v", activation, getErr)
	}
	accepted, acceptErr := store.IsTuttiModeTurnSnapshotAccepted(ctx, "ws-1", "session-unknown", prepared[0].InitialTurnID)
	if acceptErr != nil || accepted {
		t.Fatalf("provisional snapshot accepted=%v error=%v", accepted, acceptErr)
	}
}

func TestCreateInitialContentWithoutDurableProvenanceReporterStaysPrepared(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Activation provenance barrier"}); err != nil {
		t.Fatal(err)
	}
	projection := NewActivityProjection(store)
	publisher := &testTuttiModeActivationPublisher{store: store}
	activations := &tuttimodeactivationservice.Service{
		Store: store, Publisher: publisher, Sessions: &testTuttiModeActivationSessionReader{store: store},
	}
	runtime := newFakeRuntime()
	service := newTestService(runtimeWithoutDurableProvenance{RuntimeController: runtime})
	service.SessionReader = projection
	service.SessionInitializer = projection
	service.TuttiModeActivations = activations

	_, err := service.Create(ctx, "ws-1", CreateSessionInput{
		AgentSessionID: "session-no-provenance-reporter", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) {
		t.Fatalf("Create() error=%v, want delivery unknown", err)
	}
	if len(runtime.execCalls) != 1 || len(runtime.provenanceCalls) != 0 {
		t.Fatalf("runtime exec=%#v provenance=%#v", runtime.execCalls, runtime.provenanceCalls)
	}
	prepared, prepareErr := store.ListPreparedTuttiModeActivations(ctx)
	if prepareErr != nil || len(prepared) != 1 || publisher.count() != 0 {
		t.Fatalf("prepared=%#v events=%d error=%v", prepared, publisher.count(), prepareErr)
	}
	accepted, acceptErr := store.IsTuttiModeTurnSnapshotAccepted(
		ctx, "ws-1", "session-no-provenance-reporter", prepared[0].InitialTurnID,
	)
	if acceptErr != nil || accepted {
		t.Fatalf("snapshot accepted=%v error=%v", accepted, acceptErr)
	}
}

func TestCreateInitialTuttiActivationCrashRecoveryAcceptsFromDurableBarrier(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Activation recovery"}); err != nil {
		t.Fatal(err)
	}
	projection := NewActivityProjection(store)
	publisher := &testTuttiModeActivationPublisher{store: store}
	sessionReader := &testTuttiModeActivationSessionReader{store: store, failNextExists: errors.New("simulated process stop before activation accept")}
	activations := &tuttimodeactivationservice.Service{Store: store, Publisher: publisher, Sessions: sessionReader}
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.SessionReader = projection
	service.SessionInitializer = projection
	service.TuttiModeActivations = activations

	_, err := service.Create(ctx, "ws-1", CreateSessionInput{
		AgentSessionID: "session-recovery", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || publisher.count() != 0 {
		t.Fatalf("Create() error=%v events=%d", err, publisher.count())
	}
	prepared, prepareErr := store.ListPreparedTuttiModeActivations(ctx)
	if prepareErr != nil || len(prepared) != 1 {
		t.Fatalf("prepared=%#v error=%v", prepared, prepareErr)
	}
	accepted, acceptErr := store.IsTuttiModeTurnSnapshotAccepted(ctx, "ws-1", "session-recovery", prepared[0].InitialTurnID)
	if acceptErr != nil || !accepted {
		t.Fatalf("snapshot accepted=%v error=%v", accepted, acceptErr)
	}

	recovered := &tuttimodeactivationservice.Service{
		Store: store, Publisher: publisher, Sessions: &testTuttiModeActivationSessionReader{store: store},
	}
	if err := recovered.RecoverPrepared(ctx); err != nil {
		t.Fatalf("RecoverPrepared() error=%v", err)
	}
	if publisher.count() != 1 || !publisher.allSessionsReadable() {
		t.Fatalf("events=%d allSessionsReadable=%v", publisher.count(), publisher.allSessionsReadable())
	}
	if activation, getErr := recovered.Get(ctx, "ws-1", "session-recovery"); getErr != nil || activation == nil {
		t.Fatalf("recovered activation=%#v error=%v", activation, getErr)
	}
}

func TestCreateSnapshotBindFailureCompensatesSessionActivationAndClaimBeforeDispatch(t *testing.T) {
	wantErr := errors.New("snapshot bind failed")
	runtime := newFakeRuntime()
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
		bindErr: wantErr,
	}
	store := openAgentServiceSQLiteStore(t)
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TuttiModeActivations = coordinator

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-bind-failure",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		ClientSubmitID: "submit-bind-failure",
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("Create() error = %v, want bind failure", err)
	}
	if len(runtime.execCalls) != 0 || len(runtime.closeCalls) != 0 {
		t.Fatalf("exec=%#v close=%#v", runtime.execCalls, runtime.closeCalls)
	}
	if _, ok := runtime.Session("ws-1", "session-bind-failure"); ok {
		t.Fatal("runtime session survived rejected pre-dispatch bind")
	}
	if len(coordinator.setInputs) != 1 || len(coordinator.deleteSessionIDs) != 1 || coordinator.deleteSessionIDs[0] != "session-bind-failure" {
		t.Fatalf("coordinator=%#v", coordinator)
	}
	if claim, found, claimErr := store.GetSubmitClaim(context.Background(), "ws-1", "session-bind-failure", "submit-bind-failure"); claimErr != nil || found {
		t.Fatalf("claim=%#v found=%v error=%v", claim, found, claimErr)
	}
}

func TestCreateBarrierFailureKeepsPreparedClaimSnapshotAndRuntimeWithoutRedispatch(t *testing.T) {
	wantErr := errors.New("atomic submit provenance failed")
	runtime := newFakeRuntime()
	runtime.provenanceErr = wantErr
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	store := openAgentServiceSQLiteStore(t)
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TuttiModeActivations = coordinator
	input := CreateSessionInput{
		AgentSessionID: "session-barrier-failure",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		ClientSubmitID: "submit-barrier-failure",
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	}

	_, err := service.Create(context.Background(), "ws-1", input)
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || !errors.Is(err, wantErr) {
		t.Fatalf("Create() error = %v", err)
	}
	if len(runtime.execCalls) != 1 || len(runtime.provenanceCalls) != 1 || len(runtime.closeCalls) != 0 {
		t.Fatalf("runtime exec=%#v provenance=%#v close=%#v", runtime.execCalls, runtime.provenanceCalls, runtime.closeCalls)
	}
	if runtime.provenanceCalls[0].ClientSubmitID != input.ClientSubmitID || runtime.provenanceCalls[0].TurnID != runtime.execCalls[0].TurnID {
		t.Fatalf("provenance=%#v exec=%#v", runtime.provenanceCalls, runtime.execCalls)
	}
	if _, ok := runtime.Session("ws-1", input.AgentSessionID); !ok {
		t.Fatal("runtime session was removed after post-dispatch barrier failure")
	}
	if coordinator.boundTurnID == "" || coordinator.abandonedTurnID != "" || coordinator.acceptedTurnID != "" {
		t.Fatalf("coordinator=%#v", coordinator)
	}
	claim, found, claimErr := store.GetSubmitClaim(context.Background(), "ws-1", input.AgentSessionID, "submit-barrier-failure")
	if claimErr != nil || !found || claim.Status != "prepared" || claim.CanonicalTurnID != coordinator.boundTurnID {
		t.Fatalf("claim=%#v found=%v error=%v", claim, found, claimErr)
	}

	_, retryErr := service.Create(context.Background(), "ws-1", input)
	if !errors.Is(retryErr, ErrSubmitDeliveryUnknown) || len(runtime.execCalls) != 1 || len(runtime.provenanceCalls) != 1 {
		t.Fatalf("retry error=%v exec=%#v provenance=%#v", retryErr, runtime.execCalls, runtime.provenanceCalls)
	}
}

func TestPreparedGuidanceClaimsReconcileIndependentlyOnOneCanonicalTurnWithoutReplay(t *testing.T) {
	store := openAgentServiceSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Recovery"}); err != nil {
		t.Fatal(err)
	}
	for index, clientSubmitID := range []string{"guidance-1", "guidance-2"} {
		if _, created, err := store.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
			WorkspaceID: "ws-1", AgentSessionID: "session-guidance", ClientSubmitID: clientSubmitID,
			CanonicalTurnID: "turn-active", NowUnixMS: int64(10 + index),
		}); err != nil || !created {
			t.Fatalf("prepare %s created=%v err=%v", clientSubmitID, created, err)
		}
	}
	seedDurableClientSubmitEvidence(t, store, "session-guidance", "turn-active", "guidance-1", "guidance-message-1", 100)
	seedDurableClientSubmitEvidence(t, store, "session-guidance", "turn-active", "guidance-2", "guidance-message-2", 110)

	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-guidance"] = ProviderRuntimeSession{
		ID: "session-guidance", WorkspaceID: "ws-1", Provider: "codex", Status: "ready", Visible: true,
	}
	coordinator := &fakeTuttiModeActivationCoordinator{}
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TurnStore = store
	service.TuttiModeActivations = coordinator

	for _, clientSubmitID := range []string{"guidance-1", "guidance-2"} {
		result, err := service.SendInput(ctx, "ws-1", "session-guidance", SendInput{
			Content: TextPromptContent("already delivered guidance"), Guidance: true,
			ClientSubmitID: clientSubmitID,
		})
		if err != nil || result.TurnID != "turn-active" {
			t.Fatalf("SendInput(%s) result=%#v err=%v", clientSubmitID, result, err)
		}
		claim, created, err := store.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
			WorkspaceID: "ws-1", AgentSessionID: "session-guidance", ClientSubmitID: clientSubmitID,
			CanonicalTurnID: "must-not-replace", NowUnixMS: 200,
		})
		if err != nil || created || claim.Status != "accepted" || claim.TurnID != "turn-active" || claim.CanonicalTurnID != "turn-active" {
			t.Fatalf("reconciled %s claim=%#v created=%v err=%v", clientSubmitID, claim, created, err)
		}
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("runtime replayed prepared guidance: %#v", runtime.execCalls)
	}
}

func TestPreparedClaimWithMismatchedDurableProvenanceStaysUnknownWithoutReplay(t *testing.T) {
	store := openAgentServiceSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Recovery"}); err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance", ClientSubmitID: "guidance-1",
		CanonicalTurnID: "turn-active", NowUnixMS: 10,
	}); err != nil || !created {
		t.Fatalf("prepare created=%v err=%v", created, err)
	}
	seedDurableClientSubmitEvidence(t, store, "session-guidance", "turn-other", "guidance-1", "guidance-message-1", 100)

	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-guidance"] = ProviderRuntimeSession{
		ID: "session-guidance", WorkspaceID: "ws-1", Provider: "codex", Status: "ready", Visible: true,
	}
	coordinator := &fakeTuttiModeActivationCoordinator{}
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TurnStore = store
	service.TuttiModeActivations = coordinator

	_, err := service.SendInput(ctx, "ws-1", "session-guidance", SendInput{
		Content: TextPromptContent("must not replay"), Guidance: true,
		ClientSubmitID: "guidance-1",
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || len(runtime.execCalls) != 0 || coordinator.acceptedTurnID != "" {
		t.Fatalf("error=%v runtime=%#v coordinator=%#v", err, runtime.execCalls, coordinator)
	}
	claim, created, claimErr := store.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance", ClientSubmitID: "guidance-1",
		CanonicalTurnID: "retry", NowUnixMS: 200,
	})
	if claimErr != nil || created || claim.Status != "prepared" || claim.CanonicalTurnID != "turn-active" {
		t.Fatalf("claim=%#v created=%v err=%v", claim, created, claimErr)
	}
}

func TestGuidanceTransportFailureKeepsPreparedClaimAndExistingSnapshot(t *testing.T) {
	wantErr := errors.New("provider guidance transport failed")
	runtime := newFakeRuntime()
	runtime.execErr = wantErr
	activeTurnID := "turn-active"
	runtime.sessions["ws-1:session-guidance"] = ProviderRuntimeSession{
		ID: "session-guidance", WorkspaceID: "ws-1", Provider: "codex", Status: "working", Visible: true,
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID, Phase: "running"},
	}
	coordinator := &fakeTuttiModeActivationCoordinator{
		existing: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
	}
	store := openAgentServiceSQLiteStore(t)
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TuttiModeActivations = coordinator

	_, err := service.SendInput(context.Background(), "ws-1", "session-guidance", SendInput{
		Content: TextPromptContent("ambiguous guidance"), Guidance: true,
		ClientSubmitID: "guidance-ambiguous",
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || !errors.Is(err, wantErr) {
		t.Fatalf("SendInput() error = %v", err)
	}
	if len(runtime.execCalls) != 1 || coordinator.abandonedTurnID != "" || coordinator.existingTurnID != "turn-active" {
		t.Fatalf("runtime=%#v coordinator=%#v", runtime.execCalls, coordinator)
	}
	claim, created, claimErr := store.PrepareSubmitClaim(context.Background(), agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance", ClientSubmitID: "guidance-ambiguous",
		CanonicalTurnID: "retry", NowUnixMS: 200,
	})
	if claimErr != nil || created || claim.Status != "prepared" || claim.CanonicalTurnID != "turn-active" {
		t.Fatalf("claim=%#v created=%v error=%v", claim, created, claimErr)
	}
}

func TestCreateAcceptsSnapshotBeforeClaimAndKeepsAllEvidenceWhenClaimAcceptFails(t *testing.T) {
	wantErr := errors.New("claim accept persistence failed")
	order := make([]string, 0, 3)
	runtime := newFakeRuntime()
	coordinator := &fakeTuttiModeActivationCoordinator{
		current: activationSnapshot("activation-1", "revision-1", 1, tuttimodeactivationbiz.StateActive, tuttimodeactivationbiz.SourceSlashCommand),
		acceptHook: func() {
			order = append(order, "snapshot")
		},
	}
	store := &recordingSubmitClaimStore{
		SQLiteStore: openAgentServiceSQLiteStore(t),
		acceptErr:   wantErr,
		acceptHook: func() {
			order = append(order, "claim")
		},
	}
	if err := store.Create(context.Background(), workspacebiz.Summary{ID: "ws-1", Name: "Claim acceptance"}); err != nil {
		t.Fatal(err)
	}
	runtime.execHook = func(input RuntimeExecInput) (RuntimeExecResult, error) {
		return RuntimeExecResult{AgentSessionID: input.AgentSessionID, TurnID: input.TurnID, Accepted: true}, nil
	}
	runtime.provenanceHook = func(input RuntimeSubmitProvenanceInput) error {
		order = append(order, "provenance")
		seedDurableClientSubmitEvidence(t, store.SQLiteStore, input.AgentSessionID, input.TurnID, input.ClientSubmitID, "client-submit:"+input.ClientSubmitID, 100)
		return nil
	}
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TuttiModeActivations = coordinator

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-claim-accept-failure",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		ClientSubmitID: "submit-claim-accept-failure",
		InitialTuttiModeActivation: &TuttiModeActivationIntent{
			State: string(tuttimodeactivationbiz.StateActive), Source: string(tuttimodeactivationbiz.SourceSlashCommand),
		},
	})
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || !errors.Is(err, wantErr) {
		t.Fatalf("Create() error = %v", err)
	}
	if len(order) != 3 || order[0] != "provenance" || order[1] != "snapshot" || order[2] != "claim" {
		t.Fatalf("accept order = %#v", order)
	}
	if len(runtime.execCalls) != 1 || len(runtime.closeCalls) != 0 {
		t.Fatalf("runtime exec=%#v close=%#v", runtime.execCalls, runtime.closeCalls)
	}
	if _, ok := runtime.Session("ws-1", "session-claim-accept-failure"); !ok {
		t.Fatal("runtime session was deleted after ambiguous claim acceptance")
	}
	if coordinator.acceptedTurnID != runtime.execCalls[0].TurnID || coordinator.abandonedTurnID != "" || len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("coordinator=%#v", coordinator)
	}
	claim, created, claimErr := store.PrepareSubmitClaim(context.Background(), agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-claim-accept-failure", ClientSubmitID: "submit-claim-accept-failure",
		CanonicalTurnID: "retry", NowUnixMS: 200,
	})
	if claimErr != nil || created || claim.Status != "prepared" || claim.CanonicalTurnID != runtime.execCalls[0].TurnID {
		t.Fatalf("claim=%#v created=%v err=%v", claim, created, claimErr)
	}
}

func TestSubmitClaimAcceptResponseLossReconcilesWithoutProviderRedispatch(t *testing.T) {
	wantErr := errors.New("claim accept response lost")
	store := &recordingSubmitClaimStore{
		SQLiteStore:          openAgentServiceSQLiteStore(t),
		acceptAfterCommitErr: wantErr,
	}
	if err := store.Create(context.Background(), workspacebiz.Summary{ID: "ws-1", Name: "Response loss"}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-response-loss"] = ProviderRuntimeSession{
		ID: "session-response-loss", WorkspaceID: "ws-1", Provider: "codex", Status: "ready", Visible: true,
	}
	runtime.execHook = func(input RuntimeExecInput) (RuntimeExecResult, error) {
		seedDurableClientSubmitEvidence(t, store.SQLiteStore, input.AgentSessionID, input.TurnID, "submit-response-loss", "client-submit:submit-response-loss", 100)
		return RuntimeExecResult{
			AgentSessionID: input.AgentSessionID, TurnID: input.TurnID, Accepted: true,
			SessionStatus: "working", TurnLifecycle: TurnLifecycle{Phase: "submitted"},
		}, nil
	}
	service := newTestService(runtime)
	service.SubmitClaimStore = store
	service.TurnStore = store
	input := SendInput{
		Content:        TextPromptContent("hello"),
		ClientSubmitID: "submit-response-loss",
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-response-loss", input)
	if !errors.Is(err, ErrSubmitDeliveryUnknown) || !errors.Is(err, wantErr) {
		t.Fatalf("first SendInput() error = %v", err)
	}
	store.acceptAfterCommitErr = nil
	result, err := service.SendInput(context.Background(), "ws-1", "session-response-loss", input)
	if err != nil || result.TurnID == "" {
		t.Fatalf("retry SendInput() result=%#v error=%v", result, err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("runtime redispatched after accepted-commit response loss: %#v", runtime.execCalls)
	}
}

func seedDurableClientSubmitEvidence(t *testing.T, store *workspacedata.SQLiteStore, sessionID, turnID, clientSubmitID, messageID string, occurredAt int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: sessionID, Origin: "runtime", Provider: "codex",
		ProviderSessionID: sessionID, Cwd: "/workspace", Title: "recovery", Status: "running",
		OccurredAtUnixMS: occurredAt - 1, StartedAtUnixMS: occurredAt - 2,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	projection := NewActivityProjection(store)
	if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID: "ws-1", AgentSessionID: sessionID,
		SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Provider: "codex", OccurredAtUnixMS: occurredAt - 1,
			Turn: &canonical.WorkspaceAgentTurnStateUpdate{
				TurnID: turnID, Phase: agentactivitybiz.TurnPhaseSubmitted,
				StartedAtUnixMS: occurredAt - 1,
			},
		},
	}); err != nil {
		t.Fatalf("ReportSessionState(turn) error = %v", err)
	}
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: sessionID, Origin: "runtime", Provider: "codex",
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID: messageID, TurnID: turnID, Role: "user", Kind: "text", Status: "completed",
			Payload:          map[string]any{"text": "guidance", "clientSubmitId": clientSubmitID},
			OccurredAtUnixMS: occurredAt, CompletedAtUnixMS: occurredAt,
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
}

type testTuttiModeActivationSessionReader struct {
	mu             sync.Mutex
	store          *workspacedata.SQLiteStore
	failNextExists error
}

type runtimeWithoutDurableProvenance struct {
	RuntimeController
}

func (r *testTuttiModeActivationSessionReader) SessionExists(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	r.mu.Lock()
	if r.failNextExists != nil {
		err := r.failNextExists
		r.failNextExists = nil
		r.mu.Unlock()
		return false, err
	}
	r.mu.Unlock()
	_, found, err := r.store.GetSession(ctx, workspaceID, sessionID)
	return found, err
}

func (r *testTuttiModeActivationSessionReader) SessionDeleted(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	return r.store.SessionDeleted(ctx, workspaceID, sessionID)
}

type testTuttiModeActivationPublisher struct {
	mu                   sync.Mutex
	store                *workspacedata.SQLiteStore
	updates              []tuttimodeactivationbiz.Update
	allReadableAtPublish bool
}

func (p *testTuttiModeActivationPublisher) PublishTuttiModeActivationUpdated(ctx context.Context, update tuttimodeactivationbiz.Update) error {
	_, found, err := p.store.GetSession(ctx, update.WorkspaceID, update.AgentSessionID)
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.updates) == 0 {
		p.allReadableAtPublish = true
	}
	p.allReadableAtPublish = p.allReadableAtPublish && found && err == nil
	p.updates = append(p.updates, update)
	return nil
}

func (p *testTuttiModeActivationPublisher) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.updates)
}

func (p *testTuttiModeActivationPublisher) allSessionsReadable() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.allReadableAtPublish
}

type fakeTuttiModeActivationCoordinator struct {
	activation         *tuttimodeactivationbiz.Activation
	current            tuttimodeactivationbiz.TurnSnapshot
	existing           tuttimodeactivationbiz.TurnSnapshot
	currentCalls       int
	existingTurnID     string
	boundTurnID        string
	bound              tuttimodeactivationbiz.TurnSnapshot
	abandonedTurnID    string
	acceptedTurnID     string
	acceptErr          error
	acceptHook         func()
	activationAccepts  int
	activationAbandons int
	bindErr            error
	setInputs          []tuttimodeactivationservice.SetInput
	deleteSessionIDs   []string
	deleteErrors       []error
}

func (f *fakeTuttiModeActivationCoordinator) Get(context.Context, string, string) (*tuttimodeactivationbiz.Activation, error) {
	return f.activation, nil
}

func (*fakeTuttiModeActivationCoordinator) List(context.Context, string, []string) (map[string]tuttimodeactivationbiz.Activation, error) {
	return map[string]tuttimodeactivationbiz.Activation{}, nil
}

func (f *fakeTuttiModeActivationCoordinator) Set(_ context.Context, input tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error) {
	f.setInputs = append(f.setInputs, input)
	return tuttimodeactivationservice.SetResult{}, nil
}

func (f *fakeTuttiModeActivationCoordinator) Prepare(_ context.Context, input tuttimodeactivationservice.SetInput, _ string) (tuttimodeactivationservice.SetResult, error) {
	f.setInputs = append(f.setInputs, input)
	activation := activationFromSnapshot(f.current)
	if activation == nil {
		now := time.Unix(100, 0).UTC()
		activation = &tuttimodeactivationbiz.Activation{
			ID: "activation-initial", WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			CreatedAt: now, UpdatedAt: now,
			CurrentRevision: tuttimodeactivationbiz.Revision{
				ID: "revision-initial", ActivationID: "activation-initial", Revision: 1,
				State: input.State, Source: input.Source,
				OrchestrationIntensity: tuttimodeactivationbiz.DefaultOrchestrationIntensity, CreatedAt: now,
			},
		}
	}
	return tuttimodeactivationservice.SetResult{Activation: activation, Changed: true}, nil
}

func (f *fakeTuttiModeActivationCoordinator) Accept(context.Context, string, string) (bool, error) {
	f.activationAccepts++
	return true, nil
}

func (f *fakeTuttiModeActivationCoordinator) Abandon(_ context.Context, _, sessionID string) (bool, error) {
	f.activationAbandons++
	f.deleteSessionIDs = append(f.deleteSessionIDs, sessionID)
	return true, nil
}

func (f *fakeTuttiModeActivationCoordinator) SnapshotForNewTurn(context.Context, string, string) (tuttimodeactivationbiz.TurnSnapshot, error) {
	f.currentCalls++
	return f.current, nil
}

func (f *fakeTuttiModeActivationCoordinator) ExistingTurnSnapshot(_ context.Context, _, _, turnID string) (tuttimodeactivationbiz.TurnSnapshot, error) {
	f.existingTurnID = turnID
	return f.existing, nil
}

func (f *fakeTuttiModeActivationCoordinator) BindTurnSnapshot(_ context.Context, _, _, turnID string, snapshot tuttimodeactivationbiz.TurnSnapshot) (tuttimodeactivationbiz.TurnSnapshot, bool, error) {
	if f.bindErr != nil {
		return tuttimodeactivationbiz.TurnSnapshot{}, false, f.bindErr
	}
	f.boundTurnID = turnID
	f.bound = snapshot
	return snapshot, true, nil
}

func (f *fakeTuttiModeActivationCoordinator) AcceptTurnSnapshot(_ context.Context, _, _, turnID string) (bool, error) {
	f.acceptedTurnID = turnID
	if f.acceptHook != nil {
		f.acceptHook()
	}
	if f.acceptErr != nil {
		return false, f.acceptErr
	}
	return true, nil
}

type recordingSubmitClaimStore struct {
	*workspacedata.SQLiteStore
	acceptErr            error
	acceptAfterCommitErr error
	acceptHook           func()
}

func (s *recordingSubmitClaimStore) AcceptSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID, turnID string, nowUnixMS int64) (agentactivitybiz.SubmitClaim, bool, error) {
	if s.acceptHook != nil {
		s.acceptHook()
	}
	if s.acceptErr != nil {
		return agentactivitybiz.SubmitClaim{}, false, s.acceptErr
	}
	claim, accepted, err := s.SQLiteStore.AcceptSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID, turnID, nowUnixMS)
	if err == nil && s.acceptAfterCommitErr != nil {
		return claim, accepted, s.acceptAfterCommitErr
	}
	return claim, accepted, err
}

func (f *fakeTuttiModeActivationCoordinator) AbandonTurnSnapshot(_ context.Context, _, _, turnID string, _ tuttimodeactivationbiz.TurnSnapshot) (bool, error) {
	f.abandonedTurnID = turnID
	return true, nil
}

func (f *fakeTuttiModeActivationCoordinator) DeleteSessionState(_ context.Context, _, sessionID string) error {
	f.deleteSessionIDs = append(f.deleteSessionIDs, sessionID)
	if len(f.deleteErrors) == 0 {
		return nil
	}
	err := f.deleteErrors[0]
	f.deleteErrors = f.deleteErrors[1:]
	return err
}

func activationSnapshot(activationID, revisionID string, revision int64, state tuttimodeactivationbiz.State, source tuttimodeactivationbiz.Source) tuttimodeactivationbiz.TurnSnapshot {
	return tuttimodeactivationbiz.TurnSnapshot{ActivationID: activationID, RevisionID: revisionID, Revision: revision, State: state, Source: source}
}

func activationFromSnapshot(snapshot tuttimodeactivationbiz.TurnSnapshot) *tuttimodeactivationbiz.Activation {
	if snapshot.ActivationID == "" {
		return nil
	}
	now := time.Unix(100, 0).UTC()
	return &tuttimodeactivationbiz.Activation{
		ID: snapshot.ActivationID, WorkspaceID: "ws-1", AgentSessionID: "session-1",
		CreatedAt: now, UpdatedAt: now,
		CurrentRevision: tuttimodeactivationbiz.Revision{
			ID: snapshot.RevisionID, ActivationID: snapshot.ActivationID, Revision: snapshot.Revision,
			State: snapshot.State, Source: snapshot.Source,
			OrchestrationIntensity: snapshot.OrchestrationIntensity, CreatedAt: now,
		},
	}
}
