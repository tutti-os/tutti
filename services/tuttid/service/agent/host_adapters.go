package agent

import (
	"context"
	"errors"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type serviceHostStore struct{ service *Service }

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
	// Service configurations without the legacy SessionReader have always
	// allowed a live provider session to supply the session observation. A
	// TurnStore may still be present for turn lifecycle operations, so its
	// absence must not suppress that established fallback.
	if a.service.SessionReader == nil {
		if session, ok := a.service.controller().Session(workspaceID, sessionID); ok {
			activeTurnID := ""
			if session.TurnLifecycle != nil && session.TurnLifecycle.ActiveTurnID != nil {
				activeTurnID = strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID)
			}
			return storesqlite.Session{
				ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider,
				ProviderSessionID: session.ProviderSessionID, Cwd: session.Cwd, Title: session.Title,
				Kind: storesqlite.SessionKindRoot, ActiveTurnID: activeTurnID,
			}, true, nil
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

func (a serviceHostStore) DeleteSession(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	deleter, ok := a.service.SessionReader.(SessionDeleter)
	if !ok {
		return false, nil
	}
	return deleter.DeleteSession(ctx, workspaceID, sessionID)
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
	service *Service
}

type serviceHostSettingsPolicy struct{ service *Service }

func (p serviceHostSettingsPolicy) NormalizePersistedSettings(
	ctx context.Context,
	session storesqlite.Session,
	settings agenthost.ComposerSettings,
	patch agenthost.ComposerSettingsPatch,
) agenthost.ComposerSettings {
	settings = normalizeObservedComposerSettingsForProvider(session.Provider, settings)
	if patch.Model != nil || patch.ReasoningEffort != nil {
		settings.ReasoningEffort = p.service.clampReasoningEffortForModel(
			ctx,
			session.Provider,
			settings.Model,
			settings.ReasoningEffort,
		)
	}
	return settings
}

func (p serviceHostSettingsPolicy) NormalizeRuntimeSettingsPatch(
	ctx context.Context,
	session agenthost.ProviderRuntimeSession,
	settings agenthost.ComposerSettingsPatch,
) agenthost.ComposerSettingsPatch {
	provider := strings.TrimSpace(session.Provider)
	selectedModel := ""
	selectedReasoningEffort := ""
	if session.Settings != nil {
		selectedModel = session.Settings.Model
		selectedReasoningEffort = session.Settings.ReasoningEffort
	}
	if settings.Model != nil {
		selectedModel = strings.TrimSpace(*settings.Model)
	}
	if settings.ReasoningEffort != nil {
		selectedReasoningEffort = *settings.ReasoningEffort
	}
	// A live Codex-derived runtime owns the freshest per-model reasoning
	// catalog. Other providers keep tuttid's established catalog policy.
	if (settings.Model != nil || settings.ReasoningEffort != nil) &&
		!composerProviderUsesModelReasoningCatalog(provider) {
		clamped := strings.TrimSpace(selectedReasoningEffort)
		if agentprovider.Normalize(provider) != "" {
			clamped = p.service.clampReasoningEffortForModel(ctx, provider, selectedModel, selectedReasoningEffort)
		}
		if settings.ReasoningEffort != nil || clamped != selectedReasoningEffort {
			settings.ReasoningEffort = &clamped
		}
	}
	if settings.Speed != nil {
		normalized := strings.TrimSpace(*settings.Speed)
		if agentprovider.Normalize(provider) != "" {
			normalized = normalizeSpeedForProvider(provider, normalized)
		}
		settings.Speed = &normalized
	}
	return settings
}

type servicePreparedRuntimeContext struct {
	service  *Service
	prepared preparedRuntime
}

type servicePreparedRuntimeContextKey struct{}

func withServicePreparedRuntime(ctx context.Context, service *Service, prepared preparedRuntime) context.Context {
	return context.WithValue(ctx, servicePreparedRuntimeContextKey{}, servicePreparedRuntimeContext{service: service, prepared: prepared})
}

func (a serviceHostPreparation) Prepare(ctx context.Context, input agenthost.RuntimePreparationInput) (agenthost.PreparedRuntime, error) {
	if override, ok := ctx.Value(servicePreparedRuntimeContextKey{}).(servicePreparedRuntimeContext); ok && override.service == a.service {
		return agenthost.PreparedRuntime{Cwd: override.prepared.Cwd, Env: append([]string(nil), override.prepared.Env...)}, nil
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

type serviceHeldSessionLock struct {
	service *Service
	ref     agenthost.SessionRef
}

type serviceHeldSessionLockContextKey struct{}

func withServiceHeldSessionLock(ctx context.Context, service *Service, ref agenthost.SessionRef) context.Context {
	return context.WithValue(ctx, serviceHeldSessionLockContextKey{}, serviceHeldSessionLock{service: service, ref: ref})
}

func (a serviceHostLocker) Acquire(ctx context.Context, ref agenthost.SessionRef) (func(), error) {
	if held, ok := ctx.Value(serviceHeldSessionLockContextKey{}).(serviceHeldSessionLock); ok && held.service == a.service && held.ref == ref {
		return func() {}, nil
	}
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

type serviceHostClock struct{ service *Service }

func (c serviceHostClock) Now() time.Time {
	if c.service != nil && c.service.RuntimeOperationClock != nil {
		return c.service.RuntimeOperationClock().UTC()
	}
	return time.Now().UTC()
}

type serviceHostGoalClock struct{ service *Service }

func (c serviceHostGoalClock) Now() time.Time {
	if c.service != nil && c.service.GoalOperationClock != nil {
		return c.service.GoalOperationClock().UTC()
	}
	return time.Now().UTC()
}

type serviceHostLifecycleObserver struct{ service *Service }

func (o serviceHostLifecycleObserver) ObserveLifecycleStep(ctx context.Context, step agenthost.LifecycleStep) {
	if step.Err != nil {
		o.service.reportAgentServiceNodeFailure(ctx, step.AgentSessionID, step.Flow, step.Name, step.Provider, step.StartedAt, step.Err)
		return
	}
	o.service.reportAgentServiceNodeSuccess(ctx, step.AgentSessionID, step.Flow, step.Name, step.Provider, step.StartedAt)
}

type serviceHostCommitObserver struct{ service *Service }

func (o serviceHostCommitObserver) ObserveCommitted(ctx context.Context, delta agenthost.CommittedDelta) error {
	if o.service == nil || o.service.CommitObserver == nil {
		return nil
	}
	return o.service.CommitObserver.ObserveCommitted(ctx, delta)
}

type serviceHostRuntimeOperationEventPublisher struct{ service *Service }

func (p serviceHostRuntimeOperationEventPublisher) PublishRuntimeOperationEvent(ctx context.Context, event storesqlite.RuntimeOperationEvent) error {
	if p.service == nil || p.service.RuntimeOperationEventPublisher == nil {
		return nil
	}
	return p.service.RuntimeOperationEventPublisher.PublishRuntimeOperationEvent(ctx, event)
}

// NewApplicationHost composes the provider-neutral Host with tuttid-owned
// adapters. Production wiring constructs exactly one Host and installs it on
// Service; isolated package consumers may use ApplicationHost for lazy setup.
func NewApplicationHost(s *Service) *agenthost.Host {
	return newApplicationHost(s, s)
}

func newApplicationHost(s *Service, worktreeGC agenthost.WorktreeGarbageCollector) *agenthost.Host {
	if s == nil {
		return nil
	}
	return agenthost.New(agenthost.Config{
		CanonicalStore: serviceHostStore{service: s}, SessionManagement: serviceHostStore{service: s}, SessionPurge: s.SessionPurgeStore,
		Runtime:            serviceHostRuntime{service: s},
		RuntimePreparation: serviceHostPreparation{service: s}, Attachments: s.PromptAttachmentStore,
		SettingsPolicy: serviceHostSettingsPolicy{service: s},
		Clock:          serviceHostClock{service: s}, SessionLocker: serviceHostLocker{service: s},
		RuntimeStartGate:  serviceHostStartupGate{service: s},
		LifecycleObserver: serviceHostLifecycleObserver{service: s},
		CommitObserver:    serviceHostCommitObserver{service: s},
		RuntimeOperations: s.RuntimeOperationStore, OperationEvents: serviceHostRuntimeOperationEventPublisher{service: s},
		OperationOwner: s.RuntimeOperationOwner, StaleTurnSettler: s.StaleTurnSettler,
		WorktreeGC: worktreeGC,
		GoalStore:  s.GoalStateStore, GoalRuntime: serviceHostGoalRuntime{service: s}, GoalInbox: s.GoalReconcileInboxStore,
		GoalOwner: s.GoalOperationOwner, GoalClock: serviceHostGoalClock{service: s},
		GoalAttemptTimeout: s.GoalOperationAttemptTimeout, GoalRecoveryBudget: s.GoalOperationRecoveryBudget,
		GoalMaxAttempts: s.GoalOperationMaxAttempts, GoalDispatchDeadline: s.GoalOperationDispatchDeadline,
		GoalActor: agenthost.NewGoalActor(),
	})
}

// SetApplicationHost installs the single production Host composed by wiring.
func (s *Service) SetApplicationHost(host *agenthost.Host) {
	if s == nil || host == nil {
		panic("agent service requires an application host")
	}
	s.applicationHostMu.Lock()
	defer s.applicationHostMu.Unlock()
	if s.applicationHost != nil && s.applicationHost != host {
		panic("agent service application host is already configured")
	}
	s.applicationHost = host
}

// ApplicationHost returns the configured Host. Lazy construction keeps
// isolated service consumers and tests hermetic; production wiring always
// installs its explicitly composed singleton before recovery or API serving.
func (s *Service) ApplicationHost() *agenthost.Host {
	if s == nil {
		return nil
	}
	s.applicationHostMu.Lock()
	defer s.applicationHostMu.Unlock()
	if s.applicationHost == nil {
		s.applicationHost = NewApplicationHost(s)
	}
	return s.applicationHost
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
