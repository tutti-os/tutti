package agentruntime

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/modelcatalog"
)

// codexAppServerExecState owns the mutable model/config snapshot used to build
// one turn. liveSession points at the same immutable client/thread identity
// stored in the adapter; the remaining fields are copied while a.mu is held so
// ApplySessionSettings and the background model/list refresh cannot race with
// request construction.
type codexAppServerExecState struct {
	liveSession  *codexAppServerSession
	models       []map[string]any
	config       map[string]any
	defaultModel string
}

// codexAppServerModelValue resolves the request model name from one model/list
// entry. `model` is the app-server request value; `id` is only a fallback for
// older catalogs that omit it.
func codexAppServerModelValue(model map[string]any) string {
	return strings.TrimSpace(firstNonEmpty(asString(model["model"]), asString(model["id"])))
}

// codexAppServerDefaultModel resolves the default request model from
// model/list, used to satisfy the required CollaborationMode.settings.model
// field and to validate reasoning options for provider-default sessions.
func codexAppServerDefaultModel(models []map[string]any) string {
	for _, model := range models {
		if isDefault, _ := model["isDefault"].(bool); isDefault {
			if value := codexAppServerModelValue(model); value != "" {
				return value
			}
		}
	}
	for _, model := range models {
		if value := codexAppServerModelValue(model); value != "" {
			return value
		}
	}
	return ""
}

func codexAppServerNeedsSynchronousModels(session Session) bool {
	settings := session.SettingsValue()
	// A missing model needs the catalog default. A persisted reasoning effort
	// also needs the selected model's advertised options before thread/start or
	// thread/resume, otherwise an obsolete value can make the request invalid.
	// Explicit models without an effort keep the fast path and load the catalog
	// asynchronously after startup.
	return strings.TrimSpace(settings.Model) == "" ||
		strings.TrimSpace(settings.ReasoningEffort) != ""
}

func codexAppServerSessionDefaultModel(session Session, models []map[string]any) string {
	return firstNonEmpty(strings.TrimSpace(session.SettingsValue().Model), codexAppServerDefaultModel(models))
}

func cloneCodexAppServerModels(models []map[string]any) []map[string]any {
	if len(models) == 0 {
		return nil
	}
	cloned := make([]map[string]any, 0, len(models))
	for _, model := range models {
		cloned = append(cloned, clonePayloadDeep(model))
	}
	return cloned
}

func codexAppServerModelsForEffectiveConfig(
	models []map[string]any,
	config codexAppServerEffectiveConfig,
) []map[string]any {
	effectiveModel := strings.TrimSpace(asString(config.settings["model"]))
	if effectiveModel == "" {
		return models
	}
	if provider := strings.ToLower(strings.TrimSpace(config.modelProvider)); provider != "" && provider != "openai" {
		return []map[string]any{{
			"id":          effectiveModel,
			"model":       effectiveModel,
			"displayName": effectiveModel,
			"isDefault":   true,
			"hidden":      false,
		}}
	}
	reconciled := cloneCodexAppServerModels(models)
	found := false
	for _, model := range reconciled {
		isEffective := codexAppServerModelValue(model) == effectiveModel
		model["isDefault"] = isEffective
		found = found || isEffective
	}
	if found {
		return reconciled
	}
	return append([]map[string]any{{
		"id":          effectiveModel,
		"model":       effectiveModel,
		"displayName": effectiveModel,
		"isDefault":   true,
		"hidden":      false,
	}}, reconciled...)
}

// codexAppServerSessionWithConfig applies every present live config key,
// including empty-string tombstones. Presence matters while model/list is
// loading: an explicit clear must override the stale startup session value.
func codexAppServerSessionWithConfig(session Session, config map[string]any) Session {
	settings := session.SettingsValue()
	if model, ok := config["model"]; ok {
		settings.Model = asString(model)
	}
	if reasoning, ok := config["reasoning_effort"]; ok {
		settings.ReasoningEffort = asString(reasoning)
	}
	if speed, ok := config["service_tier"]; ok {
		settings.Speed = asString(speed)
	}
	session.Settings = &settings
	return session
}

// codexAppServerExecSessionWithConfig fills missing call-time settings from the
// live adapter state without replacing explicit settings carried by the
// controller's Exec session. ApplySessionSettings updates both controller state
// and the live config; preferring a stale live default here would otherwise
// undo valid model/effort overrides on the next turn.
func codexAppServerExecSessionWithConfig(session Session, config map[string]any) Session {
	requested := session.SettingsValue()
	session = codexAppServerSessionWithConfig(session, config)
	effective := session.SettingsValue()
	if value := strings.TrimSpace(requested.Model); value != "" {
		effective.Model = value
	}
	if value := strings.TrimSpace(requested.ReasoningEffort); value != "" {
		effective.ReasoningEffort = value
	}
	if value := strings.TrimSpace(requested.Speed); value != "" {
		effective.Speed = value
	}
	session.Settings = &effective
	return session
}

func codexAppServerConfigWithEffectiveSettings(
	config map[string]any,
	settings SessionSettings,
) map[string]any {
	effective := clonePayloadDeep(config)
	if effective == nil {
		effective = map[string]any{}
	}
	if model := strings.TrimSpace(settings.Model); model != "" {
		effective["model"] = model
	}
	if reasoning := strings.TrimSpace(settings.ReasoningEffort); reasoning != "" {
		effective["reasoning_effort"] = reasoning
	}
	if speed := strings.TrimSpace(settings.Speed); speed != "" {
		effective["service_tier"] = speed
	}
	return effective
}

func (a *CodexAppServerAdapter) applyStartupModels(
	agentSessionID string,
	session Session,
	threadResult json.RawMessage,
	models []map[string]any,
) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return false
	}
	models = codexAppServerModelsForEffectiveConfig(models, codexAppServerEffectiveConfig{
		settings:      appSession.configOptions,
		modelProvider: appSession.modelProvider,
	})
	if len(models) == 0 {
		return false
	}
	effectiveSession := codexAppServerSessionWithConfig(session, appSession.configOptions)
	effectiveSettings := codexAppServerEffectiveSettings(models, effectiveSession, threadResult)
	effectiveSession.Settings = &effectiveSettings
	applyACPConfigOptionDescriptors(
		&appSession.acpLiveState,
		codexAppServerConfigOptionDescriptors(models, effectiveSession, threadResult),
	)
	appSession.models = cloneCodexAppServerModels(models)
	appSession.defaultModel = codexAppServerSessionDefaultModel(effectiveSession, models)
	appSession.startupModelsReady = true
	return true
}

func codexAppServerConfigOptionDescriptors(
	models []map[string]any,
	session Session,
	threadResult json.RawMessage,
) []map[string]any {
	settings := codexAppServerEffectiveSettings(models, session, threadResult)
	currentModel := settings.Model
	currentEffort := settings.ReasoningEffort

	modelOptions := make([]any, 0, len(models))
	modelOptionValues := map[string]struct{}{}
	var effortValues []string
	effortValuesAdvertised := false
	for _, model := range models {
		value := codexAppServerModelValue(model)
		if value == "" {
			continue
		}
		// Hidden models still own the selected session's reasoning profile. Read
		// that capability before filtering them out of the model picker.
		if value == currentModel {
			effortValues, effortValuesAdvertised = appServerSupportedEfforts(model)
		}
		if hidden, _ := model["hidden"].(bool); hidden {
			continue
		}
		modelOption, ok := codexAppServerRuntimeModelOption(model)
		if !ok {
			continue
		}
		modelOptions = append(modelOptions, modelOption)
		modelOptionValues[value] = struct{}{}
	}
	if currentModel != "" {
		if _, ok := modelOptionValues[currentModel]; !ok {
			modelOptions = append(modelOptions, map[string]any{
				"value": currentModel,
				"name":  currentModel,
			})
		}
	}
	if !effortValuesAdvertised {
		effortValues = []string{"minimal", "low", "medium", "high", "xhigh"}
	}
	effortOptions := make([]any, 0, len(effortValues))
	for _, value := range effortValues {
		effortOptions = append(effortOptions, map[string]any{
			"value": value,
			"name":  strings.ToUpper(value[:1]) + value[1:],
		})
	}

	descriptors := make([]map[string]any, 0, 3)
	if len(modelOptions) > 0 {
		descriptors = append(descriptors, map[string]any{
			"id":           "model",
			"name":         "Model",
			"type":         "select",
			"category":     "model",
			"currentValue": currentModel,
			"options":      modelOptions,
		})
	}
	reasoningCurrentValue := any(firstNonEmpty(currentEffort, "medium"))
	if effortValuesAdvertised && len(effortOptions) == 0 {
		// Keep an explicit empty live descriptor. It suppresses stale daemon
		// catalog fallbacks and leaves an empty config tombstone for state
		// projection without advertising an unsupported selector value.
		reasoningCurrentValue = nil
	}
	descriptors = append(descriptors, map[string]any{
		"id":           "reasoning_effort",
		"name":         "Reasoning Effort",
		"type":         "select",
		"category":     "thought_level",
		"currentValue": reasoningCurrentValue,
		"options":      effortOptions,
	})
	descriptors = append(descriptors, map[string]any{
		"id":           "service_tier",
		"name":         "Speed",
		"type":         "select",
		"category":     "speed",
		"currentValue": firstNonEmpty(strings.TrimSpace(settings.Speed), "standard"),
		"options": []any{
			map[string]any{"value": "standard", "name": "Standard"},
			map[string]any{"value": "fast", "name": "Fast"},
		},
	})
	return descriptors
}

func codexAppServerRuntimeModelOption(model map[string]any) (map[string]any, bool) {
	raw, err := json.Marshal(model)
	if err != nil {
		return nil, false
	}
	normalized, ok := modelcatalog.NormalizeCodexModel(raw)
	if !ok {
		return nil, false
	}
	return modelcatalog.ProjectRuntimeConfigOptionModel(normalized), true
}

func codexAppServerEffectiveSettings(
	models []map[string]any,
	session Session,
	threadResult json.RawMessage,
) SessionSettings {
	settings := session.SettingsValue()
	currentModel := strings.TrimSpace(settings.Model)
	currentEffort := strings.TrimSpace(settings.ReasoningEffort)
	var threadInfo struct {
		Model           string `json:"model"`
		ReasoningEffort string `json:"reasoningEffort"`
	}
	if len(threadResult) > 0 {
		if err := json.Unmarshal(threadResult, &threadInfo); err == nil {
			currentModel = firstNonEmpty(currentModel, strings.TrimSpace(threadInfo.Model))
			currentEffort = firstNonEmpty(currentEffort, strings.TrimSpace(threadInfo.ReasoningEffort))
		}
	}
	currentModel = firstNonEmpty(currentModel, codexAppServerDefaultModel(models))
	settings.Model = currentModel
	settings.ReasoningEffort = appServerReasoningEffortForModel(models, currentModel, currentEffort)
	return settings
}

// appServerSupportedEfforts keeps field presence separate from parsed values.
// An advertised empty list means the selected model has no reasoning control;
// a missing or malformed field falls back to compatibility options.
func appServerSupportedEfforts(model map[string]any) ([]string, bool) {
	raw, advertised := model["supportedReasoningEfforts"].([]any)
	if !advertised {
		return nil, false
	}
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		switch typed := entry.(type) {
		case string:
			if trimmed := strings.TrimSpace(typed); trimmed != "" {
				out = append(out, trimmed)
			}
		case map[string]any:
			if value := firstNonEmpty(asString(typed["reasoningEffort"]), asString(typed["effort"]), asString(typed["value"])); value != "" {
				out = append(out, value)
			}
		}
	}
	return dedupeStrings(out), true
}

func appServerReasoningEffortForModel(
	models []map[string]any,
	modelID string,
	selected string,
) string {
	modelID = strings.TrimSpace(modelID)
	rawSelected := strings.TrimSpace(selected)
	selected = codexAppServerReasoningEffortValue(rawSelected)
	for _, model := range models {
		candidateID := codexAppServerModelValue(model)
		if candidateID != modelID {
			continue
		}
		efforts, advertised := appServerSupportedEfforts(model)
		if !advertised {
			return selected
		}
		if len(efforts) == 0 {
			return ""
		}
		for _, effort := range efforts {
			if effort == rawSelected || effort == selected {
				return effort
			}
		}
		rawAdvertisedDefault := asString(model["defaultReasoningEffort"])
		advertisedDefault := codexAppServerReasoningEffortValue(rawAdvertisedDefault)
		for _, effort := range efforts {
			if effort == rawAdvertisedDefault || effort == advertisedDefault {
				return effort
			}
		}
		return efforts[0]
	}
	return selected
}

// codexAppServerSessionSettingsWithConfig keeps live empty values meaningful.
// The shared ACP projection intentionally ignores empty config values, while
// Codex uses them as tombstones when a setting is cleared or the selected
// model explicitly advertises no reasoning efforts.
func codexAppServerSessionSettingsWithConfig(
	base *SessionSettings,
	provider string,
	defaultPermissionModeID string,
	config map[string]any,
) *SessionSettings {
	settings := sessionSettingsWithACPConfig(base, provider, defaultPermissionModeID, config, true)
	_, hasModel := config["model"]
	_, hasReasoning := config["reasoning_effort"]
	_, hasSpeed := config["service_tier"]
	if !hasModel && !hasReasoning && !hasSpeed {
		return settings
	}
	if settings == nil {
		normalized := normalizeSessionSettings(base, provider, defaultPermissionModeID)
		settings = &normalized
	}
	if hasModel {
		settings.Model = asString(config["model"])
	}
	if hasReasoning {
		settings.ReasoningEffort = asString(config["reasoning_effort"])
	}
	if hasSpeed {
		settings.Speed = asString(config["service_tier"])
	}
	return settings
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
		slog.Warn("agent session app-server settings apply skipped without live session",
			"event", "agent_session.app_server.settings.apply_skipped",
			"provider", a.config.provider,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"session_model", session.SettingsValue().Model,
			"patch_has_model", patch.Model != nil,
		)
		return nil
	}
	appSession.ensureInitialized()
	refreshedModelReasoningOptions := false
	if len(appSession.models) > 0 && (patch.Model != nil || patch.ReasoningEffort != nil) {
		effectiveSession := session
		effectiveSettings := effectiveSession.SettingsValue()
		if patch.Model != nil {
			effectiveSettings.Model = strings.TrimSpace(*patch.Model)
		}
		if patch.ReasoningEffort != nil {
			effectiveSettings.ReasoningEffort = strings.TrimSpace(*patch.ReasoningEffort)
		}
		if patch.Speed != nil {
			effectiveSettings.Speed = strings.TrimSpace(*patch.Speed)
		}
		effectiveSession.Settings = &effectiveSettings
		effectiveSettings = codexAppServerEffectiveSettings(appSession.models, effectiveSession, nil)
		effectiveSession.Settings = &effectiveSettings
		applyACPConfigOptionDescriptors(
			&appSession.acpLiveState,
			codexAppServerConfigOptionDescriptors(appSession.models, effectiveSession, nil),
		)
		refreshedModelReasoningOptions = true
	}
	if patch.Model != nil && !refreshedModelReasoningOptions {
		model := strings.TrimSpace(*patch.Model)
		appSession.configOptions["model"] = model
		updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "model", model)
	}
	if patch.ReasoningEffort != nil && !refreshedModelReasoningOptions {
		reasoning := codexAppServerReasoningEffortValue(*patch.ReasoningEffort)
		appSession.configOptions["reasoning_effort"] = reasoning
		updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "reasoning_effort", reasoning)
	}
	if patch.Speed != nil {
		// Speed (service_tier) is applied as a config override on the next
		// thread/start; mirror it into the picker state so the dropdown stays
		// in sync. "standard" clears the override.
		speed := strings.TrimSpace(*patch.Speed)
		appSession.configOptions["service_tier"] = speed
		updateConfigOptionDescriptorValue(appSession.configOptionDescriptors, "service_tier", speed)
	}
	slog.Info("agent session app-server settings applied",
		"event", "agent_session.app_server.settings.applied",
		"provider", a.config.provider,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"session_model", session.SettingsValue().Model,
		"patch_has_model", patch.Model != nil,
		"patch_model", stringPtrLogValue(patch.Model),
		"config_option_model", asString(appSession.configOptions["model"]),
	)
	return nil
}

func stringPtrLogValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func (*CodexAppServerAdapter) RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool {
	// The app-server supports per-turn model/effort overrides, so settings
	// changes never require recreating the session.
	return false
}

func (a *CodexAppServerAdapter) snapshotExecState(agentSessionID string) (codexAppServerExecState, bool) {
	if a == nil {
		return codexAppServerExecState{}, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.client == nil {
		return codexAppServerExecState{}, false
	}
	return codexAppServerExecState{
		liveSession:  appSession,
		models:       cloneCodexAppServerModels(appSession.models),
		config:       clonePayloadDeep(appSession.configOptions),
		defaultModel: appSession.defaultModel,
	}, true
}
