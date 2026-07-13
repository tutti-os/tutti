package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

func (a *CodexAppServerAdapter) ApplySessionSettings(
	_ context.Context,
	session Session,
	patch SessionSettingsPatch,
) error {
	// Model and reasoning effort are applied as per-turn overrides on the next
	// turn/start; no live RPC is required. Mirror the values into the config
	// option state so pickers stay in sync.
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil {
		return nil
	}
	appSession.ensureInitialized()
	if patch.Model != nil {
		if model := strings.TrimSpace(*patch.Model); model != "" {
			appSession.configOptions["model"] = model
			updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "model", model)
		}
	}
	if patch.ReasoningEffort != nil {
		if reasoning := codexACPReasoningEffortValue(*patch.ReasoningEffort); reasoning != "" {
			appSession.configOptions["reasoning_effort"] = reasoning
			updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "reasoning_effort", reasoning)
		}
	}
	if patch.Speed != nil {
		// Speed (service_tier) is applied as a config override on the next
		// thread/start; mirror it into the picker state so the dropdown stays
		// in sync. "standard" clears the override.
		if speed := strings.TrimSpace(*patch.Speed); speed != "" {
			appSession.configOptions["service_tier"] = speed
			updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "service_tier", speed)
		}
	}
	return nil
}

func (*CodexAppServerAdapter) RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool {
	// The app-server supports per-turn model/effort overrides, so settings
	// changes never require recreating the session.
	return false
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
	if len(state.serverInfo) > 0 {
		snapshot.RuntimeContext["agent"] = state.serverInfo
	}
	if len(state.account) > 0 {
		snapshot.RuntimeContext["account"] = state.account
	}
	if len(state.rateLimits) > 0 {
		snapshot.RuntimeContext["rateLimits"] = state.rateLimits
	}
	snapshot.RuntimeContext["appServerStartup"] = map[string]any{
		"models":     codexAppServerStartupStatus(state.startupModelsReady),
		"rateLimits": codexAppServerStartupStatus(state.startupRateLimitsReady),
	}
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
	codexCapabilities = appendBrowserUseCapability(codexCapabilities, session.Env)
	codexCapabilities = appendComputerUseCapability(codexCapabilities, session.Env)
	snapshot.RuntimeContext["capabilities"] = codexCapabilities
	snapshot.Settings = sessionSettingsWithACPConfig(
		session.Settings,
		session.Provider,
		session.PermissionModeID,
		state.configOptions,
		true,
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
		prompt = pending.snapshotPrompt()
		break
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
		acpLiveStateSnapshot:   snapshotACPLiveState(appSession.acpLiveState),
		pendingPrompt:          prompt,
	}, true
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
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" {
		return SubmitInteractiveResult{}, errors.New("interactive request id is required")
	}
	pending := a.getPendingRequest(session.AgentSessionID, requestID)
	if pending == nil {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: %q", ErrInteractiveRequestNotLive, requestID)
	}
	if pending.callType == "approval" {
		optionID := strings.TrimSpace(input.OptionID)
		if optionID == "" && input.Payload != nil {
			optionID = strings.TrimSpace(asString(input.Payload["optionId"]))
		}
		if optionID == "" {
			return SubmitInteractiveResult{}, errors.New("interactive option id is required")
		}
		resolvedOptionID, ok := pending.resolvePermissionOptionID(optionID)
		if !ok {
			return SubmitInteractiveResult{}, fmt.Errorf("permission option %q is not available for request %q", optionID, requestID)
		}
		select {
		case <-ctx.Done():
			return SubmitInteractiveResult{}, ctx.Err()
		case pending.response <- pendingInteractiveResponse{optionID: resolvedOptionID}:
			return SubmitInteractiveResult{
				AgentSessionID: session.AgentSessionID,
				RequestID:      requestID,
				Accepted:       true,
				OptionID:       resolvedOptionID,
			}, nil
		default:
			return SubmitInteractiveResult{}, fmt.Errorf("%w: permission request %q", ErrInteractiveAlreadyAnswered, requestID)
		}
	}
	optionID := strings.TrimSpace(input.OptionID)
	action := strings.TrimSpace(input.Action)
	payload := clonePayload(input.Payload)
	select {
	case <-ctx.Done():
		return SubmitInteractiveResult{}, ctx.Err()
	case pending.response <- pendingInteractiveResponse{
		optionID: optionID,
		action:   action,
		payload:  payload,
	}:
	default:
		return SubmitInteractiveResult{}, fmt.Errorf("%w: %q", ErrInteractiveAlreadyAnswered, requestID)
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      requestID,
		Accepted:       true,
	}, nil
}

// lockSessionLifecycle serializes lifecycle operations (Start, Resume, Close,
// ReleaseLiveSession) for one agent session: any interleaving of these calls
// could otherwise spawn a second app-server process while the first is still
// live, or close the wrong process. The lock entry is refcounted so the map
// does not grow with retired session IDs.
