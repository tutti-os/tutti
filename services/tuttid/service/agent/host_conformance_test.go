package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	hostconformance "github.com/tutti-os/tutti/packages/agent/host/conformance"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestLegacyServiceAgentHostConformance(t *testing.T) {
	for _, scenario := range hostconformance.Scenarios() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &legacyHostConformanceDriver{t: t}
			if err := hostconformance.Run(context.Background(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDirectHostApplicationCoreConformance(t *testing.T) {
	scenarios := append(hostconformance.ApplicationCoreScenarios(), hostconformance.ResumePolicyScenarios()...)
	scenarios = append(scenarios, hostconformance.SubmissionFenceScenarios()...)
	scenarios = append(scenarios, hostconformance.TitlePolicyScenarios()...)
	for _, scenario := range scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &legacyHostConformanceDriver{t: t, directHost: true}
			if err := hostconformance.Run(context.Background(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLegacyServiceResumePolicyConformance(t *testing.T) {
	scenarios := append(hostconformance.ResumePolicyScenarios(), hostconformance.SubmissionFenceScenarios()...)
	for _, scenario := range scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &legacyHostConformanceDriver{t: t}
			if err := hostconformance.Run(context.Background(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHostCoordinatorConformance(t *testing.T) {
	for _, directHost := range []bool{false, true} {
		name := "legacy_delegate"
		if directHost {
			name = "direct_host"
		}
		t.Run(name, func(t *testing.T) {
			for _, scenario := range hostconformance.CoordinatorScenarios() {
				scenario := scenario
				t.Run(scenario.Name, func(t *testing.T) {
					driver := &legacyHostConformanceDriver{t: t, directHost: directHost}
					if err := hostconformance.Run(context.Background(), driver, scenario); err != nil {
						t.Fatal(err)
					}
				})
			}
		})
	}
}

func TestHostCancelAcceptanceDoesNotImplyCanonicalSettlement(t *testing.T) {
	driver := &legacyHostConformanceDriver{t: t, directHost: true}
	fixture := hostconformance.Fixture{
		Session: &hostconformance.SessionSeed{
			WorkspaceID: "workspace-1", AgentSessionID: "session-cancel-semantics", Provider: "codex",
			ProviderSessionID: "provider-session-cancel-semantics", Cwd: "/workspace",
			ActiveTurnID: "turn-cancel-semantics", Live: true,
		},
		Turn: &hostconformance.TurnSeed{TurnID: "turn-cancel-semantics", Phase: agentactivitybiz.TurnPhaseWaiting},
	}
	if err := driver.Reset(context.Background(), fixture); err != nil {
		t.Fatal(err)
	}

	result, err := driver.service.applicationHost(serviceHostPreparation{service: driver.service}).CancelTurn(context.Background(), agenthost.CancelTurnInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-cancel-semantics", TurnID: "turn-cancel-semantics",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.IntentAccepted || !result.ProviderConfirmed {
		t.Fatalf("cancel acceptance/confirmation = accepted:%v confirmed:%v", result.IntentAccepted, result.ProviderConfirmed)
	}
	if result.Settled || result.State != agenthost.CancelStateRequested {
		t.Fatalf("cancel settlement = settled:%v state:%q, want durable request without inferred terminal state", result.Settled, result.State)
	}
	if result.Turn == nil || result.Turn.Phase == agentactivitybiz.TurnPhaseSettled {
		t.Fatalf("cancel turn = %#v, want canonical turn to remain authoritative", result.Turn)
	}
}

func TestHostCancelDoesNotUseLiveRuntimeAsMissingCanonicalSession(t *testing.T) {
	driver := &legacyHostConformanceDriver{t: t, directHost: true}
	fixture := hostconformance.Fixture{
		Session: &hostconformance.SessionSeed{
			WorkspaceID: "workspace-1", AgentSessionID: "session-orphan", Provider: "codex",
			ProviderSessionID: "provider-session-orphan", Cwd: "/workspace", ActiveTurnID: "turn-orphan", Live: true,
		},
		Turn: &hostconformance.TurnSeed{TurnID: "turn-orphan", Phase: agentactivitybiz.TurnPhaseWaiting},
	}
	if err := driver.Reset(context.Background(), fixture); err != nil {
		t.Fatal(err)
	}
	delete(driver.sessions.sessions, "workspace-1:session-orphan")
	delete(driver.turns.sessions, "session-orphan")

	_, err := driver.service.applicationHost(serviceHostPreparation{service: driver.service}).CancelTurn(context.Background(), agenthost.CancelTurnInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-orphan", TurnID: "turn-orphan",
	})
	if !errors.Is(err, agenthost.ErrSessionNotFound) {
		t.Fatalf("CancelTurn() error = %v, want canonical session not found", err)
	}
	if len(driver.runtime.cancelCalls) != 0 {
		t.Fatalf("runtime cancel calls = %d, want no provider call for orphan canonical turn", len(driver.runtime.cancelCalls))
	}
}

func TestHostFindTurnByClientSubmitIDUsesPublicCanonicalPort(t *testing.T) {
	driver := &legacyHostConformanceDriver{t: t, directHost: true}
	if err := driver.Reset(context.Background(), hostconformance.Fixture{}); err != nil {
		t.Fatal(err)
	}
	driver.operations.confirmedTurnID = "turn-confirmed"

	turnID, found, err := driver.service.applicationHost(serviceHostPreparation{service: driver.service}).FindTurnByClientSubmitID(
		context.Background(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"submit-1",
	)
	if err != nil || !found || turnID != "turn-confirmed" {
		t.Fatalf("FindTurnByClientSubmitID() = %q, %v, %v", turnID, found, err)
	}
}

type legacyHostConformanceDriver struct {
	t             *testing.T
	service       *Service
	runtime       *fakeRuntime
	sessions      *fakeSessionReader
	turns         *legacyHostConformanceTurnStore
	operations    *runtimeOperationMemoryStore
	operationPort *conformanceRuntimeOperationStore
	recoverySteps *[]string
	directHost    bool
}

func (d *legacyHostConformanceDriver) Reset(_ context.Context, fixture hostconformance.Fixture) error {
	d.runtime = newFakeRuntime()
	d.sessions = &fakeSessionReader{sessions: map[string]PersistedSession{}, tombstoned: map[string]bool{}}
	d.turns = &legacyHostConformanceTurnStore{
		sessions:     map[string]agentactivitybiz.Session{},
		turns:        map[string]agentactivitybiz.Turn{},
		interactions: map[string][]agentactivitybiz.Interaction{},
	}
	d.operations = &runtimeOperationMemoryStore{}
	steps := make([]string, 0)
	d.recoverySteps = &steps
	d.operationPort = &conformanceRuntimeOperationStore{runtimeOperationMemoryStore: d.operations, steps: &steps}
	d.service = newTestService(d.runtime)
	d.service.SessionReader = d.sessions
	d.service.SessionInitializer = legacyHostConformanceSessionInitializer{sessions: d.sessions}
	d.service.SubmitClaimStore = openAgentServiceSQLiteStore(d.t)
	d.service.RuntimeOperationStore = d.operationPort
	d.service.StaleTurnSettler = conformanceStaleTurnSettler{steps: &steps}
	d.service.RuntimeOperationOwner = "host-conformance-worker"
	d.service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1_000) }

	if fixture.Session == nil {
		return nil
	}
	seed := *fixture.Session
	kind := strings.TrimSpace(seed.Kind)
	if kind == "" {
		kind = agentactivitybiz.SessionKindRoot
	}
	settings := ComposerSettings{PlanMode: true}
	runtimeContext := map[string]any{"tuttiInitialTitleEstablished": seed.InitialTitleEstablished}
	if seed.ExternalResumeSupported != nil {
		runtimeContext["externalImportResumeSupported"] = *seed.ExternalResumeSupported
	}
	persisted := PersistedSession{
		ID: seed.AgentSessionID, WorkspaceID: seed.WorkspaceID, Kind: kind, Origin: seed.Origin,
		Provider: seed.Provider, ProviderSessionID: seed.ProviderSessionID, Cwd: seed.Cwd,
		RailSectionKey: "conversations", Settings: settings,
		Metadata:               agentactivitybiz.SessionMetadata{Visible: true, Capabilities: []string{}},
		InternalRuntimeContext: runtimeContext,
		Title:                  seed.Title, ActiveTurnID: seed.ActiveTurnID,
		CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2, LastEventUnixMS: 2,
	}
	d.sessions.sessions[seed.WorkspaceID+":"+seed.AgentSessionID] = persisted
	if fixture.PreparedSubmitID != "" {
		if _, _, err := d.service.SubmitClaimStore.PrepareSubmitClaim(context.Background(), agentactivitybiz.SubmitClaimPrepare{
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			ClientSubmitID: fixture.PreparedSubmitID, NowUnixMS: 1,
		}); err != nil {
			return err
		}
	}
	if seed.Deleted {
		d.sessions.tombstoned[seed.WorkspaceID+":"+seed.AgentSessionID] = true
	}
	d.turns.sessions[seed.AgentSessionID] = agentactivitybiz.Session{
		ID: seed.AgentSessionID, WorkspaceID: seed.WorkspaceID, Kind: agentactivitybiz.SessionKindRoot,
		Provider: seed.Provider, ProviderSessionID: seed.ProviderSessionID, Cwd: seed.Cwd,
		Title: seed.Title, ActiveTurnID: seed.ActiveTurnID,
	}
	if seed.Live {
		d.runtime.sessions[seed.WorkspaceID+":"+seed.AgentSessionID] = ProviderRuntimeSession{
			ID: seed.AgentSessionID, WorkspaceID: seed.WorkspaceID, Provider: seed.Provider,
			ProviderSessionID: seed.ProviderSessionID, Cwd: seed.Cwd, Status: "ready",
			Settings: &settings, Title: seed.Title, InitialTitleEstablished: seed.InitialTitleEstablished,
			Visible: true, CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		}
	}
	if fixture.Turn != nil {
		turn := *fixture.Turn
		d.turns.turns[seed.AgentSessionID+":"+turn.TurnID] = agentactivitybiz.Turn{
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			TurnID: turn.TurnID, Phase: turn.Phase, Outcome: turn.Outcome,
		}
		d.service.TurnStore = d.turns
	}
	if fixture.Interaction != nil {
		interaction := *fixture.Interaction
		d.turns.interactions[seed.AgentSessionID] = []agentactivitybiz.Interaction{{
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			TurnID: interaction.TurnID, RequestID: interaction.RequestID,
			Kind: interaction.Kind, Status: interaction.Status,
		}}
		d.service.TurnStore = d.turns
	}
	if fixture.RecoverInteractive {
		d.operations.operation = agentactivitybiz.RuntimeOperation{
			OperationID: runtimeOperationID(seed.WorkspaceID, seed.AgentSessionID, agentactivitybiz.RuntimeOperationKindInteractiveResponse, fixture.Interaction.TurnID+"\x00"+fixture.Interaction.RequestID),
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			Kind: agentactivitybiz.RuntimeOperationKindInteractiveResponse, Status: agentactivitybiz.RuntimeOperationStatusLeased,
			TurnID: fixture.Interaction.TurnID, RequestID: fixture.Interaction.RequestID,
			Payload: map[string]any{
				"rootAgentSessionId": seed.AgentSessionID, "action": "", "optionId": "approve",
				"payload": (map[string]any)(nil), "turnId": fixture.Interaction.TurnID,
			},
			LeaseOwner: "dead-worker", LeaseExpiresAtMS: time.UnixMilli(1_000).Add(time.Hour).UnixMilli(),
		}
	}
	return nil
}

func (d *legacyHostConformanceDriver) Create(
	ctx context.Context,
	workspaceID string,
	input agenthost.CreateSessionInput,
) (hostconformance.SessionObservation, string, error) {
	beforeExec := len(d.runtime.execCalls)
	agentTargetID := input.AgentTargetID
	if agentTargetID == "target-1" {
		agentTargetID = agenttargetbiz.IDLocalCodex
	}
	if d.directHost {
		input.AgentTargetID = agentTargetID
		prepared := preparedRuntime{Cwd: "/workspace"}
		result, err := d.service.applicationHost(serviceHostPreparation{service: d.service, prepared: &prepared}).CreateSession(ctx, workspaceID, input)
		if err != nil {
			return hostconformance.SessionObservation{}, "", err
		}
		persisted := persistedSessionFromHost(result.Canonical)
		session := serviceSessionWithPersistedFreshness(result.Session, persisted, d.runtime.CanResume(runtimeResumeInputFromRuntimeSession(result.Session)))
		d.recordSubmittedTurn(workspaceID, session.ID, result.TurnID)
		return legacyHostSessionObservation(session), result.TurnID, nil
	}
	session, err := d.service.Create(ctx, workspaceID, CreateSessionInput{
		AgentSessionID: input.AgentSessionID, AgentTargetID: agentTargetID, Provider: input.Provider,
		InitialContent: input.InitialContent, InitialDisplayPrompt: input.InitialDisplayPrompt,
		Metadata: input.Metadata, Title: input.Title, Cwd: input.Cwd,
		PermissionModeID: input.PermissionModeID, Model: input.Model, PlanMode: input.PlanMode,
		BrowserUse: input.BrowserUse, ComputerUse: input.ComputerUse,
		ProviderTargetRef: input.ProviderTargetRef, ReasoningEffort: input.ReasoningEffort,
		RuntimeContext: input.RuntimeContext, Speed: input.Speed,
		ConversationDetailMode: input.ConversationDetailMode, Visible: input.Visible,
	})
	if err != nil {
		return hostconformance.SessionObservation{}, "", err
	}
	turnID := ""
	if len(d.runtime.execCalls) > beforeExec {
		turnID = "turn-1"
		d.recordSubmittedTurn(workspaceID, session.ID, turnID)
	}
	return legacyHostSessionObservation(session), turnID, nil
}

func (d *legacyHostConformanceDriver) EnsureSession(ctx context.Context, ref agenthost.SessionRef) (hostconformance.SessionObservation, error) {
	if d.directHost {
		if _, err := d.service.applicationHost(serviceHostPreparation{service: d.service}).EnsureRuntimeSession(ctx, ref); err != nil {
			return hostconformance.SessionObservation{}, err
		}
		session, err := d.service.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
		return legacyHostSessionObservation(session), err
	}
	if _, err := d.service.ensureRuntimeSession(ctx, ref.WorkspaceID, ref.AgentSessionID); err != nil {
		return hostconformance.SessionObservation{}, err
	}
	session, err := d.service.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
	return legacyHostSessionObservation(session), err
}

func (d *legacyHostConformanceDriver) SendInput(
	ctx context.Context,
	ref agenthost.SessionRef,
	input agenthost.SendInput,
) (hostconformance.SendObservation, error) {
	if d.directHost {
		result, err := d.service.applicationHost(serviceHostPreparation{service: d.service}).SendInput(ctx, ref, input)
		if err != nil {
			return hostconformance.SendObservation{}, err
		}
		d.recordSubmittedTurn(ref.WorkspaceID, ref.AgentSessionID, result.TurnID)
		session, err := d.service.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
		return hostconformance.SendObservation{Session: legacyHostSessionObservation(session), TurnID: result.TurnID}, err
	}
	result, err := d.service.SendInput(ctx, ref.WorkspaceID, ref.AgentSessionID, input)
	if err != nil {
		return hostconformance.SendObservation{}, err
	}
	d.recordSubmittedTurn(ref.WorkspaceID, ref.AgentSessionID, result.TurnID)
	return hostconformance.SendObservation{
		Session: legacyHostSessionObservation(result.Session),
		TurnID:  result.TurnID,
	}, nil
}

func (d *legacyHostConformanceDriver) CancelTurn(ctx context.Context, input agenthost.CancelTurnInput) (hostconformance.CancelObservation, error) {
	if d.directHost {
		result, err := d.service.applicationHost(serviceHostPreparation{service: d.service}).CancelTurn(ctx, input)
		if err != nil {
			return hostconformance.CancelObservation{}, err
		}
		session, err := d.service.Get(ctx, input.WorkspaceID, input.AgentSessionID)
		turnID := ""
		if result.Turn != nil {
			turnID = result.Turn.TurnID
		}
		return hostconformance.CancelObservation{
			Session: legacyHostSessionObservation(session), TurnID: turnID,
			Canceled: result.Operation.Result == agentactivitybiz.RuntimeOperationResultCanceled,
			Reason:   string(CancelTurnReasonTurnCanceled),
		}, err
	}
	result, err := d.service.CancelTurn(ctx, input.WorkspaceID, input.AgentSessionID, input.TurnID)
	if err != nil {
		return hostconformance.CancelObservation{}, err
	}
	turnID := ""
	if result.Turn != nil {
		turnID = result.Turn.TurnID
	}
	return hostconformance.CancelObservation{
		Session: legacyHostSessionObservation(result.Session), TurnID: turnID,
		Canceled: result.Canceled, Reason: string(result.Reason),
	}, nil
}

func (d *legacyHostConformanceDriver) SubmitInteractive(
	ctx context.Context,
	ref agenthost.SessionRef,
	requestID string,
	input agenthost.SubmitInteractiveInput,
) (hostconformance.SessionObservation, error) {
	if d.directHost {
		_, err := d.service.applicationHost(serviceHostPreparation{service: d.service}).SubmitInteractive(ctx, ref, requestID, input)
		if err != nil {
			return hostconformance.SessionObservation{}, err
		}
		session, err := d.service.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
		return legacyHostSessionObservation(session), err
	}
	session, err := d.service.SubmitInteractive(ctx, ref.WorkspaceID, ref.AgentSessionID, requestID, input)
	return legacyHostSessionObservation(session), err
}

func (d *legacyHostConformanceDriver) SubmitPlanDecision(
	ctx context.Context,
	ref agenthost.SessionRef,
	turnID string,
	requestID string,
	input agenthost.SubmitPlanDecisionInput,
) (hostconformance.OperationObservation, error) {
	var operation agentactivitybiz.RuntimeOperation
	var err error
	if d.directHost {
		operation, err = d.service.applicationHost(serviceHostPreparation{service: d.service}).SubmitPlanDecision(ctx, ref, turnID, requestID, input)
	} else {
		operation, err = d.service.SubmitPlanDecision(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID, requestID, input)
	}
	return hostconformance.OperationObservation{
		OperationID: operation.OperationID, Status: operation.Status, Result: operation.Result,
	}, err
}

func (d *legacyHostConformanceDriver) UpdateTitle(ctx context.Context, input agenthost.UpdateTitleInput) (hostconformance.SessionObservation, error) {
	if d.directHost {
		result, err := d.service.applicationHost(serviceHostPreparation{service: d.service}).UpdateTitle(ctx, input)
		if err != nil {
			return hostconformance.SessionObservation{}, err
		}
		persisted := persistedSessionFromHost(result.Canonical)
		if strings.TrimSpace(result.Session.ID) != "" {
			return legacyHostSessionObservation(serviceSessionWithPersistedFreshness(result.Session, persisted, true)), nil
		}
		return legacyHostSessionObservation(sessionFromPersisted(persisted, true)), nil
	}
	session, err := d.service.UpdateTitle(ctx, input.WorkspaceID, input.AgentSessionID, input.Title)
	return legacyHostSessionObservation(session), err
}

func (d *legacyHostConformanceDriver) Metrics() hostconformance.Metrics {
	metrics := hostconformance.Metrics{
		StartCalls: len(d.runtime.startCalls), ResumeCalls: len(d.runtime.resumeCalls),
		ExecCalls: len(d.runtime.execCalls), CancelCalls: len(d.runtime.cancelCalls),
		InteractiveCalls: len(d.runtime.submitInteractiveCalls), UpdateSettingsCalls: len(d.runtime.updateSettingsCalls),
		RecoverySteps: append([]string(nil), (*d.recoverySteps)...),
	}
	if len(d.runtime.cancelCalls) > 0 {
		metrics.LastCancelTargets = append([]RuntimeCancelTarget(nil), d.runtime.cancelCalls[len(d.runtime.cancelCalls)-1].Targets...)
	}
	if len(d.runtime.submitInteractiveCalls) > 0 {
		last := d.runtime.submitInteractiveCalls[len(d.runtime.submitInteractiveCalls)-1]
		metrics.LastInteractiveTurnID = last.TurnID
		metrics.LastInteractiveRequestID = last.RequestID
	}
	if len(d.runtime.execCalls) > 0 {
		metrics.LastInitialTitle = d.runtime.execCalls[len(d.runtime.execCalls)-1].InitialTitle
	}
	if len(d.runtime.resumeCalls) > 0 {
		metrics.LastResumeRecreate = d.runtime.resumeCalls[len(d.runtime.resumeCalls)-1].RecreateIfMissing
	}
	return metrics
}

func (d *legacyHostConformanceDriver) Recover(ctx context.Context) error {
	if d.directHost {
		return d.service.applicationHost(serviceHostPreparation{service: d.service}).Recover(ctx)
	}
	return d.service.Recover(ctx)
}

type conformanceRuntimeOperationStore struct {
	*runtimeOperationMemoryStore
	steps *[]string
}

func (s *conformanceRuntimeOperationStore) RequeueLeasedRuntimeOperationsOnStartup(ctx context.Context, now int64) (int64, error) {
	*s.steps = append(*s.steps, "runtime_requeue")
	return s.runtimeOperationMemoryStore.RequeueLeasedRuntimeOperationsOnStartup(ctx, now)
}

func (s *conformanceRuntimeOperationStore) CompleteInteractiveRuntimeOperation(ctx context.Context, input agentactivitybiz.CompleteInteractiveRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	*s.steps = append(*s.steps, "runtime_complete")
	return s.runtimeOperationMemoryStore.CompleteInteractiveRuntimeOperation(ctx, input)
}

type conformanceStaleTurnSettler struct{ steps *[]string }

func (s conformanceStaleTurnSettler) SettleStaleTurnsOnStartup(context.Context) error {
	*s.steps = append(*s.steps, "stale_settle")
	return nil
}

func (d *legacyHostConformanceDriver) recordSubmittedTurn(workspaceID, sessionID, turnID string) {
	if turnID == "" {
		return
	}
	d.turns.turns[sessionID+":"+turnID] = agentactivitybiz.Turn{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID,
		Phase: agentactivitybiz.TurnPhaseSubmitted,
	}
	d.service.TurnStore = d.turns
}

type legacyHostConformanceSessionInitializer struct {
	sessions *fakeSessionReader
}

func (i legacyHostConformanceSessionInitializer) InitializeRuntimeSession(
	ctx context.Context,
	session ProviderRuntimeSession,
) (PersistedSession, error) {
	persisted, err := (fakeSessionInitializer{}).InitializeRuntimeSession(ctx, session)
	if err == nil {
		i.sessions.sessions[persisted.WorkspaceID+":"+persisted.ID] = persisted
	}
	return persisted, err
}

type legacyHostConformanceTurnStore struct {
	sessions     map[string]agentactivitybiz.Session
	turns        map[string]agentactivitybiz.Turn
	interactions map[string][]agentactivitybiz.Interaction
}

func (s *legacyHostConformanceTurnStore) GetLatestTurn(_ context.Context, _ string, sessionID string) (agentactivitybiz.Turn, bool, error) {
	for _, turn := range s.turns {
		if turn.AgentSessionID == sessionID {
			return turn, true, nil
		}
	}
	return agentactivitybiz.Turn{}, false, nil
}

func (s *legacyHostConformanceTurnStore) GetTurn(_ context.Context, _ string, sessionID, turnID string) (agentactivitybiz.Turn, bool, error) {
	turn, ok := s.turns[sessionID+":"+turnID]
	return turn, ok, nil
}

func (s *legacyHostConformanceTurnStore) GetSession(_ context.Context, _ string, sessionID string) (agentactivitybiz.Session, bool, error) {
	session, ok := s.sessions[sessionID]
	return session, ok, nil
}

func (s *legacyHostConformanceTurnStore) ListSessionTurns(_ context.Context, _ string, sessionID string) ([]agentactivitybiz.Turn, error) {
	result := make([]agentactivitybiz.Turn, 0)
	for _, turn := range s.turns {
		if turn.AgentSessionID == sessionID {
			result = append(result, turn)
		}
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListSessionInteractions(_ context.Context, input agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	return append([]agentactivitybiz.Interaction(nil), s.interactions[input.AgentSessionID]...), nil
}

func (s *legacyHostConformanceTurnStore) ListLatestTurns(_ context.Context, _ string, sessionIDs []string) (map[string]agentactivitybiz.Turn, error) {
	result := map[string]agentactivitybiz.Turn{}
	for _, sessionID := range sessionIDs {
		if turn, ok, _ := s.GetLatestTurn(context.Background(), "", sessionID); ok {
			result[sessionID] = turn
		}
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListLatestTurnInteractions(_ context.Context, _ string, sessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	result := map[string][]agentactivitybiz.Interaction{}
	for _, sessionID := range sessionIDs {
		result[sessionID] = append([]agentactivitybiz.Interaction(nil), s.interactions[sessionID]...)
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListTurnsBySession(_ context.Context, _ string, activeTurnIDs map[string]string) (map[string]agentactivitybiz.Turn, error) {
	result := map[string]agentactivitybiz.Turn{}
	for sessionID, turnID := range activeTurnIDs {
		if turn, ok := s.turns[sessionID+":"+turnID]; ok {
			result[sessionID] = turn
		}
	}
	return result, nil
}

func (s *legacyHostConformanceTurnStore) ListPendingInteractionsBySession(_ context.Context, _ string, sessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	result := map[string][]agentactivitybiz.Interaction{}
	for _, sessionID := range sessionIDs {
		result[sessionID] = append([]agentactivitybiz.Interaction(nil), s.interactions[sessionID]...)
	}
	return result, nil
}

func legacyHostSessionObservation(session Session) hostconformance.SessionObservation {
	return hostconformance.SessionObservation{
		SessionID: session.ID, ProviderSessionID: session.ProviderSessionID,
		Title: value(session.Title), ActiveTurnID: session.ActiveTurnID, Resumable: session.Resumable,
	}
}
