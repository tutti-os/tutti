// Package hostadapter adapts the daemon runtime contract to Agent Host.
//
// Both sides of this boundary are owned by Tutti. Product services should
// provide only the concrete runtime backend and current-user identity instead
// of maintaining their own lifecycle and error mappings.
package hostadapter

import (
	"context"
	"errors"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// RuntimeBackend is the daemon controller surface required by Agent Host.
// *runtime.Controller implements this interface.
type RuntimeBackend interface {
	Start(context.Context, agentruntime.StartInput) (agentruntime.StartResult, error)
	PublishSessionInitialization(context.Context, string, string) (agentruntime.Session, error)
	Resume(context.Context, agentruntime.ResumeInput) (agentruntime.Session, error)
	Session(string, string) (agentruntime.Session, bool)
	State(string, string) (agentruntime.SessionStateSnapshot, error)
	CanResume(agentruntime.ResumeInput) bool
	Exec(context.Context, agentruntime.ExecInput) (agentruntime.ExecResult, error)
	DurablyReportSubmitProvenance(context.Context, agentruntime.SubmitProvenanceInput) error
	ValidatePromptContent(context.Context, agentruntime.ExecInput) error
	Cancel(context.Context, agentruntime.CancelInput) (agentruntime.CancelResult, error)
	SubmitInteractive(context.Context, agentruntime.SubmitInteractiveInput) (agentruntime.SubmitInteractiveResult, error)
	InteractiveDisposition(string, string, string, string, string) agentruntime.InteractiveDisposition
	UpdateSettings(context.Context, agentruntime.UpdateSettingsInput) (agentruntime.UpdateSettingsResult, error)
	SetTitle(context.Context, string, string, string) (agentruntime.Session, error)
	SetVisible(context.Context, string, string, bool) (agentruntime.Session, error)
	Close(context.Context, agentruntime.CloseInput) (agentruntime.CloseResult, error)
	GoalControl(context.Context, agentruntime.GoalControlInput) (agentruntime.GoalControlResult, error)
	ReconcileGoal(context.Context, agentruntime.GoalReconcileInput) (agentruntime.GoalReconcileResult, error)
	GoalCapabilities(context.Context, agentruntime.GoalReconcileInput) (agentruntime.GoalAdapterCapabilities, error)
}

type runtimeHistoryBackend interface {
	SupportsEffectiveHistory(context.Context, agentruntime.EffectiveHistoryInput) (bool, error)
	ReadEffectiveHistory(context.Context, agentruntime.EffectiveHistoryInput) (agentruntime.EffectiveHistorySnapshot, error)
	RollbackLatestTurn(context.Context, agentruntime.EffectiveHistoryInput) (agentruntime.HistoryMutationResult, error)
}

// RuntimeController implements Agent Host runtime ports with a daemon backend.
type RuntimeController struct {
	Backend       RuntimeBackend
	CurrentUserID func() string
}

var (
	_ host.RuntimeController                       = (*RuntimeController)(nil)
	_ host.RuntimeSessionInitializationPublisher   = (*RuntimeController)(nil)
	_ host.RuntimeSessionRepreparer                = (*RuntimeController)(nil)
	_ host.RuntimeHistoryController                = (*RuntimeController)(nil)
	_ host.RuntimeProviderTurnAcceptanceReconciler = (*RuntimeController)(nil)
	_ host.RuntimeSessionLiveness                  = (*RuntimeController)(nil)
	_ host.RuntimeSubmitProvenanceReporter         = (*RuntimeController)(nil)
	_ host.SessionForkRuntime                      = (*RuntimeController)(nil)
	_ host.SessionForkTurnBindingRecoveryRuntime   = (*RuntimeController)(nil)
	_ host.GoalRuntimeController                   = (*RuntimeController)(nil)
	_ host.GoalRuntimeControlLifecycleRegistrar    = (*RuntimeController)(nil)
	_ host.GoalRuntimeReconciler                   = (*RuntimeController)(nil)
	_ host.GoalRuntimeRecoveryPolicyResolver       = (*RuntimeController)(nil)
	_ host.GoalRuntimeGenerationFencer             = (*RuntimeController)(nil)
)

type runtimeSessionReprepareBackend interface {
	Reprepare(context.Context, agentruntime.ResumeInput) (agentruntime.Session, error)
}

type sessionForkRuntimeBackend interface {
	ForkCapabilities(context.Context, agentruntime.Session) (agentruntime.SessionForkCapabilities, error)
	CanForkProviderTurn(context.Context, agentruntime.ProviderTurnForkabilityInput) (bool, error)
	Fork(context.Context, agentruntime.SessionForkInput) (agentruntime.SessionForkResult, error)
}

type providerTurnBindingRecoveryBackend interface {
	RecoverProviderTurnBinding(
		context.Context,
		agentruntime.ProviderTurnBindingRecoveryInput,
	) (agentruntime.ProviderTurnBindingRecoveryResult, error)
}

func (a *RuntimeController) SupportsEffectiveHistory(
	ctx context.Context,
	input host.RuntimeHistoryInput,
) (bool, error) {
	if err := a.requireBackend(); err != nil {
		return false, err
	}
	backend, ok := a.Backend.(runtimeHistoryBackend)
	if !ok {
		return false, nil
	}
	return backend.SupportsEffectiveHistory(ctx, runtimeHistoryInput(input))
}

func (a *RuntimeController) ReadEffectiveHistory(
	ctx context.Context,
	input host.RuntimeHistoryInput,
) (host.RuntimeHistorySnapshot, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeHistorySnapshot{}, err
	}
	backend, ok := a.Backend.(runtimeHistoryBackend)
	if !ok {
		return host.RuntimeHistorySnapshot{}, host.ErrRuntimeHistoryUnsupported
	}
	snapshot, err := backend.ReadEffectiveHistory(ctx, runtimeHistoryInput(input))
	return hostHistorySnapshot(snapshot), mapRuntimeError(err)
}

func (a *RuntimeController) RollbackLatestTurn(
	ctx context.Context,
	input host.RuntimeHistoryInput,
) (host.RuntimeHistoryMutationResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeHistoryMutationResult{
			Disposition: host.RuntimeDispatchDispositionNotDispatched,
		}, err
	}
	backend, ok := a.Backend.(runtimeHistoryBackend)
	if !ok {
		return host.RuntimeHistoryMutationResult{
			Disposition: host.RuntimeDispatchDispositionNotDispatched,
		}, host.ErrRuntimeHistoryUnsupported
	}
	result, err := backend.RollbackLatestTurn(ctx, runtimeHistoryInput(input))
	projected := host.RuntimeHistoryMutationResult{
		Disposition: host.RuntimeDispatchDisposition(result.Disposition),
	}
	if result.Snapshot != nil {
		snapshot := hostHistorySnapshot(*result.Snapshot)
		projected.Snapshot = &snapshot
	}
	return projected, mapRuntimeError(err)
}

func (a *RuntimeController) Start(ctx context.Context, input host.RuntimeStartInput) (host.RuntimeStartResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeStartResult{}, err
	}
	result, err := a.Backend.Start(ctx, agentruntime.StartInput{
		RoomID:                  input.WorkspaceID,
		AgentSessionID:          input.AgentSessionID,
		AgentTargetID:           input.AgentTargetID,
		Provider:                input.Provider,
		CWD:                     input.Cwd,
		Env:                     append([]string(nil), input.Env...),
		MCPServers:              runtimeMCPServerBindings(input.MCPServers),
		Title:                   input.Title,
		InitialTitleEstablished: input.InitialTitleEstablished,
		Visible:                 input.Visible,
		RuntimeContext:          cloneMap(input.RuntimeContext),
		ProviderTargetRef:       cloneMap(input.ProviderTargetRef),
		PermissionModeID:        input.PermissionModeID,
		Settings: runtimeSettings(host.ComposerSettings{
			CodexSaverMode:         input.CodexSaverMode,
			Model:                  input.Model,
			PermissionModeID:       input.PermissionModeID,
			PlanMode:               input.PlanMode,
			BrowserUse:             input.BrowserUse,
			ComputerUse:            input.ComputerUse,
			ReasoningEffort:        input.ReasoningEffort,
			Speed:                  input.Speed,
			ConversationDetailMode: input.ConversationDetailMode,
		}),
		Provisional:          input.Provisional,
		CanonicalInitPending: input.CanonicalInitPending,
	})
	if err != nil {
		return host.RuntimeStartResult{}, mapRuntimeError(err)
	}
	session := a.sessionWithState(result.Session)
	session.Provisional = input.Provisional
	return host.RuntimeStartResult{Session: session, Created: result.Created}, nil
}

func (a *RuntimeController) PublishSessionInitialization(
	ctx context.Context,
	input host.RuntimeSessionInitializationPublishInput,
) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	session, err := a.Backend.PublishSessionInitialization(
		ctx,
		input.WorkspaceID,
		input.AgentSessionID,
	)
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) Resume(ctx context.Context, input host.RuntimeResumeInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	session, err := a.Backend.Resume(ctx, runtimeResumeInput(input))
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) Reprepare(ctx context.Context, input host.RuntimeResumeInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	backend, ok := a.Backend.(runtimeSessionReprepareBackend)
	if !ok {
		return host.ProviderRuntimeSession{}, host.ErrRuntimeSessionReprepareUnavailable
	}
	session, err := backend.Reprepare(ctx, runtimeResumeInput(input))
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) Session(workspaceID, sessionID string) (host.ProviderRuntimeSession, bool) {
	if a == nil || a.Backend == nil {
		return host.ProviderRuntimeSession{}, false
	}
	session, found := a.Backend.Session(workspaceID, sessionID)
	if !found {
		return host.ProviderRuntimeSession{}, false
	}
	return a.sessionWithState(session), true
}

func (a *RuntimeController) RuntimeSessionLive(workspaceID, sessionID string) bool {
	if a == nil || a.Backend == nil {
		return false
	}
	liveness, ok := a.Backend.(interface {
		HasLiveSession(string, string) bool
	})
	return ok && liveness.HasLiveSession(strings.TrimSpace(workspaceID), strings.TrimSpace(sessionID))
}

func (a *RuntimeController) CanResume(input host.RuntimeResumeInput) bool {
	return a != nil && a.Backend != nil && a.Backend.CanResume(runtimeResumeInput(input))
}

func (a *RuntimeController) Exec(ctx context.Context, input host.RuntimeExecInput) (host.RuntimeExecResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeExecResult{}, err
	}
	result, err := a.Backend.Exec(ctx, runtimeExecInput(input))
	projected := host.RuntimeExecResult{
		AgentSessionID: result.AgentSessionID,
		Status:         result.Status,
		TurnID:         result.TurnID,
		Accepted:       result.Accepted,
		SessionStatus:  result.SessionStatus,
		TurnLifecycle:  hostTurnLifecycle(result.TurnLifecycle),
		SubmitAvailability: host.SubmitAvailability{
			State: result.SubmitAvailability.State, Reason: result.SubmitAvailability.Reason,
		},
	}
	if result.ProviderDispatch != nil {
		projected.ProviderDispatch.Disposition = host.RuntimeDispatchDisposition(
			result.ProviderDispatch.Disposition,
		)
		if result.ProviderDispatch.Acceptance != nil {
			projected.ProviderDispatch.Acceptance = &host.RuntimeProviderAcceptanceReceipt{
				ProviderSessionID: result.ProviderDispatch.Acceptance.ProviderSessionID,
				ProviderTurnID:    result.ProviderDispatch.Acceptance.ProviderTurnID,
				Source: host.RuntimeAcceptanceSource(
					result.ProviderDispatch.Acceptance.Source,
				),
			}
		}
	}
	return projected, mapRuntimeError(err)
}

func (a *RuntimeController) DurablyReportSubmitProvenance(ctx context.Context, input host.RuntimeSubmitProvenanceInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	return mapRuntimeError(a.Backend.DurablyReportSubmitProvenance(ctx, runtimeSubmitProvenanceInput(input)))
}

func (a *RuntimeController) ReconcileProviderTurnAcceptance(
	ctx context.Context,
	input host.RuntimeProviderTurnAcceptanceInput,
) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	reconciler, ok := a.Backend.(interface {
		ReconcileProviderTurnAcceptance(
			context.Context,
			agentruntime.ProviderTurnAcceptanceInput,
		) error
	})
	if !ok {
		return errors.New("agent runtime cannot reconcile provider turn acceptance")
	}
	return mapRuntimeError(reconciler.ReconcileProviderTurnAcceptance(
		ctx,
		agentruntime.ProviderTurnAcceptanceInput{
			RoomID:                    input.WorkspaceID,
			AgentSessionID:            input.AgentSessionID,
			Provider:                  input.Provider,
			RootTurnID:                input.RootTurnID,
			ExpectedProviderSessionID: input.ExpectedProviderSessionID,
			ExpectedProviderTurnID:    input.ExpectedProviderTurnID,
			ClientUserMessageID:       input.ClientUserMessageID,
		},
	))
}

func (a *RuntimeController) ValidatePromptContent(ctx context.Context, input host.RuntimeExecInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	return mapRuntimeError(a.Backend.ValidatePromptContent(ctx, runtimeExecInput(input)))
}

func (a *RuntimeController) Cancel(ctx context.Context, input host.RuntimeCancelInput) (host.RuntimeCancelResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeCancelResult{}, err
	}
	targets := make([]agentruntime.CancelTarget, 0, len(input.Targets))
	for _, target := range input.Targets {
		targets = append(targets, agentruntime.CancelTarget{AgentSessionID: target.AgentSessionID, TurnID: target.TurnID})
	}
	result, err := a.Backend.Cancel(ctx, agentruntime.CancelInput{
		RoomID: input.WorkspaceID, RootAgentSessionID: input.RootAgentSessionID, Targets: targets, Reason: input.Reason,
	})
	confirmed := make([]host.RuntimeCancelTarget, 0, len(result.ConfirmedTargets))
	for _, target := range result.ConfirmedTargets {
		confirmed = append(confirmed, host.RuntimeCancelTarget{AgentSessionID: target.AgentSessionID, TurnID: target.TurnID})
	}
	return host.RuntimeCancelResult{
		AgentSessionID:   result.AgentSessionID,
		Canceled:         result.Canceled,
		TargetAbsent:     result.TargetAbsent,
		ConfirmedTargets: confirmed,
	}, mapRuntimeError(err)
}

func (a *RuntimeController) SubmitInteractive(ctx context.Context, input host.RuntimeSubmitInteractiveInput) (host.RuntimeSubmitInteractiveResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeSubmitInteractiveResult{}, err
	}
	result, err := a.Backend.SubmitInteractive(ctx, agentruntime.SubmitInteractiveInput{
		RoomID: input.WorkspaceID, RootAgentSessionID: input.RootAgentSessionID,
		AgentSessionID: input.AgentSessionID, TurnID: input.TurnID, RequestID: input.RequestID,
		Action: input.Action, OptionID: input.OptionID, Payload: cloneMap(input.Payload),
	})
	return host.RuntimeSubmitInteractiveResult{Disposition: host.RuntimeInteractiveDisposition(result.Disposition)}, mapRuntimeError(err)
}

func (a *RuntimeController) InteractiveDisposition(workspaceID, rootSessionID, sessionID, turnID, requestID string) host.RuntimeInteractiveDisposition {
	if a == nil || a.Backend == nil {
		return host.RuntimeInteractiveDispositionUnknown
	}
	return host.RuntimeInteractiveDisposition(a.Backend.InteractiveDisposition(workspaceID, rootSessionID, sessionID, turnID, requestID))
}

func (a *RuntimeController) UpdateSettings(ctx context.Context, input host.RuntimeUpdateSettingsInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	_, err := a.Backend.UpdateSettings(ctx, agentruntime.UpdateSettingsInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		Settings: agentruntime.SessionSettingsPatch{
			Model: input.Settings.Model, ReasoningEffort: input.Settings.ReasoningEffort, Speed: input.Settings.Speed,
			PlanMode: input.Settings.PlanMode, BrowserUse: input.Settings.BrowserUse,
			ComputerUse: input.Settings.ComputerUse, PermissionModeID: input.Settings.PermissionModeID,
		},
	})
	return mapRuntimeError(err)
}

func (a *RuntimeController) SetTitle(ctx context.Context, input host.RuntimeSetTitleInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	session, err := a.Backend.SetTitle(ctx, input.WorkspaceID, input.AgentSessionID, input.Title)
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) SetVisible(ctx context.Context, input host.RuntimeSetVisibleInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	session, err := a.Backend.SetVisible(ctx, input.WorkspaceID, input.AgentSessionID, input.Visible)
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) Close(ctx context.Context, input host.RuntimeCloseInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	_, err := a.Backend.Close(ctx, agentruntime.CloseInput{
		RoomID:                 input.WorkspaceID,
		AgentSessionID:         input.AgentSessionID,
		PreserveCanonicalState: input.PreserveCanonicalState,
	})
	return mapRuntimeError(err)
}

func (a *RuntimeController) ResolveSessionFork(
	ctx context.Context,
	source host.ProviderRuntimeSession,
) (host.SessionForkDriverDescriptor, error) {
	if err := a.requireBackend(); err != nil {
		return host.SessionForkDriverDescriptor{}, err
	}
	backend, ok := a.Backend.(sessionForkRuntimeBackend)
	if !ok {
		return host.SessionForkDriverDescriptor{}, nil
	}
	capabilities, err := backend.ForkCapabilities(ctx, runtimeSession(source))
	if err != nil {
		return host.SessionForkDriverDescriptor{}, mapRuntimeError(err)
	}
	if !capabilities.FullSession && !capabilities.ThroughTurn {
		return host.SessionForkDriverDescriptor{}, nil
	}
	return host.SessionForkDriverDescriptor{
		Kind:             firstNonEmptyString(capabilities.DriverKind, "daemon-runtime-native"),
		Version:          firstNonEmptyString(capabilities.DriverVersion, "v1"),
		StateBindingMode: host.SessionForkStateBindingMode(firstNonEmptyString(capabilities.StateBindingMode, string(host.SessionForkStateBindingHostCopy))),
		FullSession:      capabilities.FullSession,
		ThroughTurn:      capabilities.ThroughTurn,
	}, nil
}

func (a *RuntimeController) ForkSession(
	ctx context.Context,
	input host.RuntimeSessionForkInput,
) (host.RuntimeSessionForkResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeSessionForkResult{
			DeliveryDisposition: host.SessionForkDeliveryNotStarted,
		}, err
	}
	backend, ok := a.Backend.(sessionForkRuntimeBackend)
	if !ok {
		return host.RuntimeSessionForkResult{
			DeliveryDisposition: host.SessionForkDeliveryNotStarted,
		}, host.ErrSessionForkUnsupported
	}
	result, err := backend.Fork(ctx, agentruntime.SessionForkInput{
		Source:                  runtimeSession(input.Source),
		ProviderTurnID:          input.SourceProviderTurnID,
		ProviderTurnBindingJSON: append([]byte(nil), input.SourceProviderTurnBindingJSON...),
		TargetTitle:             input.TargetTitle,
	})
	mapped := host.RuntimeSessionForkResult{
		ProviderSessionID: strings.TrimSpace(result.ProviderSessionID),
		TargetProviderTurnBindings: make(
			[]host.SessionForkProviderTurnBinding,
			0,
			len(result.TargetProviderTurnBindings),
		),
		StateBindingMode:    host.SessionForkStateBindingMode(strings.TrimSpace(result.StateBindingMode)),
		StateBindingReceipt: strings.TrimSpace(result.StateBindingReceipt),
		DeliveryDisposition: host.SessionForkDeliveryDisposition(
			result.DeliveryDisposition,
		),
	}
	for _, binding := range result.TargetProviderTurnBindings {
		mapped.TargetProviderTurnBindings = append(
			mapped.TargetProviderTurnBindings,
			host.SessionForkProviderTurnBinding{
				ProviderTurnID: strings.TrimSpace(binding.ProviderTurnID),
				ProviderTurnBindingJSON: append(
					[]byte(nil),
					binding.ProviderTurnBindingJSON...,
				),
			},
		)
	}
	if mapped.StateBindingMode == "" {
		mapped.StateBindingMode = host.SessionForkStateBindingHostCopy
	}
	if err != nil {
		if errors.Is(err, agentruntime.ErrSessionForkUnsupported) {
			return mapped, host.ErrSessionForkUnsupported
		}
		return mapped, mapRuntimeError(err)
	}
	return mapped, nil
}

func (a *RuntimeController) CanForkProviderTurn(
	ctx context.Context,
	input host.RuntimeProviderTurnForkabilityInput,
) (bool, error) {
	if err := a.requireBackend(); err != nil {
		return false, err
	}
	backend, ok := a.Backend.(sessionForkRuntimeBackend)
	if !ok {
		return false, nil
	}
	return backend.CanForkProviderTurn(
		ctx,
		agentruntime.ProviderTurnForkabilityInput{
			Source:                  runtimeSession(input.Source),
			CanonicalTurnID:         strings.TrimSpace(input.CanonicalTurnID),
			ProviderTurnID:          strings.TrimSpace(input.ProviderTurnID),
			ProviderTurnBindingJSON: append([]byte(nil), input.ProviderTurnBindingJSON...),
		},
	)
}

func (a *RuntimeController) RecoverProviderTurnBinding(
	ctx context.Context,
	input host.RuntimeProviderTurnBindingRecoveryInput,
) (host.RuntimeProviderTurnBindingRecoveryResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeProviderTurnBindingRecoveryResult{}, err
	}
	backend, ok := a.Backend.(providerTurnBindingRecoveryBackend)
	if !ok {
		return host.RuntimeProviderTurnBindingRecoveryResult{},
			host.ErrSessionForkUnsupported
	}
	result, err := backend.RecoverProviderTurnBinding(
		ctx,
		agentruntime.ProviderTurnBindingRecoveryInput{
			Source:               runtimeSession(input.Source),
			CanonicalTurnID:      input.CanonicalTurnID,
			RecoveryToken:        input.RecoveryToken,
			LegacyTextHMACKey:    input.LegacyTextHMACKey,
			LegacyTextHMACDigest: input.LegacyTextHMACDigest,
		},
	)
	return host.RuntimeProviderTurnBindingRecoveryResult{
		ProviderSessionID:       result.ProviderSessionID,
		ProviderTurnID:          result.ProviderTurnID,
		ProviderTurnBindingJSON: append([]byte(nil), result.ProviderTurnBindingJSON...),
	}, mapRuntimeError(err)
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func (a *RuntimeController) GoalControl(ctx context.Context, input host.RuntimeGoalControlInput) (host.RuntimeGoalControlResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeGoalControlResult{}, err
	}
	result, err := a.Backend.GoalControl(ctx, agentruntime.GoalControlInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		Action: agentruntime.GoalControlAction(input.Action), Objective: input.Objective,
		OperationID: input.OperationID, GoalRevision: input.GoalRevision, RepairEpoch: input.RepairEpoch,
		SubmissionMetadata: cloneMap(input.SubmissionMetadata), RequireLive: input.RequireLive,
	})
	return host.RuntimeGoalControlResult{
		AgentSessionID: result.AgentSessionID, Goal: cloneMap(result.Goal), Evidence: cloneMap(result.Evidence),
		ProviderPhase: result.ProviderPhase, ExecutionPending: result.ExecutionPending,
	}, mapRuntimeError(err)
}

func (a *RuntimeController) ReconcileGoal(ctx context.Context, input host.RuntimeGoalControlInput) (host.RuntimeGoalReconcileResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeGoalReconcileResult{}, err
	}
	result, err := a.Backend.ReconcileGoal(ctx, agentruntime.GoalReconcileInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, RequireLive: input.RequireLive,
	})
	return host.RuntimeGoalReconcileResult{
		AgentSessionID: result.AgentSessionID, Goal: cloneMap(result.Goal), Evidence: cloneMap(result.Evidence),
	}, mapRuntimeError(err)
}

func (a *RuntimeController) GoalRecoveryPolicy(ctx context.Context, input host.RuntimeGoalControlInput) (host.RuntimeGoalRecoveryPolicy, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeGoalRecoveryPolicy{}, err
	}
	capabilities, err := a.Backend.GoalCapabilities(ctx, agentruntime.GoalReconcileInput{RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID})
	return host.RuntimeGoalRecoveryPolicy{
		QuerySupported: capabilities.QuerySupported, ReplaySetAfterRestart: capabilities.ReplaySetAfterRestart,
	}, mapRuntimeError(err)
}

func (a *RuntimeController) FenceGoalGeneration(ctx context.Context, input host.RuntimeGoalGenerationFenceInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	fencer, ok := a.Backend.(interface {
		FenceGoalGeneration(context.Context, agentruntime.GoalGenerationFenceRequest) error
	})
	if !ok {
		return host.ErrGoalGenerationFenceUnavailable
	}
	return mapRuntimeError(fencer.FenceGoalGeneration(ctx, agentruntime.GoalGenerationFenceRequest{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		OperationID: input.TargetOperationID, Revision: input.TargetRevision,
		RepairEpoch: input.TargetRepairEpoch, Reason: input.Reason, RequireLive: input.RequireLive,
	}))
}

func (a *RuntimeController) requireBackend() error {
	if a == nil || a.Backend == nil {
		return errors.New("agent runtime controller is unavailable")
	}
	return nil
}

func mapRuntimeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, agentruntime.ErrSessionDisconnected) {
		return errors.Join(host.ErrRuntimeSessionDisconnected, err)
	}
	if errors.Is(err, agentruntime.ErrSessionNotFound) {
		return errors.Join(host.ErrSessionNotFound, err)
	}
	if errors.Is(err, agentruntime.ErrActiveTurnTargetRequired) {
		return errors.Join(host.ErrActiveTurnTargetRequired, err)
	}
	if errors.Is(err, agentruntime.ErrActiveTurnTargetMismatch) {
		return errors.Join(host.ErrActiveTurnTargetMismatch, err)
	}
	if errors.Is(err, agentruntime.ErrSessionActiveTurn) {
		return errors.Join(host.ErrRuntimeSessionActive, err)
	}
	if errors.Is(err, agentruntime.ErrEffectiveHistoryUnsupported) {
		return host.ErrRuntimeHistoryUnsupported
	}
	var appErr *agentruntime.AppError
	if errors.As(err, &appErr) && appErr != nil {
		if errors.Is(appErr, context.Canceled) || errors.Is(appErr, context.DeadlineExceeded) {
			return err
		}
		return host.NewProviderError(appErr.Code, appErr.Message, appErr.DebugMessage, appErr)
	}
	return err
}

func (a *RuntimeController) fromSession(session agentruntime.Session) host.ProviderRuntimeSession {
	var settings *host.ComposerSettings
	if session.Settings != nil {
		value := hostSettings(*session.Settings)
		settings = &value
	}
	return host.ProviderRuntimeSession{
		ID: session.AgentSessionID, WorkspaceID: session.RoomID, UserID: a.currentUserID(),
		AgentTargetID: session.AgentTargetID, Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
		Resumable: session.Resumable,
		Cwd:       session.CWD, Env: append([]string(nil), session.Env...), MCPServers: hostMCPServerBindings(session.MCPServers), Settings: settings,
		ProviderTargetRef: cloneMap(session.ProviderTargetRef),
		RuntimeContext:    cloneMap(session.RuntimeContext), Status: session.Status,
		TurnLifecycle: hostTurnLifecyclePointer(session.TurnLifecycle), SubmitAvailability: hostSubmitAvailability(session.SubmitAvailability),
		Visible: session.Visible, Title: session.Title, InitialTitleEstablished: session.InitialTitleEstablished,
		LastError: session.LastError, CreatedAtUnixMS: session.CreatedAtUnixMS, UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
}

func runtimeSession(session host.ProviderRuntimeSession) agentruntime.Session {
	var settings *agentruntime.SessionSettings
	if session.Settings != nil {
		settings = runtimeSettings(*session.Settings)
	}
	return agentruntime.Session{
		RoomID: session.WorkspaceID, AgentSessionID: session.ID,
		AgentTargetID: session.AgentTargetID, Provider: session.Provider,
		ProviderSessionID: session.ProviderSessionID, Resumable: session.Resumable,
		CWD: session.Cwd, Env: append([]string(nil), session.Env...), MCPServers: runtimeMCPServerBindings(session.MCPServers),
		Status: session.Status, TurnLifecycle: runtimeTurnLifecyclePointer(session.TurnLifecycle),
		SubmitAvailability: runtimeSubmitAvailability(session.SubmitAvailability),
		Title:              session.Title, LastError: session.LastError, Visible: session.Visible,
		RuntimeContext: cloneMap(session.RuntimeContext), ProviderTargetRef: cloneMap(session.ProviderTargetRef),
		Settings:        settings,
		CreatedAtUnixMS: session.CreatedAtUnixMS, UpdatedAtUnixMS: session.UpdatedAtUnixMS,
		InitialTitleEstablished: session.InitialTitleEstablished,
	}
}

// sessionWithState preserves the daemon runtime's provider-enriched live
// observation. The base Session owns process identity and lifecycle fields;
// State overlays provider-computed settings and runtime context such as model
// catalogs, usage, rate limits, account details, and commands.
func (a *RuntimeController) sessionWithState(session agentruntime.Session) host.ProviderRuntimeSession {
	result := a.fromSession(session)
	if a == nil || a.Backend == nil {
		return result
	}
	state, err := a.Backend.State(session.RoomID, session.AgentSessionID)
	if err != nil {
		return result
	}
	if state.ProviderSessionID != "" {
		result.ProviderSessionID = state.ProviderSessionID
	}
	result.Resumable = result.Resumable || state.Resumable
	if state.Status != "" {
		result.Status = state.Status
	}
	if state.TurnLifecycle != nil {
		result.TurnLifecycle = hostTurnLifecyclePointer(state.TurnLifecycle)
	}
	if state.SubmitAvailability != nil {
		result.SubmitAvailability = hostSubmitAvailability(state.SubmitAvailability)
	}
	if state.Settings != nil {
		settings := hostSettings(*state.Settings)
		result.Settings = &settings
	}
	result.Capabilities = canonical.CloneCapabilitySnapshot(state.Capabilities)
	result.RuntimeContext = cloneMap(state.RuntimeContext)
	if state.UpdatedAtUnixMS > 0 {
		result.UpdatedAtUnixMS = state.UpdatedAtUnixMS
	}
	return result
}

func (a *RuntimeController) currentUserID() string {
	if a != nil && a.CurrentUserID != nil {
		return strings.TrimSpace(a.CurrentUserID())
	}
	return ""
}

func runtimeResumeInput(input host.RuntimeResumeInput) agentruntime.ResumeInput {
	return agentruntime.ResumeInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
		Provider: input.Provider, ProviderSessionID: input.ProviderSessionID, CWD: input.Cwd,
		Resumable: input.Resumable,
		Env:       append([]string(nil), input.Env...), MCPServers: runtimeMCPServerBindings(input.MCPServers),
		Title: input.Title, Status: input.Status, Visible: input.Visible,
		RuntimeContext:               cloneMap(input.RuntimeContext),
		ProviderLaunchRuntimeContext: cloneMap(input.ProviderLaunchRuntimeContext),
		ProviderTargetRef:            cloneMap(input.ProviderTargetRef),
		PermissionModeID:             input.Settings.PermissionModeID, Settings: runtimeSettings(input.Settings),
		CreatedAtUnixMS: input.CreatedAtUnixMS, UpdatedAtUnixMS: input.UpdatedAtUnixMS,
		GoalGenerationFences: runtimeGoalGenerationFences(input.GoalGenerationFences),
		RecreateIfMissing:    input.RecreateIfMissing,
	}
}

func runtimeExecInput(input host.RuntimeExecInput) agentruntime.ExecInput {
	return agentruntime.ExecInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, ClientSubmitID: input.ClientSubmitID,
		CanonicalSubmitOccurredAtUnixMS: input.CanonicalSubmitOccurredAtUnixMS,
		CapabilityRefs:                  runtimeCapabilityReferences(input.CapabilityRefs),
		TuttiModeSnapshot:               runtimeTuttiModeSnapshot(input.TuttiModeSnapshot),
		Content:                         runtimePromptContent(input.Content),
		DisplayPrompt:                   input.DisplayPrompt, InitialTitle: input.InitialTitle, InitialTitleBase: input.InitialTitleBase,
		Metadata: cloneMap(input.Metadata), Guidance: input.Guidance,
		HistoryReplacement:        input.HistoryReplacement,
		RequireProviderAcceptance: input.RequireProviderAcceptance,
	}
}

func runtimeHistoryInput(input host.RuntimeHistoryInput) agentruntime.EffectiveHistoryInput {
	return agentruntime.EffectiveHistoryInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		Provider: input.Provider,
	}
}

func hostHistorySnapshot(input agentruntime.EffectiveHistorySnapshot) host.RuntimeHistorySnapshot {
	turns := make([]host.RuntimeHistoryTurn, 0, len(input.Turns))
	for _, turn := range input.Turns {
		turns = append(turns, host.RuntimeHistoryTurn{
			ID: turn.ID, Status: turn.Status,
			ClientUserMessageID: turn.ClientUserMessageID,
		})
	}
	return host.RuntimeHistorySnapshot{
		ProviderSessionID: input.ProviderSessionID,
		Turns:             turns,
	}
}

func runtimeSubmitProvenanceInput(input host.RuntimeSubmitProvenanceInput) agentruntime.SubmitProvenanceInput {
	return agentruntime.SubmitProvenanceInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, ClientSubmitID: input.ClientSubmitID,
		CanonicalSubmitOccurredAtUnixMS: input.CanonicalSubmitOccurredAtUnixMS,
		Content:                         runtimePromptContent(input.Content), DisplayPrompt: input.DisplayPrompt,
		Guidance: input.Guidance,
	}
}

func runtimePromptContent(input []host.PromptContentBlock) []agentruntime.PromptContentBlock {
	content := make([]agentruntime.PromptContentBlock, 0, len(input))
	for _, block := range input {
		content = append(content, agentruntime.PromptContentBlock{
			Type: block.Type, Text: block.Text, MimeType: block.MimeType, Data: block.Data, URL: block.URL,
			AttachmentID: block.AttachmentID, Name: block.Name, Path: block.Path, ConnectorKey: block.ConnectorKey,
		})
	}
	return content
}

func runtimeCapabilityReferences(input []host.CapabilityReference) []agentruntime.CapabilityReference {
	references := make([]agentruntime.CapabilityReference, 0, len(input))
	for _, reference := range input {
		references = append(references, agentruntime.CapabilityReference{
			Capability: reference.Capability,
			Source:     reference.Source,
		})
	}
	return references
}
