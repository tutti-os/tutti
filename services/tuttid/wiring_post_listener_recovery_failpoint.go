//go:build tuttid_integration_test

package main

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"

	agenthostadapter "github.com/tutti-os/tutti/packages/agent/daemon/hostadapter"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

const (
	postListenerRecoveryFailureEnv       = "TUTTID_TEST_POST_LISTENER_RECOVERY_FAILURE"
	postListenerRecoveryFailureMarkerEnv = "TUTTID_TEST_POST_LISTENER_RECOVERY_FAILURE_MARKER"
	postListenerRecoveryTestChildEnv     = "TUTTID_INTEGRATION_TEST_CHILD"
	startupProviderCallMarkerEnv         = "TUTTID_TEST_STARTUP_PROVIDER_CALL_MARKER"
)

func applyPostListenerRecoveryFailureInjection(config *agentservice.ServiceConfig) {
	if config == nil {
		return
	}
	failure := newPostListenerRecoveryFailure(os.Getenv(postListenerRecoveryFailureEnv), os.Getenv(postListenerRecoveryFailureMarkerEnv))
	if failure == nil {
		return
	}
	switch failure.kind {
	case "item", "store":
		config.Runtime.RuntimeOperationStore = failingPostListenerRuntimeOperations{RuntimeOperationStore: config.Runtime.RuntimeOperationStore, failure: failure}
	case "outbox":
		config.Observers.RuntimeOperationEventPublisher = failingPostListenerEventPublisher{RuntimeOperationEventPublisher: config.Observers.RuntimeOperationEventPublisher, failure: failure}
	}
}

func runtimeOperationHealthStoreForDaemon(store agenthost.RuntimeOperationHealthStore) agenthost.RuntimeOperationHealthStore {
	failure := newPostListenerRecoveryFailure(os.Getenv(postListenerRecoveryFailureEnv), os.Getenv(postListenerRecoveryFailureMarkerEnv))
	if failure == nil || failure.kind != "health" {
		return store
	}
	return failingRuntimeOperationHealthStore{RuntimeOperationHealthStore: store, failure: failure}
}

// The integration-only wrapper embeds the concrete production runtime and
// forwards its complete optional Host capability set. It is installed before
// Host composition, so the observer never becomes a public Host lifecycle seam.
func installStartupProviderCallTrap(runtime *agenthostadapter.RuntimeController) (agentservice.ApplicationHostRuntime, func()) {
	if runtime == nil || os.Getenv(postListenerRecoveryTestChildEnv) != "1" {
		return runtime, func() {}
	}
	marker := strings.TrimSpace(os.Getenv(startupProviderCallMarkerEnv))
	if marker == "" {
		return runtime, func() {}
	}
	trap := &startupProviderCallTrap{marker: marker}
	return startupProviderCallTrapRuntime{RuntimeController: runtime, trap: trap}, trap.markRecovered
}

type startupProviderCallTrap struct {
	mu     sync.Mutex
	marker string
	calls  int
}

func (t *startupProviderCallTrap) observe() { t.mu.Lock(); t.calls++; t.mu.Unlock() }
func (t *startupProviderCallTrap) markRecovered() {
	t.mu.Lock()
	calls, marker := t.calls, t.marker
	t.mu.Unlock()
	_ = os.WriteFile(marker, []byte(strconv.Itoa(calls)), 0o600)
}

type startupProviderCallTrapRuntime struct {
	*agenthostadapter.RuntimeController
	trap *startupProviderCallTrap
}

func (r startupProviderCallTrapRuntime) observe() {
	if r.trap != nil {
		r.trap.observe()
	}
}
func (r startupProviderCallTrapRuntime) SupportsEffectiveHistory(ctx context.Context, input agenthost.RuntimeHistoryInput) (bool, error) {
	r.observe()
	return r.RuntimeController.SupportsEffectiveHistory(ctx, input)
}
func (r startupProviderCallTrapRuntime) ReadEffectiveHistory(ctx context.Context, input agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	r.observe()
	return r.RuntimeController.ReadEffectiveHistory(ctx, input)
}
func (r startupProviderCallTrapRuntime) RollbackLatestTurn(ctx context.Context, input agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	r.observe()
	return r.RuntimeController.RollbackLatestTurn(ctx, input)
}
func (r startupProviderCallTrapRuntime) Start(ctx context.Context, input agenthost.RuntimeStartInput) (agenthost.ProviderRuntimeSession, error) {
	r.observe()
	return r.RuntimeController.Start(ctx, input)
}
func (r startupProviderCallTrapRuntime) Resume(ctx context.Context, input agenthost.RuntimeResumeInput) (agenthost.ProviderRuntimeSession, error) {
	r.observe()
	return r.RuntimeController.Resume(ctx, input)
}
func (r startupProviderCallTrapRuntime) Session(workspaceID, sessionID string) (agenthost.ProviderRuntimeSession, bool) {
	r.observe()
	return r.RuntimeController.Session(workspaceID, sessionID)
}
func (r startupProviderCallTrapRuntime) RuntimeSessionLive(workspaceID, sessionID string) bool {
	r.observe()
	return r.RuntimeController.RuntimeSessionLive(workspaceID, sessionID)
}
func (r startupProviderCallTrapRuntime) CanResume(input agenthost.RuntimeResumeInput) bool {
	r.observe()
	return r.RuntimeController.CanResume(input)
}
func (r startupProviderCallTrapRuntime) Exec(ctx context.Context, input agenthost.RuntimeExecInput) (agenthost.RuntimeExecResult, error) {
	r.observe()
	return r.RuntimeController.Exec(ctx, input)
}
func (r startupProviderCallTrapRuntime) DurablyReportSubmitProvenance(ctx context.Context, input agenthost.RuntimeSubmitProvenanceInput) error {
	r.observe()
	return r.RuntimeController.DurablyReportSubmitProvenance(ctx, input)
}
func (r startupProviderCallTrapRuntime) ReconcileProviderTurnAcceptance(ctx context.Context, input agenthost.RuntimeProviderTurnAcceptanceInput) error {
	r.observe()
	return r.RuntimeController.ReconcileProviderTurnAcceptance(ctx, input)
}
func (r startupProviderCallTrapRuntime) ValidatePromptContent(ctx context.Context, input agenthost.RuntimeExecInput) error {
	r.observe()
	return r.RuntimeController.ValidatePromptContent(ctx, input)
}
func (r startupProviderCallTrapRuntime) Cancel(ctx context.Context, input agenthost.RuntimeCancelInput) (agenthost.RuntimeCancelResult, error) {
	r.observe()
	return r.RuntimeController.Cancel(ctx, input)
}
func (r startupProviderCallTrapRuntime) SubmitInteractive(ctx context.Context, input agenthost.RuntimeSubmitInteractiveInput) (agenthost.RuntimeSubmitInteractiveResult, error) {
	r.observe()
	return r.RuntimeController.SubmitInteractive(ctx, input)
}
func (r startupProviderCallTrapRuntime) InteractiveDisposition(workspaceID, rootSessionID, sessionID, turnID, requestID string) agenthost.RuntimeInteractiveDisposition {
	r.observe()
	return r.RuntimeController.InteractiveDisposition(workspaceID, rootSessionID, sessionID, turnID, requestID)
}
func (r startupProviderCallTrapRuntime) UpdateSettings(ctx context.Context, input agenthost.RuntimeUpdateSettingsInput) error {
	r.observe()
	return r.RuntimeController.UpdateSettings(ctx, input)
}
func (r startupProviderCallTrapRuntime) SetTitle(ctx context.Context, input agenthost.RuntimeSetTitleInput) (agenthost.ProviderRuntimeSession, error) {
	r.observe()
	return r.RuntimeController.SetTitle(ctx, input)
}
func (r startupProviderCallTrapRuntime) SetVisible(ctx context.Context, input agenthost.RuntimeSetVisibleInput) (agenthost.ProviderRuntimeSession, error) {
	r.observe()
	return r.RuntimeController.SetVisible(ctx, input)
}
func (r startupProviderCallTrapRuntime) Close(ctx context.Context, input agenthost.RuntimeCloseInput) error {
	r.observe()
	return r.RuntimeController.Close(ctx, input)
}
func (r startupProviderCallTrapRuntime) ResolveSessionFork(ctx context.Context, source agenthost.ProviderRuntimeSession) (agenthost.SessionForkDriverDescriptor, error) {
	r.observe()
	return r.RuntimeController.ResolveSessionFork(ctx, source)
}
func (r startupProviderCallTrapRuntime) ForkSession(ctx context.Context, input agenthost.RuntimeSessionForkInput) (agenthost.RuntimeSessionForkResult, error) {
	r.observe()
	return r.RuntimeController.ForkSession(ctx, input)
}
func (r startupProviderCallTrapRuntime) CanForkProviderTurn(ctx context.Context, input agenthost.RuntimeProviderTurnForkabilityInput) (bool, error) {
	r.observe()
	return r.RuntimeController.CanForkProviderTurn(ctx, input)
}
func (r startupProviderCallTrapRuntime) RecoverProviderTurnBinding(ctx context.Context, input agenthost.RuntimeProviderTurnBindingRecoveryInput) (agenthost.RuntimeProviderTurnBindingRecoveryResult, error) {
	r.observe()
	return r.RuntimeController.RecoverProviderTurnBinding(ctx, input)
}
func (r startupProviderCallTrapRuntime) GoalControl(ctx context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	r.observe()
	return r.RuntimeController.GoalControl(ctx, input)
}
func (r startupProviderCallTrapRuntime) ReconcileGoal(ctx context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalReconcileResult, error) {
	r.observe()
	return r.RuntimeController.ReconcileGoal(ctx, input)
}
func (r startupProviderCallTrapRuntime) GoalRecoveryPolicy(ctx context.Context, input agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalRecoveryPolicy, error) {
	r.observe()
	return r.RuntimeController.GoalRecoveryPolicy(ctx, input)
}
func (r startupProviderCallTrapRuntime) FenceGoalGeneration(ctx context.Context, input agenthost.RuntimeGoalGenerationFenceInput) error {
	r.observe()
	return r.RuntimeController.FenceGoalGeneration(ctx, input)
}

type postListenerRecoveryFailure struct {
	kind, marker string
	once         sync.Once
}

func newPostListenerRecoveryFailure(kind, marker string) *postListenerRecoveryFailure {
	if os.Getenv(postListenerRecoveryTestChildEnv) != "1" {
		return nil
	}
	kind = strings.TrimSpace(kind)
	if kind != "item" && kind != "store" && kind != "outbox" && kind != "health" {
		return nil
	}
	return &postListenerRecoveryFailure{kind: kind, marker: strings.TrimSpace(marker)}
}
func (f *postListenerRecoveryFailure) fail() error {
	if f == nil {
		return nil
	}
	injected := false
	f.once.Do(func() {
		injected = true
		if f.marker != "" {
			_ = os.WriteFile(f.marker, []byte(f.kind), 0o600)
		}
	})
	if !injected {
		return nil
	}
	return errors.New("test-only post-listener " + f.kind + " failure")
}

type failingPostListenerRuntimeOperations struct {
	agentservice.RuntimeOperationStore
	failure *postListenerRecoveryFailure
}

func (s failingPostListenerRuntimeOperations) ListClaimableRuntimeOperations(ctx context.Context, input storesqlite.ListClaimableRuntimeOperationsInput) ([]storesqlite.RuntimeOperation, error) {
	if s.failure.kind == "store" {
		if err := s.failure.fail(); err != nil {
			return nil, err
		}
	}
	return s.RuntimeOperationStore.ListClaimableRuntimeOperations(ctx, input)
}
func (s failingPostListenerRuntimeOperations) ClaimRuntimeOperationLease(ctx context.Context, input storesqlite.ClaimRuntimeOperationLeaseInput) (storesqlite.RuntimeOperation, bool, error) {
	if s.failure.kind == "item" {
		if err := s.failure.fail(); err != nil {
			return storesqlite.RuntimeOperation{}, false, err
		}
	}
	return s.RuntimeOperationStore.ClaimRuntimeOperationLease(ctx, input)
}

type failingRuntimeOperationHealthStore struct {
	agenthost.RuntimeOperationHealthStore
	failure *postListenerRecoveryFailure
}

func (s failingRuntimeOperationHealthStore) ListActiveEditRetryDegradations(ctx context.Context, limit int) ([]storesqlite.ActiveEditRetryDegradation, int64, bool, error) {
	if err := s.failure.fail(); err != nil {
		return nil, 0, false, errors.New("SENSITIVE_HEALTH_QUERY_FAILURE")
	}
	return s.RuntimeOperationHealthStore.ListActiveEditRetryDegradations(ctx, limit)
}

type failingPostListenerEventPublisher struct {
	agenthost.RuntimeOperationEventPublisher
	failure *postListenerRecoveryFailure
}

func (p failingPostListenerEventPublisher) PublishRuntimeOperationEvent(ctx context.Context, event storesqlite.RuntimeOperationEvent) error {
	if err := p.failure.fail(); err != nil {
		return err
	}
	return p.RuntimeOperationEventPublisher.PublishRuntimeOperationEvent(ctx, event)
}
