package agentruntime

import (
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *ClaudeCodeSDKAdapter) storeSession(agentSessionID string, session *claudeSDKAdapterSession) {
	if session != nil && session.childSessions == nil {
		session.childSessions = make(map[string]claudeSDKChildSession)
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	for {
		a.mu.Lock()
		previous := a.sessions[agentSessionID]
		a.mu.Unlock()
		if previous != nil && previous != session {
			previous.dispatchMu.Lock()
		}
		a.mu.Lock()
		if a.sessions[agentSessionID] != previous {
			a.mu.Unlock()
			if previous != nil && previous != session {
				previous.dispatchMu.Unlock()
			}
			continue
		}
		a.sessions[agentSessionID] = session
		a.mu.Unlock()
		if previous != nil && previous != session {
			previous.dispatchMu.Unlock()
		}
		return
	}
}

func (*ClaudeCodeSDKAdapter) applySidecarSessionEvent(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	event claudeSDKSidecarEvent,
) []activityshared.Event {
	if event.Type == "usage_updated" {
		adapterSession.applyUsageUpdated(event.Payload)
		return nil
	}
	if event.Type != "session_started" && event.Type != "session_state" {
		return nil
	}
	adapterSession.applySessionPayload(&session, event.Payload)
	if event.Type != "session_started" {
		return nil
	}
	return []activityshared.Event{newSessionActivityEvent(
		session,
		EventSessionStarted,
		SessionStatusReady,
		claudeSDKRuntimeContext(session, adapterSession),
	)}
}

func (a *ClaudeCodeSDKAdapter) getSession(agentSessionID string) *claudeSDKAdapterSession {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[agentSessionID]
}

func (a *ClaudeCodeSDKAdapter) removeSession(agentSessionID string, expected *claudeSDKAdapterSession) bool {
	if a == nil || expected == nil {
		return false
	}
	expected.dispatchMu.Lock()
	a.mu.Lock()
	expected.invalid = true
	pending := make([]*pendingInteractiveRequest, 0, len(expected.pendingRequests))
	for _, request := range expected.pendingRequests {
		pending = append(pending, request)
	}
	if a.sessions[agentSessionID] != expected {
		a.mu.Unlock()
		expected.dispatchMu.Unlock()
		for _, request := range pending {
			request.finish(pendingInteractiveRequestStateSuperseded)
		}
		return false
	}
	delete(a.sessions, agentSessionID)
	a.mu.Unlock()
	expected.dispatchMu.Unlock()
	for _, request := range pending {
		request.finish(pendingInteractiveRequestStateSuperseded)
	}
	return true
}

func (a *ClaudeCodeSDKAdapter) restorePreviousSession(agentSessionID string, previous *claudeSDKAdapterSession) bool {
	if a == nil || previous == nil {
		return false
	}
	previous.dispatchMu.Lock()
	defer previous.dispatchMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	current := a.sessions[agentSessionID]
	if current != nil {
		return current == previous && !previous.invalid
	}
	if previous.invalid {
		return false
	}
	a.sessions[agentSessionID] = previous
	return true
}

// restoreOwnedPreviousSession is used only when a replacement launch fails.
// An invalid previous session remains unusable, but restoring it to the owned
// registry preserves the physical handle for a later close retry.
func (a *ClaudeCodeSDKAdapter) restoreOwnedPreviousSession(agentSessionID string, previous *claudeSDKAdapterSession) bool {
	if a == nil || previous == nil {
		return false
	}
	previous.dispatchMu.Lock()
	defer previous.dispatchMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	current := a.sessions[agentSessionID]
	if current != nil {
		return current == previous
	}
	a.sessions[agentSessionID] = previous
	return true
}

func (a *ClaudeCodeSDKAdapter) sessionIsUsable(agentSessionID string, session *claudeSDKAdapterSession) bool {
	if a == nil || session == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[agentSessionID] == session && !session.invalid
}

func (a *ClaudeCodeSDKAdapter) sessionMayDispatch(agentSessionID string, session *claudeSDKAdapterSession) bool {
	if a == nil || session == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	current := a.sessions[agentSessionID]
	return !session.invalid && current == session
}

func (a *ClaudeCodeSDKAdapter) emitCommandSnapshot(snapshot AgentSessionCommandSnapshot) {
	if a == nil || strings.TrimSpace(snapshot.AgentSessionID) == "" {
		return
	}
	a.mu.Lock()
	sink := a.commandSink
	a.mu.Unlock()
	if sink != nil {
		sink(snapshot)
	}
}

func claudeSDKSidecarCommand(env []string) []string {
	if command := strings.TrimSpace(os.Getenv(claudeSDKSidecarCommandEnv)); command != "" {
		return strings.Fields(command)
	}
	if entry := claudeSDKEnvValue(env, claudeSDKSidecarEntryPathEnv); entry != "" {
		return []string{claudeSDKNodeCommand(env), claudeSDKSidecarDefaultNodeArg, entry}
	}
	root := findRepoRoot()
	if root == "" {
		return []string{"node", claudeSDKSidecarDefaultNodeArg, "packages/agent/claude-sdk-sidecar/src/main.ts"}
	}
	return []string{"node", claudeSDKSidecarDefaultNodeArg, filepath.Join(root, "packages/agent/claude-sdk-sidecar/src/main.ts")}
}

func claudeSDKNodeCommand(env []string) string {
	if node := claudeSDKEnvValue(env, claudeSDKAppNodeEnv); node != "" {
		return node
	}
	if root := claudeSDKEnvValue(env, claudeSDKAppRuntimeRootEnv); root != "" {
		if node := claudeSDKManagedNodePath(root); isExecutableFile(node) {
			return node
		}
	}
	if cacheRoot := claudeSDKEnvValue(env, claudeSDKAppRuntimeCacheEnv); cacheRoot != "" {
		root := filepath.Join(cacheRoot, goruntime.GOOS+"-"+goruntime.GOARCH)
		if node := claudeSDKManagedNodePath(root); isExecutableFile(node) {
			return node
		}
	}
	return "node"
}

func claudeSDKEnvValue(env []string, key string) string {
	if value := strings.TrimSpace(envValueFromList(env, key)); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv(key))
}

func claudeSDKManagedNodePath(root string) string {
	return filepath.Join(root, "node", "bin", claudeSDKNodeBinaryName())
}

func claudeSDKNodeBinaryName() string {
	if goruntime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

func claudeSDKSidecarEnv(session Session) []string {
	env := append([]string(nil), session.Env...)
	env = append(env, "IS_SANDBOX=1")
	if os.Getenv(claudeSDKSidecarTestDriverEnv) != "" {
		env = append(env, claudeSDKSidecarTestDriverEnv+"="+os.Getenv(claudeSDKSidecarTestDriverEnv))
	}
	return env
}

func claudeSDKRuntimeContext(session Session, adapterSession *claudeSDKAdapterSession) map[string]any {
	liveState := newClaudeSDKLiveState()
	if adapterSession != nil {
		liveState = adapterSession.liveState
	}
	model := claudeSDKSessionModel(session, liveState)
	reasoningEffort := claudeSDKSessionReasoningEffort(session, liveState)
	speed := claudeSDKSessionSpeed(session, liveState)
	permissionMode := claudeSDKSessionPermissionMode(session, liveState)
	context := map[string]any{
		"adapter":          claudeSDKSidecarAdapterName,
		"configOptions":    claudeSDKConfigOptions(liveState, model, reasoningEffort, speed),
		"model":            model,
		"permissionModeId": permissionMode,
		"planMode":         session.SettingsValue().PlanMode,
		"reasoningEffort":  reasoningEffort,
		"speed":            speed,
	}
	if providerConfig := providerRuntimeConfig(session, session.Provider); len(providerConfig) > 0 {
		context["providerConfig"] = providerConfig
	}
	if len(liveState.availableCommands) > 0 {
		context["commands"] = agentSessionCommandNames(liveState.availableCommands)
	}
	if usage := claudeSDKUsageRuntimeContext(liveState.usage); len(usage) > 0 {
		context["usage"] = usage
	}
	if resumeCursor := claudeSDKResumeCursor(session, adapterSession); len(resumeCursor) > 0 {
		context["resumeCursor"] = resumeCursor
	}
	if cwd := strings.TrimSpace(session.CWD); cwd != "" {
		context["cwd"] = cwd
	}
	if title := strings.TrimSpace(session.Title); title != "" {
		context["title"] = title
	}
	if len(liveState.goal) > 0 {
		context["goal"] = clonePayload(liveState.goal)
	}
	return context
}

func claudeSDKCapabilities(session Session) []string {
	capabilities := []string{
		CapabilityImageInput,
		CapabilityCompact,
		CapabilityTokenUsage,
		CapabilityRateLimits,
		CapabilityPlanMode,
		CapabilityInterrupt,
		CapabilityActiveTurnGuidance,
		CapabilityPermissionModeChangeDuringTurn,
		CapabilitySkills,
		"review",
		// Goal set/clear/display only — no CapabilityGoalPause: Claude
		// Code's goal has no paused state to control.
		"goal",
	}
	capabilities = appendBrowserUseCapability(capabilities, session.Env)
	capabilities = appendComputerUseCapability(capabilities, session.Env)
	return capabilities
}

func (s *claudeSDKAdapterSession) mirrorGoalSlashPrompt(session Session, prompt string) (activityshared.Event, bool) {
	if s == nil {
		return activityshared.Event{}, false
	}
	goal, updateType, ok := claudeGoalSlashPromptUpdate(prompt)
	if !ok {
		return activityshared.Event{}, false
	}
	if updateType == "thread_goal_update" {
		s.liveState.goal = normalizeClaudeGoalTiming(goal, s.liveState.goal, time.Now().UnixMilli())
	} else {
		s.liveState.goal = nil
	}
	return normalizedGoalUpdatedEvent(session, updateType)
}

func claudeSDKResumeCursor(session Session, adapterSession *claudeSDKAdapterSession) map[string]any {
	if adapterSession != nil && len(adapterSession.resumeCursor) > 0 {
		return clonePayload(adapterSession.resumeCursor)
	}
	if cursor := claudeSDKResumeCursorFromSession(session); len(cursor) > 0 {
		return cursor
	}
	providerSessionID := strings.TrimSpace(session.ProviderSessionID)
	if adapterSession != nil {
		providerSessionID = firstNonEmpty(strings.TrimSpace(adapterSession.providerSessionID), providerSessionID)
	}
	if providerSessionID == "" {
		return nil
	}
	return map[string]any{
		"kind":      claudeSDKSidecarAdapterName,
		"version":   int64(1),
		"resume":    providerSessionID,
		"turnCount": int64(0),
	}
}

func claudeSDKResumeCursorFromSession(session Session) map[string]any {
	cursor := payloadMap(session.RuntimeContext, "resumeCursor")
	if len(cursor) == 0 {
		return nil
	}
	resume := strings.TrimSpace(asString(cursor["resume"]))
	providerSessionID := strings.TrimSpace(session.ProviderSessionID)
	if resume == "" || providerSessionID == "" || resume != providerSessionID {
		return nil
	}
	return clonePayload(cursor)
}

func classifyClaudeSDKResumeError(session Session, err error) error {
	if err == nil {
		return nil
	}
	message := strings.TrimSpace(err.Error())
	lower := strings.ToLower(message)
	if strings.Contains(lower, "no conversation found with session id") ||
		strings.Contains(lower, "query closed before response received") {
		return &AppError{
			Code:    AppErrorProviderSessionNotFound,
			Message: "Agent provider session could not be restored.",
			DebugMessage: fmt.Sprintf(
				"Claude SDK restore target missing: room_id=%s provider=%s agent_session_id=%s provider_session_id=%s error=%s",
				strings.TrimSpace(session.RoomID),
				strings.TrimSpace(session.Provider),
				strings.TrimSpace(session.AgentSessionID),
				strings.TrimSpace(session.ProviderSessionID),
				message,
			),
			Cause: err,
		}
	}
	return err
}

func claudeSDKModelConfigOption(model string) map[string]any {
	selectedModel := claudeSDKCanonicalModel(model)
	if selectedModel == "" {
		selectedModel = "default"
	}
	return map[string]any{
		"id":           "model",
		"currentValue": selectedModel,
		"options": []map[string]string{
			{"name": "Default", "value": "default"},
			{"name": "Opus", "value": "opus"},
			{"name": "Sonnet", "value": "sonnet"},
			{"name": "Haiku", "value": "haiku"},
		},
	}
}

func claudeSDKConfigOptions(state claudeSDKLiveState, model string, effort string, speed string) []map[string]any {
	options := cloneConfigOptionDescriptors(state.configOptionDescriptors)
	if len(options) == 0 {
		return []map[string]any{claudeSDKModelConfigOption(model), claudeSDKEffortConfigOption(effort), claudeSDKSpeedConfigOption(speed)}
	}
	ensureClaudeSDKConfigOption(&options, claudeSDKModelConfigOption(model))
	ensureClaudeSDKConfigOption(&options, claudeSDKEffortConfigOption(effort))
	ensureClaudeSDKConfigOption(&options, claudeSDKSpeedConfigOption(speed))
	updateConfigOptionDescriptorValue(options, "model", model)
	updateConfigOptionDescriptorValue(options, "effort", effort)
	updateConfigOptionDescriptorValue(options, "fast", speed)
	return options
}

func ensureClaudeSDKConfigOption(options *[]map[string]any, fallback map[string]any) {
	id := strings.TrimSpace(asString(fallback["id"]))
	if id == "" {
		return
	}
	for _, option := range *options {
		if strings.TrimSpace(asString(option["id"])) == id {
			return
		}
	}
	*options = append(*options, clonePayloadDeep(fallback))
}

func claudeSDKEffortConfigOption(effort string) map[string]any {
	selectedEffort := claudeSDKCanonicalEffort(effort)
	if selectedEffort == "" {
		selectedEffort = "high"
	}
	return map[string]any{
		"id":           "effort",
		"name":         "Reasoning",
		"currentValue": selectedEffort,
		"options": []map[string]string{
			{"name": "Low", "value": "low"},
			{"name": "Medium", "value": "medium"},
			{"name": "High", "value": "high"},
			{"name": "Extra High", "value": "xhigh"},
		},
	}
}

func claudeSDKSpeedConfigOption(speed string) map[string]any {
	selectedSpeed := claudeSDKCanonicalSpeed(speed)
	if selectedSpeed == "" {
		selectedSpeed = sessionSpeedStandard
	}
	return map[string]any{
		"id":           "fast",
		"name":         "Speed",
		"currentValue": selectedSpeed,
		"options": []map[string]string{
			{"name": "Standard", "value": sessionSpeedStandard},
			{"name": "Fast", "value": sessionSpeedFast},
		},
	}
}

func claudeSDKSessionModel(session Session, state claudeSDKLiveState) string {
	if model := claudeSDKCanonicalModel(asString(state.configOptions["model"])); model != "" {
		return model
	}
	if session.Settings != nil {
		if model := claudeSDKCanonicalModel(session.Settings.Model); model != "" {
			return model
		}
	}
	return "default"
}

func claudeSDKSessionReasoningEffort(session Session, state claudeSDKLiveState) string {
	if effort := claudeSDKCanonicalEffort(asString(state.configOptions["effort"])); effort != "" {
		return effort
	}
	if session.Settings != nil {
		if effort := claudeSDKCanonicalEffort(session.Settings.ReasoningEffort); effort != "" {
			return effort
		}
	}
	return "high"
}

func claudeSDKSessionSpeed(session Session, state claudeSDKLiveState) string {
	if speed := claudeSDKCanonicalSpeed(asString(state.configOptions["fast"])); speed != "" {
		return speed
	}
	if session.Settings != nil {
		if speed := claudeSDKCanonicalSpeed(session.Settings.Speed); speed != "" {
			return speed
		}
	}
	return sessionSpeedStandard
}

func claudeSDKSessionPermissionMode(session Session, state claudeSDKLiveState) string {
	if mode := claudeSDKPermissionMode(asString(state.configOptions["mode"])); mode != "" && mode != "plan" {
		return mode
	}
	return claudeSDKPermissionMode(firstNonEmpty(session.PermissionModeID, session.SettingsValue().PermissionModeID))
}

func claudeSDKCanonicalModel(model string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return ""
	}
	if claudeSDKModelOptionExists(model) {
		return model
	}
	return model
}

func claudeSDKCanonicalEffort(effort string) string {
	switch strings.TrimSpace(effort) {
	case "low", "medium", "high", "xhigh":
		return strings.TrimSpace(effort)
	default:
		return ""
	}
}

func claudeSDKCanonicalSpeed(speed string) string {
	switch strings.TrimSpace(speed) {
	case sessionSpeedStandard, claudeSDKFastModeOff:
		return sessionSpeedStandard
	case sessionSpeedFast, claudeSDKFastModeOn:
		return sessionSpeedFast
	default:
		return ""
	}
}

func claudeSDKSpeedFromFastModeState(state string) string {
	switch strings.TrimSpace(state) {
	case "on":
		return sessionSpeedFast
	case "off":
		return sessionSpeedStandard
	default:
		return ""
	}
}

func claudeSDKEffectivePermissionMode(session Session) string {
	settings := session.SettingsValue()
	if settings.PlanMode {
		return "plan"
	}
	return claudeSDKPermissionMode(firstNonEmpty(session.PermissionModeID, settings.PermissionModeID))
}

func claudeSDKPermissionMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan":
		return strings.TrimSpace(mode)
	default:
		return ""
	}
}

func claudeSDKModelOptionExists(model string) bool {
	switch strings.TrimSpace(model) {
	case "default", "opus", "sonnet", "haiku":
		return true
	default:
		return false
	}
}

func findRepoRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if fileExists(filepath.Join(dir, "pnpm-workspace.yaml")) && fileExists(filepath.Join(dir, "packages/agent/claude-sdk-sidecar/src/main.ts")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func envListToMap(env []string) map[string]any {
	if len(env) == 0 {
		return nil
	}
	result := make(map[string]any, len(env))
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if !ok || strings.TrimSpace(key) == "" {
			continue
		}
		result[key] = value
	}
	return result
}

func claudeSDKSessionSettingsPayload(session Session) map[string]any {
	settings := session.SettingsValue()
	payload := map[string]any{
		"model":            strings.TrimSpace(settings.Model),
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
		"planMode":         settings.PlanMode,
		"reasoningEffort":  strings.TrimSpace(settings.ReasoningEffort),
		"speed":            claudeSDKCanonicalSpeed(settings.Speed),
	}
	return payload
}

func promptTextForClaudeSDK(content []PromptContentBlock, fallback string) string {
	var parts []string
	for _, block := range content {
		if strings.TrimSpace(block.Type) == "text" && strings.TrimSpace(block.Text) != "" {
			parts = append(parts, strings.TrimSpace(block.Text))
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n\n")
	}
	return fallback
}

func promptContentForClaudeSDK(content []PromptContentBlock, fallback string) []map[string]any {
	blocks := make([]map[string]any, 0, len(content))
	for _, block := range content {
		switch strings.TrimSpace(block.Type) {
		case "text":
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			blocks = append(blocks, map[string]any{
				"type": "text",
				"text": text,
			})
		case "image":
			mimeType := strings.TrimSpace(block.MimeType)
			data := strings.TrimSpace(block.Data)
			if !runtimePromptImageMimeTypeSupported(mimeType) || data == "" {
				continue
			}
			blocks = append(blocks, map[string]any{
				"type":     "image",
				"mimeType": mimeType,
				"data":     data,
			})
		}
	}
	if len(blocks) == 0 && strings.TrimSpace(fallback) != "" {
		blocks = append(blocks, map[string]any{
			"type": "text",
			"text": strings.TrimSpace(fallback),
		})
	}
	return blocks
}

func cloneOptionalSessionSettings(settings *SessionSettings) *SessionSettings {
	if settings == nil {
		return nil
	}
	cloned := *settings
	if settings.BrowserUse != nil {
		value := *settings.BrowserUse
		cloned.BrowserUse = &value
	}
	if settings.ComputerUse != nil {
		value := *settings.ComputerUse
		cloned.ComputerUse = &value
	}
	return &cloned
}
