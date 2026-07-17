package agent

import (
	"context"
	"errors"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type serviceHostStore struct{ service *Service }

func (a serviceHostStore) GetSession(_ context.Context, workspaceID, sessionID string) (storesqlite.Session, bool, error) {
	if a.service == nil || a.service.SessionReader == nil {
		return storesqlite.Session{}, false, nil
	}
	session, ok := a.service.SessionReader.GetSession(workspaceID, sessionID)
	if !ok {
		return storesqlite.Session{}, false, nil
	}
	return activitySessionFromPersisted(session), true, nil
}

func (a serviceHostStore) SessionDeleted(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	if a.service == nil || a.service.SessionReader == nil {
		return false, nil
	}
	return a.service.SessionReader.SessionDeleted(ctx, workspaceID, sessionID)
}

func (a serviceHostStore) RollbackRuntimeSessionInitialization(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	if a.service == nil {
		return false, nil
	}
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
	if err != nil {
		return storesqlite.Session{}, err
	}
	return activitySessionFromPersisted(persisted), nil
}

func (a serviceHostStore) UpdateSessionTitle(ctx context.Context, workspaceID, sessionID, title string) (storesqlite.Session, bool, error) {
	updater, ok := a.service.SessionReader.(SessionTitleUpdater)
	if !ok {
		return storesqlite.Session{}, false, nil
	}
	persisted, updated, err := updater.UpdateSessionTitle(ctx, workspaceID, sessionID, title)
	return activitySessionFromPersisted(persisted), updated, err
}

func (a serviceHostStore) GetTurn(ctx context.Context, workspaceID, sessionID, turnID string) (storesqlite.Turn, bool, error) {
	if a.service.TurnStore == nil {
		return storesqlite.Turn{}, false, nil
	}
	return a.service.TurnStore.GetTurn(ctx, workspaceID, sessionID, turnID)
}

func (a serviceHostStore) FindTurnByClientSubmitID(ctx context.Context, workspaceID, sessionID, clientSubmitID string) (string, bool, error) {
	store, ok := a.service.TurnStore.(interface {
		FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
	})
	if !ok {
		return "", false, nil
	}
	return store.FindTurnByClientSubmitID(ctx, workspaceID, sessionID, clientSubmitID)
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

type serviceHostPreparation struct {
	service  *Service
	prepared *preparedRuntime
}

func (a serviceHostPreparation) Prepare(ctx context.Context, input agenthost.RuntimePreparationInput) (agenthost.PreparedRuntime, error) {
	if a.prepared != nil {
		return agenthost.PreparedRuntime{Cwd: a.prepared.Cwd, Env: append([]string(nil), a.prepared.Env...)}, nil
	}
	settings := input.Settings
	persisted := PersistedSession{
		ID: input.AgentSessionID, WorkspaceID: input.WorkspaceID, Origin: input.SessionOrigin,
		AgentTargetID: input.AgentTargetID, Provider: input.Provider, ProviderSessionID: input.ProviderSessionID,
		Cwd: input.Cwd, Title: input.Title, Settings: settings,
		InternalRuntimeContext: clonePayload(input.RuntimeContext), CreatedAtUnixMS: input.CreatedAtUnixMS,
		UpdatedAtUnixMS: input.UpdatedAtUnixMS, Metadata: input.SessionMetadata,
	}
	persisted = a.service.clampPersistedSessionReasoningEffortForResume(ctx, persisted)
	createInput := createSessionInputFromPersisted(persisted)
	prepared, err := a.service.prepareRuntime(ctx, input.WorkspaceID, input.Cwd, createInput)
	if err != nil {
		return agenthost.PreparedRuntime{}, err
	}
	var targetRef map[string]any
	if strings.TrimSpace(input.AgentTargetID) != "" {
		launch, err := a.service.resolveCreateSessionLaunch(ctx, CreateSessionInput{AgentTargetID: input.AgentTargetID, Provider: input.Provider})
		if err != nil {
			return agenthost.PreparedRuntime{}, err
		}
		targetRef = launch.ProviderTargetRef
	}
	settings = persisted.Settings
	return agenthost.PreparedRuntime{
		Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...),
		ProviderTargetRef: clonePayload(targetRef), Settings: &settings,
		RuntimeContext: persistedSessionRuntimeContext(persisted),
	}, nil
}

func (a serviceHostPreparation) Cleanup(ctx context.Context, input agenthost.RuntimeCleanupInput) error {
	return a.service.cleanupRuntime(ctx, input.WorkspaceID, input.AgentSessionID)
}

type serviceHostLocker struct{ service *Service }

func (a serviceHostLocker) Acquire(ctx context.Context, ref agenthost.SessionRef) (func(), error) {
	return a.service.acquireSessionSettingsLock(ctx, ref.WorkspaceID, ref.AgentSessionID)
}

type serviceHostStartupGate struct{ service *Service }

func (a serviceHostStartupGate) Acquire(ctx context.Context, provider string) (func(), error) {
	return a.service.awaitClaudeStartupSlot(ctx, provider)
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
func (a serviceHostRuntime) UpdateSettings(ctx context.Context, input RuntimeUpdateSettingsInput) error {
	return a.service.controller().UpdateSettings(ctx, input)
}
func (a serviceHostRuntime) SetTitle(ctx context.Context, input RuntimeSetTitleInput) (ProviderRuntimeSession, error) {
	return a.service.controller().SetTitle(ctx, input)
}
func (a serviceHostRuntime) SetVisible(ctx context.Context, input RuntimeSetVisibleInput) (ProviderRuntimeSession, error) {
	return a.service.controller().SetVisible(ctx, input)
}
func (a serviceHostRuntime) Close(ctx context.Context, input RuntimeCloseInput) error {
	return a.service.controller().Close(ctx, input)
}

type serviceHostClock struct{}

func (serviceHostClock) Now() time.Time { return time.Now() }

type serviceHostLifecycleObserver struct{ service *Service }

func (o serviceHostLifecycleObserver) ObserveLifecycleStep(ctx context.Context, step agenthost.LifecycleStep) {
	if step.Err != nil {
		o.service.reportAgentServiceNodeFailure(ctx, step.AgentSessionID, step.Flow, step.Name, step.Provider, step.StartedAt, step.Err)
		return
	}
	o.service.reportAgentServiceNodeSuccess(ctx, step.AgentSessionID, step.Flow, step.Name, step.Provider, step.StartedAt)
}

func (s *Service) applicationHost(preparation serviceHostPreparation) *agenthost.Host {
	return s.newApplicationHost(preparation, serviceHostLocker{service: s})
}

func (s *Service) applicationHostLocked(preparation serviceHostPreparation) *agenthost.Host {
	return s.newApplicationHost(preparation, nil)
}

func (s *Service) newApplicationHost(preparation serviceHostPreparation, locker agenthost.SessionLocker) *agenthost.Host {
	return agenthost.New(agenthost.Config{
		CanonicalStore: serviceHostStore{service: s}, Runtime: serviceHostRuntime{service: s},
		RuntimePreparation: preparation, Attachments: s.PromptAttachmentStore,
		Clock: serviceHostClock{}, SessionLocker: locker,
		RuntimeStartGate:  serviceHostStartupGate{service: s},
		LifecycleObserver: serviceHostLifecycleObserver{service: s},
	})
}

func (s *Service) cleanupHostCreateFailure(ctx context.Context, workspaceID, sessionID string, cause error) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	closeErr := s.controller().Close(cleanupCtx, RuntimeCloseInput{WorkspaceID: workspaceID, AgentSessionID: sessionID})
	return errors.Join(cause, closeErr, s.cleanupRuntime(cleanupCtx, workspaceID, sessionID))
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

func persistedSessionFromHost(session storesqlite.Session) PersistedSession {
	return persistedSessionFromActivity(session)
}
