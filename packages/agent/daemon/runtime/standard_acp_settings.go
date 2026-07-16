package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"
)

func (a *standardACPAdapter) applyACPMode(ctx context.Context, client *acpClient, session Session, modeID string) error {
	if modeID == "" {
		a.logHermesStartupDiagnostics("session_mode.skipped", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"permission_mode_id":  session.PermissionModeID,
		})
		return nil
	}
	params := map[string]any{
		"sessionId": session.ProviderSessionID,
		"modeId":    modeID,
	}
	if merge := a.config.setModeParams; merge != nil {
		for k, v := range merge(session) {
			params[k] = v
		}
	}
	setModeStartedAt := time.Now()
	slog.Info("agent session ACP mode update started",
		"event", "agent_session.acp.session_mode.start",
		"provider", a.config.provider,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"permission_mode_id", session.PermissionModeID,
		"mode_id", modeID,
		"timeout_ms", acpPermissionModeTimeout.Milliseconds(),
	)
	a.logHermesStartupDiagnostics("session_mode.start", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
		"permission_mode_id":  session.PermissionModeID,
		"mode_id":             modeID,
		"timeout_ms":          acpPermissionModeTimeout.Milliseconds(),
	})
	_, err := client.CallWithTimeout(ctx, acpPermissionModeTimeout, acpMethodSetMode, params, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logHermesStartupDiagnostics("session_mode.unconfirmed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"permission_mode_id":  session.PermissionModeID,
			"mode_id":             modeID,
			"elapsed_ms":          time.Since(setModeStartedAt).Milliseconds(),
			"error":               err.Error(),
		})
		if a.config.failOnSetModeError {
			return fmt.Errorf("agent session ACP mode confirmation failed: %w", err)
		}
		slog.Warn("agent session ACP mode was not confirmed; continuing",
			"event", "agent_session.acp.session_mode.unconfirmed",
			"provider", a.config.provider,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"mode_id", modeID,
			"elapsed_ms", time.Since(setModeStartedAt).Milliseconds(),
			"error", err.Error(),
		)
		return nil
	}
	slog.Info("agent session ACP mode update succeeded",
		"event", "agent_session.acp.session_mode.succeeded",
		"provider", a.config.provider,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"permission_mode_id", session.PermissionModeID,
		"mode_id", modeID,
		"elapsed_ms", time.Since(setModeStartedAt).Milliseconds(),
	)
	a.logHermesStartupDiagnostics("session_mode.succeeded", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
		"permission_mode_id":  session.PermissionModeID,
		"mode_id":             modeID,
		"elapsed_ms":          time.Since(setModeStartedAt).Milliseconds(),
	})
	return nil
}

func (a *standardACPAdapter) applySessionConfigOptions(
	ctx context.Context,
	client *acpClient,
	session Session,
	startResult json.RawMessage,
) error {
	settings := session.SettingsValue()
	supported := acpConfigOptionIDs(startResult)
	modelsAPI := acpModelsResultPresent(startResult)
	if len(supported) == 0 && !modelsAPI {
		a.logHermesStartupDiagnostics("config_options.skipped", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"reason":              "none_supported",
		})
		return nil
	}
	a.logHermesStartupDiagnostics("config_options.start", map[string]any{
		"room_id":              session.RoomID,
		"agent_session_id":     session.AgentSessionID,
		"provider_session_id":  session.ProviderSessionID,
		"supported_option_ids": acpConfigOptionIDList(startResult),
		"model_requested":      strings.TrimSpace(settings.Model) != "",
		"effort_requested":     strings.TrimSpace(settings.ReasoningEffort) != "",
	})
	// Startup config options are applied best-effort: a value the agent
	// rejects (e.g. a model alias the signed-in account cannot access) must
	// not abort the whole session. The session stays usable on the agent's
	// default, and the user can pick a supported value from the live list.
	if model := strings.TrimSpace(settings.Model); model != "" && (modelsAPI || shouldApplyACPModelConfigOption(supported)) {
		var err error
		if modelsAPI {
			err = a.setSessionModel(ctx, client, session, model)
		} else {
			err = a.setSessionConfigOption(ctx, client, session, "model", model)
		}
		if err != nil {
			a.logStartupConfigOptionRejected(session, "model", model, err)
		} else {
			a.updateSessionConfigOption(session.AgentSessionID, "model", model)
		}
	}
	if reasoning := strings.TrimSpace(settings.ReasoningEffort); reasoning != "" && supported["effort"] {
		if err := a.setSessionConfigOption(ctx, client, session, "effort", reasoning); err != nil {
			a.logStartupConfigOptionRejected(session, "effort", reasoning, err)
		} else {
			a.updateSessionConfigOption(session.AgentSessionID, "effort", reasoning)
		}
	}
	if speed := strings.TrimSpace(settings.Speed); speed != "" && supported["fast"] {
		if err := a.setSessionConfigOption(ctx, client, session, "fast", speed); err != nil {
			return fmt.Errorf("agent session ACP fast configuration failed: %w", err)
		}
		a.updateSessionConfigOption(session.AgentSessionID, "fast", speed)
	}
	a.logHermesStartupDiagnostics("config_options.succeeded", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
	})
	return nil
}

func (a *standardACPAdapter) logStartupConfigOptionRejected(
	session Session,
	configID string,
	value string,
	err error,
) {
	slog.Warn("agent session ACP startup config option rejected; continuing on agent default",
		"event", "agent_session.acp.config_option.rejected",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"config_id", configID,
		"value", value,
		"error", err.Error(),
	)
}

func shouldApplyACPModelConfigOption(supported map[string]bool) bool {
	return supported["model"]
}

func acpModelsResultPresent(raw json.RawMessage) bool {
	var payload struct {
		Models json.RawMessage `json:"models"`
	}
	return json.Unmarshal(raw, &payload) == nil && len(payload.Models) > 0 && string(payload.Models) != "null"
}

func (a *standardACPAdapter) setSessionModel(
	ctx context.Context,
	client *acpClient,
	session Session,
	modelID string,
) error {
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodSetModel, map[string]any{
		"sessionId": session.ProviderSessionID,
		"modelId":   strings.TrimSpace(modelID),
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		return err
	}
	a.updateSessionConfigOptionsResult(session.AgentSessionID, result)
	return nil
}

func (a *standardACPAdapter) setSessionConfigOption(
	ctx context.Context,
	client *acpClient,
	session Session,
	configID string,
	value string,
) error {
	startedAt := time.Now()
	a.logHermesStartupDiagnostics("config_option.start", map[string]any{
		"room_id":             session.RoomID,
		"agent_session_id":    session.AgentSessionID,
		"provider_session_id": session.ProviderSessionID,
		"config_id":           configID,
		"value":               value,
		"timeout_ms":          acpStartCallTimeout.Milliseconds(),
	})
	result, err := client.CallWithTimeout(ctx, acpStartCallTimeout, acpMethodSetConfigOption, map[string]any{
		"sessionId": session.ProviderSessionID,
		"configId":  configID,
		"value":     value,
	}, func(ctx context.Context, message acpMessage) error {
		_, err := a.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
		return err
	})
	if err != nil {
		a.logHermesStartupDiagnostics("config_option.failed", map[string]any{
			"room_id":             session.RoomID,
			"agent_session_id":    session.AgentSessionID,
			"provider_session_id": session.ProviderSessionID,
			"config_id":           configID,
			"elapsed_ms":          time.Since(startedAt).Milliseconds(),
			"error":               err.Error(),
		})
		return err
	}
	a.updateSessionConfigOptionsResult(session.AgentSessionID, result)
	a.logHermesStartupDiagnostics("config_option.succeeded", map[string]any{
		"room_id":              session.RoomID,
		"agent_session_id":     session.AgentSessionID,
		"provider_session_id":  session.ProviderSessionID,
		"config_id":            configID,
		"elapsed_ms":           time.Since(startedAt).Milliseconds(),
		"supported_option_ids": acpConfigOptionIDList(result),
	})
	return nil
}

func (a *standardACPAdapter) updateSessionConfigOptionsResult(agentSessionID string, raw json.RawMessage) {
	if a == nil || len(raw) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return
	}
	applyACPConfigOptionsResult(&session.acpLiveState, raw)
	applyACPModelsResult(&session.acpLiveState, raw)
}

func (a *standardACPAdapter) updateSessionConfigOption(
	agentSessionID string,
	configID string,
	value string,
) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return
	}
	session.ensureInitialized()
	if strings.TrimSpace(value) == "" {
		delete(session.configOptions, configID)
		return
	}
	session.configOptions[configID] = value
	updateConfigOptionDescriptorValue(session.configOptionDescriptors, configID, value)
}

// RequiresNewSessionForSettings implements NewSessionSettingsAdapter for
// providers whose config declares spawn-time-only settings (currently Nexight).
func (a *standardACPAdapter) RequiresNewSessionForSettings(session Session, patch SessionSettingsPatch) bool {
	if a == nil || a.config.requiresNewSessionForSettings == nil {
		return false
	}
	return a.config.requiresNewSessionForSettings(session, patch)
}

func (a *standardACPAdapter) ApplySessionSettings(
	ctx context.Context,
	session Session,
	patch SessionSettingsPatch,
) error {
	if a.RequiresNewSessionForSettings(session, patch) {
		return ErrSessionSettingsRequireNewSession
	}
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = acpSession.providerSessionID
	}

	if patch.PlanMode != nil {
		if err := a.applyACPMode(ctx, acpSession.client, session, a.effectiveModeID(session)); err != nil {
			return err
		}
	}

	if patch.Model != nil {
		model := strings.TrimSpace(*patch.Model)
		// A model the live agent advertises as a selectable option can be
		// switched in place via set_config_option, even if it is a concrete id
		// (e.g. Opus 4.6) rather than one of the static aliases. Only models the
		// running agent has not advertised still require a fresh session.
		advertised := a.sessionConfigOptionAdvertisesValue(session.AgentSessionID, "model", model)
		supported := map[string]bool{"model": true}
		if advertised || shouldApplyACPModelConfigOption(supported) {
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "model", model) {
				var err error
				if a.sessionUsesACPModelsAPI(session.AgentSessionID) {
					err = a.setSessionModel(ctx, acpSession.client, session, model)
				} else {
					err = a.setSessionConfigOption(ctx, acpSession.client, session, "model", model)
				}
				if err != nil {
					return fmt.Errorf("agent session ACP model configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "model", model)
			}
		}
	}

	if patch.ReasoningEffort != nil {
		reasoning := strings.TrimSpace(*patch.ReasoningEffort)
		if reasoning != "" {
			if !a.sessionConfigOptionAdvertisesValue(session.AgentSessionID, "effort", reasoning) {
				return fmt.Errorf("agent session ACP effort %q is not advertised for the current model", reasoning)
			}
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "effort", reasoning) {
				if err := a.setSessionConfigOption(ctx, acpSession.client, session, "effort", reasoning); err != nil {
					return fmt.Errorf("agent session ACP effort configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "effort", reasoning)
			}
		}
	}

	if patch.Speed != nil {
		speed := strings.TrimSpace(*patch.Speed)
		if speed != "" {
			if !a.sessionConfigOptionMatches(session.AgentSessionID, "fast", speed) {
				if err := a.setSessionConfigOption(ctx, acpSession.client, session, "fast", speed); err != nil {
					return fmt.Errorf("agent session ACP fast configuration failed: %w", err)
				}
				a.updateSessionConfigOption(session.AgentSessionID, "fast", speed)
			}
		}
	}

	return nil
}

func (a *standardACPAdapter) sessionUsesACPModelsAPI(agentSessionID string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	return session != nil && session.modelsAPI
}

func (a *standardACPAdapter) ApplyPermissionMode(ctx context.Context, session Session) error {
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = acpSession.providerSessionID
	}
	// Track the live tier so automatic decisions (for example full-access
	// approval or read-only denial) affect subsequent requests without respawn.
	a.setSessionPermissionModeID(session.AgentSessionID, session.PermissionModeID)
	if a.config.permissionModeID == nil || a.config.permissionModeID(session.PermissionModeID) == "" {
		return nil
	}
	return a.applyACPMode(ctx, acpSession.client, session, a.effectiveModeID(session))
}

func (a *standardACPAdapter) setSessionPermissionModeID(agentSessionID string, permissionModeID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if session := a.sessions[strings.TrimSpace(agentSessionID)]; session != nil {
		session.permissionModeID = strings.TrimSpace(permissionModeID)
	}
}

// automaticPermissionDecision resolves the decision the provider's live
// permission tier applies to a permission request, or "" to prompt the user.
func (a *standardACPAdapter) automaticPermissionDecision(agentSessionID string) string {
	if a == nil || a.config.automaticPermissionDecision == nil {
		return ""
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	permissionModeID := ""
	if session != nil {
		permissionModeID = session.permissionModeID
	}
	a.mu.Unlock()
	return a.config.automaticPermissionDecision(permissionModeID)
}

func (a *standardACPAdapter) effectiveModeID(session Session) string {
	if a == nil || a.config.permissionModeID == nil {
		return ""
	}
	if session.SettingsValue().PlanMode {
		if a.config.planModeRuntimeID != "" {
			return a.config.planModeRuntimeID
		}
		if modeID := a.config.permissionModeID("plan"); modeID != "" {
			return modeID
		}
	}
	if a.config.planModeDisabledRuntimeID != "" {
		return a.config.planModeDisabledRuntimeID
	}
	return a.config.permissionModeID(session.PermissionModeID)
}

func (a *standardACPAdapter) SessionState(session Session) SessionStateSnapshot {
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
	if a == nil {
		return snapshot
	}
	a.mu.Lock()
	acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if acpSession == nil {
		a.mu.Unlock()
		return snapshot
	}
	state := snapshotACPLiveState(acpSession.acpLiveState)
	agentInfo := clonePayload(acpSession.agentInfo)
	promptImage := acpSession.promptImage
	var prompt *SessionInteractivePrompt
	for _, pending := range acpSession.pendingApprovals {
		if candidate := pending.snapshotPrompt(); candidate != nil {
			prompt = candidate
			break
		}
	}
	a.mu.Unlock()

	if len(agentInfo) > 0 {
		snapshot.RuntimeContext["agent"] = agentInfo
	}
	if state.currentMode != "" {
		snapshot.RuntimeContext["mode"] = state.currentMode
	}
	if len(state.availableCommands) > 0 {
		snapshot.RuntimeContext["commands"] = agentSessionCommandNames(state.availableCommands)
		snapshot.RuntimeContext["availableCommands"] = agentSessionCommandsRuntimeContext(state.availableCommands)
	}
	if len(state.configOptions) > 0 {
		snapshot.RuntimeContext["config"] = state.configOptions
	}
	configOptionDescriptors := cloneConfigOptionDescriptors(state.configOptionDescriptors)
	if len(configOptionDescriptors) > 0 {
		snapshot.RuntimeContext["configOptions"] = configOptionDescriptors
	}
	if providerConfig := providerRuntimeConfig(session, session.Provider); len(providerConfig) > 0 {
		snapshot.RuntimeContext["providerConfig"] = providerConfig
	}
	if usage := acpUsageRuntimeContext(state.usage); len(usage) > 0 {
		snapshot.RuntimeContext["usage"] = usage
	}
	if len(state.goal) > 0 {
		snapshot.RuntimeContext["goal"] = state.goal
	}
	capabilities := standardACPCapabilities(a.config.provider, promptImage, state)
	capabilities = appendBrowserUseCapability(capabilities, session.Env)
	capabilities = appendComputerUseCapability(capabilities, session.Env)
	if len(capabilities) > 0 {
		snapshot.RuntimeContext["capabilities"] = capabilities
	}
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
	if prompt != nil {
		snapshot.PendingInteractive = prompt
	}
	return snapshot
}

func acpConfigOptionIDs(raw json.RawMessage) map[string]bool {
	if len(raw) == 0 {
		return nil
	}
	var payload struct {
		ConfigOptions []map[string]any `json:"configOptions"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload.ConfigOptions) == 0 {
		return nil
	}
	ids := make(map[string]bool, len(payload.ConfigOptions))
	for _, option := range payload.ConfigOptions {
		id := strings.TrimSpace(asString(option["id"]))
		if id != "" {
			ids[id] = true
		}
	}
	return ids
}

func acpConfigOptionIDList(raw json.RawMessage) []string {
	ids := acpConfigOptionIDs(raw)
	if len(ids) == 0 {
		return nil
	}
	out := make([]string, 0, len(ids))
	for id := range ids {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
