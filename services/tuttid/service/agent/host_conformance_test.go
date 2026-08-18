package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	hostconformance "github.com/tutti-os/tutti/packages/agent/host/conformance"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	market "github.com/tutti-os/tutti/packages/connector/host"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestServiceAdapterAgentHostConformance(t *testing.T) {
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

func TestHostWorkspaceRuntimeDisconnectConformance(t *testing.T) {
	for _, scenario := range hostconformance.WorkspaceRuntimeDisconnectScenarios() {
		scenario := scenario
		for _, directHost := range []bool{false, true} {
			directHost := directHost
			t.Run(fmt.Sprintf("direct=%v/%s", directHost, scenario.Name), func(t *testing.T) {
				driver := &legacyHostConformanceDriver{t: t, directHost: directHost}
				if err := hostconformance.RunWorkspaceRuntimeDisconnect(
					context.Background(), driver, scenario,
				); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestHostWorkspaceRuntimeAdmissionConformance(t *testing.T) {
	for _, scenario := range hostconformance.WorkspaceRuntimeAdmissionScenarios() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &legacyHostConformanceDriver{t: t, directHost: true}
			if err := driver.Reset(context.Background(), hostconformance.Fixture{}); err != nil {
				t.Fatal(err)
			}
			if err := hostconformance.RunWorkspaceRuntimeAdmission(
				context.Background(), driver, scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHostHistoricalStateConformance(t *testing.T) {
	for _, scenario := range hostconformance.HistoricalStateScenarios() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &legacyHostConformanceDriver{t: t, directHost: true}
			if err := hostconformance.RunHistoricalState(
				context.Background(),
				driver,
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHostConformanceDeleteSessionsRoutesAdapterAndDirectHostSeparately(t *testing.T) {
	fixture := hostconformance.Fixture{Session: &hostconformance.SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-delete-route",
		Provider: "codex", ProviderSessionID: "provider-session-delete-route",
		Cwd: "/workspace", Live: true,
	}}
	input := agenthost.DeleteSessionsInput{
		WorkspaceID: "workspace-1",
		SessionIDs:  []string{"session-delete-route", "session-delete-route"},
	}

	adapter := &legacyHostConformanceDriver{t: t}
	if err := adapter.Reset(context.Background(), fixture); err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.DeleteSessions(context.Background(), input); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("adapter DeleteSessions() error = %v, want service invalid argument", err)
	}
	if metrics := adapter.Metrics(); len(metrics.DeleteAdmissionPlans) != 0 ||
		metrics.CloseCalls != 0 || metrics.CanonicalDeleteCalls != 0 {
		t.Fatalf("adapter invalid input reached Host: metrics=%#v", metrics)
	}

	direct := &legacyHostConformanceDriver{t: t, directHost: true}
	if err := direct.Reset(context.Background(), fixture); err != nil {
		t.Fatal(err)
	}
	result, err := direct.DeleteSessions(context.Background(), input)
	if err != nil {
		t.Fatalf("direct Host DeleteSessions() error = %v", err)
	}
	if len(result.RemovedSessionIDs) != 1 || len(direct.Metrics().DeleteAdmissionPlans) != 1 {
		t.Fatalf("direct Host result=%#v metrics=%#v", result, direct.Metrics())
	}
}

func TestServiceAdapterResumePolicyConformance(t *testing.T) {
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
		name := "service_adapter"
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

func TestHostGoalConformance(t *testing.T) {
	for _, directHost := range []bool{false, true} {
		name := "service_adapter"
		if directHost {
			name = "direct_host"
		}
		t.Run(name, func(t *testing.T) {
			for _, scenario := range hostconformance.GoalScenarios() {
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

func TestHostCommitObserverConformance(t *testing.T) {
	for _, directHost := range []bool{false, true} {
		name := "service_adapter"
		if directHost {
			name = "direct_host"
		}
		t.Run(name, func(t *testing.T) {
			for _, scenario := range hostconformance.CommitObserverScenarios() {
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

	result, err := driver.service.ApplicationHost().CancelTurn(context.Background(), agenthost.CancelTurnInput{
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

	_, err := driver.service.ApplicationHost().CancelTurn(context.Background(), agenthost.CancelTurnInput{
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

	turnID, found, err := driver.service.ApplicationHost().FindTurnByClientSubmitID(
		context.Background(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"submit-1",
	)
	if err != nil || !found || turnID != "turn-confirmed" {
		t.Fatalf("FindTurnByClientSubmitID() = %q, %v, %v", turnID, found, err)
	}
}

type legacyHostConformanceDriver struct {
	t                        *testing.T
	service                  *Service
	runtime                  *fakeRuntime
	sessions                 *fakeSessionReader
	turns                    *legacyHostConformanceTurnStore
	operations               *runtimeOperationMemoryStore
	operationPort            *conformanceRuntimeOperationStore
	goalStore                *conformanceGoalStateStore
	goalInbox                *conformanceGoalInboxStore
	commitObserver           *conformanceCommitObserver
	recoverySteps            *[]string
	createdTurns             map[string]string
	directHost               bool
	goalNowUnixMS            int64
	deletionHost             *agenthost.Host
	deletionAdapter          *Service
	deletionStore            *conformanceDeletionStore
	deletionGuard            *conformanceDeletionGuard
	deletionEvents           *[]string
	historicalState          *conformanceHistoricalStateStore
	runtimeStartReportWrites int
}

func (d *legacyHostConformanceDriver) Reset(_ context.Context, fixture hostconformance.Fixture) error {
	d.runtime = newFakeRuntime()
	d.runtime.guidanceTargetMismatch = fixture.GuidanceTargetMismatch
	if fixture.CancelDeliveryUnconfirmed {
		d.runtime.cancelErr = agenthost.ErrRuntimeCancelDeliveryUnconfirmed
	}
	d.sessions = &fakeSessionReader{
		sessions: map[string]PersistedSession{}, tombstoned: map[string]bool{}, deletedAt: map[string]int64{},
		parentByKey: map[string]string{},
	}
	d.runtimeStartReportWrites = 0
	if fixture.RaceRuntimeStartReport {
		reportRuntimeStart := func(session ProviderRuntimeSession) error {
			persisted, err := (fakeSessionInitializer{}).InitializeRuntimeSession(
				context.Background(),
				session,
				nil,
			)
			if err != nil {
				return err
			}
			key := persisted.WorkspaceID + ":" + persisted.ID
			if existing, found := d.sessions.sessions[key]; found {
				persisted.RailSectionKind = existing.RailSectionKind
				persisted.RailProjectPath = existing.RailProjectPath
				persisted.RailSectionKey = existing.RailSectionKey
			}
			d.sessions.sessions[key] = persisted
			d.runtimeStartReportWrites++
			return nil
		}
		d.runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
			if input.CanonicalInitPending {
				return session
			}
			if err := reportRuntimeStart(session); err != nil {
				d.t.Fatalf("prepare raced runtime start report: %v", err)
			}
			return session
		}
		d.runtime.publishInitHook = func(
			_ RuntimeSessionInitializationPublishInput,
			session ProviderRuntimeSession,
		) error {
			return reportRuntimeStart(session)
		}
	}
	d.turns = &legacyHostConformanceTurnStore{
		sessions:     map[string]agentactivitybiz.Session{},
		turns:        map[string]agentactivitybiz.Turn{},
		interactions: map[string][]agentactivitybiz.Interaction{},
	}
	d.operations = &runtimeOperationMemoryStore{
		interactionStore:  d.turns,
		turnIdentityStore: d.turns,
	}
	d.createdTurns = make(map[string]string)
	steps := make([]string, 0)
	d.recoverySteps = &steps
	d.operationPort = &conformanceRuntimeOperationStore{runtimeOperationMemoryStore: d.operations, steps: &steps}
	d.service = newUnconfiguredIsolatedAgentService(d.runtime)
	d.service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	d.service.ConnectorMarketSnapshots = connectorMarketSnapshotStub{snapshot: market.Snapshot{
		Connectors: []market.Connector{
			localConnectorFixture(
				"lark-cli",
				market.InstallationStateInstalled,
				market.AuthorizationStateConnected,
				market.CompatibilityStateSupported,
			),
		},
	}}
	d.runtime.provenanceHook = func(input RuntimeSubmitProvenanceInput) error {
		d.recordSubmittedTurn(input.WorkspaceID, input.AgentSessionID, input.TurnID)
		d.operations.recordConfirmedTurn(input.ClientSubmitID, input.TurnID)
		return nil
	}
	if fixture.RejectInitialExec {
		d.runtime.execHook = func(input RuntimeExecInput) (RuntimeExecResult, error) {
			return RuntimeExecResult{
				AgentSessionID: input.AgentSessionID,
				TurnID:         input.TurnID,
				ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
					Disposition: agenthost.RuntimeDispatchDispositionRejected,
				},
			}, errors.New("provider rejected initial submit")
		}
	}
	d.commitObserver = &conformanceCommitObserver{fail: fixture.FailCommitObserver}
	d.service.CommitObserver = d.commitObserver
	d.service.SessionReader = d.sessions
	d.service.SessionPurgeStore = d.sessions
	canonicalStore := openAgentServiceSQLiteStore(d.t)
	for index, projectPath := range fixture.RailProjectPaths {
		if _, err := canonicalStore.PutUserProject(context.Background(), userprojectbiz.Project{
			ID: fmt.Sprintf("host-conformance-project-%d", index), Path: projectPath,
			Label: projectPath, SectionKey: userprojectbiz.SectionKeyFromPath(projectPath),
		}); err != nil {
			return fmt.Errorf("register host conformance rail project %q: %w", projectPath, err)
		}
	}
	d.service.SessionInitializer = legacyHostConformanceSessionInitializer{
		canonicalStore: canonicalStore,
		sessions:       d.sessions,
		fail:           fixture.FailSessionInitialization,
	}
	d.service.TurnSummaryReader = d.turns
	d.service.SubmitClaimStore = canonicalStore
	d.service.RuntimeOperationStore = d.operationPort
	d.service.StaleTurnSettler = conformanceStaleTurnSettler{steps: &steps}
	d.service.RuntimeOperationOwner = "host-conformance-worker"
	d.service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1_000) }
	d.goalStore = &conformanceGoalStateStore{GoalStateStore: canonicalStore, steps: &steps}
	d.goalInbox = &conformanceGoalInboxStore{GoalReconcileInboxStore: canonicalStore, steps: &steps}
	d.service.GoalStateStore = d.goalStore
	d.service.GoalGenerationFenceStore = canonicalStore
	d.service.GoalReconcileInboxStore = d.goalInbox
	d.service.GoalOperationOwner = "host-goal-conformance-worker"
	d.goalNowUnixMS = 1_000
	d.service.GoalOperationClock = func() time.Time { return time.UnixMilli(d.goalNowUnixMS) }
	if fixture.DisableGoalInbox {
		d.service.GoalReconcileInboxStore = nil
	}
	d.historicalState = &conformanceHistoricalStateStore{driver: d}
	hostStore := serviceHostStore{service: d.service}
	hostSupport := hostSupportPortsForService(d.service, nil)
	d.service.SetApplicationHost(composeApplicationHost(
		hostSupport,
		hostStore,
		hostStore,
		hostStore,
		nil,
		d.historicalState,
		serviceHostRuntime{service: d.service},
		serviceHostGoalRuntime{service: d.service},
	))
	deletionEvents := make([]string, 0)
	d.deletionEvents = &deletionEvents
	baseDeletionStore := serviceHostStore{service: d.service}
	d.deletionStore = &conformanceDeletionStore{
		SessionBatchManagementStore: baseDeletionStore,
		plans:                       fixture.DeleteSessionPlans,
		events:                      &deletionEvents,
	}
	d.deletionGuard = &conformanceDeletionGuard{
		admissionErr: fixture.DeleteAdmissionErr,
		events:       &deletionEvents,
	}
	d.deletionHost = agenthost.New(agenthost.Config{
		SessionBatchManagement: d.deletionStore,
		SessionDeletionGuard:   d.deletionGuard,
		Runtime:                serviceHostRuntime{service: d.service},
		SessionLocker: serviceHostLocker{
			mu: &d.service.sessionSettingsMu, locks: &d.service.sessionSettingsLocks,
		},
	})
	d.deletionAdapter = newUnconfiguredIsolatedAgentService(d.runtime)
	d.deletionAdapter.SetApplicationHost(d.deletionHost)
	d.runtime.closeHook = func(input RuntimeCloseInput) {
		deletionEvents = append(deletionEvents, "close:"+input.AgentSessionID)
	}

	var goalMu sync.Mutex
	var providerGoal map[string]any
	d.runtime.goalControlHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		goalMu.Lock()
		defer goalMu.Unlock()
		switch input.Action {
		case "set":
			providerGoal = map[string]any{"objective": input.Objective, "status": "active"}
			if fixture.CompleteGoalOnSet {
				providerGoal["status"] = "completed"
			}
		case "pause":
			providerGoal = clonePayload(providerGoal)
			providerGoal["status"] = "paused"
		case "resume":
			providerGoal = clonePayload(providerGoal)
			providerGoal["status"] = "active"
		case "clear":
			providerGoal = nil
		}
		resultGoal := providerGoal
		if fixture.EmptyPauseResumeGoal && (input.Action == "pause" || input.Action == "resume") {
			resultGoal = nil
		}
		providerPhase := "applied"
		evidence := map[string]any{"confidence": "authoritative"}
		if fixture.AcceptGoalControlsOnly {
			providerPhase = "accepted"
			evidence = map[string]any{"confidence": "accepted_only", "phase": "accepted"}
		}
		return RuntimeGoalControlResult{
			AgentSessionID: input.AgentSessionID, Goal: clonePayload(resultGoal),
			Evidence: evidence, ProviderPhase: providerPhase,
			ExecutionPending: input.Action == "set" && resultGoal["status"] == "active",
		}, nil
	}
	if fixture.AcceptGoalControlsOnly {
		d.runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
			return RuntimeGoalRecoveryPolicy{QuerySupported: false, ReplaySetAfterRestart: false}, nil
		}
	}
	d.runtime.goalReconcileHook = func(_ context.Context, input RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
		goalMu.Lock()
		defer goalMu.Unlock()
		return RuntimeGoalReconcileResult{
			AgentSessionID: input.AgentSessionID, Goal: clonePayload(providerGoal),
			Evidence: map[string]any{"confidence": "authoritative"},
		}, nil
	}
	if fixture.DisconnectGoalFenceDelivery {
		var disconnectOnce sync.Once
		d.runtime.goalGenerationFenceHook = func(_ context.Context, input RuntimeGoalGenerationFenceInput) error {
			disconnected := false
			disconnectOnce.Do(func() {
				d.runtime.mu.Lock()
				delete(d.runtime.sessions, input.WorkspaceID+":"+input.AgentSessionID)
				d.runtime.mu.Unlock()
				disconnected = true
			})
			if disconnected {
				return ErrSessionNotFound
			}
			return nil
		}
	}
	if fixture.LiveOnlySession != nil {
		seed := *fixture.LiveOnlySession
		settings := seed.Settings
		d.runtime.sessions[seed.WorkspaceID+":"+seed.AgentSessionID] = ProviderRuntimeSession{
			ID: seed.AgentSessionID, WorkspaceID: seed.WorkspaceID, Provider: seed.Provider,
			ProviderSessionID: seed.ProviderSessionID, Cwd: seed.Cwd, Status: "ready",
			Settings: &settings, Title: seed.Title, InitialTitleEstablished: seed.InitialTitleEstablished,
			Visible: true, PinnedAtUnixMS: boolUnixMS(seed.Pinned), CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		}
	}

	if fixture.Session == nil {
		return nil
	}
	seed := *fixture.Session
	d.runtime.guidanceTarget = strings.TrimSpace(seed.ActiveTurnID)
	if err := canonicalStore.Create(context.Background(), workspacebiz.Summary{ID: seed.WorkspaceID, Name: "Host conformance"}); err != nil {
		return err
	}
	if _, err := canonicalStore.ReportSessionState(context.Background(), agentactivitybiz.SessionStateReport{
		WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
		Provider: seed.Provider, ProviderSessionID: seed.ProviderSessionID, OccurredAtUnixMS: 1,
	}); err != nil {
		return err
	}
	kind := strings.TrimSpace(seed.Kind)
	if kind == "" {
		kind = agentactivitybiz.SessionKindRoot
	}
	settings := seed.Settings
	if settings.Model == "" && settings.PermissionModeID == "" && !settings.PlanMode &&
		settings.BrowserUse == nil && settings.ComputerUse == nil && settings.ReasoningEffort == "" && settings.Speed == "" {
		settings.PlanMode = true
	}
	runtimeContext := map[string]any{"tuttiInitialTitleEstablished": seed.InitialTitleEstablished}
	if seed.ExternalResumeSupported != nil {
		runtimeContext["externalImportResumeSupported"] = *seed.ExternalResumeSupported
	}
	persisted := PersistedSession{
		ID: seed.AgentSessionID, WorkspaceID: seed.WorkspaceID, Kind: kind, Origin: seed.Origin,
		Provider: seed.Provider, ProviderSessionID: seed.ProviderSessionID, Cwd: seed.Cwd,
		RailSectionKind: "conversations",
		RailSectionKey:  "conversations", Settings: settings,
		Metadata:               agentactivitybiz.SessionMetadata{Visible: true},
		InternalRuntimeContext: runtimeContext,
		Title:                  seed.Title, ActiveTurnID: seed.ActiveTurnID,
		PinnedAtUnixMS:  boolUnixMS(seed.Pinned),
		CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2, LastEventUnixMS: 2,
	}
	seedKey := seed.WorkspaceID + ":" + seed.AgentSessionID
	d.sessions.sessions[seedKey] = persisted
	if parentID := strings.TrimSpace(seed.ParentAgentSessionID); parentID != "" {
		d.sessions.parentByKey[seedKey] = seed.WorkspaceID + ":" + parentID
	}
	for _, additional := range fixture.AdditionalSessions {
		additionalKind := strings.TrimSpace(additional.Kind)
		if additionalKind == "" {
			additionalKind = agentactivitybiz.SessionKindChild
		}
		additionalKey := additional.WorkspaceID + ":" + additional.AgentSessionID
		d.sessions.sessions[additionalKey] = PersistedSession{
			ID: additional.AgentSessionID, WorkspaceID: additional.WorkspaceID, Kind: additionalKind,
			Provider: additional.Provider, ProviderSessionID: additional.ProviderSessionID, Cwd: additional.Cwd,
			RailSectionKind: "conversations",
			RailSectionKey:  "conversations",
			Metadata:        agentactivitybiz.SessionMetadata{Visible: true},
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2, LastEventUnixMS: 2,
		}
		if parentID := strings.TrimSpace(additional.ParentAgentSessionID); parentID != "" {
			d.sessions.parentByKey[additionalKey] = additional.WorkspaceID + ":" + parentID
		}
		if additional.Deleted {
			d.sessions.tombstoned[additionalKey] = true
			deletedAt := additional.DeletedAtUnixMS
			if deletedAt <= 0 {
				deletedAt = 1
			}
			d.sessions.deletedAt[additionalKey] = deletedAt
		}
		if additional.Live {
			settings := additional.Settings
			d.runtime.sessions[additionalKey] = ProviderRuntimeSession{
				ID: additional.AgentSessionID, WorkspaceID: additional.WorkspaceID, Provider: additional.Provider,
				ProviderSessionID: additional.ProviderSessionID, Cwd: additional.Cwd, Status: "ready",
				Settings: &settings, Visible: true, CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
			}
		}
	}
	if fixture.PreparedSubmitID != "" {
		if _, _, err := d.service.SubmitClaimStore.PrepareSubmitClaim(context.Background(), agentactivitybiz.SubmitClaimPrepare{
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			ClientSubmitID: fixture.PreparedSubmitID, CanonicalTurnID: "prepared-turn", NowUnixMS: 1,
		}); err != nil {
			return err
		}
	}
	if seed.Deleted {
		key := seed.WorkspaceID + ":" + seed.AgentSessionID
		d.sessions.tombstoned[key] = true
		deletedAt := seed.DeletedAtUnixMS
		if deletedAt <= 0 {
			deletedAt = 1
		}
		d.sessions.deletedAt[key] = deletedAt
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
			Visible: true, PinnedAtUnixMS: boolUnixMS(seed.Pinned), CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		}
	}
	if fixture.Turn != nil {
		turn := *fixture.Turn
		d.turns.turns[seed.AgentSessionID+":"+turn.TurnID] = agentactivitybiz.Turn{
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			TurnID: turn.TurnID, Phase: turn.Phase, Outcome: turn.Outcome,
			RootProviderTurnID:      turn.RootProviderTurnID,
			ProviderTurnBindingJSON: append([]byte(nil), turn.ProviderTurnBindingJSON...),
			FinalAssistantMessageID: turn.FinalAssistantMessageID,
			StartedAtUnixMS:         turn.StartedAtUnixMS, SettledAtUnixMS: turn.SettledAtUnixMS, Origin: turn.Origin,
		}
		d.service.TurnStore = d.turns
	}
	for _, turn := range fixture.AdditionalTurns {
		d.turns.turns[seed.AgentSessionID+":"+turn.TurnID] = agentactivitybiz.Turn{
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			TurnID: turn.TurnID, Phase: turn.Phase, Outcome: turn.Outcome,
			RootProviderTurnID:      turn.RootProviderTurnID,
			ProviderTurnBindingJSON: append([]byte(nil), turn.ProviderTurnBindingJSON...),
			FinalAssistantMessageID: turn.FinalAssistantMessageID,
			StartedAtUnixMS:         turn.StartedAtUnixMS, SettledAtUnixMS: turn.SettledAtUnixMS, Origin: turn.Origin,
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
	for _, interaction := range fixture.AdditionalInteractions {
		d.turns.interactions[seed.AgentSessionID] = append(d.turns.interactions[seed.AgentSessionID], agentactivitybiz.Interaction{
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			TurnID: interaction.TurnID, RequestID: interaction.RequestID,
			Kind: interaction.Kind, Status: interaction.Status,
		})
		d.service.TurnStore = d.turns
	}
	if fixture.RecoverInteractive {
		operationPayload := map[string]any{
			"rootAgentSessionId": seed.AgentSessionID, "action": "", "optionId": "approve",
			"payload": (map[string]any)(nil), "turnId": fixture.Interaction.TurnID,
		}
		if prompt := strings.TrimSpace(fixture.RecoverInteractiveFollowUpPrompt); prompt != "" {
			operationPayload["followUpPrompt"] = prompt
			operationPayload["followUpClientSubmitId"] = strings.TrimSpace(fixture.RecoverInteractiveFollowUpClientSubmitID)
			operationPayload["followUpDisposition"] = string(fixture.RecoverInteractiveFollowUpDisposition)
		}
		d.operations.operation = agentactivitybiz.RuntimeOperation{
			OperationID: runtimeOperationID(seed.WorkspaceID, seed.AgentSessionID, agentactivitybiz.RuntimeOperationKindInteractiveResponse, fixture.Interaction.TurnID+"\x00"+fixture.Interaction.RequestID),
			WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID,
			Kind: agentactivitybiz.RuntimeOperationKindInteractiveResponse, Status: agentactivitybiz.RuntimeOperationStatusLeased,
			TurnID: fixture.Interaction.TurnID, RequestID: fixture.Interaction.RequestID,
			Payload:    operationPayload,
			LeaseOwner: "dead-worker", LeaseExpiresAtMS: time.UnixMilli(1_000).Add(time.Hour).UnixMilli(),
		}
	}
	return nil
}

func (d *legacyHostConformanceDriver) ResetProviderlessTerminalExec(
	ctx context.Context,
	session *hostconformance.SessionSeed,
) error {
	fixture := hostconformance.Fixture{}
	if session != nil {
		seed := *session
		fixture.Session = &seed
	}
	if err := d.Reset(ctx, fixture); err != nil {
		return err
	}
	d.runtime.execHook = func(input RuntimeExecInput) (RuntimeExecResult, error) {
		d.recordSubmittedTurn(input.WorkspaceID, input.AgentSessionID, input.TurnID)
		d.recordProviderlessFailedTurn(
			input.WorkspaceID,
			input.AgentSessionID,
			input.TurnID,
		)
		return RuntimeExecResult{
			AgentSessionID: input.AgentSessionID,
			Status:         "started",
			Accepted:       true,
			SessionStatus:  "working",
			TurnID:         input.TurnID,
			TurnLifecycle:  TurnLifecycle{Phase: "submitted"},
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionAppliedWithoutProviderTurn,
			},
		}, nil
	}
	return nil
}

func (d *legacyHostConformanceDriver) DisconnectRuntimeSession(ctx context.Context, ref agenthost.SessionRef) error {
	return d.runtime.Close(ctx, RuntimeCloseInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		PreserveCanonicalState: true,
	})
}

func (d *legacyHostConformanceDriver) DisconnectWorkspaceRuntime(
	ctx context.Context,
	workspaceID string,
) (agenthost.DisconnectWorkspaceRuntimeResult, error) {
	return d.service.ApplicationHost().DisconnectWorkspaceRuntime(ctx, workspaceID)
}

func (d *legacyHostConformanceDriver) WithWorkspaceRuntimeOperation(
	ctx context.Context,
	workspaceID string,
	fn func(context.Context) error,
) error {
	return d.service.ApplicationHost().WithWorkspaceRuntimeOperation(ctx, workspaceID, fn)
}

func (d *legacyHostConformanceDriver) AcquireWorkspaceRuntimeDisconnectFence(
	ctx context.Context,
	workspaceID string,
) (hostconformance.WorkspaceRuntimeDisconnectFenceDriver, error) {
	return d.service.ApplicationHost().AcquireWorkspaceRuntimeDisconnectFence(ctx, workspaceID)
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
		ctx = withServicePreparedRuntime(ctx, d.service, prepared)
		result, err := d.service.ApplicationHost().CreateSession(ctx, workspaceID, input)
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
		InitialContent: input.InitialContent, InitialGoalControl: input.InitialGoalControl, InitialDisplayPrompt: input.InitialDisplayPrompt,
		Metadata: input.Metadata, ClientSubmitID: input.ClientSubmitID, Title: input.Title, Cwd: input.Cwd,
		PermissionModeID: input.PermissionModeID, Model: input.Model, PlanMode: input.PlanMode,
		BrowserUse: input.BrowserUse, ComputerUse: input.ComputerUse,
		ProviderTargetRef: input.ProviderTargetRef, ReasoningEffort: input.ReasoningEffort,
		RuntimeContext: input.RuntimeContext, Speed: input.Speed,
		ConversationDetailMode: input.ConversationDetailMode, Visible: input.Visible,
		RailPlacement:              input.RailPlacement,
		RailPlacementAuthoritative: input.RailPlacementAuthoritative,
	})
	if err != nil {
		return hostconformance.SessionObservation{}, "", err
	}
	turnID := ""
	if len(d.runtime.execCalls) > beforeExec {
		turnID = d.runtime.execCalls[len(d.runtime.execCalls)-1].TurnID
		d.recordSubmittedTurn(workspaceID, session.ID, turnID)
		if clientSubmitID := strings.TrimSpace(input.ClientSubmitID); clientSubmitID != "" {
			d.createdTurns[clientSubmitID] = turnID
		}
	} else if clientSubmitID := strings.TrimSpace(input.ClientSubmitID); clientSubmitID != "" {
		_, textGoal := agenthost.ParseTypedGoalControl(input.InitialContent, false)
		if input.InitialGoalControl == nil && !textGoal {
			turnID = d.createdTurns[clientSubmitID]
		}
		if input.InitialGoalControl == nil && !textGoal && turnID == "" {
			return hostconformance.SessionObservation{}, "", fmt.Errorf("typed create submit %q has no canonical turn", clientSubmitID)
		}
	}
	return legacyHostSessionObservation(session), turnID, nil
}

func (d *legacyHostConformanceDriver) EnsureSession(ctx context.Context, ref agenthost.SessionRef) (hostconformance.SessionObservation, error) {
	if d.directHost {
		if _, err := d.service.ApplicationHost().EnsureRuntimeSession(ctx, ref); err != nil {
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
		result, err := d.service.ApplicationHost().SendInput(ctx, ref, input)
		if err != nil {
			return hostconformance.SendObservation{}, err
		}
		d.recordSubmittedTurn(ref.WorkspaceID, ref.AgentSessionID, result.TurnID)
		session, err := d.service.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
		observation := hostconformance.SendObservation{
			Session: legacyHostSessionObservation(session), TurnID: result.TurnID, Kind: result.Kind,
		}
		if result.GoalControl != nil {
			observation.Goal = clonePayload(result.GoalControl.Goal)
			if result.GoalControl.GoalState != nil {
				observation.Revision = result.GoalControl.GoalState.Revision
			}
		}
		return observation, err
	}
	result, err := d.service.SendInput(ctx, ref.WorkspaceID, ref.AgentSessionID, input)
	if err != nil {
		return hostconformance.SendObservation{}, err
	}
	d.recordSubmittedTurn(ref.WorkspaceID, ref.AgentSessionID, result.TurnID)
	observation := hostconformance.SendObservation{
		Session: legacyHostSessionObservation(result.Session),
		TurnID:  result.TurnID, Kind: result.Kind,
	}
	if result.GoalControl != nil {
		observation.Goal = clonePayload(result.GoalControl.Goal)
		if result.GoalControl.GoalState != nil {
			observation.Revision = result.GoalControl.GoalState.Revision
		}
	}
	return observation, nil
}

func (d *legacyHostConformanceDriver) ResetHistoricalState(ctx context.Context) error {
	return d.Reset(ctx, hostconformance.Fixture{})
}

func (d *legacyHostConformanceDriver) RestoreHistoricalSessionGraph(
	ctx context.Context,
	input agenthost.HistoricalSessionGraphRestoreInput,
) error {
	return d.service.ApplicationHost().RestoreHistoricalSessionGraph(
		ctx,
		input,
	)
}

func (d *legacyHostConformanceDriver) CaptureHistoricalSessionGraph(
	ctx context.Context,
	ref agenthost.SessionRef,
) (agenthost.HistoricalSessionGraph, error) {
	return d.service.ApplicationHost().CaptureHistoricalSessionGraph(ctx, ref)
}

func (d *legacyHostConformanceDriver) HistoricalSessionUserID(
	ctx context.Context,
	ref agenthost.SessionRef,
) (string, error) {
	result, err := d.service.ApplicationHost().GetSession(ctx, ref)
	if err != nil {
		return "", err
	}
	return result.Canonical.UserID, nil
}

func (d *legacyHostConformanceDriver) EnsureHistoricalSession(
	ctx context.Context,
	ref agenthost.SessionRef,
) error {
	_, err := d.EnsureSession(ctx, ref)
	return err
}

func (d *legacyHostConformanceDriver) SendHistoricalInput(
	ctx context.Context,
	ref agenthost.SessionRef,
	input agenthost.SendInput,
) error {
	_, err := d.SendInput(ctx, ref, input)
	return err
}

func (d *legacyHostConformanceDriver) HistoricalStateMetrics() hostconformance.HistoricalStateMetrics {
	metrics := hostconformance.HistoricalStateMetrics{
		ProviderStartCalls:  len(d.runtime.startCalls),
		ProviderResumeCalls: len(d.runtime.resumeCalls),
		ProviderExecCalls:   len(d.runtime.execCalls),
	}
	if len(d.runtime.resumeCalls) > 0 {
		runtimeContext := d.runtime.resumeCalls[len(d.runtime.resumeCalls)-1].RuntimeContext
		checkpoint, _ := runtimeContext[canonical.ProviderResumeCheckpointRuntimeContextKey].(map[string]any)
		metrics.LastResumeProviderCheckpoint = clonePayload(checkpoint)
	}
	return metrics
}

type conformanceHistoricalStateStore struct {
	driver      *legacyHostConformanceDriver
	workspaceID string
	userID      string
	graph       *agenthost.HistoricalSessionGraph
}

func (s *conformanceHistoricalStateStore) RestoreHistoricalSessionGraph(
	_ context.Context,
	input agenthost.HistoricalSessionGraphRestoreInput,
) error {
	workspaceID := input.WorkspaceID
	graph := input.Graph
	if s.graph != nil {
		if s.workspaceID == workspaceID && s.userID == input.UserID &&
			reflect.DeepEqual(*s.graph, graph) {
			return nil
		}
		return agenthost.ErrHistoricalStateConflict
	}
	copied := graph
	s.workspaceID = workspaceID
	s.userID = input.UserID
	s.graph = &copied
	for _, historical := range graph.Sessions {
		settingsRaw, err := json.Marshal(historical.Settings)
		if err != nil {
			return err
		}
		var settings ComposerSettings
		if err := json.Unmarshal(settingsRaw, &settings); err != nil {
			return err
		}
		key := workspaceID + ":" + historical.ID
		s.driver.sessions.sessions[key] = PersistedSession{
			ID: historical.ID, WorkspaceID: workspaceID, Kind: historical.Kind,
			Origin: historical.Origin, UserID: input.UserID, Provider: historical.Provider,
			AgentTargetID:     historical.AgentTargetID,
			ProviderSessionID: historical.ProviderSessionID,
			RailSectionKind:   "conversations", RailSectionKey: "conversations",
			Settings: settings, Title: historical.Title,
			InternalRuntimeContext: map[string]any{
				canonical.ProviderResumeCheckpointRuntimeContextKey: clonePayload(
					historical.ProviderResumeCheckpoint,
				),
			},
			Metadata: agentactivitybiz.SessionMetadata{
				Visible: true,
			},
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 1, LastEventUnixMS: 1,
		}
		s.driver.turns.sessions[historical.ID] = agentactivitybiz.Session{
			ID: historical.ID, WorkspaceID: workspaceID, Kind: historical.Kind,
			Provider:          historical.Provider,
			ProviderSessionID: historical.ProviderSessionID,
			Title:             historical.Title,
		}
		for _, turn := range historical.Turns {
			s.driver.turns.turns[historical.ID+":"+turn.ID] = agentactivitybiz.Turn{
				WorkspaceID: workspaceID, AgentSessionID: historical.ID,
				TurnID: turn.ID, Phase: turn.Phase, Outcome: turn.Outcome,
				Origin: turn.Origin, RootProviderTurnID: turn.RootProviderTurnID,
				IdentityAnchorTurnID: turn.IdentityAnchorTurnID,
				StartedAtUnixMS:      1, SettledAtUnixMS: 1,
			}
		}
	}
	s.driver.service.TurnStore = s.driver.turns
	return nil
}

func (s *conformanceHistoricalStateStore) CaptureHistoricalSessionGraph(
	_ context.Context,
	workspaceID string,
	rootSessionID string,
) (agenthost.HistoricalSessionGraph, error) {
	if s.graph == nil || s.workspaceID != workspaceID ||
		s.graph.RootSessionID != rootSessionID {
		return agenthost.HistoricalSessionGraph{}, agenthost.ErrHistoricalStateUnavailable
	}
	return *s.graph, nil
}

func (d *legacyHostConformanceDriver) CancelTurn(ctx context.Context, input agenthost.CancelTurnInput) (hostconformance.CancelObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().CancelTurn(ctx, input)
		pending := errors.Is(err, agenthost.ErrRuntimeOperationInProgress) && result.IntentAccepted
		if err != nil && !pending {
			return hostconformance.CancelObservation{}, err
		}
		session, getErr := d.service.Get(ctx, input.WorkspaceID, input.AgentSessionID)
		if getErr != nil {
			return hostconformance.CancelObservation{}, getErr
		}
		turnID := ""
		if result.Turn != nil {
			turnID = result.Turn.TurnID
		}
		reason := CancelTurnReasonTurnCanceled
		if pending {
			reason = CancelTurnReasonCancelRequested
		}
		return hostconformance.CancelObservation{
			Session: legacyHostSessionObservation(session), TurnID: turnID,
			Canceled: result.Operation.Result == agentactivitybiz.RuntimeOperationResultCanceled,
			Pending:  pending,
			Reason:   string(reason),
		}, nil
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
		Canceled: result.Canceled, Pending: result.Reason == CancelTurnReasonCancelRequested, Reason: string(result.Reason),
	}, nil
}

func (d *legacyHostConformanceDriver) SubmitInteractive(
	ctx context.Context,
	ref agenthost.InteractionRef,
	input agenthost.SubmitInteractiveInput,
) (hostconformance.InteractiveObservation, error) {
	result, err := d.service.ApplicationHost().SubmitInteractive(ctx, ref, input)
	if err != nil {
		return hostconformance.InteractiveObservation{
			OperationID: result.Operation.OperationID, TurnID: result.Operation.TurnID,
			RequestID: result.Operation.RequestID, Disposition: result.Disposition,
		}, err
	}
	return hostconformance.InteractiveObservation{
		OperationID: result.Operation.OperationID, TurnID: result.Operation.TurnID,
		RequestID: result.Operation.RequestID, Disposition: result.Disposition,
	}, nil
}

func (d *legacyHostConformanceDriver) GetInteractionStatus(
	_ context.Context,
	ref agenthost.InteractionRef,
) (string, bool, error) {
	interaction, found := d.turns.interaction(ref.AgentSessionID, ref.TurnID, ref.RequestID)
	return interaction.Status, found && interaction.WorkspaceID == ref.WorkspaceID, nil
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
		operation, err = d.service.ApplicationHost().SubmitPlanDecision(ctx, ref, turnID, requestID, input)
	} else {
		operation, err = d.service.SubmitPlanDecision(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID, requestID, input)
	}
	observation := hostconformance.OperationObservation{
		OperationID: operation.OperationID, Status: operation.Status, Result: operation.Result,
	}
	if err != nil {
		return observation, err
	}
	deadline := time.Now().Add(time.Second)
	for {
		continuation, found, continuationErr := d.service.ApplicationHost().GetPlanDecisionContinuation(ctx, ref, turnID)
		if continuationErr != nil {
			return observation, continuationErr
		}
		if found {
			observation.ConfirmedTurnID = continuation.Turn.TurnID
			observation.IdentityAnchorTurnID = continuation.Turn.IdentityAnchorTurnID
			return observation, nil
		}
		if time.Now().After(deadline) {
			persisted, persistedFound, persistedErr := d.service.ApplicationHost().GetRuntimeOperation(
				ctx,
				ref.WorkspaceID,
				operation.OperationID,
			)
			d.t.Logf(
				"plan continuation timeout: operation=%#v found=%v err=%v turns=%#v",
				persisted,
				persistedFound,
				persistedErr,
				d.turns.turns,
			)
			return observation, nil
		}
		select {
		case <-ctx.Done():
			return observation, ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func (d *legacyHostConformanceDriver) UpdateTitle(ctx context.Context, input agenthost.UpdateTitleInput) (hostconformance.SessionObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().UpdateTitle(ctx, input)
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

func (d *legacyHostConformanceDriver) GetSession(ctx context.Context, ref agenthost.SessionRef) (hostconformance.SessionObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().GetSession(ctx, ref)
		if err != nil {
			return hostconformance.SessionObservation{}, err
		}
		session, err := d.service.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, false, true)
		return legacyHostSessionObservationWithLive(session, result.Live), err
	}
	session, err := d.service.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
	live := d.runtime.RuntimeSessionLive(ref.WorkspaceID, ref.AgentSessionID)
	return legacyHostSessionObservationWithLive(session, live), err
}

func (d *legacyHostConformanceDriver) ListSessionTurns(ctx context.Context, ref agenthost.SessionRef, query agenthost.SessionTurnQuery) (agenthost.SessionTurnSummaryPage, error) {
	if d.directHost {
		return d.service.ApplicationHost().ListSessionTurns(ctx, ref, query)
	}
	page, err := d.service.ListTurns(ctx, ref.WorkspaceID, ref.AgentSessionID, ListTurnsInput{
		Before: query.Before, Limit: query.Limit,
	})
	return agenthost.SessionTurnSummaryPage{Turns: page.Turns, HasMore: page.HasMore}, err
}

func (d *legacyHostConformanceDriver) GetCanonicalSession(_ context.Context, ref agenthost.SessionRef) (hostconformance.SessionObservation, error) {
	persisted, found := d.sessions.GetSession(ref.WorkspaceID, ref.AgentSessionID)
	if !found {
		return hostconformance.SessionObservation{}, agenthost.ErrSessionNotFound
	}
	return legacyHostSessionObservation(sessionFromPersisted(persisted, true)), nil
}

func (d *legacyHostConformanceDriver) UpdateSettings(ctx context.Context, input agenthost.UpdateSettingsInput) (hostconformance.SessionObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().UpdateSettings(ctx, input)
		if err != nil {
			return hostconformance.SessionObservation{}, err
		}
		session, err := d.service.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, false, true)
		return legacyHostSessionObservationWithLive(session, result.Live), err
	}
	session, err := d.service.UpdateSettings(ctx, input.WorkspaceID, input.AgentSessionID, input.Settings)
	_, live := d.runtime.Session(input.WorkspaceID, input.AgentSessionID)
	return legacyHostSessionObservationWithLive(session, live), err
}

func (d *legacyHostConformanceDriver) UpdatePin(ctx context.Context, input agenthost.UpdatePinInput) (hostconformance.SessionObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().UpdatePin(ctx, input)
		if err != nil {
			return hostconformance.SessionObservation{}, err
		}
		session, err := d.service.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, false, true)
		return legacyHostSessionObservationWithLive(session, result.Live), err
	}
	session, err := d.service.UpdatePin(ctx, input.WorkspaceID, input.AgentSessionID, input.Pinned)
	_, live := d.runtime.Session(input.WorkspaceID, input.AgentSessionID)
	return legacyHostSessionObservationWithLive(session, live), err
}

func (d *legacyHostConformanceDriver) DeleteSession(ctx context.Context, ref agenthost.SessionRef) (agenthost.DeleteSessionResult, error) {
	if d.directHost {
		return d.service.ApplicationHost().DeleteSession(ctx, ref)
	}
	_, live := d.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
	_, persisted := d.sessions.GetSession(ref.WorkspaceID, ref.AgentSessionID)
	deleted, err := d.service.Delete(ctx, ref.WorkspaceID, ref.AgentSessionID)
	return agenthost.DeleteSessionResult{
		Deleted: deleted.Removed, RuntimeClosed: live && deleted.Removed, CanonicalRemoved: persisted && deleted.Removed,
	}, err
}

func (d *legacyHostConformanceDriver) DeleteSessions(ctx context.Context, input agenthost.DeleteSessionsInput) (agenthost.DeleteSessionsResult, error) {
	if d.directHost {
		return d.deletionHost.DeleteSessions(ctx, input)
	}
	closeCallsBefore := len(d.runtime.closeCalls)
	result, err := d.deletionAdapter.DeleteSessionsBatch(ctx, input.WorkspaceID, DeleteSessionsBatchInput{
		SessionIDs: input.SessionIDs,
	})
	if err != nil {
		return agenthost.DeleteSessionsResult{}, err
	}
	runtimeClosedIDs := make([]string, 0, len(d.runtime.closeCalls)-closeCallsBefore)
	for _, closeCall := range d.runtime.closeCalls[closeCallsBefore:] {
		runtimeClosedIDs = append(runtimeClosedIDs, closeCall.AgentSessionID)
	}
	sort.Strings(runtimeClosedIDs)
	return agenthost.DeleteSessionsResult{
		RemovedSessionIDs: append([]string(nil), result.RemovedSessionIDs...),
		RemovedSessions:   result.RemovedSessions,
		RemovedMessages:   result.RemovedMessages,
		RuntimeClosedIDs:  runtimeClosedIDs,
		CleanupFailedIDs:  append([]string(nil), result.CleanupFailedSessionIDs...),
	}, nil
}

func (d *legacyHostConformanceDriver) PurgeDeletedSessions(ctx context.Context, input agenthost.PurgeDeletedSessionsInput) (agenthost.PurgeDeletedSessionsResult, error) {
	return d.service.ApplicationHost().PurgeDeletedSessions(ctx, input)
}

func (d *legacyHostConformanceDriver) GoalControl(ctx context.Context, input agenthost.GoalControlInput) (hostconformance.GoalObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().GoalControl(ctx, input)
		return hostGoalControlObservation(result), err
	}
	result, err := d.service.GoalControl(ctx, GoalControlInput{
		WorkspaceID:        input.WorkspaceID,
		AgentSessionID:     input.AgentSessionID,
		Action:             input.Action,
		Objective:          input.Objective,
		ClientSubmitID:     input.ClientSubmitID,
		SubmissionMetadata: input.SubmissionMetadata,
	})
	observation := hostconformance.GoalObservation{
		Goal: clonePayload(result.Goal), IntentAccepted: result.IntentAccepted,
		OperationID: result.OperationID, PendingOperationID: result.OperationID,
	}
	if result.GoalState != nil {
		observation.Revision = result.GoalState.Revision
		observation.PendingOperationID = result.GoalState.PendingOperationID
		observation.SyncStatus = result.GoalState.SyncStatus
		observation.ExecutionPending = result.GoalState.ExecutionPending
	}
	return observation, err
}

func (d *legacyHostConformanceDriver) AdoptProviderGoal(ctx context.Context, input agenthost.ProviderGoalAdoptionInput) (hostconformance.GoalObservation, error) {
	var (
		result agenthost.ProviderGoalAdoptionResult
		err    error
	)
	if d.directHost {
		result, err = d.service.ApplicationHost().AdoptProviderGoal(ctx, input)
	} else {
		result, err = d.service.AdoptProviderGoal(ctx, input)
	}
	if err != nil {
		return hostconformance.GoalObservation{}, err
	}
	state, stateErr := d.service.ApplicationHost().GetGoalState(ctx, agenthost.SessionRef{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
	})
	if stateErr != nil {
		return hostconformance.GoalObservation{}, stateErr
	}
	return hostconformance.GoalObservation{
		Goal: clonePayload(result.Goal), OperationID: result.OperationID,
		Revision: state.State.Revision, PendingOperationID: state.State.PendingOperationID,
		SyncStatus:       state.State.SyncStatus,
		ExecutionPending: state.State.ExecutionPending,
	}, nil
}

func (d *legacyHostConformanceDriver) FenceGoalGeneration(ctx context.Context, input agenthost.FenceGoalGenerationInput) (agenthost.FenceGoalGenerationResult, error) {
	return d.service.ApplicationHost().FenceGoalGeneration(ctx, input)
}

func (d *legacyHostConformanceDriver) GetGoalState(ctx context.Context, ref agenthost.SessionRef) (hostconformance.GoalObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().GetGoalState(ctx, ref)
		return hostGoalStateObservation(result), err
	}
	result, err := d.service.GetGoalState(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return hostconformance.GoalObservation{}, err
	}
	return hostGoalStateObservation(agenthost.GoalStateResult{State: result.State}), nil
}

func (d *legacyHostConformanceDriver) ReconcileGoal(ctx context.Context, ref agenthost.SessionRef) (hostconformance.GoalObservation, error) {
	if d.directHost {
		result, err := d.service.ApplicationHost().ReconcileGoal(ctx, ref)
		return hostGoalStateObservation(result), err
	}
	result, err := d.service.ReconcileGoal(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return hostconformance.GoalObservation{}, err
	}
	return hostGoalStateObservation(agenthost.GoalStateResult{State: result.State}), nil
}

func (d *legacyHostConformanceDriver) StepGoalOperations(ctx context.Context, nowUnixMS int64) error {
	d.goalNowUnixMS = nowUnixMS
	return d.service.ApplicationHost().StepGoalOperationWorker(ctx, false)
}

func hostGoalControlObservation(result agenthost.GoalControlResult) hostconformance.GoalObservation {
	observation := hostconformance.GoalObservation{
		Goal: clonePayload(result.Goal), IntentAccepted: result.IntentAccepted,
		OperationID: result.OperationID, PendingOperationID: result.OperationID,
	}
	if result.GoalState != nil {
		observation.Revision = result.GoalState.Revision
		observation.PendingOperationID = result.GoalState.PendingOperationID
		observation.SyncStatus = result.GoalState.SyncStatus
		observation.ExecutionPending = result.GoalState.ExecutionPending
	}
	return observation
}

func hostGoalStateObservation(result agenthost.GoalStateResult) hostconformance.GoalObservation {
	return hostconformance.GoalObservation{
		Goal: clonePayload(result.State.Desired), Revision: result.State.Revision,
		PendingOperationID: result.State.PendingOperationID, SyncStatus: result.State.SyncStatus,
		ExecutionPending: result.State.ExecutionPending,
	}
}

func (d *legacyHostConformanceDriver) Metrics() hostconformance.Metrics {
	metrics := hostconformance.Metrics{
		StartCalls: len(d.runtime.startCalls), ResumeCalls: len(d.runtime.resumeCalls),
		ExecCalls: len(d.runtime.execCalls), CancelCalls: len(d.runtime.cancelCalls),
		GuidanceProviderCalls: d.runtime.guidanceProviderCalls,
		InteractiveCalls:      len(d.runtime.submitInteractiveCalls), UpdateSettingsCalls: len(d.runtime.updateSettingsCalls),
		CloseCalls:       len(d.runtime.closeCalls),
		GoalControlCalls: len(d.runtime.goalControlCalls), GoalReconcileCalls: len(d.runtime.goalReconcileCalls),
		RuntimeSessionPublishCalls: len(d.runtime.publishInitCalls),
		RuntimeStartReportWrites:   d.runtimeStartReportWrites,
		RecoverySteps:              append([]string(nil), (*d.recoverySteps)...),
	}
	if len(d.runtime.startCalls) > 0 {
		metrics.LastStartEnv = append([]string(nil), d.runtime.startCalls[len(d.runtime.startCalls)-1].Env...)
	}
	if len(d.runtime.resumeCalls) > 0 {
		metrics.LastResumeEnv = append([]string(nil), d.runtime.resumeCalls[len(d.runtime.resumeCalls)-1].Env...)
	}
	if closeCallCount := len(d.runtime.closeCalls); closeCallCount > 0 {
		metrics.LastClosePreservedCanonicalState = d.runtime.closeCalls[closeCallCount-1].PreserveCanonicalState
	}
	if d.deletionGuard != nil {
		metrics.DeleteAdmissionPlans = append([]agenthost.DeleteSessionsPlan(nil), d.deletionGuard.plans...)
		metrics.DeleteReports = append([]agenthost.DeleteSessionsReport(nil), d.deletionGuard.reports...)
	}
	if d.deletionStore != nil {
		metrics.CanonicalDeleteCalls = d.deletionStore.deleteCalls
	}
	if d.deletionEvents != nil {
		metrics.DeletionEvents = append([]string(nil), (*d.deletionEvents)...)
	}
	for _, delta := range d.commitObserver.snapshot() {
		if delta.RuntimeOperation != nil {
			metrics.RuntimeOperationCommits++
		}
		if delta.GoalOperation != nil {
			metrics.GoalOperationCommits++
		}
		metrics.RootTurnSettlements += len(delta.RootTurnsSettled)
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
		last := d.runtime.execCalls[len(d.runtime.execCalls)-1]
		metrics.LastExecClientSubmitID = last.ClientSubmitID
		metrics.LastInitialTitle = last.InitialTitle
		metrics.LastExecRequiresProviderAcceptance =
			last.RequireProviderAcceptance
	}
	if len(d.runtime.resumeCalls) > 0 {
		lastResume := d.runtime.resumeCalls[len(d.runtime.resumeCalls)-1]
		metrics.LastResumeRecreate = lastResume.RecreateIfMissing
		metrics.LastResumeGoalGenerationFences = append(
			[]agenthost.RuntimeGoalGenerationFenceInput(nil), lastResume.GoalGenerationFences...,
		)
	}
	return metrics
}

type conformanceDeletionStore struct {
	agenthost.SessionBatchManagementStore
	plans       [][]string
	planIndex   int
	deleteCalls int
	events      *[]string
}

func (s *conformanceDeletionStore) PlanDeleteSessions(
	ctx context.Context,
	input agentactivitybiz.DeleteSessionsBatchInput,
) (agentactivitybiz.DeleteSessionsPlan, error) {
	if len(s.plans) == 0 {
		return s.SessionBatchManagementStore.PlanDeleteSessions(ctx, input)
	}
	index := s.planIndex
	if index >= len(s.plans) {
		index = len(s.plans) - 1
	}
	return agentactivitybiz.DeleteSessionsPlan{
		WorkspaceID: input.WorkspaceID,
		SessionIDs:  append([]string(nil), s.plans[index]...),
	}, nil
}

func (s *conformanceDeletionStore) DeleteSessionsBatch(
	ctx context.Context,
	input agentactivitybiz.DeleteSessionsBatchInput,
) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	s.deleteCalls++
	if s.events != nil {
		*s.events = append(*s.events, "delete:"+strings.Join(input.ExpectedSessionIDs, ","))
	}
	if s.planIndex+1 < len(s.plans) {
		s.planIndex++
		return agentactivitybiz.DeleteSessionsBatchResult{}, agentactivitybiz.ErrDeleteSessionsPlanChanged
	}
	return s.SessionBatchManagementStore.DeleteSessionsBatch(ctx, input)
}

type conformanceDeletionGuard struct {
	admissionErr error
	plans        []agenthost.DeleteSessionsPlan
	reports      []agenthost.DeleteSessionsReport
	events       *[]string
}

func (g *conformanceDeletionGuard) AdmitDeleteSessions(_ context.Context, plan agenthost.DeleteSessionsPlan) error {
	g.plans = append(g.plans, plan)
	if g.events != nil {
		*g.events = append(*g.events, "admit:"+strings.Join(plan.SessionIDs, ","))
	}
	return g.admissionErr
}

func (g *conformanceDeletionGuard) ReportDeleteSessions(_ context.Context, report agenthost.DeleteSessionsReport) {
	g.reports = append(g.reports, report)
	if g.events != nil {
		status := "success"
		if report.Err != nil {
			status = "failure"
		}
		*g.events = append(*g.events, "report-"+status+":"+strings.Join(report.Plan.SessionIDs, ","))
	}
}

type conformanceCommitObserver struct {
	mu     sync.Mutex
	deltas []agenthost.CommittedDelta
	fail   bool
}

func (o *conformanceCommitObserver) ObserveCommitted(_ context.Context, delta agenthost.CommittedDelta) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.deltas = append(o.deltas, delta)
	if o.fail {
		return errors.New("conformance commit observer failure")
	}
	return nil
}

func (o *conformanceCommitObserver) snapshot() []agenthost.CommittedDelta {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]agenthost.CommittedDelta(nil), o.deltas...)
}

func (d *legacyHostConformanceDriver) Recover(ctx context.Context) error {
	if d.directHost {
		return d.service.ApplicationHost().Recover(ctx)
	}
	return d.service.ApplicationHost().Recover(ctx)
}

type conformanceRuntimeOperationStore struct {
	*runtimeOperationMemoryStore
	steps *[]string
}

type conformanceGoalStateStore struct {
	agenthost.GoalStateStore
	steps *[]string
}

func (s *conformanceGoalStateStore) RequeueLeasedGoalControlOperationsOnStartup(ctx context.Context, now int64) (int64, error) {
	*s.steps = append(*s.steps, "goal_requeue")
	return s.GoalStateStore.RequeueLeasedGoalControlOperationsOnStartup(ctx, now)
}

type conformanceGoalInboxStore struct {
	agenthost.GoalReconcileInboxStore
	steps *[]string
}

func (s *conformanceGoalInboxStore) RequeueLeasedGoalReconcileInboxOnStartup(ctx context.Context, now int64) (int64, error) {
	*s.steps = append(*s.steps, "goal_inbox_requeue")
	return s.GoalReconcileInboxStore.RequeueLeasedGoalReconcileInboxOnStartup(ctx, now)
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
	key := sessionID + ":" + turnID
	if existing, ok := d.turns.turns[key]; ok &&
		existing.Phase == agentactivitybiz.TurnPhaseSettled {
		// Submit provenance and Host's post-Exec submission record are
		// idempotent facts. They must never downgrade a terminal event that the
		// Runtime committed before Exec returned.
		return
	}
	startedAtUnixMS := int64(len(d.turns.turns) + 1)
	d.turns.turns[key] = agentactivitybiz.Turn{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID,
		Phase: agentactivitybiz.TurnPhaseSubmitted, StartedAtUnixMS: startedAtUnixMS,
	}
	d.service.TurnStore = d.turns
}

func (d *legacyHostConformanceDriver) recordProviderlessFailedTurn(
	workspaceID string,
	sessionID string,
	turnID string,
) {
	key := sessionID + ":" + turnID
	turn := d.turns.turns[key]
	turn.WorkspaceID = workspaceID
	turn.AgentSessionID = sessionID
	turn.TurnID = turnID
	turn.Phase = agentactivitybiz.TurnPhaseSettled
	turn.Outcome = "failed"
	if turn.StartedAtUnixMS == 0 {
		turn.StartedAtUnixMS = int64(len(d.turns.turns) + 1)
	}
	turn.SettledAtUnixMS = turn.StartedAtUnixMS + 1
	d.turns.turns[key] = turn
	d.service.TurnStore = d.turns
}

type legacyHostConformanceSessionInitializer struct {
	canonicalStore *workspacedata.SQLiteStore
	sessions       *fakeSessionReader
	fail           bool
}

func (i legacyHostConformanceSessionInitializer) ResolveRuntimeSessionRailPlacement(
	ctx context.Context,
	input agenthost.ResolveRuntimeSessionRailPlacementInput,
) (*agenthost.RailPlacement, error) {
	if i.canonicalStore != nil && i.canonicalStore.AgentCanonicalStore() != nil {
		canonical := i.canonicalStore.AgentCanonicalStore()
		store := &agenthost.SQLiteWorkspaceStore{
			StoreForWorkspace: func(string) *agentactivitybiz.Store { return canonical },
		}
		return store.ResolveRuntimeSessionRailPlacement(ctx, input)
	}
	return (fakeSessionInitializer{reader: i.sessions}).ResolveRuntimeSessionRailPlacement(ctx, input)
}

func (i legacyHostConformanceSessionInitializer) InitializeRuntimeSession(
	ctx context.Context,
	session ProviderRuntimeSession,
	railPlacement *agenthost.RailPlacement,
) (PersistedSession, error) {
	return i.InitializeRuntimeSessionWithRailAuthority(ctx, session, railPlacement, false)
}

func (i legacyHostConformanceSessionInitializer) InitializeRuntimeSessionWithRailAuthority(
	ctx context.Context,
	session ProviderRuntimeSession,
	railPlacement *agenthost.RailPlacement,
	railPlacementAuthoritative bool,
) (PersistedSession, error) {
	if i.fail {
		return PersistedSession{}, errors.New("injected canonical session initialization failure")
	}
	if railPlacement != nil {
		if existing, found := i.sessions.sessions[session.WorkspaceID+":"+session.ID]; found &&
			(strings.TrimSpace(existing.RailSectionKind) != strings.TrimSpace(string(railPlacement.Kind)) ||
				strings.TrimSpace(existing.RailProjectPath) != strings.TrimSpace(railPlacement.ProjectPath) ||
				strings.TrimSpace(existing.RailSectionKey) != strings.TrimSpace(railPlacement.SectionKey)) {
			return PersistedSession{}, agenthost.ErrRailPlacementConflict
		}
	}
	persisted, err := (fakeSessionInitializer{}).InitializeRuntimeSession(ctx, session, railPlacement)
	if err != nil {
		return PersistedSession{}, err
	}
	i.sessions.sessions[persisted.WorkspaceID+":"+persisted.ID] = persisted
	if i.canonicalStore != nil {
		if _, err := i.canonicalStore.Get(ctx, persisted.WorkspaceID); errors.Is(err, workspacedata.ErrWorkspaceNotFound) {
			if err := i.canonicalStore.Create(ctx, workspacebiz.Summary{
				ID:   persisted.WorkspaceID,
				Name: "Host conformance",
			}); err != nil {
				return PersistedSession{}, err
			}
		} else if err != nil {
			return PersistedSession{}, err
		}
		var canonicalRail *agentactivitybiz.RailSection
		if railPlacement != nil {
			canonicalRail = &agentactivitybiz.RailSection{
				Kind:        string(railPlacement.Kind),
				ProjectPath: railPlacement.ProjectPath,
				Key:         railPlacement.SectionKey,
			}
		}
		if _, err := i.canonicalStore.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID:                persisted.WorkspaceID,
			AgentSessionID:             persisted.ID,
			Provider:                   persisted.Provider,
			ProviderSessionID:          persisted.ProviderSessionID,
			RailPlacement:              canonicalRail,
			RailPlacementAuthoritative: railPlacementAuthoritative,
			OccurredAtUnixMS:           persisted.UpdatedAtUnixMS,
		}); err != nil {
			return PersistedSession{}, err
		}
	}
	return persisted, nil
}

func legacyHostSessionObservation(session Session) hostconformance.SessionObservation {
	return legacyHostSessionObservationWithLive(session, false)
}

func legacyHostSessionObservationWithLive(session Session, live bool) hostconformance.SessionObservation {
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	return hostconformance.SessionObservation{
		SessionID: session.ID, ProviderSessionID: session.ProviderSessionID,
		RailSectionKey: session.RailSectionKey,
		Title:          value(session.Title), ActiveTurnID: session.ActiveTurnID, Resumable: session.Resumable,
		Settings: settings, Pinned: session.PinnedAtUnixMS > 0, Live: live,
	}
}

func boolUnixMS(value bool) int64 {
	if value {
		return 1
	}
	return 0
}
