package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// serviceHostStore is deliberately test-only. Production wiring consumes
// agenthost.SQLiteWorkspaceStore; package tests retain this adapter for their
// narrow in-memory service fakes.
type serviceHostStore struct{ service *Service }

func (p *ActivityProjection) ResolveRuntimeSessionRailPlacement(
	ctx context.Context,
	input agenthost.ResolveRuntimeSessionRailPlacementInput,
) (*agenthost.RailPlacement, error) {
	provider, ok := p.repo.(interface {
		AgentCanonicalStore() *storesqlite.Store
	})
	if !ok || provider.AgentCanonicalStore() == nil {
		return nil, fmt.Errorf("agent activity canonical store is unavailable")
	}
	canonical := provider.AgentCanonicalStore()
	store := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(string) *storesqlite.Store { return canonical },
	}
	return store.ResolveRuntimeSessionRailPlacement(ctx, input)
}

func (serviceHostStore) GetSessionForkLineage(
	context.Context,
	string,
	string,
) (storesqlite.SessionForkLineage, bool, error) {
	return storesqlite.SessionForkLineage{}, false, nil
}

func (serviceHostStore) GetSessionForkOperation(
	context.Context,
	string,
	string,
) (storesqlite.SessionForkOperation, bool, error) {
	return storesqlite.SessionForkOperation{}, false, nil
}

type canonicalSessionMessageReader interface {
	ListSessionMessages(context.Context, storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error)
}

func (a serviceHostStore) GetSession(ctx context.Context, workspaceID, sessionID string) (storesqlite.Session, bool, error) {
	if a.service == nil {
		return storesqlite.Session{}, false, nil
	}
	if a.service.SessionReader != nil {
		if session, ok := a.service.SessionReader.GetSession(workspaceID, sessionID); ok {
			return activitySessionFromPersisted(session), true, nil
		}
	}
	if a.service.TurnStore != nil {
		if session, ok, err := a.service.TurnStore.GetSession(ctx, workspaceID, sessionID); err != nil || ok {
			return session, ok, err
		}
	}
	return storesqlite.Session{}, false, nil
}

func (a serviceHostStore) CompareAndSwapSessionRuntimeContext(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	expected map[string]any,
	replacement map[string]any,
) (storesqlite.Session, bool, error) {
	updater, ok := a.service.SessionReader.(interface {
		CompareAndSwapSessionRuntimeContext(context.Context, string, string, map[string]any, map[string]any) (PersistedSession, bool, error)
	})
	if !ok {
		return storesqlite.Session{}, false, nil
	}
	persisted, updated, err := updater.CompareAndSwapSessionRuntimeContext(
		ctx, workspaceID, sessionID, expected, replacement,
	)
	return activitySessionFromPersisted(persisted), updated, err
}

func (a serviceHostStore) ResolveRuntimeSessionRailPlacement(
	ctx context.Context,
	input agenthost.ResolveRuntimeSessionRailPlacementInput,
) (*agenthost.RailPlacement, error) {
	if a.service != nil && a.service.SessionInitializer != nil {
		if resolver, ok := a.service.SessionInitializer.(interface {
			ResolveRuntimeSessionRailPlacement(context.Context, agenthost.ResolveRuntimeSessionRailPlacementInput) (*agenthost.RailPlacement, error)
		}); ok {
			return resolver.ResolveRuntimeSessionRailPlacement(ctx, input)
		}
	}
	if input.RailPlacement != nil {
		placement := *input.RailPlacement
		return &placement, nil
	}
	if session, found, err := a.GetSession(ctx, input.WorkspaceID, input.AgentSessionID); err != nil {
		return nil, err
	} else if found && strings.TrimSpace(session.RailSectionKey) != "" {
		return &agenthost.RailPlacement{
			Version:     agenthost.RailPlacementVersion,
			Kind:        agenthost.RailPlacementKind(session.RailSectionKind),
			ProjectPath: session.RailProjectPath,
			SectionKey:  session.RailSectionKey,
		}, nil
	}
	section := storesqlite.ClassifyRailSection(input.Cwd, input.RuntimeContext, nil)
	return &agenthost.RailPlacement{
		Version:     agenthost.RailPlacementVersion,
		Kind:        agenthost.RailPlacementKind(section.Kind),
		ProjectPath: section.ProjectPath,
		SectionKey:  section.Key,
	}, nil
}

func (a serviceHostStore) SessionDeleted(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	if a.service == nil || a.service.SessionReader == nil {
		return false, nil
	}
	return a.service.SessionReader.SessionDeleted(ctx, workspaceID, sessionID)
}

func (a serviceHostStore) RollbackRuntimeSessionInitialization(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	rollbacker, ok := a.service.SessionReader.(interface {
		RollbackRuntimeSessionInitialization(context.Context, string, string) (bool, error)
	})
	if !ok {
		return false, nil
	}
	return rollbacker.RollbackRuntimeSessionInitialization(ctx, workspaceID, sessionID)
}

func (a serviceHostStore) InitializeRuntimeSession(ctx context.Context, input agenthost.RuntimeSessionInitialization) (storesqlite.Session, error) {
	persisted, err := a.service.initializeRuntimeSessionWithRailAuthority(
		ctx, input.Session, input.RailPlacement, input.RailPlacementAuthoritative,
	)
	return activitySessionFromPersisted(persisted), err
}

func (a serviceHostStore) UpdateSessionTitle(ctx context.Context, workspaceID, sessionID, title string) (storesqlite.Session, bool, error) {
	updater, ok := a.service.SessionReader.(SessionTitleUpdater)
	if !ok {
		return storesqlite.Session{}, false, nil
	}
	persisted, updated, err := updater.UpdateSessionTitle(ctx, workspaceID, sessionID, title)
	return activitySessionFromPersisted(persisted), updated, err
}

func (a serviceHostStore) UpdateSessionSettings(ctx context.Context, workspaceID, sessionID string, settings agenthost.ComposerSettings) (storesqlite.Session, bool, error) {
	updater, ok := a.service.SessionReader.(SessionSettingsUpdater)
	if !ok {
		return storesqlite.Session{}, false, nil
	}
	persisted, updated, err := updater.UpdateSessionSettings(ctx, workspaceID, sessionID, settings)
	return activitySessionFromPersisted(persisted), updated, err
}

func (a serviceHostStore) UpdateSessionPinned(ctx context.Context, workspaceID, sessionID string, pinned bool) (storesqlite.Session, bool, error) {
	updater, ok := a.service.SessionReader.(SessionPinUpdater)
	if !ok {
		return storesqlite.Session{}, false, nil
	}
	persisted, updated, err := updater.UpdateSessionPinned(ctx, workspaceID, sessionID, pinned)
	return activitySessionFromPersisted(persisted), updated, err
}

func (a serviceHostStore) DeleteSessionsBatch(ctx context.Context, input storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsBatchResult, error) {
	deleter, ok := a.service.SessionReader.(SessionBatchDeleter)
	if !ok {
		return storesqlite.DeleteSessionsBatchResult{}, agenthost.ErrInvalidArgument
	}
	return deleter.DeleteSessionsBatch(ctx, input)
}

func (a serviceHostStore) PlanDeleteSessions(ctx context.Context, input storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsPlan, error) {
	deleter, ok := a.service.SessionReader.(SessionBatchDeleter)
	if !ok {
		return storesqlite.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID}, nil
	}
	return deleter.PlanDeleteSessions(ctx, input)
}

func (a serviceHostStore) PlanClearSessions(ctx context.Context, workspaceID string) (storesqlite.DeleteSessionsPlan, error) {
	deleter, ok := a.service.SessionReader.(SessionBatchDeleter)
	if !ok {
		return storesqlite.DeleteSessionsPlan{}, agenthost.ErrInvalidArgument
	}
	return deleter.PlanClearSessions(ctx, workspaceID)
}

func (a serviceHostStore) ListChildSessions(ctx context.Context, workspaceID, sessionID string) ([]storesqlite.Session, error) {
	reader, ok := a.service.SessionReader.(ChildSessionReader)
	if !ok {
		return nil, nil
	}
	children, err := reader.ListChildSessions(ctx, workspaceID, sessionID)
	if err != nil {
		return nil, err
	}
	result := make([]storesqlite.Session, 0, len(children))
	for _, child := range children {
		result = append(result, activitySessionFromPersisted(child))
	}
	return result, nil
}

func (a serviceHostStore) GetTurn(ctx context.Context, workspaceID, sessionID, turnID string) (storesqlite.Turn, bool, error) {
	if a.service.TurnStore == nil {
		return storesqlite.Turn{}, false, nil
	}
	return a.service.TurnStore.GetTurn(ctx, workspaceID, sessionID, turnID)
}

func (a serviceHostStore) GetProviderSessionResumeEvidence(
	ctx context.Context,
	workspaceID string,
	sessionID string,
) (storesqlite.ProviderSessionResumeEvidence, error) {
	if a.service == nil {
		return storesqlite.ProviderSessionResumeEvidence{}, nil
	}
	if a.service.TurnStore == nil {
		return storesqlite.ProviderSessionResumeEvidence{HasTurns: true, Established: true}, nil
	}
	turns, err := a.service.TurnStore.ListSessionTurns(ctx, workspaceID, sessionID)
	if err != nil {
		return storesqlite.ProviderSessionResumeEvidence{}, err
	}
	// Older service tests model an established persisted session without
	// seeding its canonical turns. Keep those fixtures meaningful; the
	// unestablished-session conformance case seeds an explicit turn with no
	// provider root id and therefore still exercises the rejection path.
	if len(turns) == 0 {
		return storesqlite.ProviderSessionResumeEvidence{HasTurns: true, Established: true}, nil
	}
	evidence := storesqlite.ProviderSessionResumeEvidence{HasTurns: len(turns) > 0}
	for _, turn := range turns {
		if strings.TrimSpace(turn.Phase) == storesqlite.TurnPhaseSettled {
			evidence.HasSettledTurn = true
		}
		if strings.TrimSpace(turn.RootProviderTurnID) != "" {
			evidence.Established = true
			break
		}
	}
	// This adapter is test-only. The shared fake runtime acknowledges Exec
	// synchronously, so expose that acknowledgement as the canonical evidence
	// that production receives through root_provider_turn.started persistence.
	if !evidence.Established {
		if session, ok := a.service.controller().Session(workspaceID, sessionID); ok {
			evidence.Established = session.Resumable
		}
	}
	return evidence, nil
}

func (a serviceHostStore) FindTurnByClientSubmitID(ctx context.Context, workspaceID, sessionID, clientSubmitID string) (string, bool, error) {
	if a.service.SubmitClaimStore != nil {
		turnID, found, err := a.service.SubmitClaimStore.FindTurnByClientSubmitID(ctx, workspaceID, sessionID, clientSubmitID)
		if err != nil || found {
			return turnID, found, err
		}
	}
	if a.service.RuntimeOperationStore == nil {
		return "", false, nil
	}
	return a.service.RuntimeOperationStore.FindTurnByClientSubmitID(ctx, workspaceID, sessionID, clientSubmitID)
}

func (a serviceHostStore) ListSessionInteractions(ctx context.Context, input storesqlite.ListSessionInteractionsInput) ([]storesqlite.Interaction, error) {
	if a.service.TurnStore == nil {
		return nil, nil
	}
	return a.service.TurnStore.ListSessionInteractions(ctx, input)
}

func (a serviceHostStore) ListLatestTurnInteractions(ctx context.Context, workspaceID string, sessionIDs []string) (map[string][]storesqlite.Interaction, error) {
	if a.service.TurnStore == nil {
		return nil, nil
	}
	return a.service.TurnStore.ListLatestTurnInteractions(ctx, workspaceID, sessionIDs)
}

func (a serviceHostStore) ListSessionMessages(ctx context.Context, input storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error) {
	reader, ok := a.service.TurnStore.(canonicalSessionMessageReader)
	if !ok {
		return storesqlite.MessagePage{}, false, nil
	}
	return reader.ListSessionMessages(ctx, input)
}

func (a serviceHostStore) ListSessionTurnSummaries(ctx context.Context, input storesqlite.ListSessionTurnSummariesInput) (storesqlite.SessionTurnSummaryPage, error) {
	if a.service == nil || a.service.TurnSummaryReader == nil {
		return storesqlite.SessionTurnSummaryPage{}, agenthost.ErrInvalidArgument
	}
	return a.service.TurnSummaryReader.ListSessionTurnSummaries(ctx, input)
}

func (a serviceHostStore) PrepareSubmitClaim(ctx context.Context, input storesqlite.SubmitClaimPrepare) (storesqlite.SubmitClaim, bool, error) {
	if a.service.SubmitClaimStore == nil {
		return storesqlite.SubmitClaim{}, false, nil
	}
	return a.service.SubmitClaimStore.PrepareSubmitClaim(ctx, input)
}

func (a serviceHostStore) AcceptSubmitClaim(ctx context.Context, workspaceID, sessionID, clientSubmitID, turnID string, now int64) (storesqlite.SubmitClaim, bool, error) {
	if a.service.SubmitClaimStore == nil {
		return storesqlite.SubmitClaim{}, false, nil
	}
	return a.service.SubmitClaimStore.AcceptSubmitClaim(ctx, workspaceID, sessionID, clientSubmitID, turnID, now)
}

func (a serviceHostStore) RejectSubmitClaim(ctx context.Context, workspaceID, sessionID, clientSubmitID, turnID string, now int64) (storesqlite.SubmitClaim, bool, error) {
	if a.service.SubmitClaimStore == nil {
		return storesqlite.SubmitClaim{}, false, nil
	}
	return a.service.SubmitClaimStore.RejectSubmitClaim(ctx, workspaceID, sessionID, clientSubmitID, turnID, now)
}

func (a serviceHostStore) DeleteSubmitClaim(ctx context.Context, workspaceID, sessionID, clientSubmitID string) (bool, error) {
	if a.service.SubmitClaimStore == nil {
		return false, nil
	}
	return a.service.SubmitClaimStore.DeleteSubmitClaim(ctx, workspaceID, sessionID, clientSubmitID)
}

type serviceHostRuntime struct{ service *Service }

func (a serviceHostRuntime) WorkspaceRuntimeSessions(_ context.Context, workspaceID string) ([]ProviderRuntimeSession, error) {
	return a.service.controller().Sessions(workspaceID), nil
}

func (a serviceHostRuntime) DisconnectRuntimeSession(
	ctx context.Context,
	ref agenthost.SessionRef,
) (bool, error) {
	disconnector, ok := a.service.controller().(interface {
		DisconnectRuntimeSession(context.Context, string, string) (bool, error)
	})
	if !ok {
		return false, agenthost.ErrWorkspaceDisconnectUnavailable
	}
	return disconnector.DisconnectRuntimeSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
}

func (a serviceHostRuntime) SnapshotWorkspaceRuntimeDisconnectTargets(workspaceID string) []agenthost.RuntimeDisconnectTarget {
	targeter, ok := a.service.controller().(interface {
		SnapshotWorkspaceRuntimeDisconnectTargets(string) []agenthost.RuntimeDisconnectTarget
	})
	if !ok {
		return nil
	}
	return targeter.SnapshotWorkspaceRuntimeDisconnectTargets(workspaceID)
}

func (a serviceHostRuntime) DisconnectRuntimeSessionTarget(
	ctx context.Context,
	target agenthost.RuntimeDisconnectTarget,
) (bool, error) {
	targeter, ok := a.service.controller().(interface {
		DisconnectRuntimeSessionTarget(context.Context, agenthost.RuntimeDisconnectTarget) (bool, error)
	})
	if !ok {
		return false, agenthost.ErrWorkspaceDisconnectUnavailable
	}
	return targeter.DisconnectRuntimeSessionTarget(ctx, target)
}

func (a serviceHostRuntime) RuntimeSessionLive(workspaceID, agentSessionID string) bool {
	if liveness, ok := a.service.controller().(interface {
		RuntimeSessionLive(string, string) bool
	}); ok {
		return liveness.RuntimeSessionLive(workspaceID, agentSessionID)
	}
	_, found := a.service.controller().Session(workspaceID, agentSessionID)
	return found
}

func (a serviceHostRuntime) Start(ctx context.Context, input RuntimeStartInput) (RuntimeStartResult, error) {
	result, err := a.service.controller().Start(ctx, input)
	result.Session.Provisional = input.Provisional
	if err != nil {
		a.service.invalidateProviderAvailability(input.Provider)
	}
	return result, normalizeRuntimeError(err)
}
func (a serviceHostRuntime) PublishSessionInitialization(
	ctx context.Context,
	input RuntimeSessionInitializationPublishInput,
) (ProviderRuntimeSession, error) {
	session, err := a.service.controller().PublishSessionInitialization(ctx, input)
	return session, normalizeRuntimeError(err)
}
func (a serviceHostRuntime) Resume(ctx context.Context, input RuntimeResumeInput) (ProviderRuntimeSession, error) {
	session, err := a.service.controller().Resume(ctx, input)
	return session, normalizeRuntimeError(err)
}
func (a serviceHostRuntime) Session(workspaceID, sessionID string) (ProviderRuntimeSession, bool) {
	return a.service.controller().Session(workspaceID, sessionID)
}
func (a serviceHostRuntime) CanResume(input RuntimeResumeInput) bool {
	return a.service.controller().CanResume(input)
}
func (a serviceHostRuntime) Exec(ctx context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	result, err := a.service.controller().Exec(ctx, input)
	return result, normalizeRuntimeError(err)
}
func (a serviceHostRuntime) DurablyReportSubmitProvenance(ctx context.Context, input RuntimeSubmitProvenanceInput) error {
	reporter, ok := a.service.controller().(interface {
		DurablyReportSubmitProvenance(context.Context, RuntimeSubmitProvenanceInput) error
	})
	if !ok && !input.Guidance && a.service.TuttiModeActivations != nil {
		return errors.New("agent runtime does not support durable submit provenance")
	}
	if ok {
		if err := reporter.DurablyReportSubmitProvenance(ctx, input); err != nil {
			return err
		}
	}
	if !input.Guidance && a.service.TuttiModeActivations != nil {
		_, err := a.service.TuttiModeActivations.AcceptTurnSnapshot(
			ctx, input.WorkspaceID, input.AgentSessionID, input.TurnID,
		)
		return err
	}
	return nil
}
func (a serviceHostRuntime) ValidatePromptContent(ctx context.Context, input RuntimeExecInput) error {
	return normalizeRuntimeError(a.service.controller().ValidatePromptContent(ctx, input))
}
func (a serviceHostRuntime) Cancel(ctx context.Context, input RuntimeCancelInput) (RuntimeCancelResult, error) {
	return a.service.controller().Cancel(ctx, input)
}
func (a serviceHostRuntime) SubmitInteractive(ctx context.Context, input RuntimeSubmitInteractiveInput) (RuntimeSubmitInteractiveResult, error) {
	return a.service.controller().SubmitInteractive(ctx, input)
}
func (a serviceHostRuntime) InteractiveDisposition(workspaceID, rootAgentSessionID, agentSessionID, turnID, requestID string) RuntimeInteractiveDisposition {
	return a.service.controller().InteractiveDisposition(workspaceID, rootAgentSessionID, agentSessionID, turnID, requestID)
}
func (a serviceHostRuntime) UpdateSettings(ctx context.Context, input RuntimeUpdateSettingsInput) error {
	return normalizeRuntimeError(a.service.controller().UpdateSettings(ctx, input))
}
func (a serviceHostRuntime) UpdateRetainedSettings(ctx context.Context, input RuntimeUpdateSettingsInput) error {
	return normalizeRuntimeError(a.service.controller().UpdateSettings(ctx, input))
}
func (a serviceHostRuntime) SetTitle(ctx context.Context, input RuntimeSetTitleInput) (ProviderRuntimeSession, error) {
	return a.service.controller().SetTitle(ctx, input)
}
func (a serviceHostRuntime) SetVisible(ctx context.Context, input RuntimeSetVisibleInput) (ProviderRuntimeSession, error) {
	return a.service.controller().SetVisible(ctx, input)
}
func (a serviceHostRuntime) Close(ctx context.Context, input RuntimeCloseInput) error {
	return normalizeRuntimeError(a.service.controller().Close(ctx, input))
}

type serviceHostGoalRuntime struct{ service *Service }

func (a serviceHostGoalRuntime) GoalControl(ctx context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	result, err := a.service.controller().GoalControl(ctx, input)
	return result, normalizeRuntimeError(err)
}

func (a serviceHostGoalRuntime) ReconcileGoal(ctx context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalReconcileResult, error) {
	reconciler, ok := a.service.controller().(RuntimeGoalReconciler)
	if !ok {
		return agenthost.RuntimeGoalReconcileResult{}, errors.New("agent runtime goal reconciliation is unavailable")
	}
	result, err := reconciler.ReconcileGoal(ctx, input)
	return result, normalizeRuntimeError(err)
}

func (a serviceHostGoalRuntime) GoalRecoveryPolicy(ctx context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalRecoveryPolicy, error) {
	resolver, ok := a.service.controller().(RuntimeGoalRecoveryPolicyResolver)
	if !ok {
		return agenthost.RuntimeGoalRecoveryPolicy{}, nil
	}
	return resolver.GoalRecoveryPolicy(ctx, input)
}

func (a serviceHostGoalRuntime) FenceGoalGeneration(ctx context.Context, input agenthost.RuntimeGoalGenerationFenceInput) error {
	fencer, ok := a.service.controller().(RuntimeGoalGenerationFencer)
	if !ok {
		return agenthost.ErrGoalGenerationFenceUnavailable
	}
	return normalizeRuntimeError(fencer.FenceGoalGeneration(ctx, input))
}

func hostSupportPortsForService(
	s *Service,
	_ committedSessionForkReader,
) HostSupportPorts {
	deletedSessions, _ := any(s.SessionReader).(agenthost.DeletedSessionStore)
	return HostSupportPorts{
		DeletedSessions:      deletedSessions,
		SessionPurge:         s.SessionPurgeStore,
		SessionDeletionGuard: s.SessionDeletionGuard,
		SessionForkContext:   serviceHostSessionForkContextPolicy{},
		SessionForkState: serviceHostSessionForkProviderStateBinder{
			runtimePreparer: s.RuntimePreparer,
		},
		RuntimePreparation: serviceHostPreparation{
			support: s, runtimePreparer: s.RuntimePreparer,
		},
		Attachments:    s.PromptAttachmentStore,
		SettingsPolicy: serviceHostSettingsPolicy{catalog: s.ModelCatalog},
		Clock:          testServiceHostClock{service: s},
		SessionLocker: serviceHostLocker{
			mu: &s.sessionSettingsMu, locks: &s.sessionSettingsLocks,
		},
		RuntimeStartGate:     serviceHostStartupGate{gate: s.claudeStartupLock},
		LifecycleObserver:    serviceHostLifecycleObserver{reporter: s.AnalyticsReporter},
		CommitObserver:       testServiceHostCommitObserver{service: s},
		RuntimeOperations:    s.RuntimeOperationStore,
		OperationEvents:      testServiceHostRuntimeOperationEventPublisher{service: s},
		OperationOwner:       s.RuntimeOperationOwner,
		StaleTurnSettler:     s.StaleTurnSettler,
		GoalStore:            s.GoalStateStore,
		GoalFences:           s.GoalGenerationFenceStore,
		GoalInbox:            s.GoalReconcileInboxStore,
		GoalOwner:            s.GoalOperationOwner,
		GoalClock:            testServiceHostClock{service: s, goal: true},
		GoalAttemptTimeout:   s.GoalOperationAttemptTimeout,
		GoalRecoveryBudget:   s.GoalOperationRecoveryBudget,
		GoalMaxAttempts:      s.GoalOperationMaxAttempts,
		GoalDispatchDeadline: s.GoalOperationDispatchDeadline,
	}
}

func newApplicationHost(s *Service) *agenthost.Host {
	store := serviceHostStore{service: s}
	support := hostSupportPortsForService(s, nil)
	return composeApplicationHost(
		support,
		store,
		store,
		store,
		nil,
		nil,
		serviceHostRuntime{service: s},
		serviceHostGoalRuntime{service: s},
	)
}

type testServiceHostClock struct {
	service *Service
	goal    bool
}

func (c testServiceHostClock) Now() time.Time {
	if c.service != nil {
		if c.goal && c.service.GoalOperationClock != nil {
			return c.service.GoalOperationClock().UTC()
		}
		if !c.goal && c.service.RuntimeOperationClock != nil {
			return c.service.RuntimeOperationClock().UTC()
		}
	}
	return time.Now().UTC()
}

type testServiceHostCommitObserver struct {
	service *Service
}

func (o testServiceHostCommitObserver) ObserveCommitted(ctx context.Context, delta agenthost.CommittedDelta) error {
	if o.service == nil || o.service.CommitObserver == nil {
		return nil
	}
	return o.service.CommitObserver.ObserveCommitted(ctx, delta)
}

type testServiceHostRuntimeOperationEventPublisher struct {
	service *Service
}

func (p testServiceHostRuntimeOperationEventPublisher) PublishRuntimeOperationEvent(
	ctx context.Context,
	event storesqlite.RuntimeOperationEvent,
) error {
	if p.service == nil || p.service.RuntimeOperationEventPublisher == nil {
		return nil
	}
	return p.service.RuntimeOperationEventPublisher.PublishRuntimeOperationEvent(ctx, event)
}

// SetApplicationHost is test-only compatibility for conformance fixtures that
// replace the exact Host under test. Production construction is immutable.
func (s *Service) SetApplicationHost(host *agenthost.Host) {
	if s == nil || host == nil {
		panic("agent service requires an application host")
	}
	s.applicationHostMu.Lock()
	defer s.applicationHostMu.Unlock()
	if s.applicationHostProvider != nil {
		if s.applicationHost == host {
			return
		}
		panic("agent service application host is already configured")
	}
	s.applicationHost = host
	s.applicationHostProvider = func() *agenthost.Host { return host }
}

func configureTestApplicationHost(s *Service) {
	var once sync.Once
	var host *agenthost.Host
	s.applicationHostMu.Lock()
	defer s.applicationHostMu.Unlock()
	if s.applicationHostProvider != nil {
		panic("test application host is already configured")
	}
	s.applicationHostProvider = func() *agenthost.Host {
		once.Do(func() {
			host = newApplicationHost(s)
		})
		return host
	}
}

func activitySessionFromPersisted(session PersistedSession) storesqlite.Session {
	return storesqlite.Session{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Kind: session.Kind,
		RootAgentSessionID: session.RootAgentSessionID, RootTurnID: session.RootTurnID,
		ParentAgentSessionID: session.ParentAgentSessionID, ParentTurnID: session.ParentTurnID,
		ParentToolCallID: session.ParentToolCallID, Origin: session.Origin, UserID: session.UserID,
		AgentTargetID: session.AgentTargetID, Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
		Cwd:             session.Cwd,
		RailSectionKind: session.RailSectionKind, RailProjectPath: session.RailProjectPath,
		RailSectionKey: session.RailSectionKey, Settings: ComposerSettingsToMap(session.Settings),
		Metadata: session.Metadata, InternalRuntimeContext: clonePayload(session.InternalRuntimeContext), Title: session.Title,
		MessageVersion: session.MessageVersion, PinnedAtUnixMS: session.PinnedAtUnixMS, LastEventUnixMS: session.LastEventUnixMS,
		StartedAtUnixMS: session.StartedAtUnixMS, EndedAtUnixMS: session.EndedAtUnixMS,
		CreatedAtUnixMS: session.CreatedAtUnixMS, UpdatedAtUnixMS: session.UpdatedAtUnixMS, ActiveTurnID: session.ActiveTurnID,
	}
}
