package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

var (
	ErrInstallPlanChanged = errors.New("agent target install plan changed")
	ErrSetupServiceClosed = errors.New("agent target setup service is closed")
	// ErrTerminalAuthMethod rejects ACP authenticate requests for terminal-type
	// auth methods: their sign-in runs an interactive CLI flow that can only
	// complete in a user-visible terminal, never inside the background probe.
	ErrTerminalAuthMethod = errors.New("authentication method requires an interactive terminal")
	clientActionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

type SetupStatus string

const (
	SetupReady          SetupStatus = "ready"
	SetupAuthRequired   SetupStatus = "auth_required"
	SetupNotInstalled   SetupStatus = "not_installed"
	SetupInstalling     SetupStatus = "installing"
	SetupAuthenticating SetupStatus = "authenticating"
	SetupFailed         SetupStatus = "failed"
)

type SetupActionStatus = agentextensionbiz.SetupActionStatus
type SetupActionPhase = agentextensionbiz.SetupActionPhase
type SetupActionKind = agentextensionbiz.SetupActionKind

const (
	SetupActionQueued      = agentextensionbiz.SetupActionQueued
	SetupActionRunning     = agentextensionbiz.SetupActionRunning
	SetupActionSucceeded   = agentextensionbiz.SetupActionSucceeded
	SetupActionFailed      = agentextensionbiz.SetupActionFailed
	SetupActionInterrupted = agentextensionbiz.SetupActionInterrupted

	SetupPhasePreparing      = agentextensionbiz.SetupPhasePreparing
	SetupPhaseInstalling     = agentextensionbiz.SetupPhaseInstalling
	SetupPhaseVerifying      = agentextensionbiz.SetupPhaseVerifying
	SetupPhaseProbing        = agentextensionbiz.SetupPhaseProbing
	SetupPhaseActivating     = agentextensionbiz.SetupPhaseActivating
	SetupPhaseAuthenticating = agentextensionbiz.SetupPhaseAuthenticating
	SetupPhaseComplete       = agentextensionbiz.SetupPhaseComplete

	SetupActionInstall      = agentextensionbiz.SetupActionInstall
	SetupActionAuthenticate = agentextensionbiz.SetupActionAuthenticate
)

type SetupAction = agentextensionbiz.SetupAction

type SetupSnapshot struct {
	WorkspaceID    string
	AgentTargetID  string
	Status         SetupStatus
	RuntimeSource  string
	RuntimeVersion string
	Reason         string
	AuthMethods    []RuntimeAuthMethod
	Account        *RuntimeAuthenticatedAccount
	Plan           *InstallPlan
	Action         *SetupAction
}

type InstallInput struct {
	WorkspaceID    string
	AgentTargetID  string
	PlanDigest     string
	ClientActionID string
}

type AuthenticateInput struct {
	WorkspaceID    string
	AgentTargetID  string
	MethodID       string
	ClientActionID string
}

type RuntimeAuthInvalidation interface {
	AuthInvalidated(provider string) bool
	ClearAuthInvalidated(provider string)
}

type SetupService struct {
	Plans            InstallPlanService
	Transport        agentruntime.ProcessTransport
	Host             agentruntime.HostMetadata
	Actions          SetupActionStore
	Discovery        SetupDiscoveryDirectory
	Runner           InstallCommandRunner
	UVToolchain      UVToolchainResolver
	AuthInvalidation RuntimeAuthInvalidation

	mu           sync.Mutex
	active       map[string]struct{}
	workerCtx    context.Context
	workerCancel context.CancelFunc
	workers      sync.WaitGroup
	closed       bool

	errMu     sync.Mutex
	workerErr error
}

func NewSetupService(workerParent context.Context) *SetupService {
	workerCtx, workerCancel := context.WithCancel(workerParent)
	return &SetupService{workerCtx: workerCtx, workerCancel: workerCancel}
}

func (s *SetupService) GetSetup(ctx context.Context, input InstallPlanInput) (SetupSnapshot, error) {
	plan, err := s.Plans.GetInstallPlan(ctx, input)
	if err != nil {
		return SetupSnapshot{}, err
	}
	return s.snapshotForPlan(ctx, plan, input.WorkspaceID)
}

func (s *SetupService) Install(ctx context.Context, input InstallInput) (SetupSnapshot, error) {
	clientActionID := strings.TrimSpace(input.ClientActionID)
	if !clientActionIDPattern.MatchString(clientActionID) {
		return SetupSnapshot{}, fmt.Errorf("%w: invalid client action id", ErrInvalidInstallPlanRequest)
	}
	plan, err := s.Plans.GetInstallPlan(ctx, InstallPlanInput{
		WorkspaceID: input.WorkspaceID, AgentTargetID: input.AgentTargetID,
	})
	if err != nil {
		return SetupSnapshot{}, err
	}
	if strings.TrimSpace(input.PlanDigest) != plan.PlanDigest {
		return SetupSnapshot{}, ErrInstallPlanChanged
	}
	current, err := s.snapshotForPlan(ctx, plan, input.WorkspaceID)
	if err != nil {
		return SetupSnapshot{}, err
	}
	if current.Status == SetupReady || current.Status == SetupAuthRequired {
		return current, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireOpenLocked(); err != nil {
		return SetupSnapshot{}, err
	}
	existing, err := s.readAction(ctx, plan)
	if err != nil {
		return SetupSnapshot{}, err
	}
	if existing != nil {
		if existing.Kind == SetupActionInstall && existing.ClientActionID == clientActionID {
			current.Action = existing
			current.Status = setupStatusForAction(*existing)
			return current, nil
		}
		if existing.Status == SetupActionQueued || existing.Status == SetupActionRunning {
			return SetupSnapshot{}, fmt.Errorf("%w: another install action is running", ErrInvalidInstallPlanRequest)
		}
	}
	now := time.Now().UnixMilli()
	action := SetupAction{
		ActionID: installActionID(plan, clientActionID), ClientActionID: clientActionID,
		Kind:        SetupActionInstall,
		WorkspaceID: input.WorkspaceID, AgentTargetID: plan.AgentTargetID, ExtensionInstallationID: plan.ExtensionInstallationID,
		PlanDigest: plan.PlanDigest, Status: SetupActionQueued, Phase: SetupPhasePreparing,
		CreatedAtUnixMS: now, UpdatedAtUnixMS: now,
	}
	if err := s.writeAction(ctx, plan, action); err != nil {
		return SetupSnapshot{}, err
	}
	workerCtx, err := s.startWorkerLocked(action.ActionID)
	if err != nil {
		return SetupSnapshot{}, err
	}
	go s.runInstall(workerCtx, plan, action)
	current.Status = SetupInstalling
	current.Action = &action
	return current, nil
}

func (s *SetupService) Authenticate(ctx context.Context, input AuthenticateInput) (SetupSnapshot, error) {
	clientActionID := strings.TrimSpace(input.ClientActionID)
	methodID := strings.TrimSpace(input.MethodID)
	if !clientActionIDPattern.MatchString(clientActionID) || methodID == "" || len(methodID) > 128 {
		return SetupSnapshot{}, fmt.Errorf("%w: invalid authenticate request", ErrInvalidInstallPlanRequest)
	}
	plan, err := s.Plans.GetInstallPlan(ctx, InstallPlanInput{
		WorkspaceID: input.WorkspaceID, AgentTargetID: input.AgentTargetID,
	})
	if err != nil {
		return SetupSnapshot{}, err
	}
	current, err := s.snapshotForPlan(ctx, plan, input.WorkspaceID)
	if err != nil {
		return SetupSnapshot{}, err
	}
	if current.Status != SetupReady && current.Status != SetupAuthRequired {
		return SetupSnapshot{}, fmt.Errorf("%w: runtime is not awaiting authentication", ErrInvalidInstallPlanRequest)
	}
	if !containsRuntimeAuthMethod(current.AuthMethods, methodID) {
		return SetupSnapshot{}, fmt.Errorf("%w: authentication method is not advertised", ErrInvalidInstallPlanRequest)
	}
	if method := findRuntimeAuthMethod(current.AuthMethods, methodID); method != nil && method.Type == "terminal" {
		return SetupSnapshot{}, fmt.Errorf("%w: %s (run `%s` in a terminal, then re-detect)", ErrTerminalAuthMethod, methodID, method.TerminalCommand)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireOpenLocked(); err != nil {
		return SetupSnapshot{}, err
	}
	existing, err := s.readAction(ctx, plan)
	if err != nil {
		return SetupSnapshot{}, err
	}
	if existing != nil {
		if existing.Kind == SetupActionAuthenticate && existing.ClientActionID == clientActionID {
			current.Action = existing
			current.Status = setupStatusForAction(*existing)
			return current, nil
		}
		if existing.Status == SetupActionQueued || existing.Status == SetupActionRunning {
			return SetupSnapshot{}, fmt.Errorf("%w: another setup action is running", ErrInvalidInstallPlanRequest)
		}
	}
	now := time.Now().UnixMilli()
	action := SetupAction{
		ActionID: authenticateActionID(plan, clientActionID), ClientActionID: clientActionID,
		Kind: SetupActionAuthenticate, MethodID: methodID,
		WorkspaceID: input.WorkspaceID, AgentTargetID: plan.AgentTargetID, ExtensionInstallationID: plan.ExtensionInstallationID,
		Status: SetupActionQueued, Phase: SetupPhaseAuthenticating,
		CreatedAtUnixMS: now, UpdatedAtUnixMS: now,
	}
	if err := s.writeAction(ctx, plan, action); err != nil {
		return SetupSnapshot{}, err
	}
	workerCtx, err := s.startWorkerLocked(action.ActionID)
	if err != nil {
		return SetupSnapshot{}, err
	}
	go s.runAuthenticate(workerCtx, plan, action)
	current.Status = SetupAuthenticating
	current.Action = &action
	return current, nil
}

func (s *SetupService) snapshotForPlan(ctx context.Context, plan InstallPlan, workspaceID string) (SetupSnapshot, error) {
	snapshot := SetupSnapshot{
		WorkspaceID: workspaceID, AgentTargetID: plan.AgentTargetID,
		Status: SetupNotInstalled, Reason: "compatible_runtime_not_installed", Plan: &plan,
	}
	s.mu.Lock()
	action, readErr := s.readAction(ctx, plan)
	if readErr != nil {
		s.mu.Unlock()
		return SetupSnapshot{}, readErr
	}
	if action != nil {
		_, active := s.active[action.ActionID]
		if (action.Status == SetupActionQueued || action.Status == SetupActionRunning) && !active {
			action.Status = SetupActionInterrupted
			action.ErrorCode = "daemon_restarted"
			action.ErrorMessage = "setup action was interrupted before completion"
			action.UpdatedAtUnixMS = time.Now().UnixMilli()
			if err := s.writeAction(ctx, plan, *action); err != nil {
				s.mu.Unlock()
				return SetupSnapshot{}, err
			}
		}
	}
	s.mu.Unlock()
	snapshot.Action = action

	discoveryRoot, discoveryErr := s.ensureDiscoveryRoot(ctx)
	if discoveryErr != nil {
		return SetupSnapshot{}, discoveryErr
	}
	binding, err := s.Plans.Manager.ResolveRuntimeForCWD(ctx, plan.ExtensionInstallationID, discoveryRoot)
	if err == nil {
		snapshot.RuntimeSource = binding.Source
		snapshot.RuntimeVersion = binding.Version
		snapshot.Plan = nil
		if action != nil && (action.Status == SetupActionQueued || action.Status == SetupActionRunning) {
			snapshot.Status = setupStatusForAction(*action)
			snapshot.Reason = ""
			return snapshot, nil
		}
		probe, probeErr := ProbeRuntime(ctx, binding, plan.AgentTargetID, discoveryRoot, s.Transport, s.Host)
		if probeErr != nil {
			snapshot.Status = SetupFailed
			snapshot.Reason = "acp_probe_failed"
			return snapshot, nil
		}
		snapshot.Status = SetupStatus(probe.Status)
		snapshot.AuthMethods = probe.AuthMethods
		if snapshot.Status == SetupReady && s.AuthInvalidation != nil &&
			s.AuthInvalidation.AuthInvalidated(binding.Installation.Provider) {
			snapshot.Status = SetupAuthRequired
			snapshot.Reason = "runtime_auth_invalidated"
			return snapshot, nil
		}
		if snapshot.Status == SetupReady && action != nil && action.Kind == SetupActionAuthenticate && action.Status == SetupActionSucceeded {
			snapshot.Account = action.Account
		}
		snapshot.Reason = ""
		return snapshot, nil
	}
	if errors.Is(err, ErrManagedRuntimeIntegrity) {
		snapshot.Reason = "runtime_integrity_failed"
	}
	if action == nil {
		return snapshot, nil
	}
	snapshot.Status = setupStatusForAction(*action)
	if snapshot.Status == SetupFailed {
		snapshot.Reason = action.ErrorCode
	}
	return snapshot, nil
}

func setupStatusForAction(action SetupAction) SetupStatus {
	switch action.Status {
	case SetupActionQueued, SetupActionRunning:
		if action.Kind == SetupActionAuthenticate {
			return SetupAuthenticating
		}
		return SetupInstalling
	case SetupActionFailed, SetupActionInterrupted:
		if action.Kind == SetupActionAuthenticate {
			return SetupAuthRequired
		}
		return SetupFailed
	default:
		return SetupNotInstalled
	}
}

func containsRuntimeAuthMethod(methods []RuntimeAuthMethod, methodID string) bool {
	return findRuntimeAuthMethod(methods, methodID) != nil
}

func findRuntimeAuthMethod(methods []RuntimeAuthMethod, methodID string) *RuntimeAuthMethod {
	for index := range methods {
		if methods[index].ID == methodID {
			return &methods[index]
		}
	}
	return nil
}

func (s *SetupService) runInstall(ctx context.Context, plan InstallPlan, action SetupAction) {
	defer s.workers.Done()
	update := func(phase SetupActionPhase) error {
		s.mu.Lock()
		defer s.mu.Unlock()
		action.Status = SetupActionRunning
		action.Phase = phase
		action.UpdatedAtUnixMS = time.Now().UnixMilli()
		return s.persistWorkerAction(ctx, plan, action)
	}
	discoveryRoot, err := s.ensureDiscoveryRoot(ctx)
	if err == nil {
		err = update(SetupPhasePreparing)
	}
	if err == nil {
		err = s.executeInstall(ctx, plan, discoveryRoot, update)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.active, action.ActionID)
	action.UpdatedAtUnixMS = time.Now().UnixMilli()
	action.Phase = SetupPhaseComplete
	if errors.Is(err, context.Canceled) {
		action.Status = SetupActionInterrupted
		action.ErrorCode = "daemon_shutdown"
		action.ErrorMessage = "setup action was interrupted during daemon shutdown"
	} else if err != nil {
		action.Status = SetupActionFailed
		action.ErrorCode = installErrorCode(err)
		action.ErrorMessage = err.Error()
	} else {
		action.Status = SetupActionSucceeded
		action.ErrorCode = ""
		action.ErrorMessage = ""
	}
	if err := s.persistWorkerAction(context.WithoutCancel(ctx), plan, action); err != nil {
		return
	}
}

func (s *SetupService) runAuthenticate(ctx context.Context, plan InstallPlan, action SetupAction) {
	defer s.workers.Done()
	s.mu.Lock()
	action.Status = SetupActionRunning
	action.Phase = SetupPhaseAuthenticating
	action.UpdatedAtUnixMS = time.Now().UnixMilli()
	writeErr := s.persistWorkerAction(ctx, plan, action)
	s.mu.Unlock()

	provider := ""
	var account *RuntimeAuthenticatedAccount
	err := writeErr
	var binding RuntimeBinding
	discoveryRoot := ""
	if err == nil {
		discoveryRoot, err = s.ensureDiscoveryRoot(ctx)
	}
	if err == nil {
		binding, err = s.Plans.Manager.ResolveRuntimeForCWD(ctx, plan.ExtensionInstallationID, discoveryRoot)
	}
	if err == nil {
		provider = binding.Installation.Provider
		var result RuntimeProbeResult
		result, err = AuthenticateRuntime(
			ctx, binding, plan.AgentTargetID, discoveryRoot, action.MethodID, s.Transport, s.Host,
		)
		if err == nil && result.Status != RuntimeProbeReady {
			err = errors.New("runtime remains authentication required")
		}
		if err == nil {
			account = result.Account
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.active, action.ActionID)
	action.UpdatedAtUnixMS = time.Now().UnixMilli()
	action.Phase = SetupPhaseComplete
	if errors.Is(err, context.Canceled) {
		action.Status = SetupActionInterrupted
		action.ErrorCode = "daemon_shutdown"
		action.ErrorMessage = "setup action was interrupted during daemon shutdown"
	} else if err != nil {
		action.Status = SetupActionFailed
		action.ErrorCode = "authentication_failed"
		action.ErrorMessage = err.Error()
	} else {
		if s.AuthInvalidation != nil {
			s.AuthInvalidation.ClearAuthInvalidated(provider)
		}
		action.Status = SetupActionSucceeded
		action.Account = account
		action.ErrorCode = ""
		action.ErrorMessage = ""
	}
	if err := s.persistWorkerAction(context.WithoutCancel(ctx), plan, action); err != nil {
		return
	}
}

func (s *SetupService) requireOpenLocked() error {
	if s.closed {
		return ErrSetupServiceClosed
	}
	if s.workerCtx == nil || s.workerCancel == nil {
		return errors.New("agent target setup worker lifecycle is not configured")
	}
	return nil
}

func (s *SetupService) startWorkerLocked(actionID string) (context.Context, error) {
	if err := s.requireOpenLocked(); err != nil {
		return nil, err
	}
	if s.active == nil {
		s.active = map[string]struct{}{}
	}
	s.active[actionID] = struct{}{}
	s.workers.Add(1)
	return s.workerCtx, nil
}

func (s *SetupService) persistWorkerAction(ctx context.Context, plan InstallPlan, action SetupAction) error {
	if err := s.writeAction(ctx, plan, action); err != nil {
		err = fmt.Errorf("persist agent target setup action %s: %w", action.ActionID, err)
		s.errMu.Lock()
		s.workerErr = errors.Join(s.workerErr, err)
		s.errMu.Unlock()
		return err
	}
	return nil
}

func (s *SetupService) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		if s.workerCancel != nil {
			s.workerCancel()
		}
	}
	s.mu.Unlock()
	s.workers.Wait()
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.workerErr
}

func (s *SetupService) readAction(ctx context.Context, plan InstallPlan) (*SetupAction, error) {
	if s.Actions == nil {
		return nil, errors.New("agent target setup action store is not configured")
	}
	return s.Actions.Read(ctx, setupActionScope(plan))
}

func (s *SetupService) writeAction(ctx context.Context, plan InstallPlan, action SetupAction) error {
	if s.Actions == nil {
		return errors.New("agent target setup action store is not configured")
	}
	return s.Actions.Put(ctx, setupActionScope(plan), action)
}

func installActionID(plan InstallPlan, clientActionID string) string {
	digest := sha256.Sum256([]byte(plan.PlanDigest + "\x00" + clientActionID))
	return "agent-target-install-" + hex.EncodeToString(digest[:12])
}

func authenticateActionID(plan InstallPlan, clientActionID string) string {
	digest := sha256.Sum256([]byte(plan.PlanDigest + "\x00authenticate\x00" + clientActionID))
	return "agent-target-authenticate-" + hex.EncodeToString(digest[:12])
}

func (s *SetupService) ensureDiscoveryRoot(ctx context.Context) (string, error) {
	if s.Discovery == nil {
		return "", errors.New("agent extension setup discovery directory is not configured")
	}
	return s.Discovery.Ensure(ctx)
}
