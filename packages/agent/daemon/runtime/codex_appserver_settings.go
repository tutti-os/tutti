package agentruntime

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func (a *CodexAppServerAdapter) ApplyPermissionMode(_ context.Context, session Session) error {
	// The app-server protocol has no live "set mode" call; the permission mode
	// maps to approvalPolicy/sandboxPolicy overrides applied on every
	// turn/start. Record the mode so session state reflects it immediately.
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil {
		return nil
	}
	if modeID := codexACPEffectiveModeID(session); modeID != "" {
		appSession.currentMode = modeID
	}
	return nil
}

func (a *CodexAppServerAdapter) SessionState(session Session) SessionStateSnapshot {
	snapshot := SessionStateSnapshot{
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Status:            session.Status,
		PermissionModeID:  session.PermissionModeID,
		RuntimeContext: map[string]any{
			"cwd":              session.CWD,
			"title":            session.Title,
			"permissionModeId": session.PermissionModeID,
		},
		UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
	state, ok := a.snapshotSessionState(session.AgentSessionID)
	if !ok {
		return snapshot
	}
	for key, value := range state.resumeRuntimeContext {
		snapshot.RuntimeContext[key] = value
	}
	snapshot.RuntimeContext["cwd"] = session.CWD
	snapshot.RuntimeContext["title"] = session.Title
	snapshot.RuntimeContext["permissionModeId"] = session.PermissionModeID
	if len(state.serverInfo) > 0 {
		snapshot.RuntimeContext["agent"] = state.serverInfo
	}
	if len(state.account) > 0 {
		snapshot.RuntimeContext["account"] = state.account
	}
	if len(state.rateLimits) > 0 {
		snapshot.RuntimeContext["rateLimits"] = state.rateLimits
	}
	startup := map[string]any{
		"models": codexAppServerStartupStatus(state.startupModelsReady),
	}
	if a.config.rateLimits {
		startup["rateLimits"] = codexAppServerStartupStatus(state.startupRateLimitsReady)
	}
	snapshot.RuntimeContext["appServerStartup"] = startup
	if len(state.goal) > 0 {
		snapshot.RuntimeContext["goal"] = state.goal
	}
	if state.authState != "" {
		snapshot.AuthState = state.authState
	}
	if state.authMessage != "" {
		snapshot.RuntimeContext["authMessage"] = state.authMessage
	}
	if state.currentMode != "" {
		snapshot.RuntimeContext["mode"] = state.currentMode
	}
	if checkpoint := codexAppServerProtocolCheckpoint(
		state.planModeMask,
		state.defaultModeMask,
		state.defaultModel,
	); checkpoint != nil {
		snapshot.RuntimeContext[canonical.ProviderResumeCheckpointRuntimeContextKey] =
			checkpoint
	}
	if len(state.availableCommands) > 0 {
		snapshot.RuntimeContext["commands"] = agentSessionCommandNames(state.availableCommands)
	}
	if len(state.configOptions) > 0 {
		snapshot.RuntimeContext["config"] = state.configOptions
	}
	if len(state.configOptionDescriptors) > 0 {
		snapshot.RuntimeContext["configOptions"] = state.configOptionDescriptors
	}
	if providerConfig := providerRuntimeConfig(session, session.Provider); len(providerConfig) > 0 {
		snapshot.RuntimeContext["providerConfig"] = providerConfig
	}
	if usage := acpUsageRuntimeContext(state.usage); len(usage) > 0 {
		snapshot.RuntimeContext["usage"] = usage
	}
	codexCapabilities := codexAppServerCapabilities(state.planModeSupported)
	if !a.config.rateLimits {
		codexCapabilities = slices.DeleteFunc(codexCapabilities, func(capability string) bool {
			return capability == CapabilityRateLimits
		})
	}
	codexCapabilities = appendBrowserUseCapability(codexCapabilities, session.Env)
	codexCapabilities = appendComputerUseCapability(codexCapabilities, session.Env)
	snapshot.Capabilities = canonical.NewCapabilitySnapshot(codexCapabilities)
	snapshot.Settings = codexAppServerSessionSettingsWithConfig(
		session.Settings,
		session.Provider,
		session.PermissionModeID,
		state.configOptions,
	)
	if snapshot.Settings != nil {
		snapshot.RuntimeContext["model"] = snapshot.Settings.Model
		snapshot.RuntimeContext["reasoningEffort"] = snapshot.Settings.ReasoningEffort
		snapshot.RuntimeContext["speed"] = snapshot.Settings.Speed
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	if state.pendingPrompt != nil {
		snapshot.PendingInteractive = state.pendingPrompt
	}
	return snapshot
}

func codexAppServerStartupStatus(ready bool) string {
	if ready {
		return "ready"
	}
	return "loading"
}

type codexAppServerSessionStateSnapshot struct {
	serverInfo             map[string]any
	account                map[string]any
	rateLimits             map[string]any
	startupModelsReady     bool
	startupRateLimitsReady bool
	goal                   map[string]any
	authState              string
	authMessage            string
	planModeSupported      bool
	planModeMask           map[string]any
	defaultModeMask        map[string]any
	defaultModel           string
	resumeRuntimeContext   map[string]any
	acpLiveStateSnapshot
	pendingPrompt *SessionInteractivePrompt
}

func (a *CodexAppServerAdapter) snapshotSessionState(agentSessionID string) (codexAppServerSessionStateSnapshot, bool) {
	if a == nil {
		return codexAppServerSessionStateSnapshot{}, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return codexAppServerSessionStateSnapshot{}, false
	}
	var prompt *SessionInteractivePrompt
	for _, pending := range appSession.pendingRequests {
		if candidate := pending.snapshotPrompt(); candidate != nil {
			prompt = candidate
			break
		}
	}
	return codexAppServerSessionStateSnapshot{
		serverInfo:             clonePayload(appSession.serverInfo),
		account:                clonePayload(appSession.account),
		rateLimits:             clonePayload(appSession.rateLimits),
		startupModelsReady:     appSession.startupModelsReady,
		startupRateLimitsReady: appSession.startupRateLimitsReady,
		goal:                   clonePayload(appSession.goal),
		authState:              strings.TrimSpace(appSession.authState),
		authMessage:            strings.TrimSpace(appSession.authMessage),
		planModeSupported:      appSession.planModeMask != nil,
		planModeMask:           clonePayload(appSession.planModeMask),
		defaultModeMask:        clonePayload(appSession.defaultModeMask),
		defaultModel:           strings.TrimSpace(appSession.defaultModel),
		resumeRuntimeContext:   clonePayload(appSession.resumeRuntimeContext),
		acpLiveStateSnapshot:   snapshotACPLiveState(appSession.acpLiveState),
		pendingPrompt:          prompt,
	}, true
}

func codexAppServerProtocolCheckpoint(
	planModeMask map[string]any,
	defaultModeMask map[string]any,
	defaultModel string,
) map[string]any {
	checkpoint := map[string]any{}
	if len(planModeMask) > 0 {
		checkpoint["planModeMask"] = clonePayload(planModeMask)
	}
	if len(defaultModeMask) > 0 {
		checkpoint["defaultModeMask"] = clonePayload(defaultModeMask)
	}
	if defaultModel = strings.TrimSpace(defaultModel); defaultModel != "" {
		checkpoint["defaultModel"] = defaultModel
	}
	if len(checkpoint) == 0 {
		return nil
	}
	return checkpoint
}

func codexAppServerProtocolCheckpointFromRuntimeContext(
	runtimeContext map[string]any,
) (map[string]any, map[string]any, string, bool) {
	checkpoint, ok := runtimeContext[canonical.ProviderResumeCheckpointRuntimeContextKey].(map[string]any)
	if !ok || len(checkpoint) == 0 {
		return nil, nil, "", false
	}
	planModeMask, _ := checkpoint["planModeMask"].(map[string]any)
	defaultModeMask, _ := checkpoint["defaultModeMask"].(map[string]any)
	return clonePayload(planModeMask),
		clonePayload(defaultModeMask),
		strings.TrimSpace(asString(checkpoint["defaultModel"])),
		true
}

func (a *CodexAppServerAdapter) SessionCommandSnapshot(session Session) (AgentSessionCommandSnapshot, bool) {
	if a == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil {
		a.mu.Unlock()
		return AgentSessionCommandSnapshot{}, false
	}
	snapshot, ok := commandSnapshotFromACPLiveState(session.AgentSessionID, appSession.acpLiveState)
	a.mu.Unlock()
	return snapshot, ok
}

func (a *CodexAppServerAdapter) SubmitInteractive(ctx context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: interactive turn id is required", ErrInteractiveResponseInvalid)
	}
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: interactive request id is required", ErrInteractiveResponseInvalid)
	}
	targetAgentSessionID := firstNonEmpty(strings.TrimSpace(input.AgentSessionID), strings.TrimSpace(session.AgentSessionID))
	pending := a.getPendingRequest(targetAgentSessionID, turnID, requestID)
	if pending == nil {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: %q", ErrInteractiveRequestNotLive, requestID)
	}
	if pending.callType == "approval" {
		optionID := interactiveApprovalOptionID(input)
		if optionID == "" {
			return SubmitInteractiveResult{}, fmt.Errorf("%w: interactive option id is required", ErrInteractiveResponseInvalid)
		}
		resolvedOptionID, ok := pending.resolvePermissionOptionID(optionID)
		if !ok {
			return SubmitInteractiveResult{}, fmt.Errorf(
				"%w: permission option %q is not available for request %q",
				ErrInteractiveResponseInvalid,
				optionID,
				requestID,
			)
		}
		if _, err := pending.dispatchResponse(ctx, pendingInteractiveResponse{
			optionID: resolvedOptionID,
			payload:  clonePayload(input.Payload),
		}); err != nil {
			return SubmitInteractiveResult{}, err
		}
		if state, err := pending.waitForDisposition(ctx); err != nil {
			return SubmitInteractiveResult{}, err
		} else if state != pendingInteractiveRequestStateAnswered {
			return SubmitInteractiveResult{}, interactiveDispositionError(requestID, state)
		}
		return SubmitInteractiveResult{AgentSessionID: targetAgentSessionID, RequestID: requestID, Accepted: true, OptionID: resolvedOptionID, Disposition: InteractiveDispositionAnswered}, nil
	}
	optionID := strings.TrimSpace(input.OptionID)
	action := strings.TrimSpace(input.Action)
	payload := clonePayload(input.Payload)
	if _, err := pending.dispatchResponse(ctx, pendingInteractiveResponse{
		optionID: optionID,
		action:   action,
		payload:  payload,
	}); err != nil {
		return SubmitInteractiveResult{}, err
	}
	if state, err := pending.waitForDisposition(ctx); err != nil {
		return SubmitInteractiveResult{}, err
	} else if state != pendingInteractiveRequestStateAnswered {
		return SubmitInteractiveResult{}, interactiveDispositionError(requestID, state)
	}
	return SubmitInteractiveResult{
		AgentSessionID: targetAgentSessionID,
		RequestID:      requestID,
		Accepted:       true,
		Disposition:    InteractiveDispositionAnswered,
	}, nil
}

func (a *CodexAppServerAdapter) InteractiveDisposition(session Session, turnID string, requestID string) InteractiveDisposition {
	return a.InteractiveDispositionForTarget(session, session.AgentSessionID, turnID, requestID)
}

func (a *CodexAppServerAdapter) InteractiveDispositionForTarget(_ Session, agentSessionID string, turnID string, requestID string) InteractiveDisposition {
	if pending := a.getPendingRequest(agentSessionID, turnID, requestID); pending != nil {
		return runtimeInteractiveDisposition(pending)
	}
	return a.terminalInteractiveDisposition(agentSessionID, turnID, requestID)
}

// lockSessionLifecycle serializes lifecycle operations (Start, Resume, Close,
// ReleaseLiveSession) for one agent session: any interleaving of these calls
// could otherwise spawn a second app-server process while the first is still
// live, or close the wrong process. The lock entry is refcounted so the map
// does not grow with retired session IDs.
