package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type serviceHostPreparation struct {
	service *Service
}

type serviceHostSettingsPolicy struct{ service *Service }

type serviceHostSessionForkContextPolicy struct{ service *Service }

func (p serviceHostSessionForkContextPolicy) PrepareSessionForkTargetContext(
	_ context.Context,
	source storesqlite.Session,
	prepared agenthost.ProviderRuntimeSession,
) (agenthost.SessionForkTargetContext, error) {
	runtimeContext := clonePayload(source.InternalRuntimeContext)
	if _, hasIsolationOwnership := runtimeContext[worktreeIsolationContextKey]; hasIsolationOwnership {
		// A provider-native thread fork continues in the provider's existing
		// cwd. Reusing Tutti's source-owned worktree lease for a second
		// canonical session would make cleanup and ownership ambiguous, while
		// silently changing cwd would diverge from the provider thread.
		return agenthost.SessionForkTargetContext{}, agenthost.ErrSessionForkUnsupported
	}
	if p.service == nil || p.service.RuntimePreparer == nil {
		return agenthost.SessionForkTargetContext{}, agenthost.ErrSessionForkUnsupported
	}
	return agenthost.SessionForkTargetContext{
		Cwd:            strings.TrimSpace(prepared.Cwd),
		RuntimeContext: clonePayload(prepared.RuntimeContext),
	}, nil
}

type serviceHostSessionForkProviderStateBinder struct{ service *Service }

func (b serviceHostSessionForkProviderStateBinder) SupportsSessionForkProviderStateBinding(
	provider string,
) bool {
	if b.service == nil || b.service.RuntimePreparer == nil {
		return false
	}
	binder, ok := b.service.RuntimePreparer.(runtimeprep.SessionForkProviderStateBinder)
	return ok && binder.SupportsSessionForkProviderStateBinding(provider)
}

func (b serviceHostSessionForkProviderStateBinder) BindSessionForkProviderState(
	ctx context.Context,
	input agenthost.SessionForkProviderStateBinding,
) error {
	if b.service == nil || b.service.RuntimePreparer == nil {
		return errors.New("session fork provider state binder is unavailable")
	}
	binder, ok := b.service.RuntimePreparer.(runtimeprep.SessionForkProviderStateBinder)
	if !ok || !binder.SupportsSessionForkProviderStateBinding(input.Provider) {
		return fmt.Errorf(
			"runtime preparer cannot bind %s session fork provider state",
			strings.TrimSpace(input.Provider),
		)
	}
	return binder.BindSessionForkProviderState(
		ctx,
		runtimeprep.SessionForkProviderStateBindingInput{
			WorkspaceID:             input.WorkspaceID,
			Provider:                input.Provider,
			SourceAgentSessionID:    input.SourceAgentSessionID,
			TargetAgentSessionID:    input.TargetAgentSessionID,
			SourceProviderSessionID: input.SourceProviderSessionID,
			TargetProviderSessionID: input.TargetProviderSessionID,
		},
	)
}

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
	prepared, err := a.service.prepareRuntimeForResume(ctx, persisted)
	if err != nil {
		return agenthost.PreparedRuntime{}, err
	}
	if err := a.bindCommittedSessionForkProviderState(ctx, input); err != nil {
		return agenthost.PreparedRuntime{}, err
	}
	var targetRef map[string]any
	if strings.TrimSpace(input.AgentTargetID) != "" {
		resolvedRef, err := a.service.resolveProviderTargetRefForResume(ctx, persisted)
		if err != nil {
			return agenthost.PreparedRuntime{}, err
		}
		targetRef = resolvedRef
	}
	settings = persisted.Settings
	return agenthost.PreparedRuntime{
		Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...),
		ProviderTargetRef: clonePayload(targetRef), Settings: &settings,
		RuntimeContext: persistedSessionRuntimeContext(persisted),
	}, nil
}

func (a serviceHostPreparation) bindCommittedSessionForkProviderState(
	ctx context.Context,
	input agenthost.RuntimePreparationInput,
) error {
	if a.service == nil ||
		a.service.RuntimePreparer == nil {
		return nil
	}
	binder, ok := a.service.RuntimePreparer.(runtimeprep.SessionForkProviderStateBinder)
	if !ok || !binder.SupportsSessionForkProviderStateBinding(input.Provider) {
		return nil
	}
	host := a.service.ApplicationHost()
	lineage, found, err := host.GetSessionForkLineage(
		ctx,
		input.WorkspaceID,
		input.AgentSessionID,
	)
	if err != nil || !found {
		return err
	}
	result, operationFound, err := host.GetSessionForkOperation(
		ctx,
		input.WorkspaceID,
		lineage.OperationID,
	)
	if err != nil {
		return err
	}
	if !operationFound ||
		result.Operation.Status != storesqlite.SessionForkStatusCommitted ||
		result.Operation.TargetAgentSessionID != input.AgentSessionID ||
		result.Operation.TargetProviderSessionID != input.ProviderSessionID {
		return errors.New("committed Codex session fork identity could not be verified")
	}
	return binder.BindSessionForkProviderState(
		ctx,
		runtimeprep.SessionForkProviderStateBindingInput{
			WorkspaceID:             input.WorkspaceID,
			Provider:                input.Provider,
			SourceAgentSessionID:    result.Operation.SourceAgentSessionID,
			TargetAgentSessionID:    result.Operation.TargetAgentSessionID,
			SourceProviderSessionID: result.Operation.SourceProviderSessionID,
			TargetProviderSessionID: result.Operation.TargetProviderSessionID,
		},
	)
}

func (a serviceHostPreparation) Cleanup(ctx context.Context, input agenthost.RuntimeCleanupInput) error {
	var activationErr error
	if input.OrphanActivationCleanup {
		activationErr = a.service.deleteTuttiModeActivationSessionState(ctx, input.WorkspaceID, input.AgentSessionID)
	}
	return errors.Join(a.service.cleanupSessionResources(ctx, input.WorkspaceID, input.AgentSessionID), activationErr)
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

type ApplicationHostRuntime interface {
	agenthost.RuntimeController
	agenthost.RuntimeHistoryController
	agenthost.GoalRuntimeController
}

// ApplicationHostCanonicalPorts groups the shared canonical store roles that
// must advance together in production.
type ApplicationHostCanonicalPorts interface {
	agenthost.CanonicalStore
	agenthost.SessionManagementStore
	agenthost.SessionBatchManagementStore
	agenthost.TurnSubmissionStore
	agenthost.EffectiveHistoryStore
}

func NewApplicationHostWithPorts(
	s *Service,
	canonical ApplicationHostCanonicalPorts,
	sessionForkRecovery agenthost.SessionForkRecoveryStore,
	runtime ApplicationHostRuntime,
) *agenthost.Host {
	if s == nil || canonical == nil || runtime == nil {
		return nil
	}
	return composeApplicationHost(
		s,
		s,
		canonical,
		canonical,
		canonical,
		sessionForkRecovery,
		runtime,
		runtime,
	)
}

func composeApplicationHost(
	s *Service,
	worktreeGC agenthost.WorktreeGarbageCollector,
	canonical agenthost.CanonicalStore,
	sessionManagement agenthost.SessionManagementStore,
	sessionBatchManagement agenthost.SessionBatchManagementStore,
	sessionForkRecovery agenthost.SessionForkRecoveryStore,
	runtime agenthost.RuntimeController,
	goalRuntime agenthost.GoalRuntimeController,
) *agenthost.Host {
	sessionForks, _ := canonical.(agenthost.SessionForkStore)
	if sessionForkRecovery == nil {
		sessionForkRecovery, _ = canonical.(agenthost.SessionForkRecoveryStore)
	}
	sessionForkRuntime, _ := runtime.(agenthost.SessionForkRuntime)
	turnSubmissions, _ := canonical.(agenthost.TurnSubmissionStore)
	effectiveHistory, _ := canonical.(agenthost.EffectiveHistoryStore)
	historyRuntime, _ := runtime.(agenthost.RuntimeHistoryController)
	return agenthost.New(agenthost.Config{
		CanonicalStore: canonical, SessionManagement: sessionManagement,
		SessionBatchManagement: sessionBatchManagement, SessionPurge: s.SessionPurgeStore,
		SessionForks: sessionForks, SessionForkRecovery: sessionForkRecovery,
		SessionForkRuntime:   sessionForkRuntime,
		SessionForkContext:   serviceHostSessionForkContextPolicy{service: s},
		SessionForkState:     serviceHostSessionForkProviderStateBinder{service: s},
		SessionDeletionGuard: s.SessionDeletionGuard,
		TurnSubmissions:      turnSubmissions, EffectiveHistory: effectiveHistory,
		Runtime: runtime, HistoryRuntime: historyRuntime,
		RuntimePreparation: serviceHostPreparation{service: s}, Attachments: s.PromptAttachmentStore,
		SettingsPolicy: serviceHostSettingsPolicy{service: s},
		Clock:          serviceHostClock{service: s}, SessionLocker: serviceHostLocker{service: s},
		RuntimeStartGate:  serviceHostStartupGate{service: s},
		LifecycleObserver: serviceHostLifecycleObserver{service: s},
		CommitObserver:    serviceHostCommitObserver{service: s},
		RuntimeOperations: s.RuntimeOperationStore, OperationEvents: serviceHostRuntimeOperationEventPublisher{service: s},
		OperationOwner: s.RuntimeOperationOwner, StaleTurnSettler: s.StaleTurnSettler,
		WorktreeGC: worktreeGC,
		GoalStore:  s.GoalStateStore, GoalFences: s.GoalGenerationFenceStore,
		GoalRuntime: goalRuntime, GoalInbox: s.GoalReconcileInboxStore,
		GoalOwner: s.GoalOperationOwner, GoalClock: serviceHostGoalClock{service: s},
		GoalAttemptTimeout: s.GoalOperationAttemptTimeout, GoalRecoveryBudget: s.GoalOperationRecoveryBudget,
		GoalMaxAttempts: s.GoalOperationMaxAttempts, GoalDispatchDeadline: s.GoalOperationDispatchDeadline,
		GoalActor: agenthost.NewSessionActor(),
	})
}

// SetApplicationHost installs the single production Host composed by wiring.
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

// ApplicationHost returns the Host installed by the process composition root.
// Missing wiring is a startup invariant violation; this adapter never creates
// a second lifecycle stack from service-local store/runtime copies.
func (s *Service) ApplicationHost() *agenthost.Host {
	if s == nil {
		return nil
	}
	s.applicationHostMu.Lock()
	provider := s.applicationHostProvider
	s.applicationHostMu.Unlock()
	if provider == nil {
		panic("agent service application host is not configured")
	}
	host := provider()
	if host == nil {
		panic("agent service application host provider returned nil")
	}
	return host
}

func persistedSessionFromHost(session storesqlite.Session) PersistedSession {
	return persistedSessionFromActivity(session)
}
