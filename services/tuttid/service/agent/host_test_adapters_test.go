package agent

import (
	"context"
	"errors"
	"sync"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// serviceHostStore is deliberately test-only. Production wiring consumes
// agenthost.SQLiteWorkspaceStore; package tests retain this adapter for their
// narrow in-memory service fakes.
type serviceHostStore struct{ service *Service }

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

func (a serviceHostStore) InitializeRuntimeSession(ctx context.Context, session ProviderRuntimeSession) (storesqlite.Session, error) {
	persisted, err := a.service.initializeRuntimeSession(ctx, session)
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

func (a serviceHostStore) FindTurnByClientSubmitID(ctx context.Context, workspaceID, sessionID, clientSubmitID string) (string, bool, error) {
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

func (a serviceHostStore) DeleteSubmitClaim(ctx context.Context, workspaceID, sessionID, clientSubmitID string) (bool, error) {
	if a.service.SubmitClaimStore == nil {
		return false, nil
	}
	return a.service.SubmitClaimStore.DeleteSubmitClaim(ctx, workspaceID, sessionID, clientSubmitID)
}

type serviceHostRuntime struct{ service *Service }

func (a serviceHostRuntime) Start(ctx context.Context, input RuntimeStartInput) (ProviderRuntimeSession, error) {
	session, err := a.service.controller().Start(ctx, input)
	session.Provisional = input.Provisional
	if err != nil {
		a.service.invalidateProviderAvailability(input.Provider)
	}
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

func newApplicationHost(s *Service, worktreeGC agenthost.WorktreeGarbageCollector) *agenthost.Host {
	store := serviceHostStore{service: s}
	return composeApplicationHost(s, worktreeGC, store, store, store, serviceHostRuntime{service: s}, serviceHostGoalRuntime{service: s})
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
			host = newApplicationHost(s, s)
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
		Cwd: session.Cwd, RailSectionKey: session.RailSectionKey, Settings: ComposerSettingsToMap(session.Settings),
		Metadata: session.Metadata, InternalRuntimeContext: clonePayload(session.InternalRuntimeContext), Title: session.Title,
		PinnedAtUnixMS: session.PinnedAtUnixMS, LastEventUnixMS: session.LastEventUnixMS,
		StartedAtUnixMS: session.StartedAtUnixMS, EndedAtUnixMS: session.EndedAtUnixMS,
		CreatedAtUnixMS: session.CreatedAtUnixMS, UpdatedAtUnixMS: session.UpdatedAtUnixMS, ActiveTurnID: session.ActiveTurnID,
	}
}
